import { describe, expect, it } from "vitest";

import { assertNoRawPii } from "../hr/pii.js";
import type { HrCalendar, HrEmployee } from "../hr/directory.js";
import { MemoryEmployeeDirectory } from "../hr/directory.js";
import { createAllRounderMastra } from "../../mastra.js";
import {
  IntakeArtifactSchema,
  LEAVE_FLOW_STEPS,
  LeaveRunStateSchema,
  PolicyArtifactSchema,
  type LeaveRunState,
} from "./contracts.js";
import {
  workingDaysBetween,
  requestIdFor,
  leaveTarget,
  type LeaveModel,
  type PolicyModelContext,
} from "./flow.js";
import {
  MemoryLeaveRegistry,
  type LeaveEntry,
  type LeaveRegistry,
} from "./tools/leave-registry.js";

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");

const EMPLOYEE: HrEmployee = {
  employeeId: "E-1001",
  fullName: "Jordan Avery",
  roleTitle: "Platform Engineer",
  department: "Engineering",
  managerId: "E-1002",
  location: "Austin",
  accessTier: "high",
  systems: ["okta", "github", "slack"],
  status: "active",
  startDate: "2024-03-04",
  leaveBalanceDays: 10,
};

const MANAGER: HrEmployee = {
  employeeId: "E-1002",
  fullName: "Priya Raman",
  roleTitle: "Engineering Manager",
  department: "Engineering",
  managerId: "E-1008",
  location: "Austin",
  accessTier: "medium",
  systems: ["okta", "github", "slack"],
  status: "active",
  startDate: "2022-06-13",
  leaveBalanceDays: 9,
};

const CALENDAR: HrCalendar = {
  holidays: [{ date: "2026-10-14", label: "Company offsite" }],
  blackoutPeriods: [{ from: "2026-12-21", to: "2026-12-31", reason: "Year-end close" }],
};

const EXISTING_BOOKING: LeaveEntry = {
  requestId: "LR-11111111",
  employeeId: "E-1001",
  startDate: "2026-10-15",
  endDate: "2026-10-16",
  workingDays: 2,
  status: "booked",
  createdAt: "2026-09-01T10:00:00.000Z",
};

class FakeModel implements LeaveModel {
  readonly calls: PolicyModelContext[] = [];

  async policy(context: PolicyModelContext) {
    this.calls.push(context);
    return {
      summary: "Policy narrative from the scripted advisor.",
      confidence: 0.81,
    };
  }
}

function harness(
  options: { registry?: LeaveRegistry; model?: LeaveModel; employees?: HrEmployee[] } = {},
) {
  const registry = options.registry ?? new MemoryLeaveRegistry();
  const model = options.model ?? new FakeModel();
  const directory = new MemoryEmployeeDirectory({
    employees: options.employees ?? [EMPLOYEE, MANAGER],
    departments: { Engineering: { headId: "E-1002" } },
    calendar: CALENDAR,
  });
  const mastra = createAllRounderMastra({
    leave: { directory, registry, model, now: () => FIXED_NOW },
  });
  const flow = mastra.getWorkflow("leaveFlow");
  if (flow === undefined) throw new Error("leaveFlow is not registered");
  return { registry, model, flow, mastra };
}

type LeaveFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<LeaveFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = {
    employeeId: "E-1001",
    leaveType: "annual",
    startDate: "2026-10-12",
    endDate: "2026-10-16",
  };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-leave-1";
    this.ticketKey = identity.ticketKey ?? "HR-12";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): LeaveRunState {
    return LeaveRunStateSchema.parse({
      runId: this.runId,
      workflow: "leave",
      ticketKey: this.ticketKey,
      caseId: "case-hr-1",
      attempt: this.attempt,
      input: this.input,
      decisions: this.decisions,
      artifacts: this.artifacts,
      effects: this.effects,
    });
  }

  /** Record a decision the way `RunService.decide()` does, then build resume data. */
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): LeaveRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return LeaveRunStateSchema.parse({ ...this.envelope(), decision });
  }
}

interface SuspendView {
  artifact: Record<string, unknown>;
  target?: string;
}

