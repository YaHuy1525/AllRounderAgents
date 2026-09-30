import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import {
  ApproveArtifactSchema,
  BillModelOutputSchema,
  BILLS_FLOW_STEPS,
  BillsIntakeArtifactSchema,
  BillsRunStateSchema,
  ExtractArtifactSchema,
  PostArtifactSchema,
  type BillModelOutput,
  type BillsRunState,
  type VendorRecord,
} from "./contracts.js";
import type { BillExtractContext, BillModel } from "./flow.js";
import { MemoryBillsLedger, type BillsLedger } from "./tools/ledger.js";
import {
  MemoryVendorRegistry,
  type MemoryVendorEntry,
  type VendorLookup,
  type VendorRegistry,
} from "./tools/vendors.js";

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-30T09:00:00.000Z");

const EMAIL = {
  messageId: "mail-1",
  from: "billing@acmepower.com.au",
  fromName: "Acme Power Billing",
  to: "bills@in.msp.example",
  subject: "Invoice INV-2041 for August usage",
  text: "Attached is invoice INV-2041 for AUD 1,320.00 including GST. Payment to Acme Power Pty Ltd, BSB 012-345, account 12345678.",
  receivedAt: "2026-09-30T08:55:00.000Z",
} as const;

const HAPPY_BILL: BillModelOutput = {
  vendor: {
    name: "Acme Power Pty Ltd",
    accountName: "Acme Power Pty Ltd",
    bsb: "012-345",
    accountNumber: "12345678",
  },
  bill: {
    number: "INV-2041",
    issueDate: "2026-09-01",
    dueDate: "2026-09-15",
    currency: "AUD",
    totalCents: 132_000,
    taxCents: 12_000,
    lineItems: [{ description: "Electricity 1 Aug to 31 Aug", amountCents: 132_000 }],
  },
};

const NO_NUMBER_BILL: BillModelOutput = {
  ...HAPPY_BILL,
  bill: { ...HAPPY_BILL.bill, number: null },
};

const EMPTY_BILL: BillModelOutput = {
  vendor: { name: null, accountName: null, bsb: null, accountNumber: null },
  bill: {
    number: null,
    issueDate: null,
    dueDate: null,
    currency: "AUD",
    totalCents: null,
    taxCents: null,
    lineItems: [],
  },
};

const REGISTERED_VENDOR: MemoryVendorEntry = {
  ref: "acme-power",
  name: "Acme Power Pty Ltd",
  accountName: "Acme Power Pty Ltd",
  bsb: "012345",
  accountNumber: "12345678",
  emails: ["billing@acmepower.com.au"],
};

class FakeBillModel implements BillModel {
  readonly calls: BillExtractContext[] = [];

  constructor(private readonly output: BillModelOutput) {}

  async extract(context: BillExtractContext): Promise<BillModelOutput> {
    this.calls.push(context);
    return BillModelOutputSchema.parse(this.output);
  }
}

/** Counts the ledger calls so replay tests can prove they never re-execute. */
class CountingLedger implements BillsLedger {
  posts = 0;

  constructor(private readonly inner: BillsLedger) {}

  get provider(): string {
    return this.inner.provider;
  }

  post(request: Parameters<BillsLedger["post"]>[0]) {
    this.posts += 1;
    return this.inner.post(request);
  }
}

class RecordingRegistry implements VendorRegistry {
  readonly queries: VendorLookup[] = [];

  constructor(
    private readonly inner: VendorRegistry = new MemoryVendorRegistry([REGISTERED_VENDOR]),
  ) {}

  async lookup(query: VendorLookup): Promise<VendorRecord | null> {
    this.queries.push(query);
    return this.inner.lookup(query);
  }
}

function harness(
  options: {
    ledger?: BillsLedger;
    registry?: VendorRegistry;
    model?: BillModel;
  } = {},
) {
  const ledger = options.ledger ?? new MemoryBillsLedger();
  const registry = options.registry ?? new MemoryVendorRegistry([REGISTERED_VENDOR]);
  const model = options.model ?? new FakeBillModel(HAPPY_BILL);
  const mastra = createAllRounderMastra({
    bills: { ledger, registry, model, now: () => FIXED_NOW },
  });
  const flow = mastra.getWorkflow("billsFlow");
  if (flow === undefined) throw new Error("billsFlow is not registered");
  return { ledger, registry, model, flow, mastra };
}

type BillsFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<BillsFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes. Suspend-payload effects are absorbed the
 * way the service merges them, so a re-drive sees every recorded side effect.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = { ...EMAIL };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "BILL-7";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): BillsRunState {
    return BillsRunStateSchema.parse({
      runId: this.runId,
      workflow: "bills",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): BillsRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return BillsRunStateSchema.parse({ ...this.envelope(), decision });
  }
}

