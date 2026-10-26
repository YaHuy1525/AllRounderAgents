import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CommandBar,
  CommandResults,
  SAVED_QUERIES,
  moveCommandCursor,
  type CommandRow,
  type CommandStatus,
} from "@/components/console/CommandBar";
import type { SearchHit, SearchResponse } from "@/lib/search";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    kind: "run",
    id: "run-1",
    title: "PR Review - ABC-1",
    subtitle: "blocked · step select-pr",
    snippet: "",
    runId: "run-1",
    workflow: "review",
    ticketKey: "ABC-1",
    stepId: "select-pr",
    stepTitle: "Select PR",
    status: "blocked",
    reason: null,
    logLine: null,
    receipt: null,
    ...overrides,
  };
}

function ready(hitItem: SearchHit, extra: Partial<SearchResponse> = {}): CommandStatus {
  const response: SearchResponse = {
    query: "why is PR 77 blocked?",
    intent: "why",
    scope: null,
    results: [hitItem],
    kb: [],
    kbDegraded: false,
    counts: { runs: 1, approvals: 0, kb: 0 },
    ...extra,
  };
  return { kind: "ready", response };
}

function renderResults(
  status: CommandStatus,
  rows: CommandRow[],
  query = "why is PR 77 blocked?",
): string {
  return renderToString(
    <CommandResults
      query={query}
      status={status}
      rows={rows}
      cursor={0}
      onActivate={() => {}}
      onHover={() => {}}
    />,
  );
}

describe("command bar results", () => {
  it("renders a blocked run as a step deep link with reason and log line", () => {
    const blocked = hit({
      status: "blocked",
      reason: "Step select-pr is held by run-2 (lock acme/app#77)",
      logLine: "run.suspended | stepId=select-pr | stepState=blocked | seq=3",
    });
    const html = renderResults(ready(blocked), [
      { kind: "hit", key: "run:run-1", hit: blocked },
    ]);
    expect(html).toContain("PR Review - ABC-1");
    expect(html).toContain("step select-pr");
    expect(html).toContain("held by run-2");
    expect(html).toContain("stepState=blocked");
    expect(html).toContain("Run");
  });

  it("renders knowledge passages with source, span, and the stale flag", () => {
    const searchHit = hit({ reason: null });
    const html = renderResults(
      ready(searchHit, {
        kb: [
          {
            sourceId: "hr_policy/remote-work.md",
            span: "12:18",
            title: "Remote work policy",
            text: "Remote work is capped at three days per week.",
            score: 0.42,
            stale: true,
            domain: "hr",
          },
        ],
        kbDegraded: false,
        counts: { runs: 1, approvals: 0, kb: 1 },
      }),
      [{ kind: "hit", key: "run:run-1", hit: searchHit }],
    );
    expect(html).toContain("Remote work policy");
    expect(html).toContain("12:18");
    expect(html).toContain("stale");
    expect(html).toContain("three days per week");
  });

  it("keeps the empty query as saved plus recent suggestions", () => {
    const rows: CommandRow[] = [
      { kind: "suggestion", key: "recent:what is overdue?", query: "what is overdue?" },
    ];
    const html = renderResults({ kind: "idle" }, rows, "");
    expect(html).toContain("Saved");
    expect(html).toContain("Recent");
    expect(html).toContain(SAVED_QUERIES[0]!);
    expect(html).toContain("what is overdue?");
    expect(html).toContain("Saved query");
    expect(html).toContain("Recent query");
  });

  it("renders loading, error, and no-match states", () => {
    expect(renderResults({ kind: "loading" }, [])).toContain("Searching");
    expect(renderResults({ kind: "error" }, [])).toContain("unavailable");
    const noMatch = hit({ runId: null, ticketKey: null, stepId: null });
    const html = renderResults(ready(noMatch, { results: [] }), []);
    expect(html).toContain("No matches for");
  });

  it("never renders decision controls — navigation only", () => {
    const gate = hit({
      kind: "approval",
      id: "appr-1",
      title: "Approval · hr-help",
      reason: "Waiting for a decision",
      logLine: "run.suspended | stepId=approve | stepState=awaiting | seq=4",
    });
    const pages = [
      renderResults(ready(gate), [{ kind: "hit", key: "approval:appr-1", hit: gate }]),
      renderResults({ kind: "error" }, []),
      renderResults({ kind: "idle" }, [{ kind: "suggestion", key: "recent:q", query: "q" }], ""),
    ];
    for (const html of pages) {
      expect(html).not.toContain("Approve");
      expect(html).not.toContain("Reject");
      expect(html).not.toContain("Proceed");
      expect(html).not.toContain("gate-actions");
    }
  });
});

describe("command bar shell", () => {
  it("renders the input, saved queries, and the navigation-only note", () => {
    const html = renderToString(
      <CommandBar
        open
        tickets={[{ key: "ENG-9", summary: "Crash on Apple login" }]}
        recent={["what is overdue?"]}
        onClose={() => {}}
        onRemember={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect(html).toContain("command-input");
    expect(html).toContain("Search everything");
    expect(html).toContain(SAVED_QUERIES[0]!);
    expect(html).toContain("Navigation only");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Reject");
  });

  it("renders nothing while closed", () => {
    const html = renderToString(
      <CommandBar
        open={false}
        tickets={[]}
        recent={[]}
        onClose={() => {}}
        onRemember={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});

describe("command cursor movement", () => {
  it("moves and clamps within the row list", () => {
    expect(moveCommandCursor(0, 3, 1)).toBe(1);
    expect(moveCommandCursor(2, 3, 1)).toBe(2);
    expect(moveCommandCursor(0, 3, -1)).toBe(0);
    expect(moveCommandCursor(-1, 3, 1)).toBe(0);
    expect(moveCommandCursor(-1, 3, -1)).toBe(2);
    expect(moveCommandCursor(0, 0, 1)).toBe(0);
  });
});
