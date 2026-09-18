import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import { assertNoRawPii } from "../hr/pii.js";
import {
  ApproveArtifactSchema,
  DraftArtifactSchema,
  HR_HELP_FLOW_STEPS,
  HrHelpRunStateSchema,
  IntakeArtifactSchema,
  RetrieveArtifactSchema,
  SendArtifactSchema,
  type DraftModelOutput,
  type HrHelpRunState,
} from "./contracts.js";
import {
  answerIdFor,
  type HrHelpDraftContext,
  type HrHelpGuardrailContext,
  type HrHelpModel,
} from "./flow.js";
import {
  MemoryHrHelpRegistry,
  type HrHelpAnswer,
  type HrHelpRegistry,
} from "./tools/hr-help-registry.js";
import { MemoryHrPolicyRetriever, type HrPolicyRetriever } from "./tools/hr-policy.js";

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");

const QUESTION = "How much parental leave do primary caregivers get?";
const REQUEST = { question: QUESTION } as const;

/** Every raw name the fixtures (and this suite) ever feed the lane. */
const RAW_NAMES = ["Jordan Avery", "Priya Raman", "Sam Okafor", "Lena Fischer"];

class FakeModel implements HrHelpModel {
  readonly draftCalls: HrHelpDraftContext[] = [];
  readonly guardrailCalls: HrHelpGuardrailContext[] = [];

  async draft(context: HrHelpDraftContext): Promise<DraftModelOutput> {
    this.draftCalls.push(context);
    const first = context.passages[0]!;
    return {
      answer: `Policy: ${first.text} [${first.sourceId}:${first.span}]`,
      citations: [{ sourceId: first.sourceId, span: first.span }],
    };
  }

  async guardrail(context: HrHelpGuardrailContext) {
    this.guardrailCalls.push(context);
    return {
      allowed: false,
      summary: "Guardrail narrative from the scripted reviewer.",
      confidence: 0.83,
      flags: [
        {
          kind: "legal-advice" as const,
          detail: "Promises a specific outcome instead of stating policy.",
          sourceId: "answer",
          span: "0-20",
        },
        {
          kind: "pii-leakage" as const,
          detail: "Names an employee in the answer.",
          sourceId: "answer",
          span: "21-40",
        },
      ],
    };
  }
}

/** A guardrail pass: no flags, allowed true. */
class CleanModel extends FakeModel {
  override async guardrail(context: HrHelpGuardrailContext) {
    this.guardrailCalls.push(context);
    return {
      allowed: true,
      summary: "The answer stays on policy and names no people.",
      confidence: 0.88,
      flags: [],
    };
  }
}

/** Cites a source that was never retrieved: the draft must fail loudly. */
class UnretrievedCitationModel extends FakeModel {
  override async draft(): Promise<DraftModelOutput> {
    return {
      answer: "The policy is documented elsewhere [hr_policy/ghost.md:1-10].",
      citations: [{ sourceId: "hr_policy/ghost.md", span: "1-10" }],
    };
  }
}

/** Cites a retrieved passage but forgets its [sourceId:span] marker. */
class UnmarkedCitationModel extends FakeModel {
  override async draft(context: HrHelpDraftContext): Promise<DraftModelOutput> {
    const first = context.passages[0]!;
    return {
      answer: "This question is answered by the retrieved policy passages in full.",
      citations: [{ sourceId: first.sourceId, span: first.span }],
    };
  }
}

/** Counts the sends so replay tests can prove the effect never re-executes. */
class CountingRegistry implements HrHelpRegistry {
  sends = 0;

  constructor(private readonly inner: HrHelpRegistry) {}

  get(caseId: string, ticketKey: string) {
    return this.inner.get(caseId, ticketKey);
  }

  send(answer: HrHelpAnswer) {
    this.sends += 1;
    return this.inner.send(answer);
  }
}

function harness(
  options: { retriever?: HrPolicyRetriever; registry?: HrHelpRegistry; model?: HrHelpModel } = {},
) {
  const retriever = options.retriever ?? new MemoryHrPolicyRetriever({ now: () => FIXED_NOW });
  const registry = options.registry ?? new MemoryHrHelpRegistry();
  const model = options.model ?? new FakeModel();
  const mastra = createAllRounderMastra({
    hrHelp: { retriever, registry, model, now: () => FIXED_NOW },
  });
  const flow = mastra.getWorkflow("hrHelpFlow");
  if (flow === undefined) throw new Error("hrHelpFlow is not registered");
  return { retriever, registry, model, flow, mastra };
}

type HrHelpFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<HrHelpFlowHandle["createRun"]>>;

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
    this.ticketKey = identity.ticketKey ?? "HR-42";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): HrHelpRunState {
    return HrHelpRunStateSchema.parse({
      runId: this.runId,
      workflow: "hr-help",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): HrHelpRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return HrHelpRunStateSchema.parse({ ...this.envelope(), decision });
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
  stopAt: (typeof HR_HELP_FLOW_STEPS)[number],
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < HR_HELP_FLOW_STEPS.length; index += 1) {
    const stepId = HR_HELP_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, HR_HELP_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

interface WalkOptions {
  retriever?: HrPolicyRetriever;
  registry?: HrHelpRegistry;
  model?: HrHelpModel;
  walk?: Walk;
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkWith(
  options: WalkOptions,
  stopAt: (typeof HR_HELP_FLOW_STEPS)[number],
) {
  const h = harness(options);
  const walk = options.walk ?? new Walk();
  const run = await h.flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), HR_HELP_FLOW_STEPS[0]);
  const payload = await runForward(run, walk, 0, first, stopAt);
  return { ...h, walk, run, payload };
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

describe("Mastra hrHelpFlow", () => {
  it("registers named hr help steps in order", () => {
    const { flow, mastra } = harness();
    expect(flow.id).toBe("hrHelpFlow");
    expect(Object.keys(flow.steps)).toEqual([...HR_HELP_FLOW_STEPS]);
    expect(mastra.getAgent("hrHelpDrafter").id).toBe("hr-help-drafter");
    expect(mastra.getAgent("hrHelpGuardrail").id).toBe("hr-help-guardrail");
  });

  it("suspends at intake with the question and its retrieval topics", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "intake");
    const artifact = IntakeArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("hr-help:HR-42");
    expect(artifact.caseId).toBe("case-1");
    expect(artifact.ticketKey).toBe("HR-42");
    expect(artifact.question).toBe(QUESTION);
    expect(artifact.topics).toEqual([
      "how",
      "much",
      "parental",
      "leave",
      "primary",
      "caregivers",
      "get",
    ]);
    expect(artifact.summary).toBe(
      "HR help question on how, much, parental, leave, primary, caregivers, get for case case-1.",
    );
    assertNoRawPii(artifact, RAW_NAMES);
  });

  it("suspends at retrieve with the ranked, scored passages", async () => {
    const { payload } = await walkWith({}, "retrieve");
    const artifact = RetrieveArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("hr-help:HR-42");
    expect(artifact.question).toBe(QUESTION);
    expect(artifact.passages).toHaveLength(5);
    expect(new Set(artifact.passages.map((passage) => passage.sourceId))).toEqual(
      new Set(["hr_policy/leave-and-time-off.md"]),
    );
    const top = artifact.passages[0]!;
    expect(top.score).toBe(0.43);
    expect(top.stale).toBe(false);
    expect(top.text).toContain("Parental leave provides 20 weeks at full pay");
    expect(artifact.staleCount).toBe(0);
    expect(artifact.matchedTerms).toContain("parental");
    expect(artifact.matchedTerms).toContain("leave");
    expect(artifact.summary).toBe(
      "Retrieved 5 policy passage(s) for the question; 0 flagged stale.",
    );
    assertNoRawPii(artifact, RAW_NAMES);
  });

  it("fails loudly when nothing matches and when every match is stale", async () => {
    const empty = await walkWith(
      { walk: new Walk({ input: { question: "Quantum espresso calibration" } }) },
      "intake",
    );
    empty.walk.artifacts["intake"] = empty.payload.artifact;
    const emptyBlocked = await empty.run.resume({
      resumeData: empty.walk.resume("intake", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(emptyBlocked))).toContain(
      "No policy passages matched this question; add or refresh the hr_policy corpus",
    );

    const stale = await walkWith(
      { walk: new Walk({ input: { question: "Legacy stipend superseded reference" } }) },
      "intake",
    );
    stale.walk.artifacts["intake"] = stale.payload.artifact;
    const staleBlocked = await stale.run.resume({
      resumeData: stale.walk.resume("intake", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(staleBlocked))).toContain(
      "Every matching passage is stale; refresh the policy corpus before answering",
    );
  });

  it("suspends at draft with the cited answer and the guardrail flags", async () => {
    const model = new FakeModel();
    const { run, walk, payload } = await walkWith({ model }, "draft");
    const artifact = DraftArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("hr-help:HR-42");
    const top = artifact.citations[0]!;
    expect(artifact.answer).toContain(`[${top.sourceId}:${top.span}]`);
    expect(artifact.flags.map((flag) => flag.kind)).toEqual(["legal-advice", "pii-leakage"]);
    expect(artifact.guardrail).toEqual({
      allowed: false,
      summary: "Guardrail narrative from the scripted reviewer.",
      confidence: 0.83,
    });
    expect(artifact.totalFlags).toBe(2);
    expect(artifact.summary).toBe(
      "Drafted a cited answer with 1 citation(s); guardrail recorded 2 flag(s).",
    );
    expect(model.draftCalls).toHaveLength(1);
    expect(model.draftCalls[0]?.question).toBe(QUESTION);
    expect(model.guardrailCalls).toHaveLength(1);
    expect(model.guardrailCalls[0]?.answer).toBe(artifact.answer);
    assertNoRawPii(artifact, RAW_NAMES);

    // Regeneration reruns the drafter and guardrail with the human guidance.
    walk.artifacts["draft"] = payload.artifact;
    const regenerated = await run.resume({
      resumeData: walk.resume("draft", "regenerate", {
        guidance: "Lead with the carry-over window.",
      }),
    });
    const second = suspendView(regenerated, "draft");
    expect(model.draftCalls).toHaveLength(2);
    expect(model.draftCalls[1]?.guidance).toBe("Lead with the carry-over window.");
    expect(model.guardrailCalls).toHaveLength(2);
    expect(DraftArtifactSchema.parse(second.artifact).citations).toEqual(artifact.citations);
  });

  it("rejects a citation that was not retrieved", async () => {
    const { run, walk, payload } = await walkWith(
      { model: new UnretrievedCitationModel() },
      "retrieve",
    );
    walk.artifacts["retrieve"] = payload.artifact;
    const blocked = await run.resume({
      resumeData: walk.resume("retrieve", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "The draft cites hr_policy/ghost.md:1-10, which was not retrieved; every claim must cite a retrieved passage",
    );
  });

  it("requires every citation to be marked in the answer", async () => {
    const { run, walk, payload } = await walkWith(
      { model: new UnmarkedCitationModel() },
      "retrieve",
    );
    walk.artifacts["retrieve"] = payload.artifact;
    const top = RetrieveArtifactSchema.parse(payload.artifact).passages[0]!;
    const blocked = await run.resume({
      resumeData: walk.resume("retrieve", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      `The draft does not mark the claim for ${top.sourceId}:${top.span}; add the [sourceId:span] marker`,
    );
  });

  it("suspends at approve with the people-partner checkpoint", async () => {
    const flagged = await walkWith({}, "approve");
    const artifact = ApproveArtifactSchema.parse(flagged.payload.artifact);

    expect(flagged.payload.target).toBe("hr-help:HR-42");
    expect(artifact.approverRole).toBe("people-partner");
    expect(artifact.approverLabel).toBe("People Partner on duty");
    expect(artifact.slaHours).toBe(24);
    expect(artifact.state).toBe("pending");
    expect(artifact.requestedAt).toBe(FIXED_NOW.toISOString());
    expect(artifact.decidedAt).toBeNull();
    expect(artifact.summary).toBe(
      "People Partner on duty approval requested for the HR help answer · guardrail flags need sign-off.",
    );
    assertNoRawPii(artifact, RAW_NAMES);

    // A clean guardrail pass drops the flag sign-off note.
    const clean = await walkWith({ model: new CleanModel() }, "approve");
    const cleanArtifact = ApproveArtifactSchema.parse(clean.payload.artifact);
    expect(cleanArtifact.summary).toBe(
      "People Partner on duty approval requested for the HR help answer.",
    );
    const draft = DraftArtifactSchema.parse(requireArtifact(clean.walk, "draft"));
    expect(draft.totalFlags).toBe(0);
    expect(draft.guardrail.allowed).toBe(true);
  });

  it("suspends at send with the preview and completes with the receipt", async () => {
    const registry = new MemoryHrHelpRegistry();
    const { run, walk, payload } = await walkWith({ registry }, "send");
    const send = SendArtifactSchema.parse(payload.artifact);
    const draft = DraftArtifactSchema.parse(requireArtifact(walk, "draft"));
    const answerId = answerIdFor("case-1", "HR-42");

    expect(payload.target).toBe("hr-help:HR-42");
    expect(send.response).toEqual({
      answerId,
      caseId: "case-1",
      ticketKey: "HR-42",
      citationCount: 1,
      status: "sent",
    });
    expect(send.idempotencyKey).toBe("send:case-1:HR-42");
    expect(send.existing).toBeNull();

    walk.artifacts["send"] = payload.artifact;
    const done = (await run.resume({
      resumeData: walk.resume("send", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(done.status).toBe("success");
    const receipt = {
      caseId: "case-1",
      ticketKey: "HR-42",
      answerId,
      citations: draft.citations,
      created: true,
      registryRef: "hr-help:case-1#HR-42",
      completedAt: FIXED_NOW.toISOString(),
    };
    expect(done.result?.receipt).toEqual(receipt);
    expect(done.result?.effects?.send?.receipt).toEqual(receipt);

    const stored = await registry.get("case-1", "HR-42");
    expect(stored?.answer).toBe(draft.answer);
    expect(stored?.citations).toEqual(draft.citations);

    // Every artifact that crossed a checkpoint stays free of raw PII.
    for (const stepArtifact of Object.values(walk.artifacts)) {
      assertNoRawPii(stepArtifact, RAW_NAMES);
    }
    assertNoRawPii(done.result, RAW_NAMES);
  });

  it("does not re-execute a send whose effect is already recorded", async () => {
    const registry = new CountingRegistry(new MemoryHrHelpRegistry());
    const { run, walk, payload } = await walkWith({ registry }, "send");
    walk.artifacts["send"] = payload.artifact;

    const seeded = {
      caseId: "case-1",
      ticketKey: "HR-42",
      answerId: answerIdFor("case-1", "HR-42"),
      citations: [{ sourceId: "hr_policy/leave-and-time-off.md", span: "1-2" }],
      created: true,
      registryRef: "hr-help:case-1#HR-42",
      completedAt: FIXED_NOW.toISOString(),
    };
    walk.effects["send"] = { actionHash: PROCEED_HASH, receipt: seeded };

    const done = (await run.resume({
      resumeData: walk.resume("send", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toEqual(seeded);
    expect(registry.sends).toBe(0);
    expect(await registry.get("case-1", "HR-42")).toBeNull();
  });

  it("replays the recorded answer idempotently by case and ticket", async () => {
    const registry = new MemoryHrHelpRegistry();
    const first = await walkWith({ registry }, "send");
    first.walk.artifacts["send"] = first.payload.artifact;
    const firstDone = (await first.run.resume({
      resumeData: first.walk.resume("send", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    const answerId = answerIdFor("case-1", "HR-42");
    expect(firstDone.result?.receipt).toMatchObject({ created: true, answerId });

    // A fresh walk with a lost effect map replays against the same registry.
    const retry = await walkWith({ registry }, "send");
    const send = SendArtifactSchema.parse(retry.payload.artifact);
    expect(send.existing).toEqual({ answerId, createdAt: FIXED_NOW.toISOString() });
    expect(send.summary).toBe(
      `Case case-1 already has answer ${answerId}; the send replays idempotently.`,
    );
    retry.walk.artifacts["send"] = retry.payload.artifact;
    const retried = (await retry.run.resume({
      resumeData: retry.walk.resume("send", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(retried.status).toBe("success");
    expect(retried.result?.receipt).toMatchObject({
      created: false,
      answerId,
      registryRef: "hr-help:case-1#HR-42",
    });
  });
});
