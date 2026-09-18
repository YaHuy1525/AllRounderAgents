import { z } from "zod";

import { AccessTierSchema } from "../hr/directory.js";

/**
 * Named steps of the Mastra offboarding flow. Ids match the API run definition
 * (`runs/definitions.py` OFFBOARDING_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const OFFBOARDING_FLOW_STEPS = ["intake", "access-audit", "approve", "revoke", "attest"] as const;

export type OffboardingFlowStepId = (typeof OFFBOARDING_FLOW_STEPS)[number];

/**
 * Run input supplied by the API (`POST /runs` input payload). The leaver is
 * referenced by directory id only; every artifact carries the deterministic
 * offboarding id plus a redacted initials label — never the raw name.
 */
export const OffboardingInputSchema = z
  .object({
    employeeId: z.string().min(2).max(40),
    lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD last day"),
    reason: z.string().min(2).max(500),
  })
  .passthrough();

export type OffboardingInput = z.infer<typeof OffboardingInputSchema>;

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

/** `intake` artifact: the resolved leaver and the departure facts. */
export const IntakeArtifactSchema = z
  .object({
    offboardingId: z.string().min(3).max(40),
    employeeId: z.string().min(2).max(40),
    /** Redacted initials only — the directory stores the raw name, not this. */
    employeeLabel: z.string().min(1).max(120),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    location: z.string().min(2).max(120),
    accessTier: AccessTierSchema,
    managerId: z.string().min(2).max(40).nullable(),
    lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string().min(2).max(500),
    systems: z.array(z.string().min(1).max(60)).min(1).max(30),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type IntakeArtifact = z.infer<typeof IntakeArtifactSchema>;

/** How recoverable a revocation is: reversible < recoverable < irreversible. */
export const REVERSIBILITIES = ["reversible", "recoverable", "irreversible"] as const;

export const ReversibilitySchema = z.enum(REVERSIBILITIES);

export type Reversibility = z.infer<typeof ReversibilitySchema>;

/** Blast-radius tiers, lowest first; high-blast items need explicit approval. */
export const BLAST_TIERS = ["low", "medium", "high"] as const;

export const BlastTierSchema = z.enum(BLAST_TIERS);

export type BlastTier = z.infer<typeof BlastTierSchema>;

/** One per-system audit row: blast radius, reversibility, and the story. */
export const AuditEntrySchema = z
  .object({
    system: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    blastRadius: BlastTierSchema,
    riskScore: z.number().int().min(0).max(100),
    reversibility: ReversibilitySchema,
    detail: z.string().min(1).max(500),
  })
  .strict();

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** One data-ownership row: the class of data a system holds, and its owner. */
export const DataOwnershipSchema = z
  .object({
    system: z.string().min(1).max(60),
    dataClass: z.string().min(1).max(120),
    owner: z.string().min(1).max(120),
  })
  .strict();

export type DataOwnership = z.infer<typeof DataOwnershipSchema>;

/** One cross-cutting departure risk with its tier and story. */
export const AuditRiskSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    tier: BlastTierSchema,
    detail: z.string().min(1).max(500),
  })
  .strict();

export type AuditRisk = z.infer<typeof AuditRiskSchema>;

/** Structured output of the audit agent (narrative frame + confidence). */
export const AuditModelOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type AuditModelOutput = z.infer<typeof AuditModelOutputSchema>;

