import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import {
  RequisitionArtifactSchema,
  SCREENING_FLOW_STEPS,
  ScheduleArtifactSchema,
  ScreeningRunStateSchema,
  ScreenArtifactSchema,
  ShortlistArtifactSchema,
  type ScreeningRunState,
} from "./contracts.js";
import { type GuardrailModelContext, type ScreeningModel } from "./flow.js";
import { assertNoRawPii } from "../hr/pii.js";
import { MemoryScreeningAts, type ScreeningAts } from "./tools/screening-ats.js";

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");

const REQUEST = { requisitionId: "REQ-2001" } as const;

/** Every raw name the fixtures (and this suite) ever feed the lane. */
const RAW_NAMES = ["Ines Varga", "Bruno Costa", "Hana Suzuki"];

class FakeModel implements ScreeningModel {
  readonly guardrailCalls: GuardrailModelContext[] = [];

  async guardrail(context: GuardrailModelContext) {
    this.guardrailCalls.push(context);
    return {
      allowed: false,
      summary: "Guardrail narrative from the scripted screener.",
      confidence: 0.81,
      flags: [
        {
          candidateId: "C-3002",
          kind: "non-rubric" as const,
          detail: "Culture-fit claim is not grounded in a rubric criterion.",
          sourceId: "note:C-3002",
          span: "1-72",
        },
        {
          candidateId: "C-3003",
          kind: "protected-attribute" as const,
          detail: "Note references age and retirement timing.",
          sourceId: "note:C-3003",
          span: "1-88",
        },
        {
          candidateId: "C-9999",
          kind: "non-rubric" as const,
          detail: "Hallucinated candidate id that must be dropped.",
          sourceId: null,
          span: null,
        },
      ],
    };
  }
}

function harness(
  options: { ats?: ScreeningAts | undefined; model?: ScreeningModel | undefined } = {},
) {
  const ats = options.ats ?? new MemoryScreeningAts();
  const model = options.model ?? new FakeModel();
  const mastra = createAllRounderMastra({
    screening: { ats, model, now: () => FIXED_NOW },
  });
  const flow = mastra.getWorkflow("screeningFlow");
  if (flow === undefined) throw new Error("screeningFlow is not registered");
  return { ats, model, flow, mastra };
}

type ScreeningFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<ScreeningFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = { ...REQUEST };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "HR-41";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): ScreeningRunState {
    return ScreeningRunStateSchema.parse({
      runId: this.runId,
      workflow: "screening",
      ticketKey: this.ticketKey,
      caseId: "case-1",
      attempt: this.attempt,
      input: this.input,
      decisions: this.decisions,
      artifacts: this.artifacts,
      effects: this.effects,
    });
  }

  /** Record a decision the way `RunService.decide()` does, then build resume data. */
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): ScreeningRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return ScreeningRunStateSchema.parse({ ...this.envelope(), decision });
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
  stopAt: (typeof SCREENING_FLOW_STEPS)[number],
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < SCREENING_FLOW_STEPS.length; index += 1) {
    const stepId = SCREENING_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, SCREENING_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: ScreeningFlowHandle,
  walk: Walk,
  stopAt: (typeof SCREENING_FLOW_STEPS)[number],
): Promise<{ run: WorkflowRunHandle; walk: Walk; payload: SuspendView }> {
  const run = await flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), SCREENING_FLOW_STEPS[0]);
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

function requireArtifact(walk: Walk, stepId: string): Record<string, unknown> {
  const artifact = walk.artifacts[stepId];
  if (artifact === undefined) throw new Error(`${stepId} artifact missing from the walk`);
  return artifact;
}

interface CompletionResult {
  status?: string;
  result?: {
    receipt?: Record<string, unknown>;
    effects?: Record<string, { receipt?: Record<string, unknown> } | undefined>;
  };
}

interface WalkOptions {
  ats?: ScreeningAts;
  model?: ScreeningModel;
  walk?: Walk;
}