interface SuspendView {
  artifact: Record<string, unknown>;
  target?: string;
  effects?: Record<string, Record<string, unknown>>;
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
 * the flow suspends at `stopAt`. Every suspend payload's effects are absorbed
 * into the walk, mirroring the API's merge of `_suspend_effects`.
 */
async function runForward(
  run: WorkflowRunHandle,
  walk: Walk,
  startIndex: number,
  currentPayload: SuspendView,
  stopAt: (typeof BILLS_FLOW_STEPS)[number],
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < BILLS_FLOW_STEPS.length; index += 1) {
    const stepId = BILLS_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (payload.effects !== undefined) walk.effects = { ...walk.effects, ...payload.effects };
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH, receiptId: "rcpt-1" }),
    });
    payload = suspendView(outcome, BILLS_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

interface WalkOptions {
  ledger?: BillsLedger;
  registry?: VendorRegistry;
  model?: BillModel;
  walk?: Walk;
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkWith(
  options: WalkOptions,
  stopAt: (typeof BILLS_FLOW_STEPS)[number],
) {
  const h = harness(options);
  const walk = options.walk ?? new Walk();
  const run = await h.flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), BILLS_FLOW_STEPS[0]);
  const payload = await runForward(run, walk, 0, first, stopAt);
  return { ...h, walk, run, payload };
}

function requireArtifact(walk: Walk, stepId: string): Record<string, unknown> {
  const artifact = walk.artifacts[stepId];
  if (artifact === undefined) throw new Error(`${stepId} artifact missing from the walk`);
  return artifact;
}

interface CompletionResult {
  status?: string;
  error?: unknown;
  result?: {
    receipt?: Record<string, unknown>;
    effects?: Record<string, Record<string, unknown>>;
  };
}

