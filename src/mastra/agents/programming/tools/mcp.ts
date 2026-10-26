// Maps `GitHubBackend` / `RepoReadBackend` onto the shared MCP client's
// discovered `github_<name>` tools. Tool discovery is the only source of which
// tools exist, so callers degrade instead of asserting, and the payload parsers
// stay tolerant because the hosted server build varies.

import {
  StaleSourceError,
  aggregateCheckRuns,
  type CheckStatus,
  type GitHubBackend,
} from "./github.js";
import type { PatchFile } from "../contracts.js";
import { githubMcpTools, type GitHubToolMap } from "./mcp-client.js";

/** One directory listing entry surfaced to the coding agents' list_dir tool. */
export interface DirEntry {
  name: string;
  kind: "file" | "dir";
}

/** One code-search hit surfaced to the coding agents' search_code tool. */
export interface CodeHit {
  path: string;
  preview: string;
}

/**
 * Review operations the deterministic review lane runs through the shared MCP
 * backend. These map onto `list_pull_requests` / `pull_request_read` and the
 * pending-review write tools; payloads stay generic (`Record<string, unknown>`)
 * so this GitHub-MCP seam owns no review-domain contracts — the review lane maps
 * them onto its own schemas. The commit-range `compare` diff has no MCP tool and
 * stays on the residual REST transport.
 */
export interface ReviewBackend {
  listPullRequests(owner: string, repo: string, limit: number): Promise<Record<string, unknown>[]>;
  getPullRequest(owner: string, repo: string, number: number): Promise<Record<string, unknown>>;
  getPullRequestFiles(owner: string, repo: string, number: number): Promise<Record<string, unknown>[]>;
  authenticatedLogin(): Promise<string | undefined>;
  submitReview(submission: ReviewSubmission): Promise<{ reviewId: string; url: string }>;
}

/** One inline comment attached to a pending review (RIGHT side of the diff). */
export interface ReviewLineComment {
  path: string;
  line: number;
  body: string;
}

/** A finalized review the backend posts via the pending-review write flow. */
export interface ReviewSubmission {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: readonly ReviewLineComment[];
}

/** How many pull requests one `listPullRequests` read returns at most. */
const MAX_LISTED_PULLS = 50;

/** How many code-search hits one `searchCode` read returns at most. */
const MAX_SEARCH_HITS = 10;

/** Upper bound on file paths a `listFiles` tree walk returns. */
const MAX_TREE_ENTRIES = 2_000;

// Directories that never hold a candidate source file. Pruning them during the
// walk bounds cost, since the hosted GitHub MCP server has no recursive tree
// tool and `listFiles` is assembled from per-directory listings.
const VENDOR_TREE_SEGMENTS = new Set([
  "node_modules", "dist", "build", "out", "vendor", "coverage", ".git", ".next", "__pycache__",
]);

/**
 * Raised when an MCP call fails (server errors, auth errors, missing tool).
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

interface McpContentBlock {
  type?: string;
  text?: string;
  resource?: { text?: string };
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: McpContentBlock[];
}

// The `execute` seam we depend on from a discovered MCP tool. Typed structurally
// so the backend stays offline-testable with a scripted fake tool map, and so a
// real `Tool<any,any,any,any>` satisfies it without fighting the generic.
interface ExecutableMcpTool {
  execute?: (input: Record<string, unknown>, context: unknown) => Promise<unknown>;
}

type ToolMapProvider = () => Promise<GitHubToolMap>;

// MCP content-block discriminants, used to tell a raw CallToolResult envelope
// (`{ content: [<blocks>] }`) from a structured-content payload whose `content`
// field happens to be an array (a directory listing).
const MCP_BLOCK_TYPES = new Set(["text", "resource", "image", "audio"]);

/** Non-enumerable symbol @mastra/mcp stashes the model-facing content blocks on. */
const MCP_CALL_TOOL_CONTENT = Symbol.for("mastra.mcp.callToolContent");

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** True when every array item looks like an MCP content block (not a file/dir entry). */
function isMcpContentBlocks(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => {
      const entry = objectValue(item);
      return entry !== undefined && typeof entry.type === "string" && MCP_BLOCK_TYPES.has(entry.type);
    });
}

