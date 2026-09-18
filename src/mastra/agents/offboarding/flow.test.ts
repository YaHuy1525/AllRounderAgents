import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import {
  ApproveArtifactSchema,
  AttestArtifactSchema,
  AuditArtifactSchema,
  IntakeArtifactSchema,
  OFFBOARDING_FLOW_STEPS,
  OffboardingRunStateSchema,
  RevokeArtifactSchema,
  type OffboardingRunState,
} from "./contracts.js";
import {
  offboardingIdFor,
  type AuditModelContext,
  type OffboardingModel,
} from "./flow.js";
import { MemoryEmployeeDirectory } from "../hr/directory.js";
import { assertNoRawPii } from "../hr/pii.js";
import {
  MemoryOffboardingRegistry,
  type AttestationRecord,
  type OffboardingRegistry,
} from "./tools/offboarding-registry.js";

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");

const LEAVER = {
  employeeId: "E-1005",
  lastDay: "2026-10-30",
  reason: "Resignation — relocating to a new city.",
} as const;

/** Every raw name the fixtures (and this suite) ever feed the lane. */
const RAW_NAMES = [
  "Jordan Avery",
  "Priya Raman",
  "Sam Okafor",
  "Lena Fischer",
  "Marco Silveira",
  "Dara Whitfield",
  "Tomas Berg",
  "Ada Nakamura",
];

class FakeModel implements OffboardingModel {
  readonly auditCalls: AuditModelContext[] = [];

  async audit(context: AuditModelContext) {
    this.auditCalls.push(context);
    return {
      summary: "Audit narrative from the scripted auditor.",
      confidence: 0.77,
    };
  }
}

function harness(
  options: { registry?: OffboardingRegistry | undefined; model?: OffboardingModel | undefined } = {},
) {
  const directory = new MemoryEmployeeDirectory();
  const registry = options.registry ?? new MemoryOffboardingRegistry();
  const model = options.model ?? new FakeModel();
  const mastra = createAllRounderMastra({
    offboarding: { directory, registry, model, now: () => FIXED_NOW },
  });
  const flow = mastra.getWorkflow("offboardingFlow");
  if (flow === undefined) throw new Error("offboardingFlow is not registered");
  return { registry, model, flow, mastra };
}

type OffboardingFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<OffboardingFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = { ...LEAVER };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "HR-31";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): OffboardingRunState {
    return OffboardingRunStateSchema.parse({
      runId: this.runId,
      workflow: "offboarding",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): OffboardingRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return OffboardingRunStateSchema.parse({ ...this.envelope(), decision });
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
  stopAt: (typeof OFFBOARDING_FLOW_STEPS)[number],
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < OFFBOARDING_FLOW_STEPS.length; index += 1) {
    const stepId = OFFBOARDING_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, OFFBOARDING_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: OffboardingFlowHandle,
  walk: Walk,
  stopAt: (typeof OFFBOARDING_FLOW_STEPS)[number],
): Promise<{ run: WorkflowRunHandle; walk: Walk; payload: SuspendView }> {
  const run = await flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), OFFBOARDING_FLOW_STEPS[0]);
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

/** The approve edits that sign off every item, high-blast rows included. */
function approvedItems(artifact: Record<string, unknown>): Record<string, unknown> {
  const items = (artifact.items as Array<Record<string, unknown>>).map((item) => ({
    ...item,
    approved: true,
    approver: item.requiresExplicitApproval === true ? "A. N." : null,
    note:
      item.requiresExplicitApproval === true
        ? "Signed off with the pending batch reassigned."
        : "Standard revocation — covered by the case approval.",
  }));
  return { items, allApproved: true };
}

interface CompletionResult {
  status?: string;
  result?: {
    receipt?: Record<string, unknown>;
    effects?: Record<string, { receipt?: Record<string, unknown> } | undefined>;
  };
}