function suspendView(outcome: unknown, stepId: string): SuspendView {
  const view = outcome as {
    status?: string;
    error?: unknown;
    suspendPayload?: Record<string, SuspendView | undefined>;
  };
  if (view.status !== "suspended") {
    const failure = view.error;
    const detail =
      typeof failure === "object" && failure !== null && "message" in failure
        ? String((failure as { message: unknown }).message)
        : String(view.error ?? view.status);
    throw new Error(`expected suspension at ${stepId}, got ${detail}`);
  }
  const payload = view.suspendPayload?.[stepId];
  if (payload?.artifact === undefined) {
    throw new Error(`no suspend payload for ${stepId}`);
  }
  return payload;
}

/**
 * From the suspension at `startIndex`, store each artifact and proceed until
 * the flow suspends at `stopAt`.
 */
async function runForward(
  run: WorkflowRunHandle,
  walk: Walk,
  startIndex: number,
  currentPayload: SuspendView,
  stopAt: (typeof LEAVE_FLOW_STEPS)[number],
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < LEAVE_FLOW_STEPS.length; index += 1) {
    const stepId = LEAVE_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, LEAVE_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: LeaveFlowHandle,
  walk: Walk,
  stopAt: (typeof LEAVE_FLOW_STEPS)[number],
): Promise<{ run: WorkflowRunHandle; walk: Walk; payload: SuspendView }> {
  const run = await flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), LEAVE_FLOW_STEPS[0]);
  const payload = await runForward(run, walk, 0, first, stopAt);
  return { run, walk, payload };
}