/** Walk the happy path from requisition to the shortlist suspension. */
async function walkToShortlist(options: WalkOptions = {}): Promise<{
  flow: ScreeningFlowHandle;
  run: WorkflowRunHandle;
  walk: Walk;
  payload: SuspendView;
  model: ScreeningModel;
  ats: ScreeningAts;
}> {
  const h = harness({ ats: options.ats, model: options.model });
  const walk = options.walk ?? new Walk();
  const { run, payload } = await walkTo(h.flow, walk, "requisition");
  walk.artifacts["requisition"] = payload.artifact;
  const screen = suspendView(
    await run.resume({
      resumeData: walk.resume("requisition", "proceed", { actionHash: PROCEED_HASH }),
    }),
    "screen",
  );
  walk.artifacts["screen"] = screen.artifact;
  const shortlist = suspendView(
    await run.resume({
      resumeData: walk.resume("screen", "proceed", { actionHash: PROCEED_HASH }),
    }),
    "shortlist",
  );
  return { flow: h.flow, run, walk, payload: shortlist, model: h.model, ats: h.ats };
}

/** Walk the happy path from requisition to the schedule suspension. */
async function walkToSchedule(options: WalkOptions = {}): Promise<{
  flow: ScreeningFlowHandle;
  run: WorkflowRunHandle;
  walk: Walk;
  payload: SuspendView;
  model: ScreeningModel;
  ats: ScreeningAts;
}> {
  const h = await walkToShortlist(options);
  h.walk.artifacts["shortlist"] = h.payload.artifact;
  const schedule = suspendView(
    await h.run.resume({
      resumeData: h.walk.resume("shortlist", "proceed", { actionHash: PROCEED_HASH }),
    }),
    "schedule",
  );
  return { ...h, payload: schedule };
}

/** The shortlist edits that include every candidate. */
function includeAll(artifact: Record<string, unknown>): Record<string, unknown> {
  const entries = (artifact.entries as Array<Record<string, unknown>>).map((entry) => ({
    ...entry,
    decision: "include",
    reason:
      typeof entry.reason === "string" && entry.reason !== ""
        ? entry.reason
        : "Reviewed and included.",
  }));
  return { entries, included: entries.length, excluded: 0 };
}

