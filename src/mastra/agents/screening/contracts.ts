import { z } from "zod";

/**
 * Named steps of the Mastra screening flow. Ids match the API run definition
 * (`runs/definitions.py` SCREENING_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const SCREENING_FLOW_STEPS = ["requisition", "screen", "shortlist", "schedule"] as const;

export type ScreeningFlowStepId = (typeof SCREENING_FLOW_STEPS)[number];

/**
 * Run input supplied by the API (`POST /runs` input payload). The requisition
 * is referenced by ATS id only; candidates stay identified by candidate id
 * with a redacted initials label — never the raw name.
 */
export const ScreeningInputSchema = z
  .object({
    requisitionId: z.string().min(2).max(40),
  })
  .passthrough();

export type ScreeningInput = z.infer<typeof ScreeningInputSchema>;

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

/** One weighted rubric criterion; must-haves gate the shortlist default. */
export const RequisitionCriterionSchema = z
  .object({
    id: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    weight: z.number().int().min(0).max(100),
    mustHave: z.boolean(),
    detail: z.string().min(1).max(500),
  })
  .strict();

export type RequisitionCriterion = z.infer<typeof RequisitionCriterionSchema>;

/** `requisition` artifact: the role, its weighted rubric, and the pipeline. */
export const RequisitionArtifactSchema = z
  .object({
    requisitionId: z.string().min(2).max(40),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    location: z.string().min(2).max(120),
    seniority: z.string().min(2).max(60),
    criteria: z.array(RequisitionCriterionSchema).min(1).max(12),
    mustHaves: z.number().int().nonnegative().max(12),
    candidateIds: z.array(z.string().min(1).max(40)).min(1).max(50),
    /** Interviewer employee ids, referenced by id only. */
    interviewers: z.array(z.string().min(2).max(40)).min(1).max(10),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type RequisitionArtifact = z.infer<typeof RequisitionArtifactSchema>;

/** One citation into the candidate's file (issues-lane evidence pattern). */
export const CitationSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    span: z.string().min(1).max(40),
    text: z.string().min(1).max(500),
  })
  .strict();

export type Citation = z.infer<typeof CitationSchema>;

/** Per-criterion verdicts: strong citations pass, weak ones partial. */
export const VERDICTS = ["pass", "partial", "fail"] as const;

export const VerdictSchema = z.enum(VERDICTS);

export type Verdict = z.infer<typeof VerdictSchema>;

/** One criterion verdict with the citations that support it. */
export const ScreenVerdictSchema = z
  .object({
    criterionId: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    weight: z.number().int().min(0).max(100),
    mustHave: z.boolean(),
    verdict: VerdictSchema,
    citations: z.array(CitationSchema).max(10),
  })
  .strict();

export type ScreenVerdict = z.infer<typeof ScreenVerdictSchema>;

/** Guardrail flag kinds: protected-attribute language and non-rubric reasoning. */
export const GUARDRAIL_FLAG_KINDS = ["protected-attribute", "non-rubric"] as const;

export const GuardrailFlagKindSchema = z.enum(GUARDRAIL_FLAG_KINDS);

export type GuardrailFlagKind = z.infer<typeof GuardrailFlagKindSchema>;

/** One guardrail finding, citing its source where the language lives. */
export const GuardrailFlagSchema = z
  .object({
    candidateId: z.string().min(1).max(40),
    kind: GuardrailFlagKindSchema,
    detail: z.string().min(1).max(500),
    sourceId: z.string().max(200).nullable(),
    span: z.string().max(40).nullable(),
  })
  .strict();

export type GuardrailFlag = z.infer<typeof GuardrailFlagSchema>;

/** Structured output of the hr guardrail agent. */
export const GuardrailOutputSchema = z
  .object({
    allowed: z.boolean(),
    summary: z.string().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    flags: z.array(GuardrailFlagSchema).max(30),
  })
  .strict();

export type GuardrailOutput = z.infer<typeof GuardrailOutputSchema>;

/** One screened candidate: verdicts, weighted score, and guardrail flags. */
export const ScreenCandidateSchema = z
  .object({
    candidateId: z.string().min(1).max(40),
    /** Redacted initials only — the ATS stores the raw name, not this. */
    candidateLabel: z.string().min(1).max(120),
    headline: z.string().min(1).max(200),
    verdicts: z.array(ScreenVerdictSchema).min(1).max(12),
    score: z.number().int().min(0).max(100),
    mustHaveMisses: z.array(z.string().min(1).max(120)).max(12),
    flags: z.array(GuardrailFlagSchema).max(10),
  })
  .strict();

