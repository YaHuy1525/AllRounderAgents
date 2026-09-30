import { describe, expect, it } from "vitest";

import {
  RUNNABLE_WORKFLOWS,
  applyRunEvent,
  auditPackFilename,
  clientRefProblem,
  completeReceipt,
  formatDuration,
  isRunStatus,
  isRunTerminal,
  isValidRepository,
  latestRunId,
  mergeRunEvents,
  normalizeClientRef,
  packMonth,
  parseRunSnapshot,
  parseSseChunk,
  runDurationSeconds,
  runListQuery,
  runVisualState,
  sortRunsNewestFirst,
  workflowLabel,
  workflowsForTicket,
  type RunDetail,
  type RunEvent,
  type RunStep,
  type RunStepState,
  type RunSummary,
} from "./runs.js";

const STEP_IDS = ["select-pr", "review-options", "ai-review", "complete"];

function makeStep(stepId: string, overrides: Partial<RunStep> = {}): RunStep {
  return {
    stepId,
    index: STEP_IDS.indexOf(stepId),
    title: stepId,
    state: "pending",
    artifact: null,
    decision: null,
    receipt: null,
    actionHash: null,
    regenerations: 0,
    updatedAt: "2026-09-12T10:00:00Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "run-1",
    workflow: "review",
    ticketKey: "ENG-101",
    status: "running",
    queuePosition: null,
    currentStepId: "select-pr",
    stepCount: 4,
    stepsDone: 0,
    startedAt: "2026-09-12T10:00:00Z",
    finishedAt: null,
    caseId: "case-1",
    attempt: 0,
    heartbeatAt: "2026-09-12T10:00:00Z",
    lockTarget: null,
    lockedBy: null,
    outcome: null,
    cancelReason: null,
    sideEffects: {},
    steps: STEP_IDS.map((id) => makeStep(id)),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RunEvent> & { type: string }): RunEvent {
  return { runId: "run-1", sequence: 1, ...overrides };
}

function makeSummary(runId: string, startedAt: string): RunSummary {
  return {
    runId,
    workflow: "review",
    ticketKey: "ENG-101",
    status: "completed",
    queuePosition: null,
    currentStepId: null,
    stepCount: 4,
    stepsDone: 4,
    startedAt,
    finishedAt: null,
  };
}

describe("run status helpers", () => {
  it("narrows known statuses and terminals", () => {
    expect(isRunStatus("awaiting_human")).toBe(true);
    expect(isRunStatus("paused")).toBe(false);
    expect(isRunTerminal("completed")).toBe(true);
    expect(isRunTerminal("cancelled")).toBe(true);
    expect(isRunTerminal("blocked")).toBe(false);
  });

  it("maps step states onto the stepper vocabulary", () => {
    const mapping: Array<[RunStepState, string]> = [
      ["done", "done"],
      ["running", "current"],
      ["awaiting_human", "awaiting"],
      ["blocked", "blocked"],
      ["failed", "blocked"],
      ["pending", "future"],
    ];
    for (const [state, visual] of mapping) {
      expect(runVisualState(makeStep("ai-review", { state }))).toBe(visual);
    }
  });
});

describe("run list ordering", () => {
  it("sorts newest first and picks the newest run", () => {
    const runs = [
      makeSummary("run-old", "2026-09-10T08:00:00Z"),
      makeSummary("run-new", "2026-09-12T09:00:00Z"),
      makeSummary("run-mid", "2026-09-11T12:00:00Z"),
    ];
    expect(sortRunsNewestFirst(runs).map((run) => run.runId)).toEqual([
      "run-new",
      "run-mid",
      "run-old",
    ]);
    expect(latestRunId(runs)).toBe("run-new");
    expect(latestRunId([])).toBeNull();
  });

  it("validates repository slugs before starting a run", () => {
    expect(isValidRepository("acme/app")).toBe(true);
    expect(isValidRepository(" acme/app.js ")).toBe(true);
    expect(isValidRepository("acme")).toBe(false);
    expect(isValidRepository("acme/app/extra")).toBe(false);
    expect(isValidRepository("acme app/app")).toBe(false);
  });
});

describe("complete receipt", () => {
  it("reads the receipt recorded by the complete side effect", () => {
    const run = makeRun({
      sideEffects: {
        complete: { receipt: { reviewId: 42, url: "https://github.com/acme/app/pull/1" } },
      },
    });
    expect(completeReceipt(run)).toEqual({
      reviewId: 42,
      url: "https://github.com/acme/app/pull/1",
    });
  });

  it("returns null while the side effect has not run", () => {
    expect(completeReceipt(makeRun())).toBeNull();
    expect(completeReceipt(makeRun({ sideEffects: { complete: { note: "pending" } } }))).toBeNull();
  });
});

describe("applyRunEvent", () => {
  it("marks queued runs and their position", () => {
    const next = applyRunEvent(makeRun(), makeEvent({ type: "run.queued", queuePosition: 2 }));
    expect(next.status).toBe("queued");
    expect(next.queuePosition).toBe(2);
  });

  it("applies terminal statuses without touching the source run", () => {
    const run = makeRun({ status: "running", queuePosition: 3 });
    const next = applyRunEvent(
      run,
      makeEvent({ type: "run.status", status: "failed", error: "boom", reason: "sandbox" }),
    );
    expect(next.status).toBe("failed");
    expect(next.outcome).toBe("boom");
    expect(next.cancelReason).toBe("sandbox");
    expect(next.queuePosition).toBeNull();
    expect(run.status).toBe("running");
    expect(run.queuePosition).toBe(3);
  });

  it("suspends onto a checkpoint, completing earlier steps", () => {
    const next = applyRunEvent(
      makeRun(),
      makeEvent({
        type: "run.suspended",
        stepId: "review-options",
        stepState: "awaiting_human",
        artifact: { categories: [{ id: "bugs", enabled: true }] },
        target: "acme/app#12",
      }),
    );
    expect(next.status).toBe("awaiting_human");
    expect(next.currentStepId).toBe("review-options");
    expect(next.lockTarget).toBe("acme/app#12");
    expect(next.lockedBy).toBe("run-1");
    expect(next.steps[0]).toMatchObject({ stepId: "select-pr", state: "done" });
    expect(next.steps[1]).toMatchObject({
      stepId: "review-options",
      state: "awaiting_human",
      artifact: { categories: [{ id: "bugs", enabled: true }] },
    });
    expect(next.steps[2]?.state).toBe("pending");
  });

  it("suspends into a lock conflict as blocked", () => {
    const next = applyRunEvent(
      makeRun(),
      makeEvent({
        type: "run.suspended",
        stepId: "select-pr",
        stepState: "blocked",
        target: "acme/app#12",
        lockedBy: "run-2",
      }),
    );
    expect(next.status).toBe("blocked");
    expect(next.lockedBy).toBe("run-2");
    expect(next.steps[0]).toMatchObject({ stepId: "select-pr", state: "blocked" });
  });

  it("moves to blocked on run.locked and reopens on run.unlocked", () => {
    const held = applyRunEvent(
      makeRun({ currentStepId: "ai-review" }),
      makeEvent({ type: "run.locked", target: "acme/app#12", lockedBy: "run-2" }),
    );
    expect(held.status).toBe("blocked");
    expect(held.steps[2]?.state).toBe("blocked");

    const reopened = applyRunEvent(held, makeEvent({ type: "run.unlocked", target: "acme/app#12" }));
    expect(reopened.status).toBe("awaiting_human");
    expect(reopened.lockedBy).toBe("run-1");
    expect(reopened.steps[2]?.state).toBe("awaiting_human");
  });

  it("records decisions: proceed completes, regenerate counts", () => {
    const proceeding = applyRunEvent(
      makeRun({ currentStepId: "ai-review" }),
      makeEvent({ type: "run.decision", stepId: "ai-review", action: "proceed" }),
    );
    expect(proceeding.steps[2]?.state).toBe("done");

    const regenerated = applyRunEvent(
      makeRun({ currentStepId: "ai-review" }),
      makeEvent({ type: "run.decision", stepId: "ai-review", action: "regenerate" }),
    );
    expect(regenerated.steps[2]?.state).toBe("pending");
    expect(regenerated.steps[2]?.regenerations).toBe(1);
  });
});

describe("run snapshots embedded on transition events", () => {
  it("applies the embedded snapshot when the API enriched the event", () => {
    const run = makeRun({ status: "running", currentStepId: "select-pr" });
    const snapshot = makeRun({
      status: "awaiting_human",
      currentStepId: "review-options",
      stepsDone: 1,
      lockTarget: "acme/app#12",
      lockedBy: "run-1",
      steps: STEP_IDS.map((id, index) =>
        makeStep(id, {
          state: index === 0 ? "done" : index === 1 ? "awaiting_human" : "pending",
          ...(index === 1 ? { artifact: { categories: [{ id: "bugs", enabled: true }] } } : {}),
        }),
      ),
    });
    const next = applyRunEvent(
      run,
      makeEvent({
        type: "run.suspended",
        stepId: "review-options",
        stepState: "awaiting_human",
        run: { ...snapshot },
      }),
    );
    expect(next.status).toBe("awaiting_human");
    expect(next.currentStepId).toBe("review-options");
    expect(next.stepsDone).toBe(1);
    expect(next.steps[0]?.state).toBe("done");
    expect(next.steps[1]).toMatchObject({
      stepId: "review-options",
      state: "awaiting_human",
      artifact: { categories: [{ id: "bugs", enabled: true }] },
    });
    expect(next.lockedBy).toBe("run-1");
    expect(run.status).toBe("running");
  });

  it("falls back to the incremental patch when the snapshot is malformed", () => {
    const next = applyRunEvent(
      makeRun(),
      makeEvent({
        type: "run.suspended",
        stepId: "review-options",
        stepState: "awaiting_human",
        run: { runId: "run-1" },
      }),
    );
    expect(next.status).toBe("awaiting_human");
    expect(next.currentStepId).toBe("review-options");
    expect(next.steps[1]?.state).toBe("awaiting_human");
  });

  it("ignores a snapshot that belongs to another run", () => {
    const other = makeRun({ runId: "run-2", status: "completed", outcome: "completed" });
    const next = applyRunEvent(
      makeRun({ status: "running" }),
      makeEvent({ type: "run.status", status: "failed", error: "boom", run: { ...other } }),
    );
    expect(next.status).toBe("failed");
    expect(next.outcome).toBe("boom");
  });

  it("validates snapshot shapes before trusting them", () => {
    const base = makeRun();
    expect(parseRunSnapshot({ ...base })?.runId).toBe("run-1");
    expect(parseRunSnapshot(null)).toBeNull();
    expect(parseRunSnapshot("nope")).toBeNull();
    expect(parseRunSnapshot({ ...base, status: "paused" })).toBeNull();
    expect(parseRunSnapshot({ ...base, steps: "nope" })).toBeNull();
    expect(parseRunSnapshot({ ...base, steps: [{ stepId: "x" }] })).toBeNull();
  });
});

describe("mergeRunEvents", () => {
  it("keeps replay order, dedupes by sequence, and re-sorts late arrivals", () => {
    let events: RunEvent[] = [];
    events = mergeRunEvents(events, makeEvent({ type: "run.created", sequence: 1 }));
    events = mergeRunEvents(events, makeEvent({ type: "run.queued", sequence: 2 }));
    events = mergeRunEvents(events, makeEvent({ type: "run.suspended", sequence: 3 }));
    // A replayed frame overlapping the tail replaces instead of duplicating.
    events = mergeRunEvents(
      events,
      makeEvent({ type: "run.queued", sequence: 2, queuePosition: 4 }),
    );
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[1]?.queuePosition).toBe(4);
    // Out-of-order arrivals come back sorted.
    events = mergeRunEvents(events, makeEvent({ type: "run.status", sequence: 10 }));
    events = mergeRunEvents(events, makeEvent({ type: "run.decision", sequence: 4 }));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 10]);
    // Frames without a sequence number append at the end.
    events = mergeRunEvents(events, { runId: "run-1", sequence: Number.NaN, type: "run.tick" });
    expect(events[events.length - 1]?.type).toBe("run.tick");
  });

  it("starts from an empty history without mutating the input", () => {
    const first = makeEvent({ type: "run.created", sequence: 1 });
    const history = mergeRunEvents([], first);
    expect(history).toEqual([first]);
    const extended = mergeRunEvents(history, makeEvent({ type: "run.queued", sequence: 2 }));
    expect(history).toHaveLength(1);
    expect(extended).toHaveLength(2);
  });
});

