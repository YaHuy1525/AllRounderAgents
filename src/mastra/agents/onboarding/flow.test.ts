import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import {
  ApproveArtifactSchema,
  CollectArtifactSchema,
  ONBOARDING_FLOW_STEPS,
  OnboardingRunStateSchema,
  ProvisionArtifactSchema,
  RiskArtifactSchema,
  VerifyArtifactSchema,
  type OnboardingRunState,
} from "./contracts.js";
import { employeeIdFor, onboardingIdFor, type OnboardingModel, type RiskModelContext, type VerifyModelContext } from "./flow.js";
import { MemoryEmployeeDirectory, type EmployeeDirectory } from "../hr/directory.js";
import { assertNoRawPii } from "../hr/pii.js";
import {
  MemoryOnboardingRegistry,
  type OnboardingRegistry,
  type ProvisionedEmployee,
} from "./tools/onboarding-registry.js";

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");

const NEW_HIRE = {
  fullName: "Nora Ellison",
  roleTitle: "Data Engineer",
  department: "Engineering",
  location: "Austin",
  startDate: "2026-10-05",
  managerId: "E-1002",
} as const;

const JORDAN_HIGH = {
  ...NEW_HIRE,
  fullName: "Jordan Avery",
  accessTier: "high" as const,
};

/** Every raw name the fixtures (and this suite) ever feed the lane. */
const RAW_NAMES = [
  NEW_HIRE.fullName,
  "Jordan Avery",
  "Priya Raman",
  "Sam Okafor",
  "Lena Fischer",
  "Marco Silveira",
  "Dara Whitfield",
  "Tomas Berg",
  "Ada Nakamura",
];

class FakeModel implements OnboardingModel {
  readonly verifyCalls: VerifyModelContext[] = [];
  readonly riskCalls: RiskModelContext[] = [];

  async verify(context: VerifyModelContext) {
    this.verifyCalls.push(context);
    return {
      summary: "Verification summary from the scripted verifier.",
      confidence: 0.8,
    };
  }

  async risk(context: RiskModelContext) {
    this.riskCalls.push(context);
    return {
      summary: "Risk narrative from the scripted analyst.",
      confidence: 0.72,
    };
  }
}

function harness(
  options: {
    registry?: OnboardingRegistry;
    model?: OnboardingModel;
    directory?: EmployeeDirectory;
  } = {},
) {
  const directory = options.directory ?? new MemoryEmployeeDirectory();
  const registry = options.registry ?? new MemoryOnboardingRegistry();
  const model = options.model ?? new FakeModel();
  const mastra = createAllRounderMastra({
    onboarding: { directory, registry, model, now: () => FIXED_NOW },
  });
  const flow = mastra.getWorkflow("onboardingFlow");
  if (flow === undefined) throw new Error("onboardingFlow is not registered");
  return { registry, model, flow, mastra };
}

type OnboardingFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<OnboardingFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = { ...NEW_HIRE };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "HR-21";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): OnboardingRunState {
    return OnboardingRunStateSchema.parse({
      runId: this.runId,
      workflow: "onboarding",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): OnboardingRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return OnboardingRunStateSchema.parse({ ...this.envelope(), decision });
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
  stopAt: (typeof ONBOARDING_FLOW_STEPS)[number],
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < ONBOARDING_FLOW_STEPS.length; index += 1) {
    const stepId = ONBOARDING_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, ONBOARDING_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: OnboardingFlowHandle,
  walk: Walk,
  stopAt: (typeof ONBOARDING_FLOW_STEPS)[number],
): Promise<{ run: WorkflowRunHandle; walk: Walk; payload: SuspendView }> {
  const run = await flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), ONBOARDING_FLOW_STEPS[0]);
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

interface LooseDocument {
  id: string;
  label: string;
  required: boolean;
  status: string;
  fileName: string | null;
  waivedReason: string | null;
  nudges: number;
  lastNudgedAt: string | null;
}

function documentRows(
  artifact: Record<string, unknown>,
  overrides: Record<string, Partial<LooseDocument>> = {},
): LooseDocument[] {
  return (artifact.documents as LooseDocument[]).map((document) => ({
    ...document,
    ...overrides[document.id],
  }));
}