export type ScreenCandidate = z.infer<typeof ScreenCandidateSchema>;

/** `screen` artifact: per-candidate verdicts plus the guardrail verdict. */
export const ScreenArtifactSchema = z
  .object({
    requisitionId: z.string().min(2).max(40),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    candidates: z.array(ScreenCandidateSchema).min(1).max(20),
    guardrail: z
      .object({
        allowed: z.boolean(),
        summary: z.string().min(1).max(2_000),
        confidence: z.number().min(0).max(1),
      })
      .strict(),
    totalFlags: z.number().int().nonnegative().max(300),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ScreenArtifact = z.infer<typeof ScreenArtifactSchema>;

/** One shortlist line: the default decision plus the reviewer's reason. */
export const ShortlistEntrySchema = z
  .object({
    candidateId: z.string().min(1).max(40),
    candidateLabel: z.string().min(1).max(120),
    score: z.number().int().min(0).max(100),
    decision: z.enum(["include", "exclude"]),
    /** Exclusions must carry a reason before the flow proceeds. */
    reason: z.string().max(500),
    flags: z.number().int().nonnegative().max(30),
  })
  .strict();

export type ShortlistEntry = z.infer<typeof ShortlistEntrySchema>;

/** `shortlist` artifact: per-candidate include/exclude with reasons. */
export const ShortlistArtifactSchema = z
  .object({
    requisitionId: z.string().min(2).max(40),
    roleTitle: z.string().min(2).max(200),
    entries: z.array(ShortlistEntrySchema).min(1).max(20),
    included: z.number().int().nonnegative().max(20),
    excluded: z.number().int().nonnegative().max(20),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ShortlistArtifact = z.infer<typeof ShortlistArtifactSchema>;

/** Per-invite scheduling states: pending until the side effect runs. */
export const SCHEDULE_STATUSES = ["pending", "scheduled", "failed"] as const;

export const ScheduleStatusSchema = z.enum(SCHEDULE_STATUSES);

export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

/** One interview invite line; failed rows are listed in the receipt. */
export const ScheduleInviteSchema = z
  .object({
    candidateId: z.string().min(1).max(40),
    candidateLabel: z.string().min(1).max(120),
    slot: z.string().min(1).max(60),
    interviewer: z.string().min(2).max(40),
    status: ScheduleStatusSchema,
    detail: z.string().min(1).max(500),
  })
  .strict();

export type ScheduleInvite = z.infer<typeof ScheduleInviteSchema>;

/** `schedule` artifact: the per-candidate interview invite plan. */
export const ScheduleArtifactSchema = z
  .object({
    requisitionId: z.string().min(2).max(40),
    roleTitle: z.string().min(2).max(200),
    invites: z.array(ScheduleInviteSchema).min(1).max(50),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ScheduleArtifact = z.infer<typeof ScheduleArtifactSchema>;

/** A candidate whose invite failed, with the ATS reason. */
export const ScheduleFailureSchema = z
  .object({
    candidateId: z.string().min(1).max(40),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type ScheduleFailure = z.infer<typeof ScheduleFailureSchema>;

/** Receipt of the interview scheduling (the `schedule` side effect). */
export const ScheduleReceiptSchema = z
  .object({
    requisitionId: z.string().min(2).max(40),
    scheduled: z
      .array(
        z
          .object({
            candidateId: z.string().min(1).max(40),
            slot: z.string().min(1).max(60),
          })
          .strict(),
      )
      .max(50),
    failed: z.array(ScheduleFailureSchema).max(50),
    /** Invites that already existed before this pass (idempotent replay). */
    replayed: z.number().int().nonnegative().max(50),
    idempotencyKey: z.string().min(5).max(80),
    registryRef: z.string().min(1).max(200),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ScheduleReceipt = z.infer<typeof ScheduleReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const ScreeningEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: ScheduleReceiptSchema.optional(),
  })
  .strict();

export type ScreeningEffect = z.infer<typeof ScreeningEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const ScreeningRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("screening"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: ScreeningInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(ScreeningEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type ScreeningRunState = z.infer<typeof ScreeningRunStateSchema>;

export const ScreeningFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(ScreeningEffectSchema),
    receipt: ScheduleReceiptSchema.optional(),
  })
  .strict();

export type ScreeningFlowOutput = z.infer<typeof ScreeningFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const ScreeningSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type ScreeningSuspendPayload = z.infer<typeof ScreeningSuspendSchema>;
