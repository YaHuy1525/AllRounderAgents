import { createHash } from "node:crypto";

import type {
  PatchFile,
  PreviewManifest,
  PullRequestReceipt,
} from "../contracts.js";
import { PullRequestReceiptSchema } from "../contracts.js";

export type CheckStatus = "pending" | "success" | "failure" | "neutral";

export interface GitHubResponse {
  status: number;
  body: unknown;
}

export interface GitHubTransport {
  request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<GitHubResponse>;
}

export interface GitHubPolicy {
  repositories: string[];
  baseBranch: string;
  allowPaths: string[];
  denyPaths: string[];
  destructivePaths: string[];
  maxFiles: number;
  maxPatchBytes: number;
  timeoutMs: number;
}

export class RepositoryPolicyError extends Error {
  constructor(
    readonly code: "repository_denied" | "path_denied" | "approval_required" | "limits_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryPolicyError";
  }
}

export class StaleSourceError extends Error {
  constructor() {
    super("Expected source SHA no longer matches base branch");
    this.name = "StaleSourceError";
  }
}

export class FetchGitHubTransport implements GitHubTransport {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.github.com",
  ) {
    if (token.length < 1) throw new Error("GitHub token is required");
  }

  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<GitHubResponse> {
    const request: RequestInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const response = await fetch(`${this.baseUrl}${path}`, request);
    const responseBody: unknown = await response.json().catch(() => ({}));
    return { status: response.status, body: responseBody };
  }
}

function globMatches(path: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

function isSafeBranchName(value: string): boolean {
  const segments = value.split("/");
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".") &&
    segments.every((segment) => segment.length > 0 && !segment.endsWith(".lock"))
  );
}

function bodyObject(response: GitHubResponse): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300 || typeof response.body !== "object"
      || response.body === null || Array.isArray(response.body)) {
    throw new Error(`GitHub request failed (${response.status})`);
  }
  return response.body as Record<string, unknown>;
}

export interface PatchFileManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
  validators: string[];
}

/**
 * Deterministic content fingerprint for a planned patch. Shared by the
 * approval gate (suspend payload) and the writer preflight so the receipt
 * always binds to the exact bytes that would be committed.
 */
export function computePatchHash(files: PatchFile[]): string {
  const fileManifest = files.map<PatchFileManifestEntry>((file) => ({
    path: file.path,
    sha256: createHash("sha256").update(file.content).digest("hex"),
    bytes: Buffer.byteLength(file.content),
    validators: file.validators,
  }));
  return createHash("sha256").update(JSON.stringify(fileManifest)).digest("hex");
}

export class GitHubSourceReader {
  constructor(
    private readonly transport: GitHubTransport,
    private readonly policy: GitHubPolicy,
  ) {}

  assertRepository(owner: string, repo: string, baseBranch: string): void {
    if (!this.policy.repositories.includes(`${owner}/${repo}`)) {
      throw new RepositoryPolicyError("repository_denied", "Repository not allowed");
    }
    if (baseBranch !== this.policy.baseBranch) {
      throw new RepositoryPolicyError("repository_denied", "Base branch not allowed");
    }
  }

  assertPath(path: string): void {
    if (this.policy.denyPaths.some((glob) => globMatches(path, glob))
      || !this.policy.allowPaths.some((glob) => globMatches(path, glob))) {
      throw new RepositoryPolicyError("path_denied", `Path denied: ${path}`);
    }
  }

  isDestructive(path: string): boolean {
    return this.policy.destructivePaths.some((glob) => globMatches(path, glob));
  }