/** `access-audit` artifact: entries, data ownership, and the risk list. */
export const AuditArtifactSchema = z
  .object({
    offboardingId: z.string().min(3).max(40),
    employeeId: z.string().min(2).max(40),
    employeeLabel: z.string().min(1).max(120),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    accessTier: AccessTierSchema,
    lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string().min(2).max(500),
    entries: z.array(AuditEntrySchema).min(1).max(30),
    dataOwnership: z.array(DataOwnershipSchema).min(1).max(30),
    risks: z.array(AuditRiskSchema).min(1).max(10),
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type AuditArtifact = z.infer<typeof AuditArtifactSchema>;

/** One revocation line in the approval gate; high-blast rows gate revoking. */
export const ApproveItemSchema = z
  .object({
    system: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    blastRadius: BlastTierSchema,
    riskScore: z.number().int().min(0).max(100),
    reversibility: ReversibilitySchema,
    /** Destructive-action semantics: high-blast revocations need a sign-off. */
    requiresExplicitApproval: z.boolean(),
    approved: z.boolean(),
    /** Redacted initials or role label of the signer; null when not required. */
    approver: z.string().max(120).nullable(),
    note: z.string().max(500).nullable(),
  })
  .strict();

export type ApproveItem = z.infer<typeof ApproveItemSchema>;

/** `approve` artifact: every revocation item individually risk-scored. */
export const ApproveArtifactSchema = z
  .object({
    offboardingId: z.string().min(3).max(40),
    employeeId: z.string().min(2).max(40),
    employeeLabel: z.string().min(1).max(120),
    lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    items: z.array(ApproveItemSchema).min(1).max(30),
    explicitApprovalsRequired: z.number().int().nonnegative().max(30),
    allApproved: z.boolean(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ApproveArtifact = z.infer<typeof ApproveArtifactSchema>;

/** Per-system revocation states: pending until the side effect runs. */
export const REVOKE_STATUSES = ["pending", "revoked", "failed"] as const;

export const RevokeStatusSchema = z.enum(REVOKE_STATUSES);

export type RevokeStatus = z.infer<typeof RevokeStatusSchema>;

/** One planned revocation action; failures are listed, never swallowed. */
export const RevokeActionSchema = z
  .object({
    system: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    blastRadius: BlastTierSchema,
    status: RevokeStatusSchema,
    detail: z.string().min(1).max(500),
  })
  .strict();

export type RevokeAction = z.infer<typeof RevokeActionSchema>;

/** `revoke` artifact: the per-system revocation plan. */
export const RevokeArtifactSchema = z
  .object({
    offboardingId: z.string().min(3).max(40),
    employeeId: z.string().min(2).max(40),
    employeeLabel: z.string().min(1).max(120),
    lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    actions: z.array(RevokeActionSchema).min(1).max(30),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type RevokeArtifact = z.infer<typeof RevokeArtifactSchema>;

/** A system whose revocation failed, with the registry's reason. */
export const RevokeFailureSchema = z
  .object({
    system: z.string().min(1).max(60),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type RevokeFailure = z.infer<typeof RevokeFailureSchema>;

/** Receipt of the access revocation (the `revoke` side effect). */
export const RevokeReceiptSchema = z
  .object({
    employeeId: z.string().min(2).max(40),
    /** Redacted initials only. */
    label: z.string().min(1).max(120),
    revoked: z.array(z.string().min(1).max(60)).max(30),
    failed: z.array(RevokeFailureSchema).max(30),
    /** Systems that were already revoked before this pass (idempotent replay). */
    replayed: z.number().int().nonnegative().max(30),
    idempotencyKey: z.string().min(5).max(40),
    registryRef: z.string().min(1).max(200),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RevokeReceipt = z.infer<typeof RevokeReceiptSchema>;

/** Final-pay checklist statuses; pending rows are still owed at close. */
export const FINAL_PAY_STATUSES = ["ready", "pending", "blocked"] as const;

export const FinalPayStatusSchema = z.enum(FINAL_PAY_STATUSES);

export type FinalPayStatus = z.infer<typeof FinalPayStatusSchema>;

export const FinalPayItemSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    status: FinalPayStatusSchema,
    detail: z.string().min(1).max(500),
  })
  .strict();

export type FinalPayItem = z.infer<typeof FinalPayItemSchema>;

export const EQUIPMENT_STATUSES = ["returned", "outstanding"] as const;

export const EquipmentStatusSchema = z.enum(EQUIPMENT_STATUSES);

export type EquipmentStatus = z.infer<typeof EquipmentStatusSchema>;

export const EquipmentItemSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    status: EquipmentStatusSchema,
    detail: z.string().min(1).max(500),
  })
  .strict();

export type EquipmentItem = z.infer<typeof EquipmentItemSchema>;

/** Reviewer note acknowledging a failed revocation before the case closes. */
export const AcknowledgementSchema = z
  .object({
    system: z.string().min(1).max(60),
    note: z.string().min(1).max(500),
  })
  .strict();

export type Acknowledgement = z.infer<typeof AcknowledgementSchema>;

/** `attest` artifact: final-pay checklist, equipment returns, case close. */
export const AttestArtifactSchema = z
  .object({
    offboardingId: z.string().min(3).max(40),
    employeeId: z.string().min(2).max(40),
    employeeLabel: z.string().min(1).max(120),
    lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    finalPay: z
      .object({
        items: z.array(FinalPayItemSchema).min(1).max(10),
        outstanding: z.number().int().nonnegative().max(10),
      })
      .strict(),
    equipment: z
      .object({
        items: z.array(EquipmentItemSchema).min(1).max(10),
        outstanding: z.number().int().nonnegative().max(10),
      })
      .strict(),
    revocation: z
      .object({
        revoked: z.array(z.string().min(1).max(60)).max(30),
        failed: z.array(RevokeFailureSchema).max(30),
      })
      .strict(),
    acknowledgements: z.array(AcknowledgementSchema).max(20),
    /** Set when the registry already attests this employee (idempotent replay). */
    existing: z
      .object({
        closedAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type AttestArtifact = z.infer<typeof AttestArtifactSchema>;

/** Receipt of the attested case close (the `attest` side effect). */
export const AttestReceiptSchema = z
  .object({
    offboardingId: z.string().min(3).max(40),
    employeeId: z.string().min(2).max(40),
    /** Redacted initials only. */
    label: z.string().min(1).max(120),
    revokedSystems: z.array(z.string().min(1).max(60)).max(30),
    failedSystems: z.array(z.string().min(1).max(60)).max(30),
    equipmentOutstanding: z.array(z.string().min(1).max(200)).max(10),
    finalPayReady: z.boolean(),
    caseClosed: z.literal(true),
    /** false when an existing attestation was reused (idempotent by employee). */
    created: z.boolean(),
    registryRef: z.string().min(1).max(200),
    closedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AttestReceipt = z.infer<typeof AttestReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const OffboardingEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: z.union([RevokeReceiptSchema, AttestReceiptSchema]).optional(),
  })
  .strict();

export type OffboardingEffect = z.infer<typeof OffboardingEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const OffboardingRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("offboarding"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: OffboardingInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(OffboardingEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type OffboardingRunState = z.infer<typeof OffboardingRunStateSchema>;

export const OffboardingFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(OffboardingEffectSchema),
    receipt: AttestReceiptSchema.optional(),
  })
  .strict();

export type OffboardingFlowOutput = z.infer<typeof OffboardingFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const OffboardingSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type OffboardingSuspendPayload = z.infer<typeof OffboardingSuspendSchema>;
