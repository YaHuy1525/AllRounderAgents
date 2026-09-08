import { describe, expect, it } from "vitest";

import {
  boardStats,
  columnForStatus,
  compactTickets,
  groupIssues,
  safeBrowseUrl,
  ticketFacts,
  type JiraIssue,
} from "./board.js";

const issues: JiraIssue[] = [
  {
    key: "ENG-1",
    project: "ENG",
    summary: "Build board",
    issue_type: "Story",
    priority: "High",
    status: "To Do",
    assignee: null,
    labels: ["ui"],
    updated: "2026-09-07T00:00:00Z",
    browse_url: "https://example.atlassian.net/browse/ENG-1",
  },
  {
    key: "ENG-2",
    project: "ENG",
    summary: "Fix API",
    issue_type: "Bug",
    priority: "Medium",
    status: "In Progress",
    assignee: "Alex",
    labels: ["api"],
    updated: "2026-09-07T00:00:00Z",
    browse_url: "https://example.atlassian.net/browse/ENG-2",
  },
  {
    key: "ENG-3",
    project: "ENG",
    summary: "Ship",
    issue_type: "Task",
    priority: "Low",
    status: "Done",
    assignee: "Sam",
    labels: [],
    updated: "2026-09-07T00:00:00Z",
    browse_url: "https://example.atlassian.net/browse/ENG-3",
  },
];

describe("Jira board model", () => {
  it("maps common Jira statuses into stable columns", () => {
    expect(columnForStatus("Selected for Development")).toBe("ready");
    expect(columnForStatus("Code Review")).toBe("progress");
    expect(columnForStatus("Resolved")).toBe("done");
    expect(columnForStatus("Unknown custom status")).toBe("backlog");
  });

  it("groups and filters issues without mutating them", () => {
    const grouped = groupIssues(issues, "api");
    expect(grouped.progress.map((issue) => issue.key)).toEqual(["ENG-2"]);
    expect(grouped.todo).toEqual([]);
    expect(issues).toHaveLength(3);
  });

  it("computes board summary metrics", () => {
    expect(boardStats(issues)).toEqual({ total: 3, progress: 33, active: 1 });
    expect(boardStats([])).toEqual({ total: 0, progress: 0, active: 0 });
  });

  it("exposes ticket facts for the detail window", () => {
    expect(ticketFacts(issues[1]!).map((item) => item.label)).toContain("Assignee");
    expect(ticketFacts(issues[1]!).find((item) => item.label === "Assignee")?.value).toBe("Alex");
    expect(compactTickets(issues, 1)).toEqual([
      {
        key: "ENG-1",
        summary: "Build board",
        status: "To Do",
        issue_type: "Story",
        priority: "High",
        assignee: null,
        labels: ["ui"],
      },
    ]);
  });

  it("allows only HTTPS Jira browse links", () => {
    expect(safeBrowseUrl("https://example.atlassian.net/browse/ENG-1")).toContain(
      "https://example.atlassian.net/",
    );
    expect(safeBrowseUrl("javascript:alert(1)")).toBe("#");
    expect(safeBrowseUrl("not a URL")).toBe("#");
  });
});
