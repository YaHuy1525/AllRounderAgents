import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  StaleSourceError,
  aggregateCheckRuns,
  type CheckStatus,
  type GitHubBackend,
} from "./github.js";
import type { PatchFile } from "../contracts.js";

export const GITHUB_MCP_DEFAULT_URL = "https://api.githubcopilot.com/mcp/";

/**
 * Raised when an MCP call fails (server errors, auth errors, tool policy).
 * `tool` names the failing MCP tool; the message carries the server text so
 * operators can diagnose without reading network traces.
 */
export class GitHubMcpError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitHubMcpError";
  }
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string; resource?: { text?: string } }>;
}

interface McpToolDef {
  name: string;
}

/**
 * Narrow seam over the MCP session so the backend is testable offline with a
 * scripted fake and swappable at runtime (real SDK client).
 */
export interface GitHubMcpSession {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

/**
 * Real MCP session over the official SDK: lazy Streamable HTTP connection to
 * the GitHub MCP remote server, authenticated with a bearer PAT header. The
 * hosted server does not support OAuth dynamic client registration, so per
 * the official remote-server docs every host authenticates with a personal
 * access token sent as `Authorization: Bearer <token>`.
 */
export class SdkGitHubMcpSession implements GitHubMcpSession {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;

  constructor(
    private readonly serverUrl: string,
    private readonly token?: string,
  ) {}

