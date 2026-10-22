import { createHash } from "node:crypto";

import type {
  ChangeManifestEntry,
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

/**
 * Host-agnostic Git host operations. `RestGitHubBackend` speaks the GitHub
 * REST sequence verbatim; `McpClientGitHubBackend` (mcp.ts) maps the same
 * operations onto the discovered GitHub MCP tools. Reader/writer policy logic
 * lives above this seam, so the flow's deterministic gates are backend-agnostic.
 */
export interface GitHubBackend {
  headSha(owner: string, repo: string, branch: string): Promise<string>;
  branchHead(owner: string, repo: string, branch: string): Promise<string | undefined>;
  fileContent(
    owner: string,
    repo: string,
    path: string,
    refSha: string,
  ): Promise<{ content: string; sha: string }>;
  commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    baseSha: string,
    files: PatchFile[],
  ): Promise<{ commitSha: string }>;
  openDraftPull(
    owner: string,
    repo: string,
    branch: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }>;
  listOpenPulls(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<Array<{ number: number; url: string; body: string; draft: boolean }>>;
  checkRuns(owner: string, repo: string, commitSha: string, pullNumber?: number): Promise<CheckStatus>;
  /** Blob file paths present at `refSha`, for lane readers to pick candidate files. */
  listFiles(owner: string, repo: string, refSha: string): Promise<string[]>;
}

/**
 * Optional capability of sandbox-backed frontiers: commit whatever the actor
 * left in the container's working tree and push the branch, instead of
 * receiving whole-file bodies. `GitHubWriter.apply` prefers this over
 * `commitFiles` when the backend exposes it, so non-sandbox backends and the
 * existing fakes stay valid untouched.
 */
export interface WorkingTreeBackend {
  commitWorkingTree(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    baseSha: string,
  ): Promise<{ commitSha: string }>;
}

export function supportsWorkingTreeCommit(
  backend: GitHubBackend,
): backend is GitHubBackend & WorkingTreeBackend {
  return typeof (backend as Partial<WorkingTreeBackend>).commitWorkingTree === "function";
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
  /**
   * Set when the lane runs on the sandbox backend: `maxPatchBytes` then bounds
   * changed-file bytes (the manifest), not model-transported whole-file bodies.
   */
  sandboxMode?: boolean;
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

export function aggregateCheckRuns(runs: unknown[]): CheckStatus {
  if (runs.some((run) => typeof run === "object" && run !== null
    && "conclusion" in run && run.conclusion === "failure")) return "failure";
  if (runs.some((run) => typeof run === "object" && run !== null
    && "status" in run && run.status !== "completed")) return "pending";
  return "success";
}

export interface PatchFileManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
  validators: string[];
}

/** True for entries already fingerprinted on disk (sandbox manifest form). */
function isManifestEntry(
  entry: PatchFile | ChangeManifestEntry,
): entry is ChangeManifestEntry {
  return (entry as Partial<ChangeManifestEntry>).sha256 !== undefined;
}

function toManifestEntries(
  entries: ReadonlyArray<PatchFile | ChangeManifestEntry>,
): PatchFileManifestEntry[] {
  return entries.map((file) => isManifestEntry(file)
    ? { path: file.path, sha256: file.sha256, bytes: file.bytes, validators: file.validators }
    : {
        path: file.path,
        sha256: createHash("sha256").update(file.content).digest("hex"),
        bytes: Buffer.byteLength(file.content),
        validators: file.validators,
      });
}

/**
 * Deterministic content fingerprint for a planned patch. Shared by the
 * approval gate (suspend payload) and the writer preflight so the receipt
 * always binds to the exact bytes that would be committed. Manifest entries
 * (sandbox path) hash identically to the `PatchFile[]` carrying the same
 * bytes, because the sha256/bytes are computed from the disk content.
 */
export function computePatchHash(
  files: ReadonlyArray<PatchFile | ChangeManifestEntry>,
): string {
  return createHash("sha256").update(JSON.stringify(toManifestEntries(files))).digest("hex");
}

/**
 * Read the current bytes for manifest entries through the backend, producing
 * the `PatchFile[]` shape deterministic validators still consume. On the
 * sandbox path the working tree answers the read, so run state never carries
 * content beyond a single validator round trip.
 */
export async function readContentForEntries(
  backend: GitHubBackend,
  owner: string,
  repo: string,
  sourceSha: string,
  entries: readonly ChangeManifestEntry[],
): Promise<PatchFile[]> {
  return Promise.all(entries.map(async (entry) => {
    const { content } = await backend.fileContent(owner, repo, entry.path, sourceSha);
    return { path: entry.path, content, validators: entry.validators };
  }));
}

export class GitHubSourceReader {
  constructor(
    private readonly backend: GitHubBackend,
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

  /** Non-throwing form of `assertPath`; listing callers filter candidates with it. */
  allowsPath(path: string): boolean {
    return (
      !this.policy.denyPaths.some((glob) => globMatches(path, glob)) &&
      this.policy.allowPaths.some((glob) => globMatches(path, glob))
    );
  }

  assertPath(path: string): void {
    if (!this.allowsPath(path)) {
      throw new RepositoryPolicyError("path_denied", `Path denied: ${path}`);
    }
  }

  isDestructive(path: string): boolean {
    return this.policy.destructivePaths.some((glob) => globMatches(path, glob));
  }

  async sourceSha(owner: string, repo: string, baseBranch: string): Promise<string> {
    this.assertRepository(owner, repo, baseBranch);
    return this.backend.headSha(owner, repo, baseBranch);
  }

  async content(
    owner: string,
    repo: string,
    path: string,
    sourceSha: string,
  ): Promise<{ content: string; sha: string }> {
    this.assertRepository(owner, repo, this.policy.baseBranch);
    this.assertPath(path);
    return this.backend.fileContent(owner, repo, path, sourceSha);
  }
}

export class GitHubWriter {
  private readonly receipts = new Map<string, PullRequestReceipt>();

  constructor(
    private readonly backend: GitHubBackend,
    private readonly policy: GitHubPolicy,
    private readonly reader: GitHubSourceReader,
  ) {}

  preflight(
    owner: string,
    repo: string,
    baseBranch: string,
    branch: string,
    sourceSha: string,
    files: ReadonlyArray<PatchFile | ChangeManifestEntry>,
    evidence: PreviewManifest["evidence"],
    approvedDestructivePaths: string[],
  ): PreviewManifest {
    this.reader.assertRepository(owner, repo, baseBranch);
    if (!isSafeBranchName(branch)) {
      throw new RepositoryPolicyError("path_denied", "Branch name is not a safe Git reference");
    }
    const uniquePaths = new Set(files.map((file) => file.path));
    const bytes = files.reduce(
      (total, file) => total + (isManifestEntry(file) ? file.bytes : Buffer.byteLength(file.content)),
      0,
    );
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
    const fileManifest = toManifestEntries(files);
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
    files: ReadonlyArray<PatchFile | ChangeManifestEntry>,
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
    // A sandbox backend commits the working tree it holds; the files argument
    // (manifest fingerprints) would be meaningless to it. Non-sandbox
    // backends keep receiving whole-file bodies, so fakes stay valid.
    const { commitSha } = supportsWorkingTreeCommit(this.backend)
      ? await this.backend.commitWorkingTree(
          owner,
          repo,
          manifest.branch,
          title,
          manifest.sourceSha,
        )
      : await this.backend.commitFiles(
          owner,
          repo,
          manifest.branch,
          title,
          manifest.sourceSha,
          files as PatchFile[],
        );
    const pull = await this.backend.openDraftPull(
      owner,
      repo,
      manifest.branch,
      manifest.baseBranch,
      title,
      body,
    );
    const receipt = PullRequestReceiptSchema.parse({
      url: pull.url,
      number: pull.number,
      draft: true,
      branch: manifest.branch,
      baseBranch: manifest.baseBranch,
      sourceSha: manifest.sourceSha,
      commitSha,
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
    const branchSha = await this.backend.branchHead(owner, repo, manifest.branch);
    if (branchSha === undefined) return undefined;
    const pulls = await this.backend.listOpenPulls(owner, repo, manifest.branch);
    const matching = pulls.find((value) =>
      value.draft && value.body.includes(`Patch hash: ${manifest.patchHash}`));
    if (matching === undefined) {
      throw new Error("Branch already exists without a matching idempotent Draft PR");
    }
    return PullRequestReceiptSchema.parse({
      url: matching.url,
      number: matching.number,
      draft: true,
      branch: manifest.branch,
      baseBranch: manifest.baseBranch,
      sourceSha: manifest.sourceSha,
      commitSha: branchSha,
      patchHash: manifest.patchHash,
      replayed: true,
    });
  }

  async checks(owner: string, repo: string, commitSha: string): Promise<CheckStatus> {
    this.reader.assertRepository(owner, repo, this.policy.baseBranch);
    const receipt = [...this.receipts.values()].find((value) => value.commitSha === commitSha);
    return this.backend.checkRuns(owner, repo, commitSha, receipt?.number);
  }
}

/**
 * NOTE: the former `RestGitHubBackend` (the hand-written GitHub REST sequence)
 * is retired. Every lane now runs on `McpClientGitHubBackend` (mcp.ts), the
 * single `GitHubBackend` implementation, so there is no parallel REST backend to
 * keep in sync. `FetchGitHubTransport` below survives only as the narrow seam
 * for the two operations the hosted GitHub MCP server exposes no tool for
 * (review commit-range `compare`, and any future raw read), not as a backend.
 */

export class GitHubRepositoryTools {
  readonly reader: GitHubSourceReader;
  readonly writer: GitHubWriter;

  constructor(backend: GitHubBackend, policy: GitHubPolicy) {
    this.reader = new GitHubSourceReader(backend, policy);
    this.writer = new GitHubWriter(backend, policy, this.reader);
  }
}

