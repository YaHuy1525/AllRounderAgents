import { z } from "zod";

import { AccessTierSchema } from "../hr/directory.js";

/**
 * Named steps of the Mastra onboarding flow. Ids match the API run definition
 * (`runs/definitions.py` ONBOARDING_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const ONBOARDING_FLOW_STEPS = ["collect", "verify", "risk-score", "approve", "provision"] as const;

export type OnboardingFlowStepId = (typeof ONBOARDING_FLOW_STEPS)[number];

/**
 * Run input supplied by the API (`POST /runs` input payload). The new hire's
 * name is the only raw PII the lane ever receives; every artifact references
 * them through the deterministic onboarding id plus a redacted label.
 */
export const OnboardingInputSchema = z
  .object({
    fullName: z.string().min(2).max(200),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    location: z.string().min(2).max(120),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD start date"),
    managerId: z.string().min(2).max(40).optional(),
    accessTier: AccessTierSchema.optional(),
  })
  .passthrough();

export type OnboardingInput = z.infer<typeof OnboardingInputSchema>;

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

/** The new-hire document checklist (collect checkpoint). */
export const DOCUMENT_IDS = [
  "id-verification",
  "right-to-work",
  "signed-contract",
  "tax-form",
  "bank-details",
  "emergency-contact",
] as const;

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
    onboardingId: z.string().min(3).max(40),
    candidateLabel: z.string().min(1).max(120),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    location: z.string().min(2).max(120),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    managerId: z.string().min(2).max(40).nullable(),
    accessTier: AccessTierSchema,
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

/** One directory lookalike with its match score and matched name parts. */
export const DuplicateCandidateSchema = z
  .object({
    employeeId: z.string().min(1).max(80),
    /** Redacted initials only — never the raw directory name. */
    label: z.string().min(1).max(120),
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
    onboardingId: z.string().min(3).max(40),
    candidateLabel: z.string().min(1).max(120),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
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
    onboardingId: z.string().min(3).max(40),
    candidateLabel: z.string().min(1).max(120),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
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
    /** Role label, or the fixture person's redacted initials when resolvable. */
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
    onboardingId: z.string().min(3).max(40),
    candidateLabel: z.string().min(1).max(120),
    tier: RiskTierSchema,
    slaHours: z.number().int().positive().max(720),
    chain: z.array(ChainEntrySchema).min(1).max(10),
    comments: z.array(ChainCommentSchema).max(50),
    allApproved: z.boolean(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ApproveArtifact = z.infer<typeof ApproveArtifactSchema>;

/** The employee record the provision checkpoint previews. */
export const EmployeeRecordSchema = z
  .object({
    employeeId: z.string().min(3).max(40),
    /** Redacted initials only — the directory stores the raw name, not this. */
    label: z.string().min(1).max(120),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    location: z.string().min(2).max(120),
    managerId: z.string().min(2).max(40).nullable(),
    accessTier: AccessTierSchema,
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.literal("onboarding"),
  })
  .strict();

export type EmployeeRecord = z.infer<typeof EmployeeRecordSchema>;

/** `provision` artifact: accounts, equipment ticket, payroll enrollment. */
export const ProvisionArtifactSchema = z
  .object({
    employee: EmployeeRecordSchema,
    accounts: z.array(z.string().min(1).max(60)).min(1).max(20),
    equipmentTicket: z
      .object({
        id: z.string().min(3).max(40),
        item: z.string().min(2).max(120),
        location: z.string().min(2).max(120),
      })
      .strict(),
    payrollEnrollment: z
      .object({
        id: z.string().min(3).max(40),
        payGroup: z.string().min(2).max(120),
      })
      .strict(),
    idempotencyKey: z.string().min(5).max(40),
    existing: z
      .object({
        employeeId: z.string().min(3).max(40),
        createdAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ProvisionArtifact = z.infer<typeof ProvisionArtifactSchema>;

/** Receipt of the provisioned employee (the `provision` side effect). */
export const OnboardingReceiptSchema = z
  .object({
    employeeId: z.string().min(3).max(40),
    label: z.string().min(1).max(120),
    department: z.string().min(2).max(120),
    accessTier: AccessTierSchema,
    /** The employee's first day; also the record's effective date. */
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    accounts: z.array(z.string().min(1).max(60)).min(1).max(20),
    equipmentTicketId: z.string().min(3).max(40),
    payrollEnrollmentId: z.string().min(3).max(40),
    /** false when an existing record was reused (idempotent by employee id). */
    created: z.boolean(),
    registryRef: z.string().min(1).max(200),
  })
  .strict();

export type OnboardingReceipt = z.infer<typeof OnboardingReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const OnboardingEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: OnboardingReceiptSchema.optional(),
  })
  .strict();

export type OnboardingEffect = z.infer<typeof OnboardingEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const OnboardingRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("onboarding"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: OnboardingInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(OnboardingEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type OnboardingRunState = z.infer<typeof OnboardingRunStateSchema>;

export const OnboardingFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(OnboardingEffectSchema),
    receipt: OnboardingReceiptSchema.optional(),
  })
  .strict();

export type OnboardingFlowOutput = z.infer<typeof OnboardingFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const OnboardingSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type OnboardingSuspendPayload = z.infer<typeof OnboardingSuspendSchema>;
