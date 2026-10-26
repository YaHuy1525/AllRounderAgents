import { describe, expect, it } from "vitest";

import {
  BOARD_SORTS,
  boardStats,
  columnForStatus,
  compactTickets,
  DEFAULT_BOARD_SORT,
  groupIssues,
  safeBrowseUrl,
  sanitizeBoardSort,
  sortIssues,
  ticketFacts,
  type JiraIssue,
} from "@/lib/board";

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

describe("board sorting (U9)", () => {
  const kit = (key: string, overrides: Partial<JiraIssue> = {}): JiraIssue => ({
    key,
    project: key.split("-")[0] ?? "ENG",
    summary: `Summary for ${key}`,
    issue_type: "Task",
    priority: "Medium",
    status: "To Do",
    assignee: null,
    labels: [],
    updated: "2026-09-07T00:00:00Z",
    browse_url: `https://example.atlassian.net/browse/${key}`,
    ...overrides,
  });

  it("orders the newest update first and sinks unparseable clocks", () => {
    const older = kit("ENG-1", { updated: "2026-09-01T00:00:00Z" });
    const newer = kit("ENG-2", { updated: "2026-09-12T00:00:00Z" });
    const broken = kit("ENG-3", { updated: "not-a-date" });
    const input = [older, broken, newer];
    expect(sortIssues(input, "updated").map((issue) => issue.key)).toEqual([
      "ENG-2",
      "ENG-1",
      "ENG-3",
    ]);
    // The input array keeps its order — sorting never mutates it.
    expect(input.map((issue) => issue.key)).toEqual(["ENG-1", "ENG-3", "ENG-2"]);
  });

  it("ranks priorities highest first and breaks ties by recency", () => {
    const low = kit("ENG-1", { priority: "Low" });
    const top = kit("ENG-2", { priority: "Highest" });
    const midOld = kit("ENG-3", { priority: "Medium", updated: "2026-09-01T00:00:00Z" });
    const midNew = kit("ENG-4", { priority: "Medium", updated: "2026-09-10T00:00:00Z" });
    const unknown = kit("ENG-5", { priority: "Seasonal" });
    expect(
      sortIssues([low, top, midOld, unknown, midNew], "priority").map((issue) => issue.key),
    ).toEqual(["ENG-2", "ENG-4", "ENG-3", "ENG-1", "ENG-5"]);
  });

  it("walks keys in natural order so ENG-2 precedes ENG-10", () => {
    const ten = kit("ENG-10");
    const two = kit("ENG-2");
    const other = kit("OPS-1");
    expect(sortIssues([other, ten, two], "key").map((issue) => issue.key)).toEqual([
      "ENG-2",
      "ENG-10",
      "OPS-1",
    ]);
  });

  it("narrows stored sort choices to the known set", () => {
    expect(BOARD_SORTS.map((option) => option.id)).toEqual(["updated", "priority", "key"]);
    expect(sanitizeBoardSort("priority")).toBe("priority");
    expect(sanitizeBoardSort("key")).toBe("key");
    expect(sanitizeBoardSort("updated")).toBe("updated");
    expect(sanitizeBoardSort("size")).toBe(DEFAULT_BOARD_SORT);
    expect(sanitizeBoardSort(undefined)).toBe(DEFAULT_BOARD_SORT);
  });
});