describe("parseSseChunk", () => {
  it("splits complete frames and keeps the partial remainder", () => {
    const buffer =
      'data: {"runId":"run-1","sequence":1,"type":"run.created"}\n\n' +
      'data: {"runId":"run-1","sequence":2,"type":"run.queued","queuePosition":1}\n\n' +
      'data: {"runId":"run-1","sequence":3,';
    const { events, rest } = parseSseChunk(buffer);
    expect(events.map((event) => event.type)).toEqual(["run.created", "run.queued"]);
    expect(events[1]?.queuePosition).toBe(1);
    expect(rest).toBe('data: {"runId":"run-1","sequence":3,');
  });

  it("joins multi-line data fields", () => {
    const { events } = parseSseChunk('data: {"type":\ndata: "run.closed"}\n\n');
    expect(events).toEqual([{ type: "run.closed" }]);
  });

  it("drops malformed or untyped frames without throwing", () => {
    const { events } = parseSseChunk(
      "data: not-json\n\n" +
        "event: ping\n\n" +
        'data: {"noType":true}\n\n' +
        'data: {"type":"run.status","status":"completed"}\n\n',
    );
    expect(events).toEqual([{ type: "run.status", status: "completed" }]);
  });
});

describe("runnable workflows", () => {
  it("offers the review, issue-resolution, feature-implementation, dependency-update, accessibility, vendor-onboarding, leave, new-hire-onboarding, offboarding, candidate-screening, HR-help and SOC-alert-triage workflows", () => {
    const ids = RUNNABLE_WORKFLOWS.map((workflow) => workflow.id);
    expect(ids).toEqual([
      "review",
      "issues",
      "features",
      "dependencies",
      "accessibility",
      "vendors",
      "leave",
      "onboarding",
      "offboarding",
      "screening",
      "hr-help",
      "security",
    ]);
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "issues")?.label).toBe(
      "Issue Resolution",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "features")?.label).toBe(
      "Feature Implementation",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "dependencies")?.label).toBe(
      "Dependency Update",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "accessibility")?.label).toBe(
      "Accessibility Audit",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "vendors")?.label).toBe(
      "Vendor Onboarding",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "leave")?.label).toBe(
      "Leave Request",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "onboarding")?.label).toBe(
      "New-Hire Onboarding",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "offboarding")?.label).toBe(
      "Employee Offboarding",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "screening")?.label).toBe(
      "Candidate Screening",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "hr-help")?.label).toBe(
      "HR Help",
    );
    expect(RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === "security")?.label).toBe(
      "SOC Alert Triage",
    );
  });
});