/**
 * Normalize whatever a discovered MCP tool's `execute()` returned into the
 * `McpToolResult` shape the parsers below consume. @mastra/mcp returns the
 * `structuredContent` directly when the server sends it (hiding the content
 * blocks on a symbol), or the full CallToolResult envelope otherwise; both are
 * folded back into one shape so the historical parsing stays intact.
 */
function normalizeExecuteResult(out: unknown): McpToolResult {
  const value = objectValue(out);
  if (value !== undefined && isMcpContentBlocks(value.content)) return out as McpToolResult;
  if (value !== undefined && value.isError === true) return out as McpToolResult;
  const hidden = (out as Record<PropertyKey, unknown> | null | undefined)?.[MCP_CALL_TOOL_CONTENT];
  const normalized: McpToolResult = { structuredContent: out };
  if (Array.isArray(hidden)) normalized.content = hidden as McpContentBlock[];
  return normalized;
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
  if (Array.isArray(result.structuredContent)) return result.structuredContent;
  const text = toolText(result);
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Maps the host-agnostic GitHub operations onto the shared MCPClient's discovered
 * tools. Ref/CAS conflicts map to `StaleSourceError`, and tool availability is
 * read from the discovered map rather than asserted, so `searchCode` degrades to
 * no hits instead of failing the loop when the server build lacks the tool.
 */
export class McpClientGitHubBackend implements GitHubBackend, ReviewBackend {
  private readonly listTools: ToolMapProvider;

  constructor(opts?: { tools?: ToolMapProvider }) {
    this.listTools = opts?.tools ?? (async () => await githubMcpTools());
  }

  private async toolMap(): Promise<GitHubToolMap> {
    return this.listTools();
  }

  private async hasTool(name: string): Promise<boolean> {
    return (await this.toolMap())[`github_${name}`] !== undefined;
  }

  private async resolveTool(name: string): Promise<ExecutableMcpTool> {
    const tool = (await this.toolMap())[`github_${name}`] as ExecutableMcpTool | undefined;
    if (tool === undefined || typeof tool.execute !== "function") {
      throw new GitHubMcpError(name, `GitHub MCP server does not expose the ${name} tool`);
    }
    return tool;
  }

  private async callRaw(
    tool: string,
    args: Record<string, unknown>,
    conflictIsStale = false,
  ): Promise<McpToolResult> {
    const handle = await this.resolveTool(tool);
    let result: McpToolResult;
    try {
      result = normalizeExecuteResult(await handle.execute!(args, {}));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Unauthorized|401|invalid token|token.*expired|authorization failed/i.test(message)) {
        throw new GitHubMcpError(tool, `GitHub MCP authorization failed: ${message}`, error);
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
        throw new GitHubMcpError(
          "get_file_contents",
          `get_file_contents returned no readable text for ${owner}/${repo}/${path}; it may be a directory or a binary blob.`,
        );
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
        throw new GitHubMcpError(
          "get_file_contents",
          `get_file_contents returned no readable text for ${owner}/${repo}/${path}; it may be a directory or a binary blob.`,
        );
      }
      return {
        content: decodeFileContent(value.content),
        sha: typeof value.sha === "string" ? value.sha : "",
      };
    }
    if (typeof data === "string") {
      return { content: decodeFileContent(data), sha: metaSha(result) };
    }
    throw new GitHubMcpError(
      "get_file_contents",
      `get_file_contents returned an unrecognized payload for ${owner}/${repo}/${path}.`,
    );
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
    if (pullNumber === undefined) {
      throw new GitHubMcpError(
        "checkRuns",
        "GitHub MCP check runs require the pull request number (writer apply must precede checks)",
      );
    }
    // The hosted GitHub MCP server reads a pull request's checks through
    // `pull_request_read` (method `get_check_runs`); it exposes no standalone
    // status tool, so this is the single path.
    if (!(await this.hasTool("pull_request_read"))) {
      throw new GitHubMcpError(
        "checkRuns",
        "GitHub MCP server does not expose pull_request_read for check runs",
      );
    }
    const data = this.responseObject("pull_request_read", await this.call(
      "pull_request_read",
      { owner, repo, pullNumber, method: "get_check_runs" },
    ));
    return normalizeCheckPayload(data);
  }

  /**
   * Directory listing for the coding agent `list_dir` tool. `get_file_contents`
   * answers a directory path with an array payload (shape varies across server
   * builds: structuredContent array, `{ content: [...] }`, or JSON text); a
   * non-array payload is reported as an actionable error naming the path.
   */
  async dirEntries(
    owner: string,
    repo: string,
    path: string,
    refSha: string,
  ): Promise<DirEntry[]> {
    const result = await this.callRaw("get_file_contents", {
      owner,
      repo,
      path,
      sha: refSha,
    });
    const listing = findArrayPayload(result);
    if (listing === undefined) {
      throw new GitHubMcpError(
        "get_file_contents",
        `get_file_contents returned no directory listing for ${owner}/${repo}/${path}; the path is likely a file, not a directory.`,
      );
    }
    const entries: DirEntry[] = [];
    for (const entry of listing) {
      const value = objectValue(entry);
      if (value === undefined || typeof value.name !== "string") continue;
      const kind = value.type === "dir" || value.type === "directory" || value.dir === true
        ? "dir"
        : "file";
      entries.push({ name: value.name, kind });
    }
    return entries;
  }

  /**
   * Repository-scoped code search for the coding agent `search_code` tool.
   * Degrades to an empty hit list when the server build does not expose
   * `search_code`, and to an empty list on index hiccups (rate limit,
   * validation) — a read-only research tool must never fail the agent loop.
   */
  async searchCode(owner: string, repo: string, query: string): Promise<CodeHit[]> {
    if (!(await this.hasTool("search_code"))) return [];
    let data: unknown;
    try {
      data = await this.call("search_code", {
        query: `${query} repo:${owner}/${repo}`,
        per_page: MAX_SEARCH_HITS,
      });
    } catch (error) {
      if (error instanceof GitHubMcpError
        && /rate|secondary|403|429|validation/i.test(error.message)) return [];
      throw error;
    }
    const value = objectValue(data) ?? {};
    const items = Array.isArray(value.items) ? value.items : [];
    const hits: CodeHit[] = [];
    for (const item of items) {
      const entry = objectValue(item);
      if (entry === undefined || typeof entry.path !== "string") continue;
      let preview = "";
      const matches = Array.isArray(entry.text_matches) ? entry.text_matches : [];
      for (const match of matches) {
        const text = objectValue(match);
        if (text !== undefined && typeof text.fragment === "string" && text.fragment !== "") {
          preview = text.fragment.slice(0, 200);
          break;
        }
      }
      hits.push({ path: entry.path, preview });
      if (hits.length >= MAX_SEARCH_HITS) break;
    }
    return hits;
  }

  /**
   * Candidate blob paths at `refSha` for the lane readers. The hosted GitHub
   * MCP server exposes no recursive tree tool (verified against tools/list), so
   * this walks `get_file_contents` directory listings breadth-first, pruning
   * vendor directories and capping the result. Replaces the retired
   * `/git/trees?recursive=1` REST call.
   */
  async listFiles(owner: string, repo: string, refSha: string): Promise<string[]> {
    const paths: string[] = [];
    const queue: string[] = [""];
    while (queue.length > 0 && paths.length < MAX_TREE_ENTRIES) {
      const dir = queue.shift() as string;
      for (const entry of await this.readDirListing(owner, repo, dir, refSha)) {
        if (entry.kind === "dir") {
          if (!VENDOR_TREE_SEGMENTS.has(entry.name)) queue.push(entry.path);
        } else {
          paths.push(entry.path);
        }
      }
    }
    return paths.slice(0, MAX_TREE_ENTRIES);
  }

  /** One directory's entries (name, kind, repo-relative path) at `refSha`. */
  private async readDirListing(
    owner: string,
    repo: string,
    path: string,
    refSha: string,
  ): Promise<Array<{ name: string; kind: "file" | "dir"; path: string }>> {
    const result = await this.callRaw("get_file_contents", { owner, repo, path, sha: refSha });
    const listing = findArrayPayload(result);
    if (listing === undefined) return [];
    const out: Array<{ name: string; kind: "file" | "dir"; path: string }> = [];
    for (const raw of listing) {
      const entry = objectValue(raw);
      const name = typeof entry?.name === "string" ? entry.name : "";
      if (name === "") continue;
      const fullPath = typeof entry?.path === "string"
        ? entry.path
        : path === "" ? name : `${path}/${name}`;
      const kind = entry?.type === "dir" || entry?.type === "directory" ? "dir" : "file";
      out.push({ name, kind, path: fullPath });
    }
    return out;
  }

  /**
   * Open pull requests (most recently updated first) as raw entries the review
   * lane maps to candidates. `list_pull_requests` answers with a bare array or a
   * `{ pulls: [...] }` envelope depending on the server build.
   */
  async listPullRequests(
    owner: string,
    repo: string,
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const data = await this.call("list_pull_requests", {
      owner,
      repo,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: Math.max(1, Math.min(MAX_LISTED_PULLS, limit)),
    });
    return rawEntries(data).slice(0, limit > 0 ? limit : MAX_LISTED_PULLS);
  }

  /** A single pull request's raw object, read through `pull_request_read`. */
  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Record<string, unknown>> {
    const data = await this.call("pull_request_read", {
      owner,
      repo,
      pullNumber: number,
      method: "get",
    });
    const value = objectValue(Array.isArray(data) ? data[0] : data);
    if (value === undefined) {
      throw new GitHubMcpError("pull_request_read", "Malformed pull request response");
    }
    return value;
  }

  /** A pull request's changed files, read through `pull_request_read` get_files. */
  async getPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Record<string, unknown>[]> {
    const data = await this.call("pull_request_read", {
      owner,
      repo,
      pullNumber: number,
      method: "get_files",
    });
    return rawEntries(data);
  }

  /** The token's own login (for the self-review downgrade), via `get_me`. */
  async authenticatedLogin(): Promise<string | undefined> {
    try {
      const data = this.responseObject("get_me", await this.call("get_me", {}));
      const login = typeof data.login === "string" ? data.login : undefined;
      return login === undefined || login === "" ? undefined : login;
    } catch {
      // A failed identity lookup must not fail the review; treat as unknown.
      return undefined;
    }
  }

  /**
   * Post a review through the MCP pending-review flow: open a pending review
   * (`pull_request_review_write` create), attach each inline comment
   * (`add_comment_to_pending_review`), then submit it with the verdict event and
   * body (`submit_pending`). The granular write tool carries no inline-comments
   * parameter, so comments are added as separate calls before submission.
   */
  async submitReview(
    submission: ReviewSubmission,
  ): Promise<{ reviewId: string; url: string }> {
    const { owner, repo, pullNumber, commitId, event, body, comments } = submission;
    await this.call("pull_request_review_write", {
      owner,
      repo,
      pullNumber,
      method: "create",
      commitID: commitId,
    });
    for (const comment of comments) {
      await this.call("add_comment_to_pending_review", {
        owner,
        repo,
        pullNumber,
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
        subjectType: "LINE",
        body: comment.body,
      });
    }
    const data = this.responseObject(
      "pull_request_review_write",
      await this.call("pull_request_review_write", {
        owner,
        repo,
        pullNumber,
        method: "submit_pending",
        event,
        body,
      }),
    );
    const id = typeof data.id === "number" || typeof data.id === "string" ? String(data.id) : "";
    return { reviewId: id, url: typeof data.html_url === "string" ? data.html_url : "" };
  }

  /** The client is a shared module singleton, so a backend never owns it. */
  async close(): Promise<void> {}
}

/**
 * Extract a list of raw object entries from a review-read payload. The hosted
 * server returns a bare array or wraps it under `pulls` / `files` / `content`
 * depending on the tool and build; non-object items are dropped so the review
 * lane only maps well-formed entries.
 */
function rawEntries(data: unknown): Record<string, unknown>[] {
  let list: unknown[] | undefined;
  if (Array.isArray(data)) list = data;
  else {
    const value = objectValue(data);
    if (value !== undefined) {
      for (const key of ["pulls", "files", "content", "items", "reviews"]) {
        if (Array.isArray(value[key])) {
          list = value[key] as unknown[];
          break;
        }
      }
    }
  }
  if (list === undefined) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of list) {
    const value = objectValue(entry);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** First array payload in a get_file_contents result (directory listing). */
function findArrayPayload(result: McpToolResult): unknown[] | undefined {
  const structured = objectValue(result.structuredContent);
  if (structured !== undefined && Array.isArray(structured.content)) return structured.content;
  if (Array.isArray(result.structuredContent)) return result.structuredContent;
  const data = toolData(result);
  if (Array.isArray(data)) return data;
  const value = objectValue(data);
  if (value !== undefined && Array.isArray(value.content)) return value.content;
  return undefined;
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
