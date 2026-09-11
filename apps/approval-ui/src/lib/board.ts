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
};

export type BoardColumnId = "blocked" | "open" | "progress" | "review";

export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardColumnId; label: string }> = [
  { id: "blocked", label: "Blocked" },
  { id: "open", label: "Open" },
  { id: "progress", label: "In Progress" },
  { id: "review", label: "Review" },
];

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
