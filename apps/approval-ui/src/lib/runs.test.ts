import { describe, expect, it } from "vitest";

import {
  RUNNABLE_WORKFLOWS,
  applyRunEvent,
  completeReceipt,
  isRunStatus,
  isRunTerminal,
  isValidRepository,
  latestRunId,
  parseSseChunk,
  runVisualState,
  sortRunsNewestFirst,
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
  it("offers the review, issue-resolution, feature-implementation, dependency-update, accessibility, vendor-onboarding, leave, new-hire-onboarding, offboarding, candidate-screening and HR-help workflows", () => {
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

  it("falls back to every workflow for unknown ticket types", () => {
    expect(
      workflowsForTicket({ issueType: "Support", summary: "Customer question", labels: [] }),
    ).toEqual(RUNNABLE_WORKFLOWS.map((workflow) => workflow.id));
  });
});
