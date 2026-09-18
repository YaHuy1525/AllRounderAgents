import type { IssueReader, IssueWriter } from "../../issues/tools/github-issues.js";

export { GitHubIssueReader as GitHubDependencyReader } from "../../issues/tools/github-issues.js";

/**
 * The dependencies lane reads manifests through the same surfaces the issues
 * lane exposes: the reader provides the source SHA and allowlisted file reads
 * (manifest + lockfile), and the coding writer opens the bump PRs. Renamed
 * here so the lane stays self-describing without duplicating transport logic.
 */
export type DependencyReader = Pick<IssueReader, "sourceSha" | "content">;
export type DependencyWriter = IssueWriter;
