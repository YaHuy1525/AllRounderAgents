import { z } from "zod";

/**
 * Named steps of the Mastra vendors flow. Ids match the API run definition
 * (`runs/definitions.py` VENDORS_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const VENDORS_FLOW_STEPS = ["collect", "verify", "risk-score", "approve", "create"] as const;

export type VendorsFlowStepId = (typeof VENDORS_FLOW_STEPS)[number];

/** Run input supplied by the API (`POST /runs` input payload). */
export const VendorInputSchema = z
  .object({
    vendorName: z.string().min(2).max(200),
    taxId: z.string().min(5).max(40),
    requestor: z.string().min(3).max(200),
    country: z.string().regex(/^[A-Z]{2}$/, "expected an ISO 3166-1 alpha-2 code"),
    category: z.string().min(1).max(120).optional(),
    website: z.string().url().max(300).optional(),
  })
  .passthrough();

export type VendorInput = z.infer<typeof VendorInputSchema>;

/**
 * Decision recorded by the API for a step (mirrors `RunStep.decision`).
 * `proceed`/`edit` carry the action hash of the signed receipt; `regenerate`
 * carries the human guidance and its bounded attempt count.
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

/** The onboarding document checklist (collect checkpoint). */
export const DOCUMENT_IDS = ["registration", "tax-id", "bank-letter", "insurance"] as const;

export const DocumentIdSchema = z.enum(DOCUMENT_IDS);

export type DocumentId = z.infer<typeof DocumentIdSchema>;

/** missing = never provided; pending = requested; received = uploaded; waived. */
export const DOCUMENT_STATUSES = ["missing", "pending", "received", "waived"] as const;

