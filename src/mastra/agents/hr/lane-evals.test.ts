import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import { MemoryEmployeeDirectory, type AccessTier } from "../hr/directory.js";
import { HR_HELP_FLOW_STEPS } from "../hr-help/contracts.js";
import {
  answerIdFor,
  hrHelpTarget,
  type HrHelpDraftContext,
  type HrHelpModel,
} from "../hr-help/flow.js";
import { MemoryHrHelpRegistry } from "../hr-help/tools/hr-help-registry.js";
import {
  matchesTerm,
  MemoryHrPolicyRetriever,
  queryTerms,
} from "../hr-help/tools/hr-policy.js";
import { LEAVE_FLOW_STEPS } from "../leave/contracts.js";
import {
  leaveTarget,
  noticeDays,
  requestIdFor,
  workingDaysBetween,
  type LeaveModel,
} from "../leave/flow.js";
import { MemoryLeaveRegistry } from "../leave/tools/leave-registry.js";
import { OFFBOARDING_FLOW_STEPS } from "../offboarding/contracts.js";
import {
  blastScoreFor,
  blastTierFor,
  offboardingIdFor,
  type OffboardingModel,
} from "../offboarding/flow.js";
import { MemoryOffboardingRegistry } from "../offboarding/tools/offboarding-registry.js";
import { ONBOARDING_FLOW_STEPS } from "../onboarding/contracts.js";
import {
  employeeIdFor,
  onboardingIdFor,
  provisionAccounts,
  type OnboardingModel,
} from "../onboarding/flow.js";
import { MemoryOnboardingRegistry } from "../onboarding/tools/onboarding-registry.js";
import { SCREENING_FLOW_STEPS } from "../screening/contracts.js";
import { type ScreeningModel } from "../screening/flow.js";
import { MemoryScreeningAts } from "../screening/tools/screening-ats.js";

/**
 * Golden-gate style evals for the HR lane deterministic engines: pinned cases
 * live in `evals/hr_lane_cases.jsonl` and are replayed here through the same
 * exported functions and flows the lanes ship. A mismatch fails with the
 * exact `expected`-vs-`actual` pair so a regression shows up as a data diff,
 * not a silent drift (the dispatcher golden tickets follow the same idea).
 */

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");
const EVAL_RUN_ID = "run-eval-1";
const EVAL_CASE_ID = "case-eval-1";

interface LaneEvalCase {
  id: string;
  lane: string;
  engine: string;
  args?: unknown[];
  expected?: unknown;
  input?: Record<string, unknown>;
  expect?: Record<string, unknown>;
}

