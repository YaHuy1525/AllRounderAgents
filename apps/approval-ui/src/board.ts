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

export type BoardColumnId = "backlog" | "todo" | "ready" | "progress" | "done";

export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardColumnId; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "To Do" },
  { id: "ready", label: "Ready for Dev" },
  { id: "progress", label: "In Progress" },
  { id: "done", label: "Done" },
];

export function safeBrowseUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "#";
  } catch {
    return "#";
  }
}

export function columnForStatus(status: string): BoardColumnId {
  const normalized = status.trim().toLowerCase();
  if (normalized.includes("done") || normalized.includes("closed") || normalized.includes("resolved")) {
    return "done";
  }
  if (normalized.includes("progress") || normalized.includes("review")) return "progress";
  if (normalized.includes("ready") || normalized.includes("selected")) return "ready";
  if (normalized === "to do" || normalized === "todo" || normalized.includes("open")) return "todo";
  return "backlog";
}

export function groupIssues(
  issues: JiraIssue[],
  query = "",
): Record<BoardColumnId, JiraIssue[]> {
  const groups: Record<BoardColumnId, JiraIssue[]> = {
    backlog: [],
    todo: [],
    ready: [],
    progress: [],
    done: [],
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
  const completed = issues.filter((issue) => columnForStatus(issue.status) === "done").length;
  const inProgress = issues.filter((issue) => columnForStatus(issue.status) === "progress").length;
  return {
    total: issues.length,
    progress: issues.length === 0 ? 0 : Math.round((completed / issues.length) * 100),
    active: inProgress,
  };
}