describe("workflowsForTicket", () => {
  it("maps bug tickets to issue resolution plus review", () => {
    expect(
      workflowsForTicket({ issueType: "Bug", summary: "Checkout crashes", labels: [] }),
    ).toEqual(["issues", "review"]);
  });

  it("maps other code-ish tickets to feature work plus review", () => {
    expect(
      workflowsForTicket({ issueType: "Story", summary: "Add CSV export", labels: [] }),
    ).toEqual(["features", "review"]);
  });

  it("puts keyword matches first, then the type rules", () => {
    expect(
      workflowsForTicket({ issueType: "Task", summary: "Onboard vendor Acme", labels: [] }),
    ).toEqual(["vendors", "features", "review"]);
    expect(
      workflowsForTicket({
        issueType: "Bug",
        summary: "Contrast fails",
        labels: ["accessibility"],
      }),
    ).toEqual(["accessibility", "issues", "review"]);
    expect(
      workflowsForTicket({ issueType: "Story", summary: "Bump lodash", labels: [] }),
    ).toEqual(["dependencies", "features", "review"]);
  });

  it("pulls the leave workflow in from time-off keywords", () => {
    expect(
      workflowsForTicket({ issueType: "Task", summary: "Book annual leave for E-1001", labels: [] }),
    ).toEqual(["leave", "features", "review"]);
    expect(
      workflowsForTicket({ issueType: "Support", summary: "PTO question", labels: [] }),
    ).toEqual(["leave"]);
  });

  it("pulls the onboarding workflow in from new-hire keywords", () => {
    expect(
      workflowsForTicket({
        issueType: "Task",
        summary: "Onboarding new hire starting 2026-10-05",
        labels: [],
      }),
    ).toEqual(["onboarding", "vendors", "features", "review"]);
    expect(
      workflowsForTicket({
        issueType: "Support",
        summary: "New starter equipment checklist",
        labels: [],
      }),
    ).toEqual(["onboarding"]);
  });

  it("pulls the offboarding workflow in from departure keywords", () => {
    expect(
      workflowsForTicket({
        issueType: "Task",
        summary: "Offboarding Marco Silveira on 2026-10-30",
        labels: [],
      }),
    ).toEqual(["offboarding", "features", "review"]);
    expect(
      workflowsForTicket({
        issueType: "Support",
        summary: "Resignation: revoke access",
        labels: [],
      }),
    ).toEqual(["offboarding"]);
  });

  it("pulls the screening workflow in from candidate keywords", () => {
    expect(
      workflowsForTicket({
        issueType: "Task",
        summary: "Screen candidates for the Senior Frontend Engineer role",
        labels: [],
      }),
    ).toEqual(["screening", "features", "review"]);
    expect(
      workflowsForTicket({
        issueType: "Support",
        summary: "Requisition REQ-2001 interview loop",
        labels: [],
      }),
    ).toEqual(["screening"]);
  });

  it("pulls the hr-help workflow in from HR help and handbook keywords", () => {
    expect(
      workflowsForTicket({
        issueType: "Task",
        summary: "HR help: is the home-office stipend still current?",
        labels: [],
      }),
    ).toEqual(["hr-help", "features", "review"]);
    expect(
      workflowsForTicket({
        issueType: "Support",
        summary: "Handbook question about parental leave",
        labels: [],
      }),
    ).toEqual(["hr-help", "leave"]);
  });

  it("pulls the security workflow in from SOC alert keywords", () => {
    expect(
      workflowsForTicket({
        issueType: "Task",
        summary: "Investigate EDR alert on fin-db-01",
        labels: ["security"],
      }),
    ).toEqual(["security", "features", "review"]);
    expect(
      workflowsForTicket({
        issueType: "Support",
        summary: "Phishing report: credential page reported by finance",
        labels: [],
      }),
    ).toEqual(["security"]);
  });

  it("falls back to every workflow for unknown ticket types", () => {
    expect(
      workflowsForTicket({ issueType: "Support", summary: "Customer question", labels: [] }),
    ).toEqual(RUNNABLE_WORKFLOWS.map((workflow) => workflow.id));
  });
});