/** Resume the post checkpoint with a signed receipt and absorb the effects. */
async function finish(
  run: WorkflowRunHandle,
  walk: Walk,
  extra: Record<string, unknown> = {},
): Promise<CompletionResult> {
  const done = (await run.resume({
    resumeData: walk.resume(BILLS_FLOW_STEPS[3], "proceed", {
      actionHash: PROCEED_HASH,
      receiptId: "rcpt-1",
      ...extra,
    }),
  })) as CompletionResult;
  const effects = done.result?.effects;
  if (effects !== undefined) walk.effects = { ...walk.effects, ...effects };
  return done;
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

describe("Mastra billsFlow", () => {
  it("registers named bills steps in order", () => {
    const { flow, mastra } = harness();
    expect(flow.id).toBe("billsFlow");
    expect(Object.keys(flow.steps)).toEqual([...BILLS_FLOW_STEPS]);
    expect(mastra.getAgent("billsExtractor").id).toBe("bill-extractor");
  });

  it("suspends at intake with the vendor ref derived from the sender domain", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "intake");
    const artifact = BillsIntakeArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("bills:BILL-7");
    expect(payload.effects).toEqual({});
    expect(artifact.caseId).toBe("case-1");
    expect(artifact.ticketKey).toBe("BILL-7");
    expect(artifact.vendorRef).toBe("acmepower");
    expect(artifact.messageId).toBe("mail-1");
    expect(artifact.from).toBe("billing@acmepower.com.au");
    expect(artifact.fromName).toBe("Acme Power Billing");
    expect(artifact.receivedAt).toBe("2026-09-30T08:55:00.000Z");
    expect(artifact.summary).toBe(
      "Inbound vendor email from billing@acmepower.com.au for vendor acmepower.",
    );
  });

  it("scopes the vendor lookup to the tenant and the sender address", async () => {
    const scoped = new RecordingRegistry();
    const walk = new Walk({ input: { ...EMAIL, tenantId: "tenant-a" } });
    await walkWith({ registry: scoped, walk }, "extract");

    expect(scoped.queries).toEqual([
      { tenantId: "tenant-a", email: "billing@acmepower.com.au" },
    ]);

    const derived = new RecordingRegistry();
    await walkWith({ registry: derived }, "extract");

    expect(derived.queries).toEqual([{ tenantId: null, email: "billing@acmepower.com.au" }]);
  });

  it("matches a registered vendor and escalates nothing", async () => {
    const { walk, payload } = await walkWith({}, "approve");
    const extract = ExtractArtifactSchema.parse(requireArtifact(walk, "extract"));

    expect(extract.vendorRef).toBe("acmepower");
    expect(extract.vendorName).toBe("Acme Power Pty Ltd");
    expect(extract.registryRef).toBe("acme-power");
    expect(extract.bill.number).toBe("INV-2041");
    expect(extract.bill.totalCents).toBe(132_000);
    expect(extract.bank.stated.bsb).toBe("012-345");
    // Registered BSB "012345" equals the stated "012-345": digits compare.
    expect(extract.bank.matches).toBe(true);
    expect(extract.escalations).toEqual([]);
    expect(extract.escalated).toBe(false);
    expect(extract.summary).toBe(
      "Extracted bill INV-2041 from acmepower and matched registry entry acme-power.",
    );

    expect(payload.target).toBe("bills:BILL-7");
  });

  it("suspends at approve with the bookkeeper checkpoint", async () => {
    const { payload } = await walkWith({}, "approve");
    const artifact = ApproveArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("bills:BILL-7");
    expect(artifact.approverRole).toBe("bookkeeper");
    expect(artifact.approverLabel).toBe("MSP bookkeeper on duty");
    expect(artifact.slaHours).toBe(24);
    expect(artifact.state).toBe("pending");
    expect(artifact.requestedAt).toBe(FIXED_NOW.toISOString());
    expect(artifact.decidedAt).toBeNull();
    expect(artifact.summary).toBe(
      "MSP bookkeeper on duty approval requested for the vendor bill from acmepower.",
    );
  });

  it("suspends at post with the draft plan and completes with the receipt", async () => {
    const inner = new MemoryBillsLedger();
    const ledger = new CountingLedger(inner);
    const { run, walk, payload } = await walkWith({ ledger }, "post");
    const post = PostArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("bills:BILL-7");
    expect(post.provider).toBe("memory");
    expect(post.billNumber).toBe("INV-2041");
    expect(post.dueDate).toBe("2026-09-15");
    expect(post.currency).toBe("AUD");
    expect(post.totalCents).toBe(132_000);
    expect(post.ledgerKey).toBe("bills-post:case-1:BILL-7");
    expect(post.summary).toBe(
      "Posts the approved bill INV-2041 from acmepower to the memory ledger as a draft;"
        + " idempotent by case and ticket.",
    );

    walk.artifacts["post"] = payload.artifact;
    const done = await finish(run, walk);
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toMatchObject({
      caseId: "case-1",
      ticketKey: "BILL-7",
      vendorRef: "acmepower",
      vendorEmail: "billing@acmepower.com.au",
      provider: "memory",
      ledgerKey: "bills-post:case-1:BILL-7",
      billId: "memory-bill-1",
      billNumber: "INV-2041",
      currency: "AUD",
      totalCents: 132_000,
      billCreated: true,
      escalations: [],
      postedAt: FIXED_NOW.toISOString(),
    });
    expect(done.result?.effects?.post?.receipt).toEqual(done.result?.receipt);
    expect(ledger.posts).toBe(1);
    // The human approved exactly what the extractor read.
    expect(inner.posted[0]).toMatchObject({
      vendorName: "Acme Power Pty Ltd",
      vendorEmail: "billing@acmepower.com.au",
      billNumber: "INV-2041",
      issueDate: "2026-09-01",
      dueDate: "2026-09-15",
      currency: "AUD",
      totalCents: 132_000,
      taxCents: 12_000,
      lineItems: [{ description: "Electricity 1 Aug to 31 Aug", amountCents: 132_000 }],
      reference: "case case-1 · ticket BILL-7",
    });
  });

  it("does not re-execute a post whose effect is already recorded", async () => {
    const ledger = new CountingLedger(new MemoryBillsLedger());
    const { run, walk, payload } = await walkWith({ ledger }, "post");
    walk.artifacts["post"] = payload.artifact;

    const seeded = {
      caseId: "case-1",
      ticketKey: "BILL-7",
      vendorRef: "acmepower",
      vendorEmail: "billing@acmepower.com.au",
      provider: "memory",
      ledgerKey: "bills-post:case-1:BILL-7",
      billId: "memory-bill-1",
      billNumber: "INV-2041",
      currency: "AUD",
      totalCents: 132_000,
      billCreated: true,
      escalations: [],
      postedAt: FIXED_NOW.toISOString(),
    };
    walk.effects["post"] = { actionHash: PROCEED_HASH, receipt: seeded };

    const done = await finish(run, walk);
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toEqual(seeded);
    expect(ledger.posts).toBe(0);
  });

  it("escalates a sender that is not in the registry", async () => {
    const { walk, payload } = await walkWith(
      { registry: new MemoryVendorRegistry([]) },
      "approve",
    );
    const extract = ExtractArtifactSchema.parse(requireArtifact(walk, "extract"));

    expect(extract.escalations).toEqual(["vendor_unverified"]);
    expect(extract.escalated).toBe(true);
    expect(extract.registryRef).toBeNull();
    expect(extract.vendorName).toBe("Acme Power Pty Ltd");
    expect(extract.bank.registered).toBeNull();
    expect(extract.bank.matches).toBe(false);
    expect(extract.summary).toBe(
      "Bill extraction escalated (vendor_unverified); a human review is needed before"
        + " the draft can post.",
    );

    const approve = ApproveArtifactSchema.parse(payload.artifact);
    expect(approve.summary).toBe(
      "MSP bookkeeper on duty approval requested for the vendor bill · 1 escalation(s)"
        + " need a decision.",
    );
  });

  it("escalates changed remittance bank details", async () => {
    const moved = new MemoryVendorRegistry([
      { ...REGISTERED_VENDOR, bsb: "068-000", accountNumber: "99999999" },
    ]);
    const { walk } = await walkWith({ registry: moved }, "extract");
    const extract = ExtractArtifactSchema.parse(requireArtifact(walk, "extract"));

    expect(extract.escalations).toEqual(["bank_details_changed"]);
    expect(extract.bank.matches).toBe(false);
    expect(extract.bank.registered?.bsb).toBe("068-000");
    expect(extract.bank.stated.accountNumber).toBe("12345678");
  });

  it("escalates an empty extraction and refuses to post the unedited bill", async () => {
    const ledger = new CountingLedger(new MemoryBillsLedger());
    const { run, walk, payload } = await walkWith(
      { ledger, model: new FakeBillModel(EMPTY_BILL) },
      "post",
    );
    const extract = ExtractArtifactSchema.parse(requireArtifact(walk, "extract"));
    expect(extract.escalations).toEqual(["empty_extraction"]);
    expect(extract.summary).toBe(
      "Bill extraction escalated (empty_extraction); a human review is needed before"
        + " the draft can post.",
    );

    walk.artifacts["post"] = payload.artifact;
    const blocked = await run.resume({
      resumeData: walk.resume("post", "proceed", {
        actionHash: PROCEED_HASH,
        receiptId: "rcpt-1",
      }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "edit the extraction before posting",
    );
    expect(ledger.posts).toBe(0);
  });

  it("lets a human edit carry a bill missing its number through the post", async () => {
    const ledger = new CountingLedger(new MemoryBillsLedger());
    const { run, walk } = await walkWith(
      { ledger, model: new FakeBillModel(NO_NUMBER_BILL) },
      "extract",
    );
    const unedited = ExtractArtifactSchema.parse(requireArtifact(walk, "extract"));
    expect(unedited.escalations).toEqual(["missing_fields"]);

    const editedBill = { ...NO_NUMBER_BILL.bill, number: "INV-2041" };
    const resumed = suspendView(
      await run.resume({
        resumeData: walk.resume("extract", "edit", {
          edits: { bill: editedBill },
          actionHash: PROCEED_HASH,
        }),
      }),
      "approve",
    );
    const approve = ApproveArtifactSchema.parse(resumed.artifact);
    expect(approve.summary).toBe(
      "MSP bookkeeper on duty approval requested for the vendor bill · 1 escalation(s)"
        + " need a decision.",
    );

    const postPayload = await runForward(run, walk, 2, resumed, "post");
    walk.artifacts["post"] = postPayload.artifact;
    const done = await finish(run, walk);
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toMatchObject({
      billNumber: "INV-2041",
      billCreated: true,
      escalations: ["missing_fields"],
    });
    expect(ledger.posts).toBe(1);
  });

  it("recomputes the extraction with the human guidance", async () => {
    const model = new FakeBillModel(HAPPY_BILL);
    const { run, walk } = await walkWith({ model }, "extract");

    const second = suspendView(
      await run.resume({
        resumeData: walk.resume("extract", "regenerate", {
          guidance: "Read the remittance block at the bottom of the email.",
        }),
      }),
      "extract",
    );
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]?.guidance).toBeUndefined();
    expect(model.calls[1]?.guidance).toBe(
      "Read the remittance block at the bottom of the email.",
    );
    expect(ExtractArtifactSchema.parse(second.artifact).bill.number).toBe("INV-2041");
  });

  it("refuses to post without a signed approval receipt", async () => {
    const inner = new MemoryBillsLedger();
    const ledger = new CountingLedger(inner);
    const { run, walk, payload } = await walkWith({ ledger }, "post");
    walk.artifacts["post"] = payload.artifact;

    const blocked = await run.resume({
      resumeData: walk.resume("post", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "approval receipt required",
    );
    // The ledger rejected the posting before recording anything.
    expect(inner.posted).toHaveLength(0);
  });
});