interface WalkOptions {
  registry?: OffboardingRegistry;
  model?: OffboardingModel;
  walk?: Walk;
}

/** Walk the happy path from intake to the approve suspension. */
async function walkToApprove(options: WalkOptions = {}): Promise<{
  flow: OffboardingFlowHandle;
  run: WorkflowRunHandle;
  walk: Walk;
  payload: SuspendView;
  model: OffboardingModel;
  registry: OffboardingRegistry;
}> {
  const h = harness({ registry: options.registry, model: options.model });
  const walk = options.walk ?? new Walk();
  const { run, payload } = await walkTo(h.flow, walk, "intake");
  walk.artifacts["intake"] = payload.artifact;
  const audit = suspendView(
    await run.resume({
      resumeData: walk.resume("intake", "proceed", { actionHash: PROCEED_HASH }),
    }),
    "access-audit",
  );
  walk.artifacts["access-audit"] = audit.artifact;
  const approve = suspendView(
    await run.resume({
      resumeData: walk.resume("access-audit", "proceed", { actionHash: PROCEED_HASH }),
    }),
    "approve",
  );
  return { flow: h.flow, run, walk, payload: approve, model: h.model, registry: h.registry };
}

/** Walk the happy path from intake to the attest suspension. */
async function walkToAttest(options: WalkOptions = {}): Promise<{
  flow: OffboardingFlowHandle;
  run: WorkflowRunHandle;
  walk: Walk;
  payload: SuspendView;
  model: OffboardingModel;
  registry: OffboardingRegistry;
}> {
  const h = await walkToApprove(options);
  h.walk.artifacts["approve"] = h.payload.artifact;
  const revoke = suspendView(
    await h.run.resume({
      resumeData: h.walk.resume("approve", "edit", {
        edits: approvedItems(h.payload.artifact),
        actionHash: PROCEED_HASH,
      }),
    }),
    "revoke",
  );
  h.walk.artifacts["revoke"] = revoke.artifact;
  const attest = suspendView(
    await h.run.resume({
      resumeData: h.walk.resume("revoke", "proceed", { actionHash: PROCEED_HASH }),
    }),
    "attest",
  );
  return { ...h, payload: attest };
}