function collectTotals(documents: LooseDocument[]) {
  const required = documents.filter((document) => document.required);
  const received = required.filter((document) => document.status === "received").length;
  const waived = required.filter((document) => document.status === "waived").length;
  return {
    documents: documents.length,
    required: required.length,
    received,
    waived,
    outstanding: required.length - received - waived,
  };
}

function allReceived(artifact: Record<string, unknown>): Record<string, unknown> {
  const documents = documentRows(
    artifact,
    Object.fromEntries(
      (artifact.documents as LooseDocument[]).map((document) => [
        document.id,
        { status: "received", fileName: `${document.id}.pdf` },
      ]),
    ),
  );
  return { documents, totals: collectTotals(documents), returnedNote: null };
}

function approvedChain(artifact: Record<string, unknown>): Record<string, unknown> {
  const chain = (artifact.chain as Array<Record<string, unknown>>).map((entry) => ({
    ...entry,
    state: "approved",
    actedAt: FIXED_NOW.toISOString(),
    note: "Approved in review.",
  }));
  return { chain, allApproved: true };
}

async function walkToVerify(
  options: { registry?: OnboardingRegistry; model?: OnboardingModel; walk?: Walk } = {},
): Promise<{
  run: WorkflowRunHandle;
  walk: Walk;
  payload: SuspendView;
  model: OnboardingModel;
}> {
  const h = harness(options);
  const walk = options.walk ?? new Walk();
  const { run, payload } = await walkTo(h.flow, walk, "collect");
  walk.artifacts["collect"] = payload.artifact;
  const outcome = await run.resume({
    resumeData: walk.resume("collect", "edit", {
      edits: allReceived(payload.artifact),
      actionHash: PROCEED_HASH,
    }),
  });
  return { run, walk, payload: suspendView(outcome, "verify"), model: h.model };
}