describe("run list query", () => {
  it("serializes filters in a fixed order and omits empty fields", () => {
    expect(runListQuery()).toBe("");
    // The server default (active) is omitted so ticket lists keep their URL.
    expect(runListQuery({ scope: "active" })).toBe("");
    expect(runListQuery({ workflow: "", cursor: "" })).toBe("");
    expect(
      runListQuery({
        ticket: "ENG-101",
        scope: "history",
        workflow: "review",
        status: "completed",
        limit: 25,
        cursor: "2026-09-12T10:00:00Z",
      }),
    ).toBe(
      "?ticket=ENG-101&scope=history&workflow=review&status=completed&limit=25&cursor=2026-09-12T10%3A00%3A00Z",
    );
  });
});

describe("workflow labels", () => {
  it("labels known workflows and falls back to the raw id", () => {
    expect(workflowLabel("review")).toBe("PR Review");
    expect(workflowLabel("security")).toBe("SOC Alert Triage");
    expect(workflowLabel("unknown-workflow")).toBe("unknown-workflow");
  });
});

describe("run durations", () => {
  it("measures finished runs from their timestamps", () => {
    expect(
      runDurationSeconds({
        startedAt: "2026-09-12T10:00:00Z",
        finishedAt: "2026-09-12T10:02:05Z",
      }),
    ).toBe(125);
  });

  it("measures open runs against the injected now", () => {
    const startedAt = "2026-09-12T10:00:00Z";
    const now = Date.parse(startedAt) + 42_000;
    expect(runDurationSeconds({ startedAt, finishedAt: null }, now)).toBe(42);
    expect(runDurationSeconds({ startedAt: "nope", finishedAt: null })).toBeNull();
    expect(runDurationSeconds({ startedAt, finishedAt: "nope" })).toBeNull();
  });

  it("formats seconds, minutes, and hours compactly", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(185)).toBe("3m 05s");
    expect(formatDuration(7_620)).toBe("2h 07m");
  });
});

describe("MSP client refs", () => {
  it("normalizes refs to trimmed lowercase", () => {
    expect(normalizeClientRef(" Acme.Support ")).toBe("acme.support");
    expect(normalizeClientRef("ACME")).toBe("acme");
  });

  it("accepts refs the server would accept and names a reason for the rest", () => {
    expect(clientRefProblem("acme")).toBeNull();
    expect(clientRefProblem(" Acme.2 ")).toBeNull();
    expect(clientRefProblem("a-1")).toBeNull();
    expect(clientRefProblem("")).toContain("mailbox local part");
    expect(clientRefProblem("Acme Support")).toContain("lowercase letters");
    expect(clientRefProblem("_acme")).toContain("lowercase letters");
    expect(clientRefProblem(`${"a".repeat(65)}`)).toContain("lowercase letters");
  });
});

describe("audit pack naming", () => {
  it("derives the pack month from the clock in UTC", () => {
    expect(packMonth(new Date("2026-09-15T12:00:00Z"))).toBe("2026-09");
    expect(packMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("names the download like the server's Content-Disposition", () => {
    expect(auditPackFilename("acme", "2026-09")).toBe("audit-pack-acme-2026-09.pdf");
  });
});