function loadCases(): LaneEvalCase[] {
  const path = fileURLToPath(new URL("../../../../evals/hr_lane_cases.jsonl", import.meta.url));
  const cases: LaneEvalCase[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path}:${index + 1} is not a JSON object`);
    }
    cases.push(parsed as LaneEvalCase);
  }
  return cases;
}

const CASES = loadCases();

/** Exact expected-vs-actual failure line, golden-gate style. */
function expectSame(id: string, actual: unknown, expected: unknown): void {
  try {
    expect(actual).toEqual(expected);
  } catch {
    throw new Error(`FAIL ${id}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

/** Dotted-path lookup: object keys and array indices, e.g. `candidates.0.score`. */
function resolvePath(root: unknown, path: string): { found: boolean; value: unknown } {
  let current = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/* ------------------------------------------------------------ fake models */

class EvalLeaveModel implements LeaveModel {
  async policy() {
    return { summary: "Eval policy narrative.", confidence: 0.8 };
  }
}

class EvalOnboardingModel implements OnboardingModel {
  async verify() {
    return { summary: "Eval verification narrative.", confidence: 0.8 };
  }

  async risk() {
    return { summary: "Eval risk narrative.", confidence: 0.7 };
  }
}

class EvalOffboardingModel implements OffboardingModel {
  async audit() {
    return { summary: "Eval audit narrative.", confidence: 0.7 };
  }
}

class EvalScreeningModel implements ScreeningModel {
  async guardrail() {
    return {
      allowed: false,
      summary: "Eval guardrail narrative.",
      confidence: 0.8,
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
      ],
    };
  }
}

class EvalHrHelpModel implements HrHelpModel {
  async draft(context: HrHelpDraftContext) {
    const first = context.passages[0];
    if (first === undefined) throw new Error("eval draft needs a retrieved passage");
    return {
      answer: `Policy: ${first.text} [${first.sourceId}:${first.span}]`,
      citations: [{ sourceId: first.sourceId, span: first.span }],
    };
  }

  async guardrail() {
    return { allowed: true, summary: "Eval guardrail narrative.", confidence: 0.8, flags: [] };
  }
}

/* ------------------------------------------------------------ replay engines */

const PURE_ENGINES: Record<string, (...args: unknown[]) => unknown> = {
  "leave.workingDaysBetween": (from, to, holidays) =>
    workingDaysBetween(from as string, to as string, holidays as readonly string[]),
  "leave.noticeDays": (startDate, iso) => noticeDays(startDate as string, new Date(iso as string)),
  "leave.requestIdFor": (input) =>
    requestIdFor(input as { employeeId: string; leaveType: string; startDate: string; endDate: string }),
  "leave.leaveTarget": (requestId) => leaveTarget(requestId as string),
  "onboarding.onboardingIdFor": (input) =>
    onboardingIdFor(
      input as { fullName: string; roleTitle: string; department: string; startDate: string },
    ),
  "onboarding.employeeIdFor": (onboardingId) => employeeIdFor(onboardingId as string),
  "onboarding.provisionAccounts": (tier, department) =>
    provisionAccounts(tier as AccessTier, department as string),
  "offboarding.offboardingIdFor": (input) =>
    offboardingIdFor(input as { employeeId: string; lastDay: string }),
  "offboarding.blastScoreFor": (system, tier) =>
    blastScoreFor(system as string, tier as AccessTier),
  "offboarding.blastTierFor": (score) => blastTierFor(score as number),
  "hrhelp.queryTerms": (query) => queryTerms(query as string),
  "hrhelp.matchesTerm": (text, term) => matchesTerm(text as string, term as string),
  "hrhelp.answerIdFor": (caseId, ticketKey) => answerIdFor(caseId as string, ticketKey as string),
  "hrhelp.hrHelpTarget": (ticketKey) => hrHelpTarget(ticketKey as string),
};

interface SuspendView {
  artifact: Record<string, unknown>;
  target?: string;
}

interface FlowLike {
  createRun: () => Promise<{
    start: (args: { inputData: Record<string, unknown> }) => Promise<unknown>;
    resume: (args: { resumeData: Record<string, unknown> }) => Promise<unknown>;
  }>;
}

interface LaneRuntime {
  flow: FlowLike;
  workflow: string;
  ticketKey: string;
  steps: readonly string[];
}

function laneRuntime(lane: string): LaneRuntime {
  switch (lane) {
    case "leave": {
      const mastra = createAllRounderMastra({
        leave: {
          directory: new MemoryEmployeeDirectory(),
          registry: new MemoryLeaveRegistry(),
          model: new EvalLeaveModel(),
          now: () => FIXED_NOW,
        },
      });
      const flow = mastra.getWorkflow("leaveFlow");
      if (flow === undefined) throw new Error("leaveFlow is not registered");
      return { flow: flow as unknown as FlowLike, workflow: "leave", ticketKey: "HR-12", steps: LEAVE_FLOW_STEPS };
    }
    case "onboarding": {
      const mastra = createAllRounderMastra({
        onboarding: {
          directory: new MemoryEmployeeDirectory(),
          registry: new MemoryOnboardingRegistry(),
          model: new EvalOnboardingModel(),
          now: () => FIXED_NOW,
        },
      });
      const flow = mastra.getWorkflow("onboardingFlow");
      if (flow === undefined) throw new Error("onboardingFlow is not registered");
      return { flow: flow as unknown as FlowLike, workflow: "onboarding", ticketKey: "HR-21", steps: ONBOARDING_FLOW_STEPS };
    }
    case "offboarding": {
      const mastra = createAllRounderMastra({
        offboarding: {
          directory: new MemoryEmployeeDirectory(),
          registry: new MemoryOffboardingRegistry(),
          model: new EvalOffboardingModel(),
          now: () => FIXED_NOW,
        },
      });
      const flow = mastra.getWorkflow("offboardingFlow");
      if (flow === undefined) throw new Error("offboardingFlow is not registered");
      return { flow: flow as unknown as FlowLike, workflow: "offboarding", ticketKey: "HR-31", steps: OFFBOARDING_FLOW_STEPS };
    }
    case "screening": {
      const mastra = createAllRounderMastra({
        screening: { ats: new MemoryScreeningAts(), model: new EvalScreeningModel(), now: () => FIXED_NOW },
      });
      const flow = mastra.getWorkflow("screeningFlow");
      if (flow === undefined) throw new Error("screeningFlow is not registered");
      return { flow: flow as unknown as FlowLike, workflow: "screening", ticketKey: "HR-41", steps: SCREENING_FLOW_STEPS };
    }
    case "hr-help": {
      const mastra = createAllRounderMastra({
        hrHelp: {
          retriever: new MemoryHrPolicyRetriever({ now: () => FIXED_NOW }),
          registry: new MemoryHrHelpRegistry(),
          model: new EvalHrHelpModel(),
          now: () => FIXED_NOW,
        },
      });
      const flow = mastra.getWorkflow("hrHelpFlow");
      if (flow === undefined) throw new Error("hrHelpFlow is not registered");
      return { flow: flow as unknown as FlowLike, workflow: "hr-help", ticketKey: "HR-42", steps: HR_HELP_FLOW_STEPS };
    }
    default:
      throw new Error(`No eval runtime for lane ${lane}`);
  }
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
 * Forward decision for one step. Onboarding's collect gate needs every
 * required document received or waived, sent the way the API records an
 * `edit` decision, before the flow may advance to verify.
 */
function forwardDecision(
  lane: string,
  stepId: string,
  artifact: Record<string, unknown>,
): Record<string, unknown> {
  if (lane === "onboarding" && stepId === "collect") {
    const documents: Array<Record<string, unknown>> = (
      artifact["documents"] as Array<Record<string, unknown>>
    ).map((document) => ({
      ...document,
      status: "received",
      fileName: `${String(document["id"])}.pdf`,
    }));
    const required = documents.filter((document) => document["required"] === true);
    const received = required.filter((document) => document["status"] === "received").length;
    return {
      action: "edit",
      edits: {
        documents,
        totals: {
          documents: documents.length,
          required: required.length,
          received,
          waived: 0,
          outstanding: required.length - received,
        },
        returnedNote: null,
      },
      actionHash: PROCEED_HASH,
    };
  }
  return { action: "proceed", actionHash: PROCEED_HASH };
}

/** Drive the lane flow from the start until it suspends at `stopAt`. */
async function walkTo(
  runtime: LaneRuntime,
  input: Record<string, unknown>,
  stopAt: string,
): Promise<Record<string, unknown>> {
  const decisions: Record<string, Record<string, unknown>> = {};
  const artifacts: Record<string, Record<string, unknown>> = {};
  const effects: Record<string, Record<string, unknown>> = {};
  const envelope = (decision?: Record<string, unknown>): Record<string, unknown> => ({
    runId: EVAL_RUN_ID,
    workflow: runtime.workflow,
    ticketKey: runtime.ticketKey,
    caseId: EVAL_CASE_ID,
    attempt: 1,
    input,
    decisions,
    artifacts,
    effects,
    ...(decision === undefined ? {} : { decision }),
  });

  const run = await runtime.flow.createRun();
  const firstStep = runtime.steps[0];
  if (firstStep === undefined) throw new Error(`lane ${runtime.workflow} has no steps`);
  let payload = suspendView(await run.start({ inputData: envelope() }), firstStep);
  for (let index = 0; index < runtime.steps.length; index += 1) {
    const stepId = runtime.steps[index]!;
    artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload.artifact;
    const decision = forwardDecision(runtime.workflow, stepId, payload.artifact);
    decisions[stepId] = decision;
    const nextStep = runtime.steps[index + 1];
    if (nextStep === undefined) throw new Error(`flow never suspended at ${stopAt}`);
    payload = suspendView(await run.resume({ resumeData: envelope(decision) }), nextStep);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

async function replayFlowCase(entry: LaneEvalCase): Promise<void> {
  const stepId = entry.engine.split(":")[1];
  if (stepId === undefined || stepId === "") {
    throw new Error(`Case ${entry.id} names no flow step`);
  }
  const artifact = await walkTo(laneRuntime(entry.lane), entry.input ?? {}, stepId);
  for (const [path, expected] of Object.entries(entry.expect ?? {})) {
    const resolved = resolvePath(artifact, path);
    if (!resolved.found) throw new Error(`FAIL ${entry.id}: missing path ${path}`);
    expectSame(`${entry.id}.${path}`, resolved.value, expected);
  }
}

async function replayCase(entry: LaneEvalCase): Promise<void> {
  const pure = PURE_ENGINES[entry.engine];
  if (pure !== undefined) {
    expectSame(entry.id, pure(...(entry.args ?? [])), entry.expected);
    return;
  }
  if (entry.engine.includes(":")) {
    await replayFlowCase(entry);
    return;
  }
  throw new Error(`Unknown eval engine ${entry.engine}`);
}

describe("HR lane golden evals", () => {
  it("pins cases for all five lanes", () => {
    const lanes = [...new Set(CASES.map((entry) => entry.lane))].sort();
    expect(lanes).toEqual(["hr-help", "leave", "offboarding", "onboarding", "screening"]);
  });

  it("keeps case ids unique", () => {
    const ids = CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const entry of CASES) {
    it(entry.id, async () => {
      await replayCase(entry);
    }, 30_000);
  }
});
