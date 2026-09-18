import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import {
  ApproveArtifactSchema,
  CollectArtifactSchema,
  CreateArtifactSchema,
  RiskArtifactSchema,
  VENDORS_FLOW_STEPS,
  VendorsRunStateSchema,
  VerifyArtifactSchema,
  type VendorsRunState,
} from "./contracts.js";
import {
  matchCandidates,
  vendorIdFor,
  vendorTarget,
  type RiskModelContext,
  type VendorsModel,
  type VerifyModelContext,
} from "./flow.js";
import {
  MemoryVendorRegistry,
  type VendorMasterRecord,
  type VendorRegistry,
} from "./tools/vendor-registry.js";

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");
const TAX_ID = "GB-812345678";

const EXISTING_VENDOR: VendorMasterRecord = {
  vendorId: "V-2C91A7F4",
  legalName: "Northwind Supply Ltd",
  taxId: TAX_ID,
  country: "GB",
  requestor: "procurement@acme.test",
  status: "active",
  effectiveDate: "2026-01-05",
  createdAt: "2026-01-05T10:00:00.000Z",
};

class FakeModel implements VendorsModel {
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

function harness(options: { registry?: VendorRegistry; model?: VendorsModel } = {}) {
  const registry = options.registry ?? new MemoryVendorRegistry();
  const model = options.model ?? new FakeModel();
  const mastra = createAllRounderMastra({
    vendors: { registry, model, now: () => FIXED_NOW },
  });
  const flow = mastra.getWorkflow("vendorsFlow");
  if (flow === undefined) throw new Error("vendorsFlow is not registered");
  return { registry, model, flow, mastra };
}

type VendorsFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<VendorsFlowHandle["createRun"]>>;

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
    vendorName: "Northwind Supply Ltd",
    taxId: TAX_ID,
    requestor: "procurement@acme.test",
    country: "GB",
  };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "VEND-12";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): VendorsRunState {
    return VendorsRunStateSchema.parse({
      runId: this.runId,
      workflow: "vendors",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): VendorsRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return VendorsRunStateSchema.parse({ ...this.envelope(), decision });
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
  stopAt: (typeof VENDORS_FLOW_STEPS)[number],
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < VENDORS_FLOW_STEPS.length; index += 1) {
    const stepId = VENDORS_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, VENDORS_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: VendorsFlowHandle,
  walk: Walk,
  stopAt: (typeof VENDORS_FLOW_STEPS)[number],
): Promise<{ run: WorkflowRunHandle; walk: Walk; payload: SuspendView }> {
  const run = await flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), VENDORS_FLOW_STEPS[0]);
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
  options: { registry?: VendorRegistry; model?: VendorsModel; walk?: Walk } = {},
): Promise<{
  run: WorkflowRunHandle;
  walk: Walk;
  payload: SuspendView;
  model: VendorsModel;
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

describe("Mastra vendorsFlow", () => {
  it("registers named vendors steps in order", () => {
    const { flow, mastra } = harness();
    expect(flow.id).toBe("vendorsFlow");
    expect(Object.keys(flow.steps)).toEqual([...VENDORS_FLOW_STEPS]);
    expect(mastra.getAgent("vendorsVerifier").id).toBe("vendors-verifier");
    expect(mastra.getAgent("vendorsRisk").id).toBe("vendors-risk");
  });

  it("suspends at collect with the document checklist, totals and lock target", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "collect");
    const artifact = CollectArtifactSchema.parse(payload.artifact);
    expect(payload.target).toBe(`vendor-tax:${TAX_ID}`);
    expect(vendorTarget(TAX_ID)).toBe("vendor-tax:GB-812345678");
    expect(artifact.vendorName).toBe("Northwind Supply Ltd");
    expect(artifact.documents.map((document) => document.id)).toEqual([
      "registration",
      "tax-id",
      "bank-letter",
      "insurance",
    ]);
    expect(artifact.documents.every((document) => document.status === "missing")).toBe(true);
    expect(artifact.documents.every((document) => document.required)).toBe(true);
    expect(artifact.totals).toEqual({
      documents: 4,
      required: 4,
      received: 0,
      waived: 0,
      outstanding: 4,
    });
    expect(artifact.returnedNote).toBeNull();
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
          document.id === "bank-letter"
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
      "Bank letter is marked received; record the uploaded file or waive it",
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
          document.id === "insurance"
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
      "Insurance certificate is waived without a reason; add one or collect the document",
    );
  });

  it("suspends at verify with passing checks and the framed summary", async () => {
    const { payload, model } = await walkToVerify();
    const artifact = VerifyArtifactSchema.parse(payload.artifact);
    expect(payload.target).toBe(`vendor-tax:${TAX_ID}`);
    expect(artifact.checks.map((check) => check.id)).toEqual([
      "registration",
      "tax-id",
      "tax-format",
      "bank-letter",
      "insurance",
      "duplicate-screening",
    ]);
    expect(artifact.checks.every((check) => check.status === "pass")).toBe(true);
    expect(artifact.candidates).toEqual([]);
    expect(artifact.manualReview).toEqual({ required: false, items: [] });
    expect(artifact.summary).toBe("Verification summary from the scripted verifier.");
    expect(artifact.confidence).toBe(0.8);
    const calls = (model as FakeModel).verifyCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.country).toBe("GB");
  });

  it("routes failing checks to manual review with evidence and requires a resolution", async () => {
    const registry = new MemoryVendorRegistry([EXISTING_VENDOR]);
    const h = harness({ registry });
    const walk = new Walk({
      input: {
        vendorName: "Northwind Supply Limited",
        taxId: "GB812345678",
        requestor: "procurement@acme.test",
        country: "GB",
      },
    });
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
    expect(duplicate?.detail).toBe("Likely duplicate of V-2C91A7F4 (score 1.00).");
    expect(artifact.candidates).toEqual([
      {
        vendorId: "V-2C91A7F4",
        legalName: "Northwind Supply Ltd",
        taxId: TAX_ID,
        country: "GB",
        matchScore: 1,
        matchedOn: ["legalName", "taxId"],
      },
    ]);
    expect(artifact.manualReview.required).toBe(true);
    expect(artifact.manualReview.items).toEqual([
      { checkId: "duplicate-screening", reason: "Likely duplicate of V-2C91A7F4 (score 1.00)." },
    ]);

    // Proceeding without a manual-review note fails on this run.
    walk.artifacts["verify"] = payload.artifact;
    const blocked = await collect.run.resume({
      resumeData: walk.resume("verify", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "Record a manual-review note for every failing check before proceeding",
    );

    // A failed run cannot be resumed, so a fresh run replays the same decisions
    // with the resolution edit added.
    const retry = new Walk({
      input: {
        vendorName: "Northwind Supply Limited",
        taxId: "GB812345678",
        requestor: "procurement@acme.test",
        country: "GB",
      },
    });
    retry.artifacts["collect"] = collect.payload.artifact;
    retry.decisions["collect"] = {
      action: "edit",
      edits: allReceived(collect.payload.artifact),
      actionHash: PROCEED_HASH,
    };
    retry.artifacts["verify"] = payload.artifact;
    retry.decisions["verify"] = {
      action: "edit",
      edits: {
        resolutions: [
          { checkId: "duplicate-screening", note: "Separate legal entity; see case notes." },
        ],
      },
      actionHash: PROCEED_HASH,
    };
    const retryRun = await h.flow.createRun();
    const resolved = await retryRun.start({ inputData: retry.envelope() });
    const risk = suspendView(resolved, "risk-score");
    expect(RiskArtifactSchema.parse(risk.artifact).score).toBe(40);
  });

  it("scores the risk, picks the tier and previews the approver matrix", async () => {
    const model = new FakeModel();
    const h = harness({ model });
    const walk = new Walk();
    const collect = await walkTo(h.flow, walk, "collect");
    walk.artifacts["collect"] = collect.payload.artifact;
    const toVerify = await collect.run.resume({
      resumeData: walk.resume("collect", "edit", {
        edits: allReceived(collect.payload.artifact),
        actionHash: PROCEED_HASH,
      }),
    });
    const verifyPayload = suspendView(toVerify, "verify");
    walk.artifacts["verify"] = verifyPayload.artifact;
    const toRisk = await collect.run.resume({
      resumeData: walk.resume("verify", "proceed", { actionHash: PROCEED_HASH }),
    });
    const riskPayload = suspendView(toRisk, "risk-score");
    const artifact = RiskArtifactSchema.parse(riskPayload.artifact);

    expect(artifact.score).toBe(0);
    expect(artifact.tier).toBe("low");
    expect(artifact.factors).toEqual([
      {
        id: "document-coverage",
        label: "Document coverage",
        points: 0,
        detail: "4 of 4 required documents received.",
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
    expect(artifact.requiredSigners).toEqual(["procurement-lead"]);
    expect(artifact.matrix).toEqual([
      { tier: "low", requiredSigners: ["procurement-lead"] },
      { tier: "medium", requiredSigners: ["procurement-lead", "finance-manager"] },
      { tier: "high", requiredSigners: ["procurement-lead", "finance-manager", "cfo"] },
    ]);
    expect(artifact.summary).toBe("Risk narrative from the scripted analyst.");
    expect(artifact.confidence).toBe(0.72);
    expect((model as FakeModel).riskCalls).toHaveLength(1);
  });

  it("suspends at approve with the signer chain and blocks an incomplete chain", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const collect = await walkTo(flow, walk, "collect");
    walk.artifacts["collect"] = collect.payload.artifact;
    const verifyOutcome = await collect.run.resume({
      resumeData: walk.resume("collect", "edit", {
        edits: allReceived(collect.payload.artifact),
        actionHash: PROCEED_HASH,
      }),
    });
    const verifyPayload = suspendView(verifyOutcome, "verify");
    walk.artifacts["verify"] = verifyPayload.artifact;
    const riskOutcome = await collect.run.resume({
      resumeData: walk.resume("verify", "proceed", { actionHash: PROCEED_HASH }),
    });
    const riskPayload = suspendView(riskOutcome, "risk-score");
    walk.artifacts["risk-score"] = riskPayload.artifact;
    const approveOutcome = await collect.run.resume({
      resumeData: walk.resume("risk-score", "proceed", { actionHash: PROCEED_HASH }),
    });
    const payload = suspendView(approveOutcome, "approve");
    const artifact = ApproveArtifactSchema.parse(payload.artifact);

    expect(artifact.tier).toBe("low");
    expect(artifact.slaHours).toBe(48);
    expect(artifact.chain).toHaveLength(1);
    expect(artifact.chain[0]?.role).toBe("procurement-lead");
    expect(artifact.chain[0]?.name).toBe("Procurement Lead");
    expect(artifact.chain[0]?.state).toBe("pending");
    expect(artifact.chain[0]?.requestedAt).toBe(FIXED_NOW.toISOString());
    expect(artifact.allApproved).toBe(false);
    expect(artifact.comments).toEqual([]);
    expect(artifact.summary).toBe("Tier low — 1 signer(s) required: Procurement Lead.");

    walk.artifacts["approve"] = payload.artifact;
    const blocked = await collect.run.resume({
      resumeData: walk.resume("approve", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "Every required signer must approve before the vendor record is created",
    );

    // A failed run cannot be resumed; a fresh run replaying the approved chain
    // reaches the create preview.
    const retry = new Walk();
    retry.artifacts["collect"] = collect.payload.artifact;
    retry.decisions["collect"] = {
      action: "edit",
      edits: allReceived(collect.payload.artifact),
      actionHash: PROCEED_HASH,
    };
    retry.artifacts["verify"] = verifyPayload.artifact;
    retry.decisions["verify"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["risk-score"] = riskPayload.artifact;
    retry.decisions["risk-score"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["approve"] = payload.artifact;
    retry.decisions["approve"] = {
      action: "edit",
      edits: approvedChain(payload.artifact),
      actionHash: PROCEED_HASH,
    };
    const retryRun = await flow.createRun();
    const approved = await retryRun.start({ inputData: retry.envelope() });
    const createPayload = suspendView(approved, "create");
    expect(CreateArtifactSchema.parse(createPayload.artifact).record.vendorId).toBe(
      vendorIdFor(TAX_ID),
    );
  });

  it("suspends at create with the master-record preview and creates idempotently", async () => {
    const registry = new MemoryVendorRegistry();
    const { flow } = harness({ registry });
    const walk = new Walk();
    const collect = await walkTo(flow, walk, "collect");
    walk.artifacts["collect"] = collect.payload.artifact;
    const verifyOutcome = await collect.run.resume({
      resumeData: walk.resume("collect", "edit", {
        edits: allReceived(collect.payload.artifact),
        actionHash: PROCEED_HASH,
      }),
    });
    const verifyPayload = suspendView(verifyOutcome, "verify");
    walk.artifacts["verify"] = verifyPayload.artifact;
    const riskOutcome = await collect.run.resume({
      resumeData: walk.resume("verify", "proceed", { actionHash: PROCEED_HASH }),
    });
    const riskPayload = suspendView(riskOutcome, "risk-score");
    walk.artifacts["risk-score"] = riskPayload.artifact;
    const approveOutcome = await collect.run.resume({
      resumeData: walk.resume("risk-score", "proceed", { actionHash: PROCEED_HASH }),
    });
    const approvePayload = suspendView(approveOutcome, "approve");
    walk.artifacts["approve"] = approvePayload.artifact;
    const createOutcome = await collect.run.resume({
      resumeData: walk.resume("approve", "edit", {
        edits: approvedChain(approvePayload.artifact),
        actionHash: PROCEED_HASH,
      }),
    });
    const payload = suspendView(createOutcome, "create");
    const artifact = CreateArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe(`vendor-tax:${TAX_ID}`);
    expect(artifact.record.vendorId).toBe(vendorIdFor(TAX_ID));
    expect(artifact.record.legalName).toBe("Northwind Supply Ltd");
    expect(artifact.record.status).toBe("active");
    expect(artifact.record.effectiveDate).toBe("2026-09-12");
    expect(artifact.idempotencyKey).toBe(TAX_ID);
    expect(artifact.welcomePacket).toBe(true);
    expect(artifact.existing).toBeNull();

    walk.artifacts["create"] = payload.artifact;
    const done = (await collect.run.resume({
      resumeData: walk.resume("create", "proceed", { actionHash: PROCEED_HASH }),
    })) as { status?: string; result?: { receipt?: Record<string, unknown> } };
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toEqual({
      vendorId: vendorIdFor(TAX_ID),
      legalName: "Northwind Supply Ltd",
      taxId: TAX_ID,
      effectiveDate: "2026-09-12",
      welcomePacket: true,
      created: true,
      registryRef: `vendor-registry:${vendorIdFor(TAX_ID)}`,
    });
    expect(await registry.get(TAX_ID)).toMatchObject({
      vendorId: vendorIdFor(TAX_ID),
      legalName: "Northwind Supply Ltd",
    });

    // A second onboarding of the same tax ID reuses the record.
    const again = new MemoryVendorRegistry([EXISTING_VENDOR]);
    const second = harness({ registry: again });
    const secondWalk = new Walk();
    const secondCollect = await walkTo(second.flow, secondWalk, "collect");
    secondWalk.artifacts["collect"] = secondCollect.payload.artifact;
    const secondVerify = suspendView(
      await secondCollect.run.resume({
        resumeData: secondWalk.resume("collect", "edit", {
          edits: allReceived(secondCollect.payload.artifact),
          actionHash: PROCEED_HASH,
        }),
      }),
      "verify",
    );
    secondWalk.artifacts["verify"] = secondVerify.artifact;
    const secondRisk = suspendView(
      await secondCollect.run.resume({
        resumeData: secondWalk.resume("verify", "edit", {
          edits: {
            resolutions: [
              {
                checkId: "duplicate-screening",
                note: "Re-onboarding the same vendor; case notes record the approval.",
              },
            ],
          },
          actionHash: PROCEED_HASH,
        }),
      }),
      "risk-score",
    );
    secondWalk.artifacts["risk-score"] = secondRisk.artifact;
    const secondApprove = suspendView(
      await secondCollect.run.resume({
        resumeData: secondWalk.resume("risk-score", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "approve",
    );
    secondWalk.artifacts["approve"] = secondApprove.artifact;
    const secondCreate = suspendView(
      await secondCollect.run.resume({
        resumeData: secondWalk.resume("approve", "edit", {
          edits: approvedChain(secondApprove.artifact),
          actionHash: PROCEED_HASH,
        }),
      }),
      "create",
    );
    const secondArtifact = CreateArtifactSchema.parse(secondCreate.artifact);
    expect(secondArtifact.record.vendorId).toBe("V-2C91A7F4");
    expect(secondArtifact.existing).toEqual({
      vendorId: "V-2C91A7F4",
      legalName: "Northwind Supply Ltd",
      createdAt: "2026-01-05T10:00:00.000Z",
    });
    secondWalk.artifacts["create"] = secondCreate.artifact;
    const replay = (await secondCollect.run.resume({
      resumeData: secondWalk.resume("create", "edit", {
        edits: { welcomePacket: false },
        actionHash: "1".repeat(64),
      }),
    })) as { status?: string; result?: { receipt?: Record<string, unknown> } };
    expect(replay.result?.receipt).toMatchObject({
      vendorId: "V-2C91A7F4",
      welcomePacket: false,
      created: false,
      registryRef: "vendor-registry:V-2C91A7F4",
    });
  });
});

describe("vendors tooling", () => {
  it("creates master records idempotently by tax-ID key", async () => {
    const registry = new MemoryVendorRegistry();
    const record: VendorMasterRecord = {
      vendorId: vendorIdFor(TAX_ID),
      legalName: "Northwind Supply Ltd",
      taxId: TAX_ID,
      country: "GB",
      requestor: "procurement@acme.test",
      status: "active",
      effectiveDate: "2026-09-12",
      createdAt: FIXED_NOW.toISOString(),
    };
    const first = await registry.create(record);
    expect(first.created).toBe(true);
    const second = await registry.create({ ...record, vendorId: "V-DIFFERENT" });
    expect(second.created).toBe(false);
    expect(second.record.vendorId).toBe(record.vendorId);
    expect(await registry.list()).toEqual([record]);
  });

  it("scores duplicate candidates on legal name and tax ID", () => {
    const candidates = matchCandidates("Northwind Supply Limited", "GB812345678", [
      EXISTING_VENDOR,
      {
        ...EXISTING_VENDOR,
        vendorId: "V-UNRELATED",
        legalName: "Aurora Logistics BV",
        taxId: "NL-991122334",
      },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      vendorId: "V-2C91A7F4",
      legalName: "Northwind Supply Ltd",
      taxId: TAX_ID,
      country: "GB",
      matchScore: 1,
      matchedOn: ["legalName", "taxId"],
    });
    expect(matchCandidates("Totally Different Co", "FR-102938475", [EXISTING_VENDOR])).toEqual([]);
  });
});
