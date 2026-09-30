import { z } from "zod";

/**
 * Named steps of the Mastra bills flow. Ids match the API run definition
 * (`runs/definitions.py` BILLS_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const BILLS_FLOW_STEPS = ["intake", "extract", "approve", "post"] as const;

export type BillsFlowStepId = (typeof BILLS_FLOW_STEPS)[number];

/**
 * Escalation ladder for a vendor bill. `empty_extraction` and `missing_fields`
 * cover an unreadable or incomplete email, `vendor_unverified` a sender that
 * is not in the registry, and `bank_details_changed` a remittance account
 * that differs from the registered one. Every reason is advisory: the bill
 * still parks for a human, and the posting receipt records them all. Nothing
 * ever posts without the signed approval either way.
 */
export const BILL_ESCALATION_REASONS = [
  "empty_extraction",
  "missing_fields",
  "bank_details_changed",
  "vendor_unverified",
] as const;

export const BillEscalationReasonSchema = z.enum(BILL_ESCALATION_REASONS);

export type BillEscalationReason = z.infer<typeof BillEscalationReasonSchema>;

/**
 * Decision recorded by the API for a step (mirrors `RunStep.decision`).
 * `proceed`/`edit` carry the action hash and receipt id of the signed
 * receipt; `regenerate` carries the human guidance and its bounded attempt
 * count.
 */
export const StepDecisionSchema = z
  .object({
    action: z.enum(["proceed", "edit", "regenerate", "back", "abort", "retry_lock"]),
    edits: z.record(z.unknown()).nullish(),
    guidance: z.string().nullish(),
    actionHash: z.string().nullish(),
    approvalId: z.string().nullish(),
    receiptId: z.string().nullish(),
    approver: z.string().nullish(),
    decidedAt: z.string().nullish(),
    regenerations: z.number().int().nonnegative().nullish(),
  })
  .strict();

export type StepDecision = z.infer<typeof StepDecisionSchema>;

/** Calendar date as the extractor returns it; comparisons stay string-equal. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Vendor slug: the sender domain's first label, e.g. "acme-power". */
export const VENDOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Run input supplied by the API (`POST /intake/vendor-email`): one normalized
 * vendor email. `vendorRef` may be set by the intake route when the forwarder
 * already knows the vendor; otherwise it derives from the sender domain.
 */
export const BillsInputSchema = z
  .object({
    messageId: z.string().min(1).max(300),
    from: z.string().min(3).max(320),
    fromName: z.string().min(1).max(200).optional(),
    to: z.string().min(3).max(320),
    subject: z.string().min(1).max(500),
    text: z.string().min(1).max(20_000),
    receivedAt: z.string().datetime({ offset: true }).optional(),
    vendorRef: z.string().min(1).max(40).optional(),
    /** Tenant scope for the vendor registry lookup; intake fills it in. */
    tenantId: z.string().min(1).max(200).optional(),
  })
  .passthrough();

export type BillsInput = z.infer<typeof BillsInputSchema>;

/**
 * The vendor slug a sender address belongs to: the first label of the sender
 * domain, lowercased and cleaned. Falls back to "vendor" so an odd address
 * still yields a stable ref (the registry lookup fails closed either way).
 */
export function vendorSlugFor(address: string): string {
  const domain = address.split("@")[1] ?? "";
  const label = (domain.split(".")[0] ?? "").trim().toLowerCase();
  const cleaned = label.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "vendor" : cleaned.slice(0, 40);
}

/** `intake` artifact: the normalized email plus the derived vendor slug. */
export const BillsIntakeArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    vendorRef: z.string().min(1).max(40),
    messageId: z.string().min(1).max(300),
    from: z.string().min(3).max(320),
    fromName: z.string().min(1).max(200).nullable(),
    subject: z.string().min(1).max(500),
    receivedAt: z.string().datetime({ offset: true }),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type BillsIntakeArtifact = z.infer<typeof BillsIntakeArtifactSchema>;

/** Remittance bank details as they appear on the bill or in the registry. */
export const BankDetailsSchema = z
  .object({
    accountName: z.string().min(1).max(200).nullable(),
    bsb: z.string().min(1).max(20).nullable(),
    accountNumber: z.string().min(1).max(40).nullable(),
  })
  .strict();

export type BankDetails = z.infer<typeof BankDetailsSchema>;

export const BillLineItemSchema = z
  .object({
    description: z.string().min(1).max(200),
    amountCents: z.number().int().nonnegative(),
  })
  .strict();

export type BillLineItem = z.infer<typeof BillLineItemSchema>;

/**
 * One extracted bill. Every field is nullable on purpose: extraction is the
 * model step, and whatever it could not read stays a visible null that
 * escalates instead of being guessed.
 */
export const ExtractedBillSchema = z
  .object({
    number: z.string().min(1).max(100).nullable(),
    issueDate: z.string().regex(ISO_DATE_PATTERN).nullable(),
    dueDate: z.string().regex(ISO_DATE_PATTERN).nullable(),
    currency: z.string().length(3),
    totalCents: z.number().int().nonnegative().nullable(),
    taxCents: z.number().int().nonnegative().nullable(),
    lineItems: z.array(BillLineItemSchema).max(50),
  })
  .strict();

export type ExtractedBill = z.infer<typeof ExtractedBillSchema>;

