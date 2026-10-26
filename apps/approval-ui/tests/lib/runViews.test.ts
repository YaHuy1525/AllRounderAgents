import { describe, expect, it } from "vitest";

import {
  LOG_FILTERS,
  filterRunEvents,
  mergeTimeline,
  receiptFlags,
  runSpendLine,
  stepLineage,
} from "@/lib/runViews";
import type { CaseEvent } from "@/lib/cases";
import type { RunEvent, RunStep, RunStepState } from "@/lib/runs";

function makeEvent(type: string, sequence: number): RunEvent {
  return { runId: "run-1", sequence, type };
}

function makeCaseEvent(kind: string, createdAt: string): CaseEvent {
  return { actor: "agent-1", kind, payload: {}, created_at: createdAt };
}

function makeTimelineStep(
  stepId: string,
  state: RunStepState,
  updatedAt: string,
  extra: Partial<Pick<RunStep, "decision" | "artifact">> = {},
) {
  return { stepId, title: stepId, state, updatedAt, ...extra };
}

describe("log filters", () => {
  const events = [
    makeEvent("run.created", 1),
    makeEvent("run.suspended", 2),
    makeEvent("run.decision", 3),
    makeEvent("run.locked", 4),
    makeEvent("run.unlocked", 5),
    makeEvent("run.status", 6),
    makeEvent("run.closed", 7),
  ];

  it("exposes one chip per facet in a stable order", () => {
    expect(LOG_FILTERS.map((filter) => filter.id)).toEqual([
      "all",
      "lifecycle",
      "decisions",
      "locks",
    ]);
  });

  it("keeps the full stream for the all chip without aliasing it", () => {
    const kept = filterRunEvents(events, "all");
    expect(kept).toEqual(events);
    expect(kept).not.toBe(events);
  });

  it("splits lifecycle, decisions, and locks into their chips", () => {
    expect(filterRunEvents(events, "lifecycle").map((event) => event.type)).toEqual([
      "run.created",
      "run.suspended",
      "run.status",
      "run.closed",
    ]);
    expect(filterRunEvents(events, "decisions").map((event) => event.type)).toEqual([
      "run.decision",
    ]);
    expect(filterRunEvents(events, "locks").map((event) => event.type)).toEqual([
      "run.locked",
      "run.unlocked",
    ]);
  });
});

describe("step lineage", () => {
  it("lights the artifact → decision → receipt trail", () => {
    const full = stepLineage({
      artifact: { summary: "ok" },
      decision: { action: "proceed" },
      receipt: "rcpt-1",
    });
    expect(full).toEqual([
      { id: "artifact", label: "Artifact", on: true },
      { id: "decision", label: "Decision", on: true },
      { id: "receipt", label: "Receipt", on: true },
    ]);
  });

  it("keeps the chips off until the evidence exists", () => {
    const empty = stepLineage({ artifact: null, decision: null, receipt: null });
    expect(empty.map((link) => link.on)).toEqual([false, false, false]);
  });
});

describe("receipt flags", () => {
  it("flags only the steps with a signed receipt", () => {
    const flags = receiptFlags([
      { stepId: "select-pr", receipt: "rcpt-1" },
      { stepId: "ai-review", receipt: null },
    ]);
    expect(flags).toEqual({ "select-pr": true });
  });
});

