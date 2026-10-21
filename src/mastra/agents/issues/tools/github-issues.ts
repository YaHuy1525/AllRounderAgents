import {
  GitHubSourceReader,
  RepositoryPolicyError,
  type GitHubBackend,
  type GitHubPolicy,
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

/**
 * GitHub read surface for the issues workflow: the coding lane's
 * `GitHubSourceReader` (source SHA + allowlisted file reads) plus a bounded
 * candidate-file listing so the analyst can cite real paths. Both the source
 * reads and the file listing go through the shared `GitHubBackend`, which the
 * coding lane runs on the GitHub MCP tools, so there is no per-lane REST here.
 * Every call is scoped by the same repository path policy the coding lane
 * enforces, so a listed path can always be read.
 */
export class GitHubIssueReader implements IssueReader {
  constructor(
    private readonly source: GitHubSourceReader,
    private readonly backend: GitHubBackend,
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
    const tree = await this.backend.listFiles(owner, repo, sourceSha);
    return tree
      .filter((path) => !path.split("/").some((segment) => VENDOR_SEGMENTS.has(segment)))
      .filter((path) => this.source.allowsPath(path))
      .slice(0, limit);
  }
}