/** Structured output of the bill extractor agent. */
export const BillModelOutputSchema = z
  .object({
    vendor: z
      .object({
        name: z.string().min(1).max(200).nullable(),
        accountName: z.string().min(1).max(200).nullable(),
        bsb: z.string().min(1).max(20).nullable(),
        accountNumber: z.string().min(1).max(40).nullable(),
      })
      .strict(),
    bill: ExtractedBillSchema,
  })
  .strict();

export type BillModelOutput = z.infer<typeof BillModelOutputSchema>;

/** The registry row the flow's lookup seam returns for a sender address. */
export const VendorRecordSchema = z
  .object({
    ref: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    accountName: z.string().min(1).max(200).nullable(),
    bsb: z.string().min(1).max(20).nullable(),
    accountNumber: z.string().min(1).max(40).nullable(),
  })
  .strict();

export type VendorRecord = z.infer<typeof VendorRecordSchema>;

/**
 * `extract` artifact: the model's reading of the email next to the registry
 * row matched by the sender address, plus every escalation reason. `matches`
 * is false when there is no registered record to compare against (already
 * named by `vendor_unverified`) or when both sides state a comparable detail
 * and they differ; a detail only one side states is never called a change.
 */
export const ExtractArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    vendorRef: z.string().min(1).max(40),
    vendorEmail: z.string().min(3).max(320),
    vendorName: z.string().min(1).max(200).nullable(),
    bill: ExtractedBillSchema,
    bank: z
      .object({
        stated: BankDetailsSchema,
        registered: BankDetailsSchema.nullable(),
        matches: z.boolean(),
      })
      .strict(),
    registryRef: z.string().min(1).max(40).nullable(),
    escalations: z.array(BillEscalationReasonSchema).max(8),
    escalated: z.boolean(),
    summary: z.string().min(1).max(2_000),
  })
  .strict()
  .superRefine((extract, ctx) => {
    if (extract.escalated !== (extract.escalations.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "escalated must match a non-empty escalation list",
      });
    }
  });

export type ExtractArtifact = z.infer<typeof ExtractArtifactSchema>;

/** `approve` artifact: the bookkeeper approval the receipt will back. */
export const ApproveArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    approverRole: z.string().min(1).max(80),
    approverLabel: z.string().min(1).max(80),
    slaHours: z.number().int().positive().max(720),
    state: z.enum(["pending", "approved", "rejected"]),
    requestedAt: z.string().datetime({ offset: true }),
    decidedAt: z.string().datetime({ offset: true }).nullable(),
    note: z.string().max(1_000).nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ApproveArtifact = z.infer<typeof ApproveArtifactSchema>;

/** `post` artifact: the draft bill the post checkpoint previews. */
export const PostArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    vendorRef: z.string().min(1).max(40),
    provider: z.string().min(1).max(80),
    billNumber: z.string().min(1).max(100).nullable(),
    dueDate: z.string().regex(ISO_DATE_PATTERN).nullable(),
    currency: z.string().length(3),
    totalCents: z.number().int().nonnegative().nullable(),
    /** Ledger idempotency key; also the xero.post policy key. */
    ledgerKey: z.string().min(5).max(200),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type PostArtifact = z.infer<typeof PostArtifactSchema>;

/**
 * The ledger posting the flow builds from the reviewed extraction. The Xero
 * adapter maps this onto one ACCPAY bill in DRAFT status; the memory ledger
 * records it for tests.
 */
export const BillPostingSchema = z
  .object({
    vendorName: z.string().min(1).max(200),
    vendorEmail: z.string().min(3).max(320),
    billNumber: z.string().min(1).max(100),
    issueDate: z.string().regex(ISO_DATE_PATTERN).nullable(),
    dueDate: z.string().regex(ISO_DATE_PATTERN),
    currency: z.string().length(3),
    totalCents: z.number().int().nonnegative(),
    taxCents: z.number().int().nonnegative().nullable(),
    lineItems: z.array(BillLineItemSchema).max(50),
    reference: z.string().min(1).max(200),
  })
  .strict();

export type BillPosting = z.infer<typeof BillPostingSchema>;

/** Receipt of the posted draft bill (the `post` side effect). */
export const BillsPostReceiptSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    vendorRef: z.string().min(1).max(40),
    vendorEmail: z.string().min(3).max(320),
    provider: z.string().min(1).max(80),
    ledgerKey: z.string().min(5).max(200),
    billId: z.string().min(1).max(200),
    billNumber: z.string().min(1).max(100),
    currency: z.string().length(3),
    totalCents: z.number().int().nonnegative(),
    /** false when the ledger replayed an earlier posting. */
    billCreated: z.boolean(),
    escalations: z.array(BillEscalationReasonSchema).max(8),
    postedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type BillsPostReceipt = z.infer<typeof BillsPostReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const BillsEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: z.record(z.unknown()).optional(),
  })
  .strict();

export type BillsEffect = z.infer<typeof BillsEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const BillsRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("bills"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: BillsInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(BillsEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type BillsRunState = z.infer<typeof BillsRunStateSchema>;

export const BillsFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(BillsEffectSchema),
    receipt: BillsPostReceiptSchema.optional(),
  })
  .strict();

export type BillsFlowOutput = z.infer<typeof BillsFlowOutputSchema>;

/**
 * Suspend payload the API reads: the reviewable artifact plus lock target.
 * `effects` carries every side effect recorded so far, so a restarted or
 * re-driven run learns about a posted bill even while a later step is
 * suspended (the API merges it into the authoritative map).
 */
export const BillsSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
    effects: z.record(BillsEffectSchema).optional(),
  })
  .strict();

export type BillsSuspendPayload = z.infer<typeof BillsSuspendSchema>;
