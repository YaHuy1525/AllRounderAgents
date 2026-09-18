import type { IssueReader, IssueWriter } from "../../issues/tools/github-issues.js";

export { GitHubIssueReader as GitHubAccessibilityReader } from "../../issues/tools/github-issues.js";

/**
 * The accessibility lane reads route components through the same surfaces the
 * issues lane exposes: the reader provides the source SHA and allowlisted file
 * reads, and the coding writer opens the fix pull request. Renamed here so the
 * lane stays self-describing without duplicating transport logic.
 */
export type AccessibilityReader = Pick<IssueReader, "sourceSha" | "content">;
export type AccessibilityWriter = IssueWriter;
