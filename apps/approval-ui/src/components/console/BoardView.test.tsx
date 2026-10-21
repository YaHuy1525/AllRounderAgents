import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BoardView } from "@/components/console/BoardView";
import type { JiraIssue } from "@/lib/board";

type BoardProps = Parameters<typeof BoardView>[0];

function makeIssue(key: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    project: "ENG",
    summary: `Summary for ${key}`,
    issue_type: "Task",
    priority: "Medium",
    status: "To Do",
    assignee: null,
    labels: [],
    updated: "2026-09-07T00:00:00Z",
    browse_url: `https://example.atlassian.net/browse/${key}`,
    ...overrides,
  };
}

/** The two cards share the "To Do" column so their order proves the sort. */
const OLDER = makeIssue("ENG-2", { updated: "2026-09-01T00:00:00Z" });
const NEWER = makeIssue("ENG-9", { updated: "2026-09-12T00:00:00Z" });

function renderBoard(overrides: Partial<BoardProps> = {}): string {
  const props: BoardProps = {
    prefs: { email: "", project: "ENG", boardId: 7, boardName: "ENG board" },
    issues: [OLDER, NEWER],
    boardTitle: "ENG board · ENG",
    status: "2 tickets fetched from Jira",
    lastSync: "09:30",
    refreshing: false,
    search: "",
    sort: "updated",
    onSearchChange: () => {},
    onSortChange: () => {},
    onRefresh: () => {},
    onOpenDetails: () => {},
    ...overrides,
  };
  return renderToString(<BoardView {...props} />);
}

/** SSR attribute order varies, so match the option tag on both attributes. */
function optionSelected(html: string, value: string): boolean {
  return new RegExp(`<option(?=[^>]* value="${value}")(?=[^>]* selected)[^>]*>`).test(html);
}

describe("board sort control (U9)", () => {
  it("renders the sort picker with every board order", () => {
    const html = renderBoard();
    expect(html).toContain('id="board-sort"');
    expect(html).toContain("Sort");
    expect(html).toContain(">Updated</option>");
    expect(html).toContain(">Priority</option>");
    expect(html).toContain(">Key</option>");
  });

  it("marks the persisted order as the selected option", () => {
    expect(optionSelected(renderBoard({ sort: "priority" }), "priority")).toBe(true);
    expect(optionSelected(renderBoard({ sort: "priority" }), "updated")).toBe(false);
  });

  it("orders the cards by recency when updated is chosen", () => {
    const html = renderBoard({ sort: "updated" });
    expect(html.indexOf("ENG-9")).toBeLessThan(html.indexOf("ENG-2"));
  });

  it("orders the cards naturally when key is chosen", () => {
    const html = renderBoard({ sort: "key" });
    expect(html.indexOf("ENG-2")).toBeLessThan(html.indexOf("ENG-9"));
  });
});
