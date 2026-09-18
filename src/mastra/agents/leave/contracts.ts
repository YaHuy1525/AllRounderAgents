import { z } from "zod";

/**
 * Named steps of the Mastra leave flow. Ids match the API run definition
 * (`runs/definitions.py` LEAVE_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const LEAVE_FLOW_STEPS = ["intake", "policy-check", "approve", "apply"] as const;

export type LeaveFlowStepId = (typeof LEAVE_FLOW_STEPS)[number];

/** Leave types the policy engine understands. */
export const LEAVE_TYPES = ["annual", "sick", "unpaid", "parental"] as const;

export const LeaveTypeSchema = z.enum(LEAVE_TYPES);

export type LeaveType = z.infer<typeof LeaveTypeSchema>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Run input supplied by the API (`POST /runs` input payload). */
export const LeaveInputSchema = z
  .object({
    employeeId: z.string().min(2).max(40),
    leaveType: LeaveTypeSchema,
    startDate: z.string().regex(DATE_PATTERN, "expected YYYY-MM-DD"),
    endDate: z.string().regex(DATE_PATTERN, "expected YYYY-MM-DD"),
    note: z.string().max(500).optional(),
  })
  .passthrough();

export type LeaveInput = z.infer<typeof LeaveInputSchema>;

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

/** Verification outcomes for one policy row. */
export const POLICY_STATUSES = ["pass", "flag", "fail"] as const;

export const PolicyStatusSchema = z.enum(POLICY_STATUSES);

export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

export const PolicyCheckRowSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    status: PolicyStatusSchema,
    detail: z.string().min(1).max(1_000),
  })
  .strict();

export type PolicyCheckRow = z.infer<typeof PolicyCheckRowSchema>;

/** One overlapping booking already on the calendar for the same employee. */
export const OverlapEntrySchema = z
  .object({
    requestId: z.string().min(1).max(80),
    startDate: z.string().regex(DATE_PATTERN),
    endDate: z.string().regex(DATE_PATTERN),
  })
  .strict();

export type OverlapEntry = z.infer<typeof OverlapEntrySchema>;

/** `intake` artifact: the request, the requester, and the balance snapshot. */
export const IntakeArtifactSchema = z
  .object({
    requestId: z.string().min(3).max(80),
    employeeId: z.string().min(2).max(40),
    employeeLabel: z.string().min(1).max(80),
    department: z.string().min(2).max(120),
    leaveType: LeaveTypeSchema,
    startDate: z.string().regex(DATE_PATTERN),
    endDate: z.string().regex(DATE_PATTERN),
    note: z.string().max(500).nullable(),
    balanceDays: z.number().int().min(0).max(365),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type IntakeArtifact = z.infer<typeof IntakeArtifactSchema>;

/** Structured output of the leave advisor agent (narrative + confidence). */
export const PolicyModelOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type PolicyModelOutput = z.infer<typeof PolicyModelOutputSchema>;

/** `policy-check` artifact: the deterministic engine result plus narrative. */
export const PolicyArtifactSchema = z
  .object({
    requestId: z.string().min(3).max(80),
    employeeId: z.string().min(2).max(40),
    employeeLabel: z.string().min(1).max(80),
    leaveType: LeaveTypeSchema,
    startDate: z.string().regex(DATE_PATTERN),
    endDate: z.string().regex(DATE_PATTERN),
    workingDays: z.number().int().min(1).max(120),
    balanceBefore: z.number().int().min(0).max(365),
    balanceAfter: z.number().int().min(-365).max(365),
    checks: z.array(PolicyCheckRowSchema).min(1).max(10),
    overlaps: z.array(OverlapEntrySchema).max(20),
    blackoutHits: z.array(z.string().min(1).max(200)).max(10),
    verdict: z.enum(["ok", "exception_required"]),
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type PolicyArtifact = z.infer<typeof PolicyArtifactSchema>;

/** `approve` artifact: the manager approval the receipt will back. */
export const ApproveArtifactSchema = z
  .object({
    requestId: z.string().min(3).max(80),
    employeeId: z.string().min(2).max(40),
    employeeLabel: z.string().min(1).max(80),
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

/** The calendar entry the apply checkpoint previews. */
export const LeaveEntryPreviewSchema = z
  .object({
    entryId: z.string().min(3).max(80),
    requestId: z.string().min(3).max(80),
    employeeId: z.string().min(2).max(40),
    employeeLabel: z.string().min(1).max(80),
    leaveType: LeaveTypeSchema,
    startDate: z.string().regex(DATE_PATTERN),
    endDate: z.string().regex(DATE_PATTERN),
    workingDays: z.number().int().min(1).max(120),
    status: z.literal("booked"),
  })
  .strict();

export type LeaveEntryPreview = z.infer<typeof LeaveEntryPreviewSchema>;

/** `apply` artifact: the booking preview plus the idempotency key. */
export const ApplyArtifactSchema = z
  .object({
    request: LeaveEntryPreviewSchema,
    idempotencyKey: z.string().min(5).max(80),
    existing: z
      .object({
        entryId: z.string().min(3).max(80),
        createdAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ApplyArtifact = z.infer<typeof ApplyArtifactSchema>;

/** Receipt of the booked leave entry (the `apply` side effect). */
export const LeaveReceiptSchema = z
  .object({
    entryId: z.string().min(3).max(80),
    requestId: z.string().min(3).max(80),
    employeeId: z.string().min(2).max(40),
    startDate: z.string().regex(DATE_PATTERN),
    endDate: z.string().regex(DATE_PATTERN),
    workingDays: z.number().int().min(1).max(120),
    /** false when the booking replayed (idempotent by request id). */
    created: z.boolean(),
    registryRef: z.string().min(1).max(200),
  })
  .strict();

export type LeaveReceipt = z.infer<typeof LeaveReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const LeaveEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: LeaveReceiptSchema.optional(),
  })
  .strict();

export type LeaveEffect = z.infer<typeof LeaveEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const LeaveRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("leave"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: LeaveInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(LeaveEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type LeaveRunState = z.infer<typeof LeaveRunStateSchema>;

export const LeaveFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(LeaveEffectSchema),
    receipt: LeaveReceiptSchema.optional(),
  })
  .strict();

export type LeaveFlowOutput = z.infer<typeof LeaveFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const LeaveSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type LeaveSuspendPayload = z.infer<typeof LeaveSuspendSchema>;