  async sourceSha(owner: string, repo: string, baseBranch: string): Promise<string> {
    this.assertRepository(owner, repo, baseBranch);
    const response = bodyObject(await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
      undefined,
      this.policy.timeoutMs,
    ));
    const object = response.object;
    if (typeof object !== "object" || object === null || !("sha" in object)
      || typeof object.sha !== "string") throw new Error("Malformed GitHub ref response");
    return object.sha;
  }

  async content(
    owner: string,
    repo: string,
    path: string,
    sourceSha: string,
  ): Promise<{ content: string; sha: string }> {
    this.assertRepository(owner, repo, this.policy.baseBranch);
    this.assertPath(path);
    const response = bodyObject(await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(sourceSha)}`,
      undefined,
      this.policy.timeoutMs,
    ));
    if (typeof response.content !== "string" || typeof response.sha !== "string") {
      throw new Error("Malformed GitHub contents response");
    }
    return {
      content: Buffer.from(response.content.replace(/\s/g, ""), "base64").toString("utf8"),
      sha: response.sha,
    };
  }
}

export class GitHubWriter {
  private readonly receipts = new Map<string, PullRequestReceipt>();

  constructor(
    private readonly transport: GitHubTransport,
    private readonly policy: GitHubPolicy,
    private readonly reader: GitHubSourceReader,
  ) {}

  preflight(
    owner: string,
    repo: string,
    baseBranch: string,
    branch: string,
    sourceSha: string,
    files: PatchFile[],
    evidence: PreviewManifest["evidence"],
    approvedDestructivePaths: string[],
  ): PreviewManifest {
    this.reader.assertRepository(owner, repo, baseBranch);
    if (!isSafeBranchName(branch)) {
      throw new RepositoryPolicyError("path_denied", "Branch name is not a safe Git reference");
    }
    const uniquePaths = new Set(files.map((file) => file.path));
    const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    if (files.length > this.policy.maxFiles || uniquePaths.size !== files.length
      || bytes > this.policy.maxPatchBytes) {
      throw new RepositoryPolicyError("limits_exceeded", "Patch limits exceeded");
    }
    for (const file of files) {
      this.reader.assertPath(file.path);
      if (this.reader.isDestructive(file.path) && !approvedDestructivePaths.includes(file.path)) {
        throw new RepositoryPolicyError("approval_required", `Approval required: ${file.path}`);
      }
    }
    const fileManifest = files.map<PatchFileManifestEntry>((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
      bytes: Buffer.byteLength(file.content),
      validators: file.validators,
    }));
    const patchHash = computePatchHash(files);
    return {
      repository: `${owner}/${repo}`,
      baseBranch,
      sourceSha,
      branch,
      patchHash,
      files: fileManifest,
      risk: files.some((file) => this.reader.isDestructive(file.path)) ? "high" : "low",
      evidence,
    };
  }

  async apply(
    manifest: PreviewManifest,
    files: PatchFile[],
    title: string,
    body: string,
  ): Promise<PullRequestReceipt> {
    const [owner, repo] = manifest.repository.split("/");
    if (owner === undefined || repo === undefined) throw new Error("Invalid repository");
    const key = `${manifest.repository}:${manifest.branch}:${manifest.patchHash}`;
    const prior = this.receipts.get(key);
    if (prior !== undefined) return PullRequestReceiptSchema.parse({ ...prior, replayed: true });
    const durableReplay = await this.findDurableReplay(owner, repo, manifest);
    if (durableReplay !== undefined) {
      this.receipts.set(key, durableReplay);
      return durableReplay;
    }

    const actualSha = await this.reader.sourceSha(owner, repo, manifest.baseBranch);
    if (actualSha !== manifest.sourceSha) throw new StaleSourceError();
    const commit = bodyObject(await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/git/commits/${manifest.sourceSha}`,
      undefined,
      this.policy.timeoutMs,
    ));
    const tree = commit.tree;
    if (typeof tree !== "object" || tree === null || !("sha" in tree)
      || typeof tree.sha !== "string") throw new Error("Malformed GitHub commit response");

    const treeEntries = [];
    for (const file of files) {
      const blob = bodyObject(await this.transport.request(
        "POST",
        `/repos/${owner}/${repo}/git/blobs`,
        { content: file.content, encoding: "utf-8" },
        this.policy.timeoutMs,
      ));
      if (typeof blob.sha !== "string") throw new Error("Malformed GitHub blob response");
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = bodyObject(await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/git/trees`,
      { base_tree: tree.sha, tree: treeEntries },
      this.policy.timeoutMs,
    ));
    const createdCommit = bodyObject(await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/git/commits`,
      { message: title, tree: newTree.sha, parents: [manifest.sourceSha] },
      this.policy.timeoutMs,
    ));
    if (typeof createdCommit.sha !== "string") throw new Error("Malformed commit response");
    bodyObject(await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/git/refs`,
      { ref: `refs/heads/${manifest.branch}`, sha: createdCommit.sha },
      this.policy.timeoutMs,
    ));
    const pull = bodyObject(await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      { title, head: manifest.branch, base: manifest.baseBranch, body, draft: true },
      this.policy.timeoutMs,
    ));
    if (typeof pull.html_url !== "string" || typeof pull.number !== "number") {
      throw new Error("Malformed pull request response");
    }
    const receipt = PullRequestReceiptSchema.parse({
      url: pull.html_url,
      number: pull.number,
      draft: true,
      branch: manifest.branch,
      baseBranch: manifest.baseBranch,
      sourceSha: manifest.sourceSha,
      commitSha: createdCommit.sha,
      patchHash: manifest.patchHash,
      replayed: false,
    });
    this.receipts.set(key, receipt);
    return receipt;
  }

  private async findDurableReplay(
    owner: string,
    repo: string,
    manifest: PreviewManifest,
  ): Promise<PullRequestReceipt | undefined> {
    const branchResponse = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(manifest.branch)}`,
      undefined,
      this.policy.timeoutMs,
    );
    if (branchResponse.status === 404) return undefined;
    const branch = bodyObject(branchResponse);
    const object = branch.object;
    if (typeof object !== "object" || object === null || !("sha" in object)
      || typeof object.sha !== "string") throw new Error("Malformed GitHub branch response");
    const pulls = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${manifest.branch}`)}&state=open`,
      undefined,
      this.policy.timeoutMs,
    );
    if (pulls.status < 200 || pulls.status >= 300 || !Array.isArray(pulls.body)) {
      throw new Error(`GitHub request failed (${pulls.status})`);
    }
    const matching = pulls.body.find((value) =>
      typeof value === "object" && value !== null
      && "body" in value && typeof value.body === "string"
      && "draft" in value && value.draft === true
      && value.body.includes(`Patch hash: ${manifest.patchHash}`));
    if (typeof matching !== "object" || matching === null
      || !("html_url" in matching) || typeof matching.html_url !== "string"
      || !("number" in matching) || typeof matching.number !== "number") {
      throw new Error("Branch already exists without a matching idempotent Draft PR");
    }
    return PullRequestReceiptSchema.parse({
      url: matching.html_url,
      number: matching.number,
      draft: true,
      branch: manifest.branch,
      baseBranch: manifest.baseBranch,
      sourceSha: manifest.sourceSha,
      commitSha: object.sha,
      patchHash: manifest.patchHash,
      replayed: true,
    });
  }

  async checks(owner: string, repo: string, commitSha: string): Promise<CheckStatus> {
    this.reader.assertRepository(owner, repo, this.policy.baseBranch);
    const response = bodyObject(await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/commits/${commitSha}/check-runs`,
      undefined,
      this.policy.timeoutMs,
    ));
    const runs = Array.isArray(response.check_runs) ? response.check_runs : [];
    if (runs.some((run) => typeof run === "object" && run !== null
      && "conclusion" in run && run.conclusion === "failure")) return "failure";
    if (runs.some((run) => typeof run === "object" && run !== null
      && "status" in run && run.status !== "completed")) return "pending";
    return "success";
  }
}

export class GitHubRepositoryTools {
  readonly reader: GitHubSourceReader;
  readonly writer: GitHubWriter;

  constructor(transport: GitHubTransport, policy: GitHubPolicy, _tokenSeam?: string) {
    this.reader = new GitHubSourceReader(transport, policy);
    this.writer = new GitHubWriter(transport, policy, this.reader);
  }
}

export class FakeGitHubTransport implements GitHubTransport {
  sourceSha: string;
  checks: CheckStatus;
  readonly treeSha: string;
  readonly commitSha: string;
  writeCalls = 0;
  commitCreates = 0;
  readonly pullRequests: Array<{ body: string; draft: boolean }> = [];
  readonly logs: string[] = [];
  private branchSha: string | undefined;

  constructor(config: {
    sourceSha: string;
    treeSha: string;
    commitSha: string;
    checks: CheckStatus;
  }) {
    this.sourceSha = config.sourceSha;
    this.treeSha = config.treeSha;
    this.commitSha = config.commitSha;
    this.checks = config.checks;
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<GitHubResponse> {
    this.logs.push(`${method} ${path}`);
    if (method === "POST") this.writeCalls += 1;
    if (path.endsWith("/git/ref/heads/main")) {
      return { status: 200, body: { object: { sha: this.sourceSha } } };
    }
    if (path.includes("/git/ref/heads/")) {
      return this.branchSha === undefined
        ? { status: 404, body: {} }
        : { status: 200, body: { object: { sha: this.branchSha } } };
    }
    if (/\/git\/commits\/[a-f0-9]+$/.test(path) && method === "GET") {
      return { status: 200, body: { tree: { sha: this.treeSha } } };
    }
    if (path.endsWith("/git/blobs")) return { status: 201, body: { sha: "e".repeat(40) } };
    if (path.endsWith("/git/trees")) return { status: 201, body: { sha: "f".repeat(40) } };
    if (path.endsWith("/git/commits") && method === "POST") {
      this.commitCreates += 1;
      return { status: 201, body: { sha: this.commitSha } };
    }
    if (path.endsWith("/git/refs")) {
      const value = body as { sha: string };
      this.branchSha = value.sha;
      return { status: 201, body: { ref: "created" } };
    }
    if (path.includes("/pulls?")) {
      return {
        status: 200,
        body: this.pullRequests.map((pull, index) => ({
          ...pull,
          html_url: `https://github.example/acme/widget/pull/${index + 1}`,
          number: index + 1,
        })),
      };
    }
    if (path.endsWith("/pulls")) {
      const value = body as { body: string; draft: boolean };
      this.pullRequests.push(value);
      return {
        status: 201,
        body: { html_url: "https://github.example/acme/widget/pull/1", number: 1 },
      };
    }
    if (path.endsWith("/check-runs")) {
      const check = this.checks === "failure"
        ? { status: "completed", conclusion: "failure" }
        : this.checks === "pending"
          ? { status: "in_progress", conclusion: null }
          : { status: "completed", conclusion: "success" };
      return { status: 200, body: { check_runs: [check] } };
    }
    if (path.includes("/contents/")) {
      return { status: 200, body: { content: Buffer.from("fixture").toString("base64"), sha: "1".repeat(40) } };
    }
    return { status: 404, body: {} };
  }
}