describe("Mastra screeningFlow", () => {
  it("registers named screening steps in order", () => {
    const { flow, mastra } = harness();
    expect(flow.id).toBe("screeningFlow");
    expect(Object.keys(flow.steps)).toEqual([...SCREENING_FLOW_STEPS]);
    expect(mastra.getAgent("screeningGuardrail").id).toBe("hr-guardrail");
  });

  it("suspends at requisition with the weighted rubric and the lock target", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "requisition");
    const artifact = RequisitionArtifactSchema.parse(payload.artifact);
    expect(payload.target).toBe("screening:REQ-2001");
    expect(artifact.requisitionId).toBe("REQ-2001");
    expect(artifact.roleTitle).toBe("Senior Frontend Engineer");
    expect(artifact.department).toBe("Engineering");
    expect(artifact.mustHaves).toBe(2);
    expect(
      artifact.criteria.map((criterion) => [criterion.id, criterion.weight, criterion.mustHave]),
    ).toEqual([
      ["react-depth", 30, true],
      ["typescript", 25, true],
      ["testing", 20, false],
      ["design-systems", 15, false],
      ["mentoring", 10, false],
    ]);
    expect(artifact.candidateIds).toEqual(["C-3001", "C-3002", "C-3003"]);
    expect(artifact.interviewers).toEqual(["E-1001", "E-1002"]);
    expect(artifact.summary).toBe(
      "Senior Frontend Engineer (Engineering, Remote (EU)) — 5 weighted criteria with 2 must-have(s) and 3 candidate(s) to screen.",
    );
    assertNoRawPii(artifact, RAW_NAMES);
  });

  it("fails loudly when the requisition is not in the ATS", async () => {
    const { flow } = harness();
    const walk = new Walk({ input: { requisitionId: "REQ-9999" } });
    const run = await flow.createRun();
    const message = await failureMessage(Promise.resolve(await run.start({ inputData: walk.envelope() })));
    expect(message).toContain("Requisition REQ-9999 is not in the ATS");
  });

  it("suspends at screen with verdicts, citations and guardrail flags", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run, payload: requisitionPayload } = await walkTo(flow, walk, "requisition");
    walk.artifacts["requisition"] = requisitionPayload.artifact;
    const outcome = await run.resume({
      resumeData: walk.resume("requisition", "proceed", { actionHash: PROCEED_HASH }),
    });
    const payload = suspendView(outcome, "screen");
    const artifact = ScreenArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("screening:REQ-2001");
    expect(
      artifact.candidates.map((candidate) => [candidate.candidateId, candidate.score, candidate.mustHaveMisses]),
    ).toEqual([
      ["C-3001", 90, []],
      ["C-3002", 55, ["TypeScript"]],
      ["C-3003", 83, []],
    ]);
    const first = artifact.candidates[0]!;
    expect(first.candidateLabel).toBe("I. V.");
    expect(first.verdicts.map((verdict) => [verdict.criterionId, verdict.verdict])).toEqual([
      ["react-depth", "pass"],
      ["typescript", "pass"],
      ["testing", "partial"],
      ["design-systems", "pass"],
      ["mentoring", "pass"],
    ]);
    expect(first.verdicts[0]?.citations).toEqual([
      {
        sourceId: "cv:C-3001",
        span: "83-140",
        text: "Led the migration of the billing console to React 19 with server components.",
      },
    ]);
    expect(first.verdicts[2]?.citations).toEqual([
      {
        sourceId: "screen-call:C-3001",
        span: "12-96",
        text: "Writes tests when the schedule allows; no coverage targets mentioned.",
      },
    ]);
    expect(artifact.candidates[1]?.flags).toEqual([
      {
        candidateId: "C-3002",
        kind: "non-rubric",
        detail: "Culture-fit claim is not grounded in a rubric criterion.",
        sourceId: "note:C-3002",
        span: "1-72",
      },
    ]);
    expect(artifact.candidates[2]?.flags).toEqual([
      {
        candidateId: "C-3003",
        kind: "protected-attribute",
        detail: "Note references age and retirement timing.",
        sourceId: "note:C-3003",
        span: "1-88",
      },
    ]);
    // The hallucinated candidate id in the fake output is dropped, not attached.
    expect(artifact.totalFlags).toBe(2);
    expect(artifact.guardrail).toEqual({
      allowed: false,
      summary: "Guardrail narrative from the scripted screener.",
      confidence: 0.81,
    });
    expect(artifact.summary).toBe(
      "Screened 3 candidate(s) against 5 criteria: 2 guardrail flag(s) recorded.",
    );
    expect(model.guardrailCalls).toHaveLength(1);
    expect(model.guardrailCalls[0]?.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "C-3001",
      "C-3002",
      "C-3003",
    ]);
    assertNoRawPii(artifact, RAW_NAMES);

    // Regeneration re-frames the screen with the human guidance.
    const regenerated = await run.resume({
      resumeData: walk.resume("screen", "regenerate", {
        guidance: "Call out the culture-fit note explicitly.",
      }),
    });
    const second = suspendView(regenerated, "screen");
    expect(model.guardrailCalls).toHaveLength(2);
    expect(model.guardrailCalls[1]?.guidance).toBe("Call out the culture-fit note explicitly.");
    expect(ScreenArtifactSchema.parse(second.artifact).summary).toBe(
      "Screened 3 candidate(s) against 5 criteria: 2 guardrail flag(s) recorded.",
    );
  });

  it("defaults the shortlist from must-haves, guardrails and the score", async () => {
    const { run, walk, payload } = await walkToShortlist();
    const artifact = ShortlistArtifactSchema.parse(payload.artifact);

    expect(
      artifact.entries.map((entry) => [entry.candidateId, entry.decision, entry.reason]),
    ).toEqual([
      [
        "C-3001",
        "include",
        "Meets every must-have at score 90.",
      ],
      [
        "C-3002",
        "exclude",
        "Missing must-have(s): TypeScript.",
      ],
      [
        "C-3003",
        "exclude",
        "Protected-attribute language flagged; a human decision is required before including.",
      ],
    ]);
    expect(artifact.included).toBe(1);
    expect(artifact.excluded).toBe(2);
    expect(artifact.summary).toBe("1 of 3 candidate(s) included; 2 excluded pending review.");
    assertNoRawPii(artifact, RAW_NAMES);

    // Proceeding with every candidate excluded fails on this run.
    walk.artifacts["shortlist"] = payload.artifact;
    const excluded = (payload.artifact.entries as Array<Record<string, unknown>>).map((entry) => ({
      ...entry,
      decision: "exclude",
      reason: "Reviewed and excluded.",
    }));
    const blocked = await run.resume({
      resumeData: walk.resume("shortlist", "edit", {
        edits: { entries: excluded, included: 0, excluded: 3 },
        actionHash: PROCEED_HASH,
      }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "Include at least one candidate before scheduling interviews",
    );
  });

  it("rejects an exclusion without a recorded reason", async () => {
    const { run, walk, payload } = await walkToShortlist();
    walk.artifacts["shortlist"] = payload.artifact;
    const entries = (payload.artifact.entries as Array<Record<string, unknown>>).map((entry) => {
      if (entry.candidateId === "C-3001") {
        return { ...entry, decision: "exclude", reason: "" };
      }
      if (entry.candidateId === "C-3003") {
        return { ...entry, decision: "include", reason: "Re-screened without the age framing." };
      }
      return entry;
    });
    const blocked = await run.resume({
      resumeData: walk.resume("shortlist", "edit", {
        edits: { entries },
        actionHash: PROCEED_HASH,
      }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "I. V. is excluded without a reason; record why",
    );
  });

  it("suspends at schedule with the invite plan once the shortlist clears", async () => {
    const { run, walk, payload } = await walkToShortlist();
    walk.artifacts["shortlist"] = payload.artifact;
    const outcome = await run.resume({
      resumeData: walk.resume("shortlist", "proceed", { actionHash: PROCEED_HASH }),
    });
    const schedulePayload = suspendView(outcome, "schedule");
    const artifact = ScheduleArtifactSchema.parse(schedulePayload.artifact);

    expect(schedulePayload.target).toBe("screening:REQ-2001");
    expect(artifact.invites).toEqual([
      {
        candidateId: "C-3001",
        candidateLabel: "I. V.",
        slot: "2026-09-15 10:00",
        interviewer: "E-1001",
        status: "pending",
        detail: "Panel interview with E-1001 at 2026-09-15 10:00.",
      },
    ]);
    expect(artifact.summary).toBe(
      "Schedules 1 interview(s) for requisition REQ-2001; every invite is idempotent by candidate and requisition.",
    );
    assertNoRawPii(artifact, RAW_NAMES);
  });

  it("schedules every included candidate and completes with the receipt", async () => {
    const ats = new MemoryScreeningAts();
    const { run, walk, payload } = await walkToShortlist({ ats });
    walk.artifacts["shortlist"] = payload.artifact;
    const schedule = suspendView(
      await run.resume({
        resumeData: walk.resume("shortlist", "edit", {
          edits: includeAll(payload.artifact),
          actionHash: PROCEED_HASH,
        }),
      }),
      "schedule",
    );
    const artifact = ScheduleArtifactSchema.parse(schedule.artifact);
    expect(
      artifact.invites.map((invite) => [invite.candidateId, invite.slot, invite.interviewer]),
    ).toEqual([
      ["C-3001", "2026-09-15 10:00", "E-1001"],
      ["C-3002", "2026-09-16 10:00", "E-1002"],
      ["C-3003", "2026-09-17 10:00", "E-1001"],
    ]);

    walk.artifacts["schedule"] = schedule.artifact;
    const done = (await run.resume({
      resumeData: walk.resume("schedule", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(done.status).toBe("success");
    const receipt = {
      requisitionId: "REQ-2001",
      scheduled: [
        { candidateId: "C-3001", slot: "2026-09-15 10:00" },
        { candidateId: "C-3002", slot: "2026-09-16 10:00" },
        { candidateId: "C-3003", slot: "2026-09-17 10:00" },
      ],
      failed: [],
      replayed: 0,
      idempotencyKey: "schedule:REQ-2001",
      registryRef: "screening:REQ-2001",
      completedAt: FIXED_NOW.toISOString(),
    };
    expect(done.result?.receipt).toEqual(receipt);
    expect(done.result?.effects?.schedule?.receipt).toEqual(receipt);
    expect(await ats.scheduledInvites("REQ-2001")).toEqual([
      { candidateId: "C-3001", slot: "2026-09-15 10:00" },
      { candidateId: "C-3002", slot: "2026-09-16 10:00" },
      { candidateId: "C-3003", slot: "2026-09-17 10:00" },
    ]);

    // Every artifact that crossed a checkpoint stays free of raw PII.
    for (const stepArtifact of Object.values(walk.artifacts)) {
      assertNoRawPii(stepArtifact, RAW_NAMES);
    }
    assertNoRawPii(done.result, RAW_NAMES);
  });

  it("lists failed invites and still completes", async () => {
    const ats = new MemoryScreeningAts({
      failures: {
        "C-3001": "Interviewer calendar is locked for the proposed week.",
      },
    });
    const { run, walk, payload } = await walkToSchedule({ ats });
    const artifact = ScheduleArtifactSchema.parse(payload.artifact);
    expect(artifact.invites.map((invite) => invite.candidateId)).toEqual(["C-3001"]);

    walk.artifacts["schedule"] = payload.artifact;
    const done = (await run.resume({
      resumeData: walk.resume("schedule", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toMatchObject({
      scheduled: [],
      failed: [
        {
          candidateId: "C-3001",
          reason: "Interviewer calendar is locked for the proposed week.",
        },
      ],
      replayed: 0,
    });
  });

  it("replays invites idempotently by candidate and requisition", async () => {
    const ats = new MemoryScreeningAts();
    const first = await walkToSchedule({ ats });
    first.walk.artifacts["schedule"] = first.payload.artifact;
    await first.run.resume({
      resumeData: first.walk.resume("schedule", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await ats.scheduledInvites("REQ-2001")).toEqual([
      { candidateId: "C-3001", slot: "2026-09-15 10:00" },
    ]);

    // A fresh walk with a lost effect map replays against the same ATS.
    const retry = new Walk();
    retry.decisions["requisition"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["requisition"] = requireArtifact(first.walk, "requisition");
    retry.decisions["screen"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["screen"] = requireArtifact(first.walk, "screen");
    retry.decisions["shortlist"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["shortlist"] = requireArtifact(first.walk, "shortlist");
    const retryRun = await first.flow.createRun();
    const retriedSchedule = suspendView(
      await retryRun.start({ inputData: retry.envelope() }),
      "schedule",
    );
    retry.artifacts["schedule"] = retriedSchedule.artifact;
    const done = (await retryRun.resume({
      resumeData: retry.resume("schedule", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toMatchObject({
      scheduled: [{ candidateId: "C-3001", slot: "2026-09-15 10:00" }],
      failed: [],
      replayed: 1,
    });
  });
});