export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/** One checklist row: status pill, upload, nudge counter, waiver. */
export const DocumentEntrySchema = z
  .object({
    id: DocumentIdSchema,
    label: z.string().min(1).max(120),
    required: z.boolean(),
    status: DocumentStatusSchema,
    fileName: z.string().max(200).nullable(),
    waivedReason: z.string().max(1_000).nullable(),
    nudges: z.number().int().nonnegative().max(50),
    lastNudgedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type DocumentEntry = z.infer<typeof DocumentEntrySchema>;

/** `collect` artifact: the document checklist and its completion totals. */
export const CollectArtifactSchema = z
  .object({
    vendorName: z.string().min(2).max(200),
    taxId: z.string().min(5).max(40),
    country: z.string().regex(/^[A-Z]{2}$/),
    requestor: z.string().min(3).max(200),
    documents: z.array(DocumentEntrySchema).min(1).max(20),
    totals: z
      .object({
        documents: z.number().int().nonnegative(),
        required: z.number().int().nonnegative(),
        received: z.number().int().nonnegative(),
        waived: z.number().int().nonnegative(),
        outstanding: z.number().int().nonnegative(),
      })
      .strict(),
    /** Approval return note: set when Approve sends the onboarding back. */
    returnedNote: z.string().max(500).nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type CollectArtifact = z.infer<typeof CollectArtifactSchema>;

/** Verification outcomes for one check row. */
export const CHECK_STATUSES = ["pass", "flag", "fail"] as const;

export const CheckStatusSchema = z.enum(CHECK_STATUSES);

export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const VerificationCheckSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    status: CheckStatusSchema,
    source: z.string().min(1).max(120),
    checkedAt: z.string().datetime({ offset: true }),
    detail: z.string().min(1).max(2_000),
  })
  .strict();

export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

/** One lookalike master record with its match score and matched fields. */
export const DuplicateCandidateSchema = z
  .object({
    vendorId: z.string().min(1).max(80),
    legalName: z.string().min(1).max(200),
    taxId: z.string().min(1).max(40),
    country: z.string().min(2).max(2),
    matchScore: z.number().min(0).max(1),
    matchedOn: z.array(z.string().min(1).max(60)).max(5),
  })
  .strict();

export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

/** A failing check routed to manual review; the reviewer records a note. */
export const ManualReviewItemSchema = z
  .object({
    checkId: z.string().min(1).max(120),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export type ManualReviewItem = z.infer<typeof ManualReviewItemSchema>;

/** Reviewer note accepting a failing check after manual review. */
export const ResolutionSchema = z
  .object({
    checkId: z.string().min(1).max(120),
    note: z.string().min(1).max(1_000),
  })
  .strict();

export type Resolution = z.infer<typeof ResolutionSchema>;

/** Structured output of the verifier agent (report frame + confidence). */
export const VerifyModelOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type VerifyModelOutput = z.infer<typeof VerifyModelOutputSchema>;

/** `verify` artifact: the check table, duplicate candidates, manual review. */
export const VerifyArtifactSchema = z
  .object({
    vendorName: z.string().min(2).max(200),
    taxId: z.string().min(5).max(40),
    country: z.string().regex(/^[A-Z]{2}$/),
    checks: z.array(VerificationCheckSchema).min(1).max(20),
    candidates: z.array(DuplicateCandidateSchema).max(10),
    manualReview: z
      .object({
        required: z.boolean(),
        items: z.array(ManualReviewItemSchema).max(20),
      })
      .strict(),
    resolutions: z.array(ResolutionSchema).max(20),
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type VerifyArtifact = z.infer<typeof VerifyArtifactSchema>;

/** Risk tiers, lowest first; the tier picks the required signer roles. */
export const RISK_TIERS = ["low", "medium", "high"] as const;

export const RiskTierSchema = z.enum(RISK_TIERS);

export type RiskTier = z.infer<typeof RiskTierSchema>;

/** One scoring factor with its point contribution and explanation. */
export const RiskFactorSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    points: z.number().int().nonnegative().max(100),
    detail: z.string().min(1).max(500),
  })
  .strict();

export type RiskFactor = z.infer<typeof RiskFactorSchema>;

/** Approver matrix row: a tier and the roles that must sign for it. */
export const ApproverMatrixRowSchema = z
  .object({
    tier: RiskTierSchema,
    requiredSigners: z.array(z.string().min(1).max(80)).min(1).max(5),
  })
  .strict();

export type ApproverMatrixRow = z.infer<typeof ApproverMatrixRowSchema>;

/** Structured output of the risk agent (narrative frame + confidence). */
export const RiskModelOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type RiskModelOutput = z.infer<typeof RiskModelOutputSchema>;

/** `risk-score` artifact: score meter, tier, factors, approver matrix. */
export const RiskArtifactSchema = z
  .object({
    vendorName: z.string().min(2).max(200),
    taxId: z.string().min(5).max(40),
    score: z.number().int().min(0).max(100),
    tier: RiskTierSchema,
    factors: z.array(RiskFactorSchema).max(10),
    requiredSigners: z.array(z.string().min(1).max(80)).min(1).max(5),
    matrix: z.array(ApproverMatrixRowSchema).min(1).max(3),
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type RiskArtifact = z.infer<typeof RiskArtifactSchema>;

/** Sign-off states of one approver in the chain. */
export const SIGNER_STATES = ["pending", "approved", "rejected"] as const;

export const SignerStateSchema = z.enum(SIGNER_STATES);

export type SignerState = z.infer<typeof SignerStateSchema>;

/** One chain tracker entry: signer identity, state, SLA age, nudges. */
export const ChainEntrySchema = z
  .object({
    role: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    state: SignerStateSchema,
    requestedAt: z.string().datetime({ offset: true }),
    actedAt: z.string().datetime({ offset: true }).nullable(),
    note: z.string().max(1_000).nullable(),
    nudges: z.number().int().nonnegative().max(50),
    lastNudgedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type ChainEntry = z.infer<typeof ChainEntrySchema>;

export const ChainCommentSchema = z
  .object({
    author: z.string().min(1).max(200),
    at: z.string().datetime({ offset: true }),
    body: z.string().min(1).max(2_000),
  })
  .strict();

export type ChainComment = z.infer<typeof ChainCommentSchema>;

/** `approve` artifact: the signer chain, comments, and the approval gate. */
export const ApproveArtifactSchema = z
  .object({
    vendorName: z.string().min(2).max(200),
    taxId: z.string().min(5).max(40),
    tier: RiskTierSchema,
    slaHours: z.number().int().positive().max(720),
    chain: z.array(ChainEntrySchema).min(1).max(10),
    comments: z.array(ChainCommentSchema).max(50),
    allApproved: z.boolean(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ApproveArtifact = z.infer<typeof ApproveArtifactSchema>;

/** The master record the create checkpoint previews. */
export const MasterRecordSchema = z
  .object({
    vendorId: z.string().min(3).max(80),
    legalName: z.string().min(2).max(200),
    taxId: z.string().min(5).max(40),
    country: z.string().regex(/^[A-Z]{2}$/),
    requestor: z.string().min(3).max(200),
    status: z.literal("active"),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export type MasterRecord = z.infer<typeof MasterRecordSchema>;

/** `create` artifact: the master-record preview plus the idempotency key. */
export const CreateArtifactSchema = z
  .object({
    record: MasterRecordSchema,
    idempotencyKey: z.string().min(5).max(40),
    welcomePacket: z.boolean(),
    existing: z
      .object({
        vendorId: z.string().min(3).max(80),
        legalName: z.string().min(2).max(200),
        createdAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type CreateArtifact = z.infer<typeof CreateArtifactSchema>;

/** Receipt of the created vendor master record (the `create` side effect). */
export const VendorReceiptSchema = z
  .object({
    vendorId: z.string().min(3).max(80),
    legalName: z.string().min(2).max(200),
    taxId: z.string().min(5).max(40),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    welcomePacket: z.boolean(),
    /** false when an existing record was reused (idempotent by tax-ID key). */
    created: z.boolean(),
    registryRef: z.string().min(1).max(200),
  })
  .strict();

export type VendorReceipt = z.infer<typeof VendorReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const VendorsEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: VendorReceiptSchema.optional(),
  })
  .strict();

export type VendorsEffect = z.infer<typeof VendorsEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const VendorsRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("vendors"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: VendorInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(VendorsEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type VendorsRunState = z.infer<typeof VendorsRunStateSchema>;

export const VendorsFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(VendorsEffectSchema),
    receipt: VendorReceiptSchema.optional(),
  })
  .strict();

export type VendorsFlowOutput = z.infer<typeof VendorsFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const VendorsSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type VendorsSuspendPayload = z.infer<typeof VendorsSuspendSchema>;