describe("Mastra onboardingFlow", () => {
  it("registers named onboarding steps in order", () => {
    const { flow, mastra } = harness();
    expect(flow.id).toBe("onboardingFlow");
    expect(Object.keys(flow.steps)).toEqual([...ONBOARDING_FLOW_STEPS]);
    expect(mastra.getAgent("onboardingVerifier").id).toBe("onboarding-verifier");
    expect(mastra.getAgent("onboardingRisk").id).toBe("onboarding-risk");
  });

  it("suspends at collect with the checklist, totals and lock target", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "collect");
    const artifact = CollectArtifactSchema.parse(payload.artifact);
    expect(payload.target).toBe(`employee:${onboardingIdFor(NEW_HIRE)}`);
    expect(onboardingIdFor(NEW_HIRE)).toMatch(/^OB-[0-9A-F]{8}$/);
    expect(artifact.onboardingId).toBe(onboardingIdFor(NEW_HIRE));
    expect(artifact.candidateLabel).toBe("N. E.");
    expect(artifact.managerId).toBe("E-1002");
    expect(artifact.accessTier).toBe("medium");
    expect(artifact.documents.map((document) => document.id)).toEqual([
      "id-verification",
      "right-to-work",
      "signed-contract",
      "tax-form",
      "bank-details",
      "emergency-contact",
    ]);
    expect(artifact.documents.every((document) => document.status === "missing")).toBe(true);
    expect(
      artifact.documents.filter((document) => !document.required).map((document) => document.id),
    ).toEqual(["emergency-contact"]);
    expect(artifact.totals).toEqual({
      documents: 6,
      required: 5,
      received: 0,
      waived: 0,
      outstanding: 5,
    });
    expect(artifact.returnedNote).toBeNull();
    assertNoRawPii(artifact, RAW_NAMES);
  });

  it("blocks proceeding until every required document is received or waived", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "collect");

    // Nothing collected yet.
    walk.artifacts["collect"] = payload.artifact;
    const untouched = await run.resume({
      resumeData: walk.resume("collect", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(untouched))).toContain(
      "Collect every required document or waive it with a reason",
    );
  });

  it("rejects an upload without a file name and a waiver without a reason", async () => {
    const noFile = harness();
    const noFileWalk = new Walk();
    const first = await walkTo(noFile.flow, noFileWalk, "collect");
    noFileWalk.artifacts["collect"] = first.payload.artifact;
    const documents = documentRows(
      first.payload.artifact,
      Object.fromEntries(
        (first.payload.artifact.documents as LooseDocument[]).map((document) => [
          document.id,
          document.id === "bank-details"
            ? { status: "received", fileName: "" }
            : { status: "received", fileName: `${document.id}.pdf` },
        ]),
      ),
    );
    const noFileOutcome = await first.run.resume({
      resumeData: noFileWalk.resume("collect", "edit", {
        edits: { documents, totals: collectTotals(documents), returnedNote: null },
        actionHash: PROCEED_HASH,
      }),
    });
    expect(await failureMessage(Promise.resolve(noFileOutcome))).toContain(
      "Bank account details is marked received; record the uploaded file or waive it",
    );

    const noReason = harness();
    const noReasonWalk = new Walk();
    const second = await walkTo(noReason.flow, noReasonWalk, "collect");
    noReasonWalk.artifacts["collect"] = second.payload.artifact;
    const waived = documentRows(
      second.payload.artifact,
      Object.fromEntries(
        (second.payload.artifact.documents as LooseDocument[]).map((document) => [
          document.id,
          document.id === "right-to-work"
            ? { status: "waived", fileName: null, waivedReason: "" }
            : { status: "received", fileName: `${document.id}.pdf` },
        ]),
      ),
    );
    const noReasonOutcome = await second.run.resume({
      resumeData: noReasonWalk.resume("collect", "edit", {
        edits: { documents: waived, totals: collectTotals(waived), returnedNote: null },
        actionHash: PROCEED_HASH,
      }),
    });
    expect(await failureMessage(Promise.resolve(noReasonOutcome))).toContain(
      "Right-to-work evidence is waived without a reason; add one or collect the document",
    );
  });

  it("suspends at verify with passing checks and the framed summary", async () => {
    const { payload, model } = await walkToVerify();
    const artifact = VerifyArtifactSchema.parse(payload.artifact);
    expect(payload.target).toBe(`employee:${onboardingIdFor(NEW_HIRE)}`);
    expect(artifact.checks.map((check) => check.id)).toEqual([
      "id-verification",
      "right-to-work",
      "signed-contract",
      "tax-form",
      "bank-details",
      "start-date",
      "manager-assignment",
      "duplicate-screening",
    ]);
    expect(artifact.checks.every((check) => check.status === "pass")).toBe(true);
    const startDate = artifact.checks.find((check) => check.id === "start-date");
    expect(startDate?.detail).toBe("Starts in 22 calendar day(s).");
    const manager = artifact.checks.find((check) => check.id === "manager-assignment");
    expect(manager?.detail).toBe("Reports to E-1002.");
    expect(artifact.candidates).toEqual([]);
    expect(artifact.manualReview).toEqual({ required: false, items: [] });
    expect(artifact.summary).toBe("Verification summary from the scripted verifier.");
    expect(artifact.confidence).toBe(0.8);
    const calls = (model as FakeModel).verifyCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.candidateLabel).toBe("N. E.");
    assertNoRawPii(artifact, RAW_NAMES);
  });

  it("routes a directory lookalike to manual review with id-only evidence", async () => {
    const h = harness();
    const walk = new Walk({ input: { ...NEW_HIRE, fullName: "Jordan Avery" } });
    const collect = await walkTo(h.flow, walk, "collect");
    walk.artifacts["collect"] = collect.payload.artifact;
    const toVerify = await collect.run.resume({
      resumeData: walk.resume("collect", "edit", {
        edits: allReceived(collect.payload.artifact),
        actionHash: PROCEED_HASH,
      }),
    });
    const payload = suspendView(toVerify, "verify");
    const artifact = VerifyArtifactSchema.parse(payload.artifact);

    const duplicate = artifact.checks.find((check) => check.id === "duplicate-screening");
    expect(duplicate?.status).toBe("fail");
    expect(duplicate?.detail).toBe("Likely duplicate of E-1001 (score 1.00).");
    expect(artifact.candidates).toEqual([
      {
        employeeId: "E-1001",
        label: "J. A.",
        matchScore: 1,
        matchedOn: ["full name", "department"],
      },
    ]);
    expect(artifact.manualReview.required).toBe(true);
    expect(artifact.manualReview.items).toEqual([
      { checkId: "duplicate-screening", reason: "Likely duplicate of E-1001 (score 1.00)." },
    ]);
    assertNoRawPii(artifact, RAW_NAMES);

    // Proceeding without a manual-review note fails on this run.
    walk.artifacts["verify"] = payload.artifact;
    const blocked = await collect.run.resume({
      resumeData: walk.resume("verify", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "Record a manual-review note for every failing check before proceeding",
    );
  });

  it("scores the access tier, documents, findings and duplicates into a tier", async () => {
    const model = new FakeModel();
    const walk = new Walk({ input: { ...NEW_HIRE, accessTier: "high" } });
    const { run, payload } = await walkToVerify({ model, walk });
    walk.artifacts["verify"] = payload.artifact;
    const outcome = await run.resume({
      resumeData: walk.resume("verify", "proceed", { actionHash: PROCEED_HASH }),
    });
    const artifact = RiskArtifactSchema.parse(suspendView(outcome, "risk-score").artifact);

    expect(artifact.score).toBe(30);
    expect(artifact.tier).toBe("medium");
    expect(artifact.factors).toEqual([
      {
        id: "access-tier",
        label: "Access tier",
        points: 30,
        detail: "high access tier requested.",
      },
      {
        id: "document-coverage",
        label: "Document coverage",
        points: 0,
        detail: "5 of 5 required documents received.",
      },
      {
        id: "verification-findings",
        label: "Verification findings",
        points: 0,
        detail: "0 failing and 0 flagged checks.",
      },
      {
        id: "duplicate-risk",
        label: "Duplicate risk",
        points: 0,
        detail: "No duplicate candidates.",
      },
    ]);
    expect(artifact.requiredSigners).toEqual(["people-partner", "department-head"]);
    expect(artifact.matrix).toEqual([
      { tier: "low", requiredSigners: ["people-partner"] },
      { tier: "medium", requiredSigners: ["people-partner", "department-head"] },
      {
        tier: "high",
        requiredSigners: ["people-partner", "department-head", "people-ops-director"],
      },
    ]);
    expect(artifact.summary).toBe("Risk narrative from the scripted analyst.");
    expect(artifact.confidence).toBe(0.72);
    expect((model as FakeModel).riskCalls).toHaveLength(1);
    assertNoRawPii(artifact, RAW_NAMES);
  });

  it("resolves the fixture signer chain and gates provisioning on approvals", async () => {
    const h = harness();
    const walk = new Walk({ input: JORDAN_HIGH });
    const collect = await walkTo(h.flow, walk, "collect");
    walk.artifacts["collect"] = collect.payload.artifact;
    const verifyPayload = suspendView(
      await collect.run.resume({
        resumeData: walk.resume("collect", "edit", {
          edits: allReceived(collect.payload.artifact),
          actionHash: PROCEED_HASH,
        }),
      }),
      "verify",
    );
    walk.artifacts["verify"] = verifyPayload.artifact;
    const resolution = { checkId: "duplicate-screening", note: "Distinct person; case notes record the check." };
    const riskPayload = suspendView(
      await collect.run.resume({
        resumeData: walk.resume("verify", "edit", {
          edits: { resolutions: [resolution] },
          actionHash: PROCEED_HASH,
        }),
      }),
      "risk-score",
    );
    walk.artifacts["risk-score"] = riskPayload.artifact;
    const approveOutcome = await collect.run.resume({
      resumeData: walk.resume("risk-score", "proceed", { actionHash: PROCEED_HASH }),
    });
    const payload = suspendView(approveOutcome, "approve");
    const artifact = ApproveArtifactSchema.parse(payload.artifact);

    expect(artifact.tier).toBe("high");
    expect(artifact.slaHours).toBe(48);
    expect(artifact.chain.map((entry) => [entry.role, entry.name])).toEqual([
      ["people-partner", "D. W."],
      ["department-head", "P. R."],
      ["people-ops-director", "A. N."],
    ]);
    expect(artifact.chain.every((entry) => entry.state === "pending")).toBe(true);
    expect(artifact.chain[0]?.requestedAt).toBe(FIXED_NOW.toISOString());
    expect(artifact.allApproved).toBe(false);
    expect(artifact.comments).toEqual([]);
    expect(artifact.summary).toBe("Tier high — 3 signer(s) required: D. W., P. R., A. N.");
    assertNoRawPii(artifact, RAW_NAMES);

    walk.artifacts["approve"] = payload.artifact;
    const blocked = await collect.run.resume({
      resumeData: walk.resume("approve", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "Every required signer must approve before the employee is provisioned",
    );

    // A failed run cannot be resumed; a fresh run replaying the approved chain
    // reaches the provision preview.
    const retry = new Walk({ input: JORDAN_HIGH });
    retry.artifacts["collect"] = collect.payload.artifact;
    retry.decisions["collect"] = {
      action: "edit",
      edits: allReceived(collect.payload.artifact),
      actionHash: PROCEED_HASH,
    };
    retry.artifacts["verify"] = verifyPayload.artifact;
    retry.decisions["verify"] = {
      action: "edit",
      edits: { resolutions: [resolution] },
      actionHash: PROCEED_HASH,
    };
    retry.artifacts["risk-score"] = riskPayload.artifact;
    retry.decisions["risk-score"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["approve"] = payload.artifact;
    retry.decisions["approve"] = {
      action: "edit",
      edits: approvedChain(payload.artifact),
      actionHash: PROCEED_HASH,
    };
    const retryRun = await h.flow.createRun();
    const approved = await retryRun.start({ inputData: retry.envelope() });
    const provisionPayload = suspendView(approved, "provision");
    const provision = ProvisionArtifactSchema.parse(provisionPayload.artifact);
    expect(provision.employee.employeeId).toBe(employeeIdFor(onboardingIdFor(JORDAN_HIGH)));
    expect(provision.accounts).toEqual(["aws", "github", "jira", "okta", "slack", "workday"]);
  });

  it("suspends at provision with the record preview and provisions idempotently", async () => {
    const registry = new MemoryOnboardingRegistry();
    const { run, walk, payload } = await walkToProvision({ registry });
    const artifact = ProvisionArtifactSchema.parse(payload.artifact);

    const onboardingId = onboardingIdFor(NEW_HIRE);
    const employeeId = employeeIdFor(onboardingId);
    expect(payload.target).toBe(`employee:${employeeId}`);
    expect(employeeId).toMatch(/^E-[0-9A-F]{6}$/);
    expect(artifact.employee).toEqual({
      employeeId,
      label: "N. E.",
      roleTitle: "Data Engineer",
      department: "Engineering",
      location: "Austin",
      managerId: "E-1002",
      accessTier: "medium",
      effectiveDate: "2026-10-05",
      status: "onboarding",
    });
    expect(artifact.accounts).toEqual(["aws", "github", "jira", "okta", "slack", "workday"]);
    expect(artifact.equipmentTicket.id).toMatch(/^EQ-[0-9A-F]{6}$/);
    expect(artifact.equipmentTicket.item).toBe("Laptop and peripheral kit");
    expect(artifact.payrollEnrollment.id).toMatch(/^PR-[0-9A-F]{6}$/);
    expect(artifact.payrollEnrollment.payGroup).toBe("Austin");
    expect(artifact.idempotencyKey).toBe(onboardingId);
    expect(artifact.existing).toBeNull();

    walk.artifacts["provision"] = payload.artifact;
    const done = (await run.resume({
      resumeData: walk.resume("provision", "proceed", { actionHash: PROCEED_HASH }),
    })) as { status?: string; result?: { receipt?: Record<string, unknown> } };
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toEqual({
      employeeId,
      label: "N. E.",
      department: "Engineering",
      accessTier: "medium",
      effectiveDate: "2026-10-05",
      accounts: ["aws", "github", "jira", "okta", "slack", "workday"],
      equipmentTicketId: artifact.equipmentTicket.id,
      payrollEnrollmentId: artifact.payrollEnrollment.id,
      created: true,
      registryRef: `hris:${employeeId}`,
    });
    expect(await registry.get(employeeId)).toMatchObject({
      employeeId,
      label: "N. E.",
      effectiveDate: "2026-10-05",
      equipmentTicketId: artifact.equipmentTicket.id,
    });

    // Every artifact that crossed a checkpoint stays free of raw PII.
    for (const stepArtifact of Object.values(walk.artifacts)) {
      assertNoRawPii(stepArtifact, RAW_NAMES);
    }
    assertNoRawPii(done.result, RAW_NAMES);
  });

  it("replays provisioning against an existing record without re-creating it", async () => {
    const onboardingId = onboardingIdFor(NEW_HIRE);
    const employeeId = employeeIdFor(onboardingId);
    const seeded: ProvisionedEmployee = {
      employeeId,
      label: "N. E.",
      roleTitle: "Data Engineer",
      department: "Engineering",
      location: "Austin",
      managerId: "E-1002",
      accessTier: "medium",
      effectiveDate: "2026-10-05",
      accounts: ["aws", "github", "jira", "okta", "slack", "workday"],
      equipmentTicketId: "EQ-OLD001",
      payrollEnrollmentId: "PR-OLD001",
      status: "onboarding",
      createdAt: "2026-09-01T10:00:00.000Z",
    };
    const registry = new MemoryOnboardingRegistry([seeded]);
    const { run, walk, payload } = await walkToProvision({ registry });
    const artifact = ProvisionArtifactSchema.parse(payload.artifact);
    expect(artifact.existing).toEqual({
      employeeId,
      createdAt: "2026-09-01T10:00:00.000Z",
    });

    walk.artifacts["provision"] = payload.artifact;
    const replay = (await run.resume({
      resumeData: walk.resume("provision", "edit", {
        edits: { existing: { employeeId, createdAt: "2026-09-01T10:00:00.000Z" } },
        actionHash: "1".repeat(64),
      }),
    })) as { status?: string; result?: { receipt?: Record<string, unknown> } };
    expect(replay.result?.receipt).toMatchObject({
      employeeId,
      effectiveDate: "2026-10-05",
      equipmentTicketId: "EQ-OLD001",
      payrollEnrollmentId: "PR-OLD001",
      created: false,
      registryRef: `hris:${employeeId}`,
    });
    expect(await registry.get(employeeId)).toMatchObject({ equipmentTicketId: "EQ-OLD001" });
  });
});

/** Walk the happy path from collect to the provision suspension. */
async function walkToProvision(
  options: { registry?: OnboardingRegistry; model?: OnboardingModel; walk?: Walk } = {},
): Promise<{ run: WorkflowRunHandle; walk: Walk; payload: SuspendView }> {
  const h = harness(options);
  const walk = options.walk ?? new Walk();
  const { run, payload } = await walkTo(h.flow, walk, "collect");
  walk.artifacts["collect"] = payload.artifact;
  const verify = suspendView(
    await run.resume({
      resumeData: walk.resume("collect", "edit", {
        edits: allReceived(payload.artifact),
        actionHash: PROCEED_HASH,
      }),
    }),
    "verify",
  );
  walk.artifacts["verify"] = verify.artifact;
  const risk = suspendView(
    await run.resume({
      resumeData: walk.resume("verify", "proceed", { actionHash: PROCEED_HASH }),
    }),
    "risk-score",
  );
  walk.artifacts["risk-score"] = risk.artifact;
  const approve = suspendView(
    await run.resume({
      resumeData: walk.resume("risk-score", "proceed", { actionHash: PROCEED_HASH }),
    }),
    "approve",
  );
  walk.artifacts["approve"] = approve.artifact;
  const provision = suspendView(
    await run.resume({
      resumeData: walk.resume("approve", "edit", {
        edits: approvedChain(approve.artifact),
        actionHash: PROCEED_HASH,
      }),
    }),
    "provision",
  );
  return { run, walk, payload: provision };
}
