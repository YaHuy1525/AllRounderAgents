export type JiraIssue = {
  key: string;
  project: string;
  summary: string;
  issue_type: string;
  priority: string;
  status: string;
  assignee: string | null;
  labels: string[];
  updated: string;
  browse_url: string;
  /**
   * Raw Atlassian Document Format body from Jira. The console converts it to
   * markdown with mdast-util-from-adf and renders it through the shared
   * Markdown component. Absent for synthetic (describe-started) issues.
   */
  description_adf?: Record<string, unknown>;
};

export type BoardColumnId = "blocked" | "open" | "progress" | "review";

export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardColumnId; label: string }> = [
  { id: "blocked", label: "Blocked" },
  { id: "open", label: "Open" },
  { id: "progress", label: "In Progress" },
  { id: "review", label: "Review" },
];

/** Board card ordering, chosen in the filter row and sticky via UiPrefs (U9). */
export type BoardSort = "updated" | "priority" | "key";

export const BOARD_SORTS: ReadonlyArray<{ id: BoardSort; label: string }> = [
  { id: "updated", label: "Updated" },
  { id: "priority", label: "Priority" },
  { id: "key", label: "Key" },
];

export const DEFAULT_BOARD_SORT: BoardSort = "updated";

export function safeBrowseUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "#";
  } catch {
    return "#";
  }
}

export function isCompletedStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return ["done", "closed", "resolved", "complete"].some((token) => normalized.includes(token));
}

export function columnForStatus(status: string): BoardColumnId {
  const normalized = status.trim().toLowerCase();
  if (normalized.includes("block")) return "blocked";
  if (normalized.includes("review")) return "review";
  if (
    normalized.includes("progress") ||
    normalized.includes("doing") ||
    normalized.includes("in development")
  ) {
    return "progress";
  }
  // The four-column sprint board keeps finished work visible in the terminal
  // column instead of dropping it from the board entirely.
  if (isCompletedStatus(normalized)) return "review";
  return "open";
}

export function groupIssues(
  issues: JiraIssue[],
  query = "",
): Record<BoardColumnId, JiraIssue[]> {
  const groups: Record<BoardColumnId, JiraIssue[]> = {
    blocked: [],
    open: [],
    progress: [],
    review: [],
  };
  const needle = query.trim().toLowerCase();
  for (const issue of issues) {
    const searchable = `${issue.key} ${issue.summary} ${issue.issue_type} ${issue.labels.join(" ")}`
      .toLowerCase();
    if (needle && !searchable.includes(needle)) continue;
    groups[columnForStatus(issue.status)].push(issue);
  }
  return groups;
}

/** Jira priority schemes vary; the rank map folds both common vocabularies. */
const PRIORITY_RANK: Record<string, number> = {
  blocker: 0,
  critical: 0,
  highest: 0,
  urgent: 0,
  high: 1,
  major: 1,
  medium: 2,
  normal: 2,
  low: 3,
  minor: 3,
  lowest: 4,
  trivial: 4,
};

const UNRANKED_PRIORITY = 5;

function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority.trim().toLowerCase()] ?? UNRANKED_PRIORITY;
}

/** Unparseable Jira clocks sink to the bottom instead of poisoning the sort. */
function updatedClock(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareUpdated(left: JiraIssue, right: JiraIssue): number {
  const a = updatedClock(left.updated);
  const b = updatedClock(right.updated);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** "ENG-10" walks after "ENG-2" by splitting off the trailing number. */
function keyParts(key: string): { head: string; tail: number | null } {
  const clean = key.trim().toUpperCase();
  const match = /^(.*?)(\d+)$/.exec(clean);
  if (match === null) return { head: clean, tail: null };
  return { head: match[1] ?? "", tail: Number(match[2]) };
}

function compareKeys(left: string, right: string): number {
  const a = keyParts(left);
  const b = keyParts(right);
  const head = a.head.localeCompare(b.head);
  if (head !== 0) return head;
  if (a.tail !== null && b.tail !== null && a.tail !== b.tail) return a.tail - b.tail;
  if (a.tail === null && b.tail !== null) return 1;
  if (a.tail !== null && b.tail === null) return -1;
  return left.localeCompare(right);
}

/**
 * Order the board's cards inside their columns: "updated" keeps the newest
 * activity first (the Jira search default), "priority" ranks highest first
 * and breaks ties by recency, "key" walks the natural key order. The input
 * array is never mutated.
 */
export function sortIssues(issues: JiraIssue[], sort: BoardSort): JiraIssue[] {
  const copy = [...issues];
  if (sort === "priority") {
    return copy.sort(
      (left, right) =>
        priorityRank(left.priority) - priorityRank(right.priority) || compareUpdated(left, right),
    );
  }
  if (sort === "key") return copy.sort((left, right) => compareKeys(left.key, right.key));
  return copy.sort(compareUpdated);
}

/** Narrow arbitrary stored values to a board sort; anything else is the default. */
export function sanitizeBoardSort(value: unknown): BoardSort {
  return value === "priority" || value === "key" || value === "updated"
    ? value
    : DEFAULT_BOARD_SORT;
}

export function ticketFacts(issue: JiraIssue): Array<{ label: string; value: string }> {
  return [
    { label: "Key", value: issue.key },
    { label: "Summary", value: issue.summary },
    { label: "Status", value: issue.status },
    { label: "Type", value: issue.issue_type },
    { label: "Priority", value: issue.priority },
    { label: "Assignee", value: issue.assignee ?? "Unassigned" },
    { label: "Labels", value: issue.labels.length > 0 ? issue.labels.join(", ") : "None" },
    { label: "Updated", value: issue.updated },
    { label: "Project", value: issue.project },
  ];
}

export function compactTickets(
  items: JiraIssue[],
  limit = 40,
): Array<Pick<JiraIssue, "key" | "summary" | "status" | "issue_type" | "priority" | "assignee" | "labels">> {
  return items.slice(0, limit).map((issue) => ({
    key: issue.key,
    summary: issue.summary.slice(0, 240),
    status: issue.status,
    issue_type: issue.issue_type,
    priority: issue.priority,
    assignee: issue.assignee,
    labels: issue.labels.slice(0, 8),
  }));
}

export function boardStats(issues: JiraIssue[]): {
  total: number;
  progress: number;
  active: number;
} {
  const completed = issues.filter((issue) => isCompletedStatus(issue.status)).length;
  const inProgress = issues.filter((issue) => columnForStatus(issue.status) === "progress").length;
  return {
    total: issues.length,
    progress: issues.length === 0 ? 0 : Math.round((completed / issues.length) * 100),
    active: inProgress,
  };
}
