import {
  GitHubSourceReader,
  RepositoryPolicyError,
  type GitHubPolicy,
  type GitHubTransport,
  type GitHubWriter,
} from "../../programming/tools/github.js";

/** One source file read for the analysis/implementation steps. */
export interface IssueSourceFile {
  readonly path: string;
  readonly content: string;
}

/** Read surface the issues flow needs (fake-friendly structural interface). */
export interface IssueReader {
  sourceSha(owner: string, repo: string, baseBranch: string): Promise<string>;
  content(
    owner: string,
    repo: string,
    path: string,
    sourceSha: string,
  ): Promise<{ content: string; sha: string }>;
  listFiles(owner: string, repo: string, sourceSha: string, limit: number): Promise<string[]>;
  /** True when the repository path policy allows this lane to read `path`. */
  allowsPath(path: string): boolean;
}

/** Write surface reused verbatim from the coding lane. */
export type IssueWriter = Pick<GitHubWriter, "preflight" | "apply">;

/** Directories that never contain the fix the analyst should cite. */
const VENDOR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "vendor",
  "coverage",
  ".git",
  ".next",
  "__pycache__",
]);

function bodyObject(response: { status: number; body: unknown }): Record<string, unknown> {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    typeof response.body !== "object" ||
    response.body === null ||
    Array.isArray(response.body)
  ) {
    throw new Error(`GitHub request failed (${response.status})`);
  }
  return response.body as Record<string, unknown>;
}

/**
 * GitHub REST read surface for the issues workflow: the coding lane's
 * `GitHubSourceReader` (source SHA + allowlisted file reads) plus a bounded
 * recursive tree listing so the analyst can cite real paths. Every call is
 * scoped by the same repository path policy the coding lane enforces, so a
 * listed path can always be read.
 */
export class GitHubIssueReader implements IssueReader {
  constructor(
    private readonly source: GitHubSourceReader,
    private readonly transport: GitHubTransport,
    private readonly policy: GitHubPolicy,
  ) {}

  sourceSha(owner: string, repo: string, baseBranch: string): Promise<string> {
    return this.source.sourceSha(owner, repo, baseBranch);
  }

  content(
    owner: string,
    repo: string,
    path: string,
    sourceSha: string,
  ): Promise<{ content: string; sha: string }> {
    return this.source.content(owner, repo, path, sourceSha);
  }

  allowsPath(path: string): boolean {
    return this.source.allowsPath(path);
  }

  async listFiles(
    owner: string,
    repo: string,
    sourceSha: string,
    limit: number,
  ): Promise<string[]> {
    if (!this.policy.repositories.includes(`${owner}/${repo}`)) {
      throw new RepositoryPolicyError("repository_denied", "Repository not allowed");
    }
    const response = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/git/trees/${sourceSha}?recursive=1`,
      undefined,
      this.policy.timeoutMs,
    );
    const body = bodyObject(response);
    const tree = Array.isArray(body.tree) ? body.tree : [];
    return tree
      .filter(
        (item): item is { type: string; path: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as { type?: unknown }).type === "blob" &&
          typeof (item as { path?: unknown }).path === "string",
      )
      .map((item) => item.path)
      .filter((path) => !path.split("/").some((segment) => VENDOR_SEGMENTS.has(segment)))
      .filter((path) => this.source.allowsPath(path))
      .slice(0, limit);
  }
}