describe("mergeTimeline", () => {
  it("interleaves case events with run milestones and touched steps", () => {
    const entries = mergeTimeline({
      caseEvents: [
        makeCaseEvent("run_started", "2026-09-12T10:00:30Z"),
        makeCaseEvent("decision_recorded", "2026-09-12T10:02:00Z"),
      ],
      runs: [
        {
          workflow: "review",
          status: "awaiting_human",
          startedAt: "2026-09-12T10:00:00Z",
          finishedAt: null,
          steps: [
            makeTimelineStep("select-pr", "done", "2026-09-12T10:01:00Z"),
            makeTimelineStep("ai-review", "pending", "2026-09-12T10:00:00Z"),
            makeTimelineStep("complete", "awaiting_human", "2026-09-12T10:03:00Z"),
          ],
        },
      ],
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "run:started",
      "case:0",
      "step:select-pr",
      "case:1",
      "step:complete",
    ]);
    expect(entries[0]).toMatchObject({
      kind: "run",
      title: "Run started",
      detail: "review",
      href: null,
    });
    expect(entries[1]).toMatchObject({ kind: "case", title: "run started" });
    expect(entries[4]).toMatchObject({ kind: "step", detail: "awaiting_human" });
  });

  it("appends the finish milestone and drops unparseable timestamps", () => {
    const entries = mergeTimeline({
      caseEvents: [makeCaseEvent("closed", "")],
      runs: [
        {
          workflow: "review",
          status: "completed",
          startedAt: "2026-09-12T10:00:00Z",
          finishedAt: "2026-09-12T10:04:00Z",
          steps: [makeTimelineStep("select-pr", "done", "not-a-date")],
        },
      ],
    });
    expect(entries.map((entry) => entry.id)).toEqual(["run:started", "run:finished"]);
    expect(entries[1]).toMatchObject({ title: "Run finished", detail: "completed" });
  });

  it("keeps case events alone when no run is loaded", () => {
    const entries = mergeTimeline({
      caseEvents: [makeCaseEvent("note_added", "2026-09-12T10:00:00Z")],
      runs: [],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("case");
  });

  it("sorts across mixed ISO offsets by instant, not string order", () => {
    const entries = mergeTimeline({
      caseEvents: [makeCaseEvent("late", "2026-09-12T12:00:01+02:00")],
      runs: [
        {
          workflow: "review",
          status: "running",
          startedAt: "2026-09-12T10:00:00Z",
          finishedAt: null,
          steps: [],
        },
      ],
    });
    // 12:00:01+02:00 is 10:00:01Z — after the 10:00:00Z start.
    expect(entries.map((entry) => entry.id)).toEqual(["run:started", "case:0"]);
  });

  it("scopes row ids and labels the start row when a ticket merges runs", () => {
    const entries = mergeTimeline({
      caseEvents: [],
      runs: [
        {
          runId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workflow: "review",
          status: "awaiting_human",
          startedAt: "2026-09-12T10:00:00Z",
          finishedAt: null,
          steps: [makeTimelineStep("select-pr", "done", "2026-09-12T10:01:00Z")],
        },
        {
          runId: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          workflow: "issues",
          status: "completed",
          startedAt: "2026-09-12T10:05:00Z",
          finishedAt: "2026-09-12T10:09:00Z",
          steps: [],
        },
      ],
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "run:11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa:started",
      "step:11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa:select-pr",
      "run:22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb:started",
      "run:22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb:finished",
    ]);
    expect(entries[0]).toMatchObject({ title: "Run started", detail: "review · 11111111" });
    expect(entries[2]).toMatchObject({ detail: "issues · 22222222" });
  });

  it("replaces a decided step with its decision row", () => {
    const entries = mergeTimeline({
      caseEvents: [],
      runs: [
        {
          workflow: "review",
          status: "awaiting_human",
          startedAt: "2026-09-12T10:00:00Z",
          finishedAt: null,
          steps: [
            makeTimelineStep("select-pr", "done", "2026-09-12T10:01:00Z", {
              decision: {
                action: "proceed",
                approver: "jane",
                decidedAt: "2026-09-12T10:02:00Z",
              },
            }),
            makeTimelineStep("draft", "awaiting_human", "2026-09-12T10:03:00Z", {
              decision: { action: "regenerate", guidance: "no decidedAt" },
            }),
          ],
        },
      ],
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "run:started",
      "step:select-pr",
      "step:draft",
    ]);
    expect(entries[1]).toMatchObject({
      kind: "decision",
      title: "select-pr",
      detail: "proceed · jane",
      at: "2026-09-12T10:02:00Z",
      href: null,
    });
    // The regenerate decision carries no clock: the plain step row survives.
    expect(entries[2]).toMatchObject({ kind: "step", detail: "awaiting_human" });
  });

  it("derives GitHub rows from artifacts and dedupes by URL", () => {
    const url = "https://github.com/acme/app/pull/77";
    const entries = mergeTimeline({
      caseEvents: [],
      runs: [
        {
          runId: "run-a",
          workflow: "review",
          status: "completed",
          startedAt: "2026-09-12T10:00:00Z",
          finishedAt: null,
          steps: [
            makeTimelineStep("complete", "done", "2026-09-12T10:05:00Z", {
              artifact: {
                pr: { url: `${url}/`, number: 77, draft: true, branch: "feat/77" },
                docs: "https://example.com/app/pull/1",
              },
            }),
          ],
        },
        {
          runId: "run-b",
          workflow: "issues",
          status: "completed",
          startedAt: "2026-09-12T10:10:00Z",
          finishedAt: null,
          steps: [
            makeTimelineStep("complete", "done", "2026-09-12T10:20:00Z", {
              artifact: { url, number: 77, draft: false, branch: "feat/77" },
            }),
          ],
        },
      ],
    });
    const github = entries.filter((entry) => entry.kind === "github");
    expect(github).toEqual([
      {
        id: `github:${url}`,
        at: "2026-09-12T10:05:00Z",
        kind: "github",
        title: "PR #77",
        detail: "feat/77 · draft",
        href: url,
      },
    ]);
  });
});

describe("runSpendLine", () => {
  it("combines the case cost with the elapsed run time", () => {
    const line = runSpendLine(
      { startedAt: "2026-09-12T10:00:00Z", finishedAt: "2026-09-12T10:05:00Z" },
      4200,
    );
    expect(line).toBe("Cost $0.0042 · Elapsed 5m 00s");
  });

  it("names the missing sides instead of guessing", () => {
    expect(runSpendLine({ startedAt: "", finishedAt: null }, null, 0)).toBe(
      "Cost not recorded · Elapsed —",
    );
    expect(runSpendLine(null, 0)).toBe("Cost $0.00 · Elapsed —");
    expect(runSpendLine({ startedAt: "2026-09-12T10:00:00Z", finishedAt: null }, 4200, 0)).toBe(
      "Cost $0.0042 · Elapsed 0s",
    );
  });
});
