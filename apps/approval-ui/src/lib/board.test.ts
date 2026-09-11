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
  it("maps common Jira statuses into the four console columns", () => {
    expect(columnForStatus("Blocked")).toBe("blocked");
    expect(columnForStatus("Selected for Development")).toBe("open");
    expect(columnForStatus("In Progress")).toBe("progress");
    expect(columnForStatus("Code Review")).toBe("review");
    expect(columnForStatus("Resolved")).toBe("review");
    expect(columnForStatus("Unknown custom status")).toBe("open");
  });

  it("groups and filters issues without mutating them", () => {
    const grouped = groupIssues(issues, "api");
    expect(grouped.progress.map((issue) => issue.key)).toEqual(["ENG-2"]);
    expect(grouped.open).toEqual([]);
    expect(grouped.blocked).toEqual([]);
    expect(grouped.review).toEqual([]);
    expect(issues).toHaveLength(3);
  });

  it("keeps finished work visible in the terminal review column", () => {
    const grouped = groupIssues(issues);
    expect(grouped.open.map((issue) => issue.key)).toEqual(["ENG-1"]);
    expect(grouped.review.map((issue) => issue.key)).toEqual(["ENG-3"]);
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
