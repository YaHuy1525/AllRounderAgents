import { describe, expect, it } from "vitest";

import {
  INBOX_STATUS_COPY,
  buildInboxTask,
  buildInboxTasks,
  compareInboxTasks,
  formatWait,
  isInboxTaskStatus,
  sortInboxTasks,
  waitLabel,
  waitingSeconds,
} from "@/lib/taskInbox";
import type { RunSummary, RunTopology, RunTopologyStep } from "@/lib/runs";

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    workflow: "vendors",
    ticketKey: "PO-884",
    status: "awaiting_human",
    queuePosition: null,
    waitingOn: null,
    heldSlots: [],
    currentStepId: "chase",
    stepCount: 4,
    stepsDone: 2,
    startedAt: "2026-09-17T08:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeStep(overrides: Partial<RunTopologyStep> = {}): RunTopologyStep {
  return {
    stepId: "chase",
    index: 2,
    title: "Chase the purchase order",
    state: "awaiting_human",
    sideEffecting: false,
    integrations: [],
    fields: [],
    receipt: null,
    actionHash: null,
    hasArtifact: true,
    hasDecision: false,
    regenerations: 0,
    updatedAt: "2026-09-17T09:30:00Z",
    ...overrides,
  };
}

function makeTopology(overrides: Partial<RunTopology> = {}): RunTopology {
  return {
    runId: "run-1",
    workflow: "vendors",
    status: "awaiting_human",
    attempt: 1,
    currentStepId: "chase",
    stepCount: 4,
    stepsDone: 2,
    startedAt: "2026-09-17T08:00:00Z",
    finishedAt: null,
    lock: null,
    receipts: { signed: 1, items: [] },
    steps: [makeStep()],
    ...overrides,
  };
}

describe("isInboxTaskStatus", () => {
  it("keeps gates and stalls, drops every other run status", () => {
    expect(isInboxTaskStatus("awaiting_human")).toBe(true);
    expect(isInboxTaskStatus("blocked")).toBe(true);
    expect(isInboxTaskStatus("running")).toBe(false);
    expect(isInboxTaskStatus("completed")).toBe(false);
    expect(isInboxTaskStatus("queued")).toBe(false);
  });
});

describe("buildInboxTask", () => {
  it("derives the card from the summary plus the topology overlay", () => {
    const task = buildInboxTask(makeSummary(), makeTopology());
    expect(task).toMatchObject({
      runId: "run-1",
      workflow: "vendors",
      ticketKey: "PO-884",
      status: "awaiting_human",
      stepId: "chase",
      stepTitle: "Chase the purchase order",
      stepsDone: 2,
      stepCount: 4,
      waitingSince: "2026-09-17T09:30:00Z",
      receipts: 1,
    });
  });

  it("falls back to the run start when the topology is missing", () => {
    const task = buildInboxTask(makeSummary(), null);
    expect(task).toMatchObject({
      stepId: "chase",
      stepTitle: null,
      stepsDone: 2,
      receipts: 0,
      waitingSince: "2026-09-17T08:00:00Z",
    });
  });

  it("reads title and timestamp off the current step only", () => {
    const topology = makeTopology({
      currentStepId: "collect",
      steps: [
        makeStep(),
        makeStep({
          stepId: "collect",
          title: "Collect vendor invoices",
          updatedAt: "2026-09-17T09:55:00Z",
        }),
      ],
    });
    const task = buildInboxTask(makeSummary(), topology);
    expect(task?.stepId).toBe("collect");
    expect(task?.stepTitle).toBe("Collect vendor invoices");
    expect(task?.waitingSince).toBe("2026-09-17T09:55:00Z");
  });

  it("carries the lock for a blocked stall", () => {
    const task = buildInboxTask(
      makeSummary({ status: "blocked" }),
      makeTopology({ lock: { target: "acme/app#77", lockedBy: "run-2" } }),
    );
    expect(task).toMatchObject({ status: "blocked", lockTarget: "acme/app#77", lockedBy: "run-2" });
  });

  it("returns null for runs the inbox does not carry", () => {
    expect(buildInboxTask(makeSummary({ status: "running" }), makeTopology())).toBeNull();
    expect(buildInboxTask(makeSummary({ status: "completed" }), null)).toBeNull();
  });
});

