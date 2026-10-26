import { describe, expect, it } from "vitest";

import {
  commandTarget,
  emptySearchResponse,
  mergeSearchHits,
  parseSearchResponse,
  searchQueryString,
  ticketHits,
  type SearchHit,
} from "@/lib/search";

function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    kind: "run",
    id: "run-1",
    title: "PR Review - ABC-1",
    subtitle: "awaiting_human",
    snippet: "",
    runId: "run-1",
    workflow: "review",
    ticketKey: "ABC-1",
    stepId: "select-pr",
    stepTitle: "Select PR",
    status: "awaiting_human",
    reason: null,
    logLine: null,
    receipt: null,
    ...overrides,
  };
}

describe("search payload parsing", () => {
  it("validates a full response and drops malformed rows", () => {
    const parsed = parseSearchResponse({
      query: "which tickets wait on me?",
      intent: "list",
      scope: "awaiting",
      results: [
        {
          kind: "run",
          id: "run-1",
          title: "PR Review - ABC-1",
          subtitle: "awaiting_human · step select-pr",
          snippet: "Waiting for a decision",
          runId: "run-1",
          workflow: "review",
          ticketKey: "ABC-1",
          stepId: "select-pr",
          status: "awaiting_human",
        },
        { kind: "nonsense", id: "x" },
        "not an object",
      ],
      kb: [
        { sourceId: "policy.md", span: "1:5", text: "Leave policy", score: 0.5, stale: true },
        { text: "missing source" },
      ],
      kbDegraded: false,
      counts: { runs: 1, approvals: 0, kb: 1 },
    });
    expect(parsed.intent).toBe("list");
    expect(parsed.scope).toBe("awaiting");
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]!.stepId).toBe("select-pr");
    expect(parsed.results[0]!.reason).toBeNull();
    expect(parsed.kb).toHaveLength(1);
    expect(parsed.kb[0]!.stale).toBe(true);
    expect(parsed.counts.runs).toBe(1);
  });

  it("falls back to an empty envelope on junk input", () => {
    const parsed = parseSearchResponse("garbage");
    expect(parsed).toEqual(emptySearchResponse(""));
    expect(parseSearchResponse(null).results).toEqual([]);
  });

  it("encodes the query string safely", () => {
    expect(searchQueryString("why is PR 77 blocked?")).toBe("q=why+is+PR+77+blocked%3F");
  });
});

describe("local ticket matches", () => {
  const tickets = [
    { key: "ENG-9", summary: "Crash on Apple login" },
    { key: "ENG-10", summary: "Billing summary totals" },
  ];

  it("matches every token against key + summary", () => {
    const hits = ticketHits("apple login", tickets);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ticketKey).toBe("ENG-9");
    expect(hits[0]!.kind).toBe("ticket");
  });

  it("returns nothing for an empty query", () => {
    expect(ticketHits("   ", tickets)).toEqual([]);
  });

  it("merges server hits first and deduplicates by kind:id", () => {
    const server = [hit({ id: "run-1" })];
    const local = ticketHits("eng-9", tickets);
    const merged = mergeSearchHits(server, local);
    expect(merged.map((row) => row.id)).toEqual(["run-1", "ENG-9"]);
    const deduped = mergeSearchHits(server, [hit({ id: "run-1", title: "dup" })]);
    expect(deduped).toHaveLength(1);
  });
});

describe("command targets are navigation only", () => {
  it("prefers ticket + step, then run, then bare ticket", () => {
    expect(commandTarget(hit({}))).toEqual({
      kind: "ticket",
      ticketKey: "ABC-1",
      stepId: "select-pr",
    });
    expect(commandTarget(hit({ stepId: null }))).toEqual({
      kind: "run",
      runId: "run-1",
      ticketKey: "ABC-1",
      stepId: null,
    });
    expect(commandTarget(hit({ stepId: null, runId: null }))).toEqual({
      kind: "ticket",
      ticketKey: "ABC-1",
      stepId: null,
    });
  });

  it("keeps the step on run targets that carry no ticket", () => {
    expect(commandTarget(hit({ ticketKey: null }))).toEqual({
      kind: "run",
      runId: "run-1",
      ticketKey: null,
      stepId: "select-pr",
    });
  });

  it("falls back to the approvals panel for bare approvals", () => {
    expect(
      commandTarget(
        hit({ kind: "approval", runId: null, ticketKey: null, stepId: null }),
      ),
    ).toEqual({ kind: "approvals" });
    expect(commandTarget(hit({ kind: "receipt", runId: null, ticketKey: null, stepId: null }))).toBeNull();
  });
});