  private async connect(): Promise<void> {
    if (this.client !== undefined) return;
    const client = new Client(
      { name: "allrounder-coding-agent", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(this.serverUrl),
      this.token === undefined || this.token === ""
        ? undefined
        : { requestInit: { headers: { Authorization: `Bearer ${this.token}` } } },
    );
    this.client = client;
    this.transport = transport;
    try {
      await client.connect(transport as unknown as Transport);
    } catch (error) {
      this.client = undefined;
      this.transport = undefined;
      if (error instanceof UnauthorizedError) {
        throw new GitHubMcpError(
          "connect",
          "GitHub MCP authorization failed. Set GITHUB_MCP_TOKEN (or GITHUB_TOKEN) to a"
          + " classic repo-scope PAT or a fine-grained token with Contents and Pull"
          + " requests read/write, then verify with `node scripts/github-mcp-verify.mjs`.",
          error,
        );
      }
      throw error;
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.connect();
    const result = await this.client?.listTools();
    return result?.tools.map((tool) => ({ name: tool.name })) ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.connect();
    const result = await this.client?.callTool({ name, arguments: args });
    return (result ?? {}) as McpToolResult;
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (transport !== undefined) await transport.close();
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Joins every text content block of an MCP tool result into one string. */
function toolText(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** Text of the first resource block in a tool result (used for file reads). */
function resourceText(result: McpToolResult): string | undefined {
  if (!Array.isArray(result.content)) return undefined;
  for (const part of result.content) {
    if (typeof part?.resource?.text === "string") return part.resource.text;
  }
  return undefined;
}

/** Blob/commit sha embedded in descriptive text blocks, e.g. "SHA: <40 hex>". */
function metaSha(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return "";
  for (const part of result.content) {
    const match = typeof part?.text === "string"
      ? part.text.match(/SHA:\s*([0-9a-f]{40})/)
      : undefined;
    if (match?.[1] !== undefined) return match[1];
  }
  return "";
}

/** JSON payload from a successful tool call: structuredContent, then text. */
function toolData(result: McpToolResult): unknown {
  if (objectValue(result.structuredContent) !== undefined) return result.structuredContent;
  const text = toolText(result);
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * MCP GitHub backend. Tool shapes differ across GitHub MCP server builds, so
 * the real tool list is asserted on first use and the check-runs reader picks
 * whichever variant the server exposes (`get_pull_request_status` granular vs
 * `pull_request_read` meta method). Ref/CAS conflicts raised by the server
 * map to `StaleSourceError`, matching the flow's stale_source escalation.
 */
export class McpGitHubBackend implements GitHubBackend {
  private readonly requiredTools = [
    "get_commit",
    "get_file_contents",
    "push_files",
    "create_pull_request",
    "list_pull_requests",
  ];
  private tools: Set<string> | undefined;
  private session: GitHubMcpSession;
  private closeSession = false;

  constructor(opts?: { session?: GitHubMcpSession; serverUrl?: string; token?: string }) {
    if (opts?.session !== undefined) {
      this.session = opts.session;
      return;
    }
    const token = opts?.token ?? process.env.GITHUB_MCP_TOKEN ?? process.env.GITHUB_TOKEN;
    this.session = new SdkGitHubMcpSession(
      opts?.serverUrl ?? process.env.GITHUB_MCP_URL ?? GITHUB_MCP_DEFAULT_URL,
      token,
    );
    this.closeSession = true;
  }

  private async assertTools(): Promise<void> {
    if (this.tools !== undefined) return;
    const tools = new Set((await this.session.listTools()).map((tool) => tool.name));
    const missing = this.requiredTools.filter((name) => !tools.has(name));
    if (missing.length > 0) {
      throw new GitHubMcpError(
        "connect",
        `GitHub MCP server is missing required tools: ${missing.join(", ")}`,
      );
    }
    this.tools = tools;
  }

  private async callRaw(
    tool: string,
    args: Record<string, unknown>,
    conflictIsStale = false,
  ): Promise<McpToolResult> {
    await this.assertTools();
    let result: McpToolResult;
    try {
      result = await this.session.callTool(tool, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Unauthorized|401|invalid token|token.*expired/i.test(message)) {
        throw new GitHubMcpError(
          tool,
          `GitHub MCP authorization failed: ${message}`,
          error,
        );
      }
      if (conflictIsStale && /already exists|not fast-forward|fast-forward|reference/i.test(message)) {
        throw new StaleSourceError();
      }
      throw new GitHubMcpError(tool, `GitHub MCP call failed: ${message}`, error);
    }
    if (result.isError === true) {
      const message = toolText(result);
      if (conflictIsStale && /already exists|fast-forward/i.test(message)) {
        throw new StaleSourceError();
      }
      throw new GitHubMcpError(tool, message === "" ? "MCP tool reported an error" : message);
    }
    return result;
  }

  private async call(
    tool: string,
    args: Record<string, unknown>,
    conflictIsStale = false,
  ): Promise<unknown> {
    return toolData(await this.callRaw(tool, args, conflictIsStale));
  }

  private responseObject(tool: string, data: unknown): Record<string, unknown> {
    const value = objectValue(data);
    if (value === undefined) {
      throw new GitHubMcpError(tool, "MCP tool returned a non-object payload");
    }
    return value;
  }

  async headSha(owner: string, repo: string, branch: string): Promise<string> {
    const data = this.responseObject("get_commit", await this.call(
      "get_commit",
      { owner, repo, sha: branch },
    ));
    if (typeof data.sha !== "string") {
      throw new GitHubMcpError("get_commit", "Malformed commit response");
    }
    return data.sha;
  }

  async branchHead(owner: string, repo: string, branch: string): Promise<string | undefined> {
    try {
      const data = this.responseObject("get_commit", await this.call(
        "get_commit",
        { owner, repo, sha: branch },
      ));
      return typeof data.sha === "string" ? data.sha : undefined;
    } catch (error) {
      // A missing branch is an ordinary replay probe result, not an error.
      if (error instanceof GitHubMcpError
        && /not found|no commit found|404|could not resolve/i.test(error.message)) {
        return undefined;
      }
      throw error;
    }
  }

  async fileContent(
    owner: string,
    repo: string,
    path: string,
    refSha: string,
  ): Promise<{ content: string; sha: string }> {
    const result = await this.callRaw("get_file_contents", {
      owner,
      repo,
      path,
      sha: refSha,
    });
    const structured = objectValue(result.structuredContent);
    if (structured !== undefined) {
      if (typeof structured.content !== "string") {
        throw new GitHubMcpError("get_file_contents", "Malformed file contents response");
      }
      return {
        content: decodeFileContent(structured.content),
        sha: typeof structured.sha === "string" ? structured.sha : "",
      };
    }
    // Official server builds stream the file body as a resource block and the
    // blob sha in the descriptive text; older builds return a JSON text payload.
    const resource = resourceText(result);
    if (resource !== undefined) {
      return { content: resource, sha: metaSha(result) };
    }
    const data = toolData(result);
    const value = objectValue(data);
    if (value !== undefined) {
      if (typeof value.content !== "string") {
        throw new GitHubMcpError("get_file_contents", "Malformed file contents response");
      }
      return {
        content: decodeFileContent(value.content),
        sha: typeof value.sha === "string" ? value.sha : "",
      };
    }
    if (typeof data === "string") {
      return { content: decodeFileContent(data), sha: metaSha(result) };
    }
    throw new GitHubMcpError("get_file_contents", "MCP tool returned a non-object payload");
  }

  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    _baseSha: string,
    files: PatchFile[],
  ): Promise<{ commitSha: string }> {
    await this.call(
      "push_files",
      {
        owner,
        repo,
        branch,
        files: files.map((file) => ({ path: file.path, content: file.content })),
        message,
      },
      true,
    );
    // push_files does not pin the parent; the server CAS commits on the branch
    // tip. Read the resulting head commit back to bind the receipt.
    return { commitSha: await this.headSha(owner, repo, branch) };
  }

  async openDraftPull(
    owner: string,
    repo: string,
    branch: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }> {
    const data = this.responseObject("create_pull_request", await this.call(
      "create_pull_request",
      { owner, repo, title, body, head: branch, base: baseBranch, draft: true },
      true,
    ));
    // Official builds return a MinimalResponse { id, url } with the PR number
    // only implied by the html url; other builds return number/html_url.
    const url = typeof data.url === "string" ? data.url : typeof data.html_url === "string"
      ? data.html_url
      : "";
    let number = typeof data.number === "number" ? data.number : Number.NaN;
    if (!Number.isInteger(number) || number <= 0) {
      const match = /\/pull\/(\d+)\/?$/.exec(url);
      if (match?.[1] === undefined || url === "") {
        throw new GitHubMcpError("create_pull_request", "Malformed pull request response");
      }
      number = Number(match[1]);
    }
    return { number, url };
  }

  async listOpenPulls(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<Array<{ number: number; url: string; body: string; draft: boolean }>> {
    const data = await this.call("list_pull_requests", {
      owner,
      repo,
      state: "open",
      head: `${owner}:${branch}`,
    });
    const rawList = Array.isArray(data) ? data : this.responseObject("list_pull_requests", data)?.pulls;
    if (!Array.isArray(rawList)) {
      throw new GitHubMcpError("list_pull_requests", "Malformed pull request list response");
    }
    return rawList.map((entry) => {
      const value = objectValue(entry);
      if (value === undefined || typeof value.number !== "number"
        || typeof value.html_url !== "string") {
        throw new GitHubMcpError("list_pull_requests", "Malformed pull request list response");
      }
      return {
        number: value.number,
        url: value.html_url,
        body: typeof value.body === "string" ? value.body : "",
        draft: value.draft === true,
      };
    });
  }

  async checkRuns(
    owner: string,
    repo: string,
    commitSha: string,
    pullNumber?: number,
  ): Promise<CheckStatus> {
    await this.assertTools();
    if (pullNumber === undefined) {
      throw new GitHubMcpError(
        "checkRuns",
        "GitHub MCP check runs require the pull request number (writer apply must precede checks)",
      );
    }
    const tools = this.tools ?? new Set();
    if (tools.has("get_pull_request_status")) {
      const data = this.responseObject("get_pull_request_status", await this.call(
        "get_pull_request_status",
        { owner, repo, pull_number: pullNumber },
      ));
      return normalizeCheckPayload(data);
    }
    if (tools.has("pull_request_read")) {
      const data = this.responseObject("pull_request_read", await this.call(
        "pull_request_read",
        { owner, repo, pullNumber, method: "get_check_runs" },
      ));
      return normalizeCheckPayload(data);
    }
    throw new GitHubMcpError(
      "checkRuns",
      "GitHub MCP server exposes neither get_pull_request_status nor pull_request_read",
    );
  }

  async close(): Promise<void> {
    if (this.closeSession) await this.session.close();
  }
}

function normalizeCheckPayload(data: Record<string, unknown>): CheckStatus {
  if (typeof data.state === "string") {
    if (data.state === "FAILURE") return "failure";
    if (data.state === "PENDING") return "pending";
    if (data.state === "SUCCESS") return "success";
  }
  const runs = Array.isArray(data.check_runs)
    ? data.check_runs
    : Array.isArray(data.runs)
      ? data.runs
      : [];
  return aggregateCheckRuns(runs);
}

/**
 * Defensive decoding: GitHub MCP servers disagree on whether `content` is
 * base64 (REST-style) or decoded text, so a well-formed base64 payload is
 * decoded while plain text passes through untouched.
 */
function decodeFileContent(value: string): string {
  const compact = value.replace(/\s/g, "");
  if (compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf8");
      if (decoded.length > 0 || compact.length === 0) return decoded;
    } catch {
      // fall through to raw text
    }
  }
  return value;
}