describe("buildInboxTasks", () => {
  it("filters, dedupes, and joins the topologies by run id", () => {
    const runs = [
      makeSummary(),
      makeSummary({ runId: "run-2", status: "blocked", currentStepId: "select-pr" }),
      makeSummary({ runId: "run-3", status: "running" }),
      makeSummary(), // duplicate of run-1
    ];
    const topologies = new Map([
      ["run-1", makeTopology()],
      ["run-2", makeTopology({ runId: "run-2", currentStepId: "select-pr", lock: { target: "acme/app#77", lockedBy: "run-9" } })],
    ]);
    const tasks = buildInboxTasks(runs, topologies);
    expect(tasks.map((task) => task.runId)).toEqual(["run-1", "run-2"]);
    expect(tasks[1]).toMatchObject({ status: "blocked", lockTarget: "acme/app#77" });
  });
});

describe("sortInboxTasks", () => {
  const base = makeSummary();

  it("puts awaiting gates above blocked stalls", () => {
    const oldStall = buildInboxTask(
      makeSummary({ runId: "stall", status: "blocked" }),
      makeTopology({ runId: "stall" }),
    );
    const newGate = buildInboxTask(
      makeSummary({ runId: "gate" }),
      makeTopology({ runId: "gate", steps: [makeStep({ updatedAt: "2026-09-17T09:59:00Z" })] }),
    );
    const sorted = sortInboxTasks([oldStall!, newGate!]);
    expect(sorted.map((task) => task.runId)).toEqual(["gate", "stall"]);
  });

  it("orders the oldest wait on top inside a group", () => {
    const older = buildInboxTask(
      makeSummary({ runId: "older" }),
      makeTopology({ runId: "older", steps: [makeStep({ updatedAt: "2026-09-17T09:00:00Z" })] }),
    );
    const newer = buildInboxTask(
      makeSummary({ runId: "newer" }),
      makeTopology({ runId: "newer", steps: [makeStep({ updatedAt: "2026-09-17T09:50:00Z" })] }),
    );
    const sorted = sortInboxTasks([newer!, older!]);
    expect(sorted.map((task) => task.runId)).toEqual(["older", "newer"]);
  });

  it("tie-breaks equal waits by run id and sorts unreadable timestamps last", () => {
    const sameA = buildInboxTask(
      makeSummary({ runId: "b-run", startedAt: "2026-09-17T09:00:00Z" }),
      null,
    );
    const sameB = buildInboxTask(
      makeSummary({ runId: "a-run", startedAt: "2026-09-17T09:00:00Z" }),
      null,
    );
    const broken = buildInboxTask(
      makeSummary({ runId: "z-run", startedAt: "not-a-date" }),
      null,
    );
    const sorted = sortInboxTasks([broken!, sameA!, sameB!]);
    expect(sorted.map((task) => task.runId)).toEqual(["a-run", "b-run", "z-run"]);
  });

  it("does not mutate the input list", () => {
    const tasks = buildInboxTasks([base], new Map([["run-1", makeTopology()]]));
    const copy = [...tasks];
    sortInboxTasks(tasks);
    expect(tasks).toEqual(copy);
  });
});

describe("waiting copy", () => {
  const task = buildInboxTask(makeSummary(), makeTopology())!;

  it("measures seconds since the gate's step timestamp", () => {
    // 10:00 minus 09:30 is 30 minutes.
    const now = Date.parse("2026-09-17T10:00:00Z");
    expect(waitingSeconds(task, now)).toBe(1800);
    expect(waitLabel(task, now)).toBe("waiting 30m");
  });

  it("clamps a future timestamp to zero and degrades unreadable ones", () => {
    const future = buildInboxTask(
      makeSummary(),
      makeTopology({ steps: [makeStep({ updatedAt: "2026-09-17T11:00:00Z" })] }),
    )!;
    expect(waitingSeconds(future, Date.parse("2026-09-17T10:00:00Z"))).toBe(0);
    const broken = buildInboxTask(makeSummary({ startedAt: "nope" }), null)!;
    expect(waitingSeconds(broken, Date.now())).toBeNull();
    expect(waitLabel(broken, Date.now())).toBe("waiting");
  });

  it("formats each magnitude in the compact copy", () => {
    expect(formatWait(0)).toBe("<1m");
    expect(formatWait(59)).toBe("<1m");
    expect(formatWait(60)).toBe("1m");
    expect(formatWait(42 * 60)).toBe("42m");
    expect(formatWait(3600)).toBe("1h");
    expect(formatWait(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatWait(2 * 86400 + 5 * 3600)).toBe("2d 5h");
    expect(formatWait(3 * 86400)).toBe("3d");
  });

  it("keeps one status copy per inbox status", () => {
    expect(INBOX_STATUS_COPY).toEqual({
      awaiting_human: "Awaiting you",
      blocked: "Blocked",
    });
  });
});