/** Extract the failure message from a step failure the way the API would see it. */
async function failureMessage(outcomePromise: Promise<unknown>): Promise<string> {
  try {
    const outcome = (await outcomePromise) as { status?: string; error?: unknown };
    if (outcome.status === "failed") {
      const failure = outcome.error as { message?: unknown };
      return typeof failure?.message === "string" ? failure.message : String(outcome.error);
    }
    return `status ${outcome.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Mastra leaveFlow", () => {
  it("registers named leave steps in order", () => {
    const { flow, mastra } = harness();
    expect(flow.id).toBe("leaveFlow");
    expect(Object.keys(flow.steps)).toEqual([...LEAVE_FLOW_STEPS]);
    expect(mastra.getAgent("leaveAdvisor").id).toBe("leave-advisor");
  });

  it("computes working days around weekends and holidays", () => {
    expect(workingDaysBetween("2026-10-12", "2026-10-16", ["2026-10-14"])).toBe(4);
    expect(workingDaysBetween("2026-10-12", "2026-10-16", [])).toBe(5);
    expect(workingDaysBetween("2026-10-12", "2026-10-18", [])).toBe(5);
  });

  it("suspends at intake with the request details and the request lock target", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "intake");
    const artifact = IntakeArtifactSchema.parse(payload.artifact);
    const requestId = requestIdFor({
      employeeId: "E-1001",
      leaveType: "annual",
      startDate: "2026-10-12",
      endDate: "2026-10-16",
    });
    expect(payload.target).toBe(`leave:${requestId}`);
    expect(leaveTarget(requestId)).toBe(`leave:${requestId}`);
    expect(artifact.requestId).toBe(requestId);
    expect(artifact.employeeLabel).toBe("J. A.");
    expect(artifact.balanceDays).toBe(10);
  });

  it("fails loudly for an employee that is not in the directory", async () => {
    const { flow } = harness();
    const walk = new Walk();
    walk.input = { ...walk.input, employeeId: "E-9999" };
    const run = await flow.createRun();
    const message = await failureMessage(Promise.resolve(await run.start({ inputData: walk.envelope() })));
    expect(message).toContain("Unknown employee E-9999");
  });

  it("suspends at policy-check with the deterministic checks and model narrative", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "policy-check");
    const artifact = PolicyArtifactSchema.parse(payload.artifact);
    expect(artifact.workingDays).toBe(4);
    expect(artifact.balanceBefore).toBe(10);
    expect(artifact.balanceAfter).toBe(6);
    expect(artifact.verdict).toBe("ok");
    expect(artifact.checks.map((check) => [check.id, check.status])).toEqual([
      ["balance", "pass"],
      ["coverage", "pass"],
      ["blackout", "pass"],
      ["notice", "pass"],
    ]);
    expect(artifact.summary).toBe("Policy narrative from the scripted advisor.");
    expect(artifact.confidence).toBe(0.81);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.workingDays).toBe(4);
  });

  it("flags overlapping bookings without demanding an exception", async () => {
    const { flow } = harness({ registry: new MemoryLeaveRegistry([EXISTING_BOOKING]) });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "policy-check");
    const artifact = PolicyArtifactSchema.parse(payload.artifact);
    expect(artifact.verdict).toBe("ok");
    const coverage = artifact.checks.find((check) => check.id === "coverage");
    expect(coverage?.status).toBe("flag");
    expect(coverage?.detail).toContain("LR-11111111");
    expect(artifact.overlaps.map((overlap) => overlap.requestId)).toEqual(["LR-11111111"]);
  });

  it("demands an exception when the range lands inside a blackout window", async () => {
    const { flow } = harness();
    const walk = new Walk();
    walk.input = { ...walk.input, startDate: "2026-12-22", endDate: "2026-12-24" };
    const { payload } = await walkTo(flow, walk, "policy-check");
    const artifact = PolicyArtifactSchema.parse(payload.artifact);
    expect(artifact.verdict).toBe("exception_required");
    expect(artifact.blackoutHits[0]).toContain("Year-end close");
  });

  it("rejects a range that contains no working days", async () => {
    const { flow } = harness();
    const walk = new Walk();
    walk.input = { ...walk.input, startDate: "2026-10-17", endDate: "2026-10-18" };
    const { run } = await walkTo(flow, walk, "intake");
    walk.artifacts["intake"] = walk.artifacts["intake"] ?? {};
    const outcome = await run.resume({
      resumeData: walk.resume("intake", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(outcome))).toContain("no working days");
  });

  it("passes regeneration guidance to the advisor", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "policy-check");
    walk.artifacts["policy-check"] = payload.artifact;
    const outcome = await run.resume({
      resumeData: walk.resume("policy-check", "regenerate", { guidance: "Mention the offsite." }),
    });
    suspendView(outcome, "policy-check");
    expect(model.calls.at(-1)?.guidance).toBe("Mention the offsite.");
  });

  it("books the leave once, replaying idempotently by request id", async () => {
    const registry = new MemoryLeaveRegistry();
    const first = harness({ registry });
    const firstWalk = new Walk();
    const firstRun = await walkTo(first.flow, firstWalk, "apply");
    expect(firstRun.payload.artifact["existing"]).toBeNull();
    const completed = (await firstRun.run.resume({
      resumeData: firstWalk.resume("apply", "proceed", { actionHash: PROCEED_HASH }),
    })) as {
      status?: string;
      result?: { status?: string; receipt?: Record<string, unknown> };
    };
    expect(completed.status).toBe("success");
    const receipt = completed.result?.receipt;
    expect(receipt?.["created"]).toBe(true);
    expect(receipt?.["requestId"]).toBe(firstWalk.artifacts["intake"]?.["requestId"]);
    expect(receipt?.["workingDays"]).toBe(4);
    expect(await registry.list("E-1001")).toHaveLength(1);

    // A second run for the same request replays the booking idempotently.
    const second = harness({ registry });
    const secondWalk = new Walk({ runId: "run-leave-2" });
    const secondRun = await walkTo(second.flow, secondWalk, "apply");
    expect(secondRun.payload.artifact["existing"]).not.toBeNull();
    const replay = (await secondRun.run.resume({
      resumeData: secondWalk.resume("apply", "proceed", { actionHash: PROCEED_HASH }),
    })) as { result?: { receipt?: Record<string, unknown> } };
    expect(replay.result?.receipt?.["created"]).toBe(false);
    expect(await registry.list("E-1001")).toHaveLength(1);
  });

  it("keeps artifacts free of raw names", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "intake");
    for (const artifact of Object.values(walk.artifacts)) {
      assertNoRawPii(artifact, ["Jordan Avery", "Priya Raman"]);
    }
    void run;
  });
});
