import type {
  IssueReader,
  IssueSourceFile,
  IssueWriter,
} from "../../issues/tools/github-issues.js";

export { GitHubIssueReader as GitHubFeatureReader } from "../../issues/tools/github-issues.js";

/**
 * The features lane reads and writes repositories through the same surfaces
 * the issues lane exposes: the issue reader already provides source SHAs,
 * allowlisted file reads, and the bounded tree listing the planner cites
 * paths from, and the coding writer opens the Draft PR. Renamed here so the
 * lane stays self-describing without duplicating transport logic.
 */
export type FeatureReader = IssueReader;
export type FeatureSourceFile = IssueSourceFile;
export type FeatureWriter = IssueWriter;