describe("Mastra offboardingFlow", () => {
  it("registers named offboarding steps in order", () => {
    const { flow, mastra } = harness();
    expect(flow.id).toBe("offboardingFlow");
    expect(Object.keys(flow.steps)).toEqual([...OFFBOARDING_FLOW_STEPS]);
    expect(mastra.getAgent("offboardingAudit").id).toBe("offboarding-audit");
  });

  it("suspends at intake with the resolved leaver and the lock target", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "intake");
    const artifact = IntakeArtifactSchema.parse(payload.artifact);
    expect(payload.target).toBe("employee:E-1005");
    expect(offboardingIdFor(LEAVER)).toMatch(/^OF-[0-9A-F]{8}$/);
    expect(artifact.offboardingId).toBe(offboardingIdFor(LEAVER));
    expect(artifact.employeeId).toBe("E-1005");
    expect(artifact.employeeLabel).toBe("M. S.");
    expect(artifact.roleTitle).toBe("Finance Manager");
    expect(artifact.accessTier).toBe("high");
    expect(artifact.managerId).toBe("E-1008");
    expect(artifact.lastDay).toBe("2026-10-30");
    expect(artifact.systems).toEqual(["banking", "erp", "okta", "payroll", "slack"]);
    assertNoRawPii(artifact, RAW_NAMES);
  });

  it("fails loudly when the employee is not in the directory", async () => {
    const { flow } = harness();
    const walk = new Walk({ input: { ...LEAVER, employeeId: "E-9999" } });
    const run = await flow.createRun();
    const message = await failureMessage(Promise.resolve(await run.start({ inputData: walk.envelope() })));
    expect(message).toContain("Employee E-9999 is not in the directory");
  });

  it("suspends at access-audit with blast radius, ownership and risks", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run, payload: intakePayload } = await walkTo(flow, walk, "intake");
    walk.artifacts["intake"] = intakePayload.artifact;
    const outcome = await run.resume({
      resumeData: walk.resume("intake", "proceed", { actionHash: PROCEED_HASH }),
    });
    const payload = suspendView(outcome, "access-audit");
    const artifact = AuditArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("employee:E-1005");
    expect(artifact.entries.map((entry) => [entry.system, entry.blastRadius, entry.riskScore, entry.reversibility])).toEqual([
      ["banking", "high", 75, "recoverable"],
      ["erp", "high", 55, "recoverable"],
      ["okta", "medium", 50, "recoverable"],
      ["payroll", "high", 70, "recoverable"],
      ["slack", "low", 20, "reversible"],
    ]);
    expect(artifact.dataOwnership).toEqual([
      { system: "banking", dataClass: "Payment approval rights", owner: "Finance" },
      { system: "erp", dataClass: "Financial records and POs", owner: "Finance" },
      { system: "okta", dataClass: "Identity and SSO sessions", owner: "IT Operations" },
      { system: "payroll", dataClass: "Compensation and final-pay data", owner: "Finance" },
      { system: "slack", dataClass: "Workspace messages and files", owner: "IT Operations" },
    ]);
    expect(artifact.risks).toEqual([
      {
        id: "high-blast",
        label: "High-blast revocations",
        tier: "high",
        detail: "3 system(s) require explicit per-item approval: banking, erp, payroll.",
      },
      {
        id: "irreversible",
        label: "Irreversible actions",
        tier: "low",
        detail: "No irreversible actions.",
      },
      {
        id: "standard-revocations",
        label: "Standard revocations",
        tier: "medium",
        detail: "2 system(s) follow the standard revoke path.",
      },
    ]);
    expect(artifact.summary).toBe("Audit narrative from the scripted auditor.");
    expect(artifact.confidence).toBe(0.77);
    expect(model.auditCalls).toHaveLength(1);
    expect(model.auditCalls[0]?.employeeLabel).toBe("M. S.");
    assertNoRawPii(artifact, RAW_NAMES);

    // Regeneration re-frames the audit with the human guidance.
    const regenerated = await run.resume({
      resumeData: walk.resume("access-audit", "regenerate", {
        guidance: "Lead with the payment-batch risk.",
      }),
    });
    const second = suspendView(regenerated, "access-audit");
    expect(model.auditCalls).toHaveLength(2);
    expect(model.auditCalls[1]?.guidance).toBe("Lead with the payment-batch risk.");
    expect(AuditArtifactSchema.parse(second.artifact).summary).toBe(
      "Audit narrative from the scripted auditor.",
    );
  });

  it("risk-scores every revocation item and gates high-blast items on approval", async () => {
    const { run, walk, payload } = await walkToApprove();
    const artifact = ApproveArtifactSchema.parse(payload.artifact);

    expect(artifact.explicitApprovalsRequired).toBe(3);
    expect(artifact.allApproved).toBe(false);
    expect(
      artifact.items.map((item) => [item.system, item.requiresExplicitApproval, item.approved]),
    ).toEqual([
      ["banking", true, false],
      ["erp", true, false],
      ["okta", false, true],
      ["payroll", true, false],
      ["slack", false, true],
    ]);
    expect(artifact.summary).toBe(
      "5 revocation(s) — 3 high-blast system(s) need explicit per-item approval: Banking, ERP, Payroll system.",
    );
    assertNoRawPii(artifact, RAW_NAMES);

    // Proceeding without signing the high-blast rows off fails on this run.
    walk.artifacts["approve"] = payload.artifact;
    const blocked = await run.resume({
      resumeData: walk.resume("approve", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "Explicit approval is required before revoking high-blast access (Banking, ERP, Payroll system)",
    );
  });

  it("rejects a high-blast approval without a recorded approver", async () => {
    const { run, walk, payload } = await walkToApprove();
    const items = (payload.artifact.items as Array<Record<string, unknown>>).map((item) => ({
      ...item,
      approved: true,
      approver: item.requiresExplicitApproval === true ? "" : null,
    }));
    walk.artifacts["approve"] = payload.artifact;
    const blocked = await run.resume({
      resumeData: walk.resume("approve", "edit", {
        edits: { items, allApproved: true },
        actionHash: PROCEED_HASH,
      }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "Banking is approved without a recorded approver; record who signed off",
    );
  });

  it("suspends at revoke with the plan once every item is approved", async () => {
    const { run, walk, payload } = await walkToApprove();
    walk.artifacts["approve"] = payload.artifact;
    const outcome = await run.resume({
      resumeData: walk.resume("approve", "edit", {
        edits: approvedItems(payload.artifact),
        actionHash: PROCEED_HASH,
      }),
    });
    const revokePayload = suspendView(outcome, "revoke");
    const artifact = RevokeArtifactSchema.parse(revokePayload.artifact);

    expect(revokePayload.target).toBe("employee:E-1005");
    expect(artifact.actions.map((action) => [action.system, action.status])).toEqual([
      ["banking", "pending"],
      ["erp", "pending"],
      ["okta", "pending"],
      ["payroll", "pending"],
      ["slack", "pending"],
    ]);
    expect(artifact.summary).toBe(
      "Revokes 5 system(s) for E-1005; each revocation is idempotent by employee and system.",
    );
  });

  it("revokes per system and attests the case close with both receipts", async () => {
    const registry = new MemoryOffboardingRegistry();
    const { run, walk, payload } = await walkToAttest({ registry });
    const artifact = AttestArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("employee:E-1005");
    expect(artifact.revocation).toEqual({
      revoked: ["banking", "erp", "okta", "payroll", "slack"],
      failed: [],
    });
    expect(artifact.finalPay.items).toEqual([
      {
        id: "access-revocation",
        label: "Access revocation",
        status: "ready",
        detail: "5 system(s) revoked.",
      },
      {
        id: "leave-balance",
        label: "Outstanding leave",
        status: "pending",
        detail: "15 day(s) to settle in the final pay cycle.",
      },
      {
        id: "equipment-return",
        label: "Equipment returns",
        status: "pending",
        detail: "3 item(s) outstanding.",
      },
    ]);
    expect(artifact.finalPay.outstanding).toBe(2);
    expect(artifact.equipment.items).toEqual([
      {
        id: "laptop",
        label: "Laptop and peripheral kit",
        status: "outstanding",
        detail: "Return coordinated with IT operations at Lisbon.",
      },
      {
        id: "badge",
        label: "Building badge",
        status: "outstanding",
        detail: "Return to workplace operations.",
      },
      {
        id: "token",
        label: "Security token",
        status: "outstanding",
        detail: "Return to IT operations.",
      },
    ]);
    expect(artifact.existing).toBeNull();
    expect(artifact.summary).toBe(
      "Case closes for E-1005 on 2026-10-30: 5 revoked, 0 failed, 3 equipment item(s) outstanding.",
    );
    expect(await registry.revokedSystems("E-1005")).toEqual([
      "banking",
      "erp",
      "okta",
      "payroll",
      "slack",
    ]);
    assertNoRawPii(artifact, RAW_NAMES);

    // Completing attest closes the case with both step receipts.
    walk.artifacts["attest"] = payload.artifact;
    const done = (await run.resume({
      resumeData: walk.resume("attest", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toEqual({
      offboardingId: offboardingIdFor(LEAVER),
      employeeId: "E-1005",
      label: "M. S.",
      revokedSystems: ["banking", "erp", "okta", "payroll", "slack"],
      failedSystems: [],
      equipmentOutstanding: ["Laptop and peripheral kit", "Building badge", "Security token"],
      finalPayReady: false,
      caseClosed: true,
      created: true,
      registryRef: "offboard:E-1005",
      closedAt: FIXED_NOW.toISOString(),
    });
    expect(done.result?.effects?.revoke?.receipt).toEqual({
      employeeId: "E-1005",
      label: "M. S.",
      revoked: ["banking", "erp", "okta", "payroll", "slack"],
      failed: [],
      replayed: 0,
      idempotencyKey: offboardingIdFor(LEAVER),
      registryRef: "offboard:E-1005",
      completedAt: FIXED_NOW.toISOString(),
    });
    expect(done.result?.effects?.attest?.receipt).toMatchObject({
      caseClosed: true,
      created: true,
    });
    expect(await registry.attestation("E-1005")).toMatchObject({
      offboardingId: offboardingIdFor(LEAVER),
      lastDay: "2026-10-30",
      closedAt: FIXED_NOW.toISOString(),
    });

    // Every artifact that crossed a checkpoint stays free of raw PII.
    for (const stepArtifact of Object.values(walk.artifacts)) {
      assertNoRawPii(stepArtifact, RAW_NAMES);
    }
    assertNoRawPii(done.result, RAW_NAMES);
  });

  it("lists failed revocations and gates the case close on acknowledgements", async () => {
    const registry = new MemoryOffboardingRegistry({
      failures: {
        banking: "Pending payment batch must be reassigned before the banking user is removed.",
      },
    });
    const { flow, run, walk, payload } = await walkToAttest({ registry });
    const artifact = AttestArtifactSchema.parse(payload.artifact);

    expect(artifact.revocation.revoked).toEqual(["erp", "okta", "payroll", "slack"]);
    expect(artifact.revocation.failed).toEqual([
      {
        system: "banking",
        reason: "Pending payment batch must be reassigned before the banking user is removed.",
      },
    ]);
    expect(artifact.finalPay.items[0]).toEqual({
      id: "access-revocation",
      label: "Access revocation",
      status: "pending",
      detail: "1 failed revocation(s) need an acknowledgement note.",
    });
    assertNoRawPii(artifact, RAW_NAMES);

    // Closing without an acknowledgement fails on this run.
    walk.artifacts["attest"] = payload.artifact;
    const blocked = await run.resume({
      resumeData: walk.resume("attest", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "Record an acknowledgement for every failed revocation before closing the case (banking)",
    );

    // A fresh run replaying the reviewed steps acknowledges the failure and
    // lists it in the receipt instead of swallowing it.
    const retry = new Walk();
    retry.decisions["intake"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["intake"] = requireArtifact(walk, "intake");
    retry.decisions["access-audit"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["access-audit"] = requireArtifact(walk, "access-audit");
    retry.decisions["approve"] = {
      action: "edit",
      edits: approvedItems(requireArtifact(walk, "approve")),
      actionHash: PROCEED_HASH,
    };
    retry.artifacts["approve"] = requireArtifact(walk, "approve");
    retry.decisions["revoke"] = { action: "proceed", actionHash: PROCEED_HASH };
    retry.artifacts["revoke"] = requireArtifact(walk, "revoke");
    const retryRun = await flow.createRun();
    const retriedAttest = suspendView(await retryRun.start({ inputData: retry.envelope() }), "attest");
    expect(AttestArtifactSchema.parse(retriedAttest.artifact).revocation.failed).toEqual([
      {
        system: "banking",
        reason: "Pending payment batch must be reassigned before the banking user is removed.",
      },
    ]);
    retry.artifacts["attest"] = retriedAttest.artifact;
    const done = (await retryRun.resume({
      resumeData: retry.resume("attest", "edit", {
        edits: {
          acknowledgements: [
            { system: "banking", note: "Batch reassigned to E-1004; case notes record it." },
          ],
        },
        actionHash: "1".repeat(64),
      }),
    })) as CompletionResult;
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toMatchObject({
      failedSystems: ["banking"],
      caseClosed: true,
      created: true,
    });
    expect(done.result?.effects?.revoke?.receipt).toMatchObject({
      revoked: ["erp", "okta", "payroll", "slack"],
      failed: [
        {
          system: "banking",
          reason: "Pending payment batch must be reassigned before the banking user is removed.",
        },
      ],
      replayed: 4,
    });
  });

  it("replays revocations idempotently by employee and system", async () => {
    const registry = new MemoryOffboardingRegistry();
    const first = await walkToAttest({ registry });
    first.walk.artifacts["attest"] = first.payload.artifact;
    await first.run.resume({
      resumeData: first.walk.resume("attest", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await registry.revokedSystems("E-1005")).toEqual([
      "banking",
      "erp",
      "okta",
      "payroll",
      "slack",
    ]);

    // A fresh walk with a lost effect map replays against the same registry.
    const second = await walkToAttest({ registry });
    second.walk.artifacts["attest"] = second.payload.artifact;
    const done = (await second.run.resume({
      resumeData: second.walk.resume("attest", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(done.status).toBe("success");
    expect(done.result?.effects?.revoke?.receipt).toMatchObject({
      revoked: ["banking", "erp", "okta", "payroll", "slack"],
      failed: [],
      replayed: 5,
    });
    expect(done.result?.receipt).toMatchObject({ created: false, caseClosed: true });
  });

  it("replays the case close against an existing attestation without re-closing", async () => {
    const offboardingId = offboardingIdFor(LEAVER);
    const seeded: AttestationRecord = {
      employeeId: "E-1005",
      offboardingId,
      lastDay: "2026-10-30",
      revokedSystems: ["banking", "erp", "okta", "payroll", "slack"],
      failedSystems: [],
      equipmentOutstanding: ["Laptop and peripheral kit"],
      finalPayReady: false,
      closedAt: "2026-09-01T10:00:00.000Z",
    };
    const registry = new MemoryOffboardingRegistry();
    await registry.attest(seeded);
    const { run, walk, payload } = await walkToAttest({ registry });
    const artifact = AttestArtifactSchema.parse(payload.artifact);
    expect(artifact.existing).toEqual({ closedAt: "2026-09-01T10:00:00.000Z" });

    walk.artifacts["attest"] = payload.artifact;
    const done = (await run.resume({
      resumeData: walk.resume("attest", "proceed", { actionHash: PROCEED_HASH }),
    })) as CompletionResult;
    expect(done.result?.receipt).toMatchObject({
      caseClosed: true,
      created: false,
      closedAt: "2026-09-01T10:00:00.000Z",
      equipmentOutstanding: ["Laptop and peripheral kit"],
    });
    expect(await registry.attestation("E-1005")).toMatchObject({
      closedAt: "2026-09-01T10:00:00.000Z",
    });
  });

  it("skips explicit approvals for a low-tier leaver", async () => {
    const walk = new Walk({ input: { ...LEAVER, employeeId: "E-1003" } });
    const { run, walk: driven, payload } = await walkToApprove({ walk });
    const artifact = ApproveArtifactSchema.parse(payload.artifact);

    expect(artifact.employeeLabel).toBe("S. O.");
    expect(artifact.explicitApprovalsRequired).toBe(0);
    expect(artifact.allApproved).toBe(true);
    expect(artifact.summary).toBe(
      "3 revocation(s) — no high-blast systems; the case approval covers every item.",
    );

    // Proceeding straight through opens the revoke checkpoint.
    driven.artifacts["approve"] = payload.artifact;
    const outcome = await run.resume({
      resumeData: driven.resume("approve", "proceed", { actionHash: PROCEED_HASH }),
    });
    const revoke = RevokeArtifactSchema.parse(suspendView(outcome, "revoke").artifact);
    expect(revoke.actions.map((action) => action.system)).toEqual(["okta", "slack", "zendesk"]);
  });
});
