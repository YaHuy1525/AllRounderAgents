import { z } from "zod";

/**
 * Named steps of the Mastra HR help flow. Ids match the API run definition
 * (`runs/definitions.py` HR_HELP_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const HR_HELP_FLOW_STEPS = ["intake", "retrieve", "draft", "approve", "send"] as const;

export type HrHelpFlowStepId = (typeof HR_HELP_FLOW_STEPS)[number];

/**
 * Run input supplied by the API (`POST /runs` input payload). The question is
 * the ticket text; it carries no personnel records, and every artifact keeps
 * people out of the answer entirely.
 */
export const HrHelpInputSchema = z
  .object({
    question: z.string().min(5).max(2_000),
  })
  .passthrough();

export type HrHelpInput = z.infer<typeof HrHelpInputSchema>;

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

/** Support-lane citation discipline: a source id plus a character span. */
export const SPAN_PATTERN = /^\d+-\d+$/;

export const CitationSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    span: z.string().regex(SPAN_PATTERN),
  })
  .strict();

export type Citation = z.infer<typeof CitationSchema>;

/** One retrieved policy paragraph with its score and staleness flag. */
export const PolicyPassageSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    span: z.string().regex(SPAN_PATTERN),
    title: z.string().min(1).max(200),
    text: z.string().min(1).max(2_000),
    /** Deterministic term-overlap score between 0 and 1. */
    score: z.number().min(0).max(1),
    /** True when the policy document's review date is out of date. */
    stale: z.boolean(),
  })
  .strict();

export type PolicyPassage = z.infer<typeof PolicyPassageSchema>;

/** `intake` artifact: the question plus the terms retrieval will match on. */
export const IntakeArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    question: z.string().min(5).max(2_000),
    topics: z.array(z.string().min(1).max(40)).min(1).max(8),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type IntakeArtifact = z.infer<typeof IntakeArtifactSchema>;

/** `retrieve` artifact: the ranked passages the draft must cite. */
export const RetrieveArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    question: z.string().min(5).max(2_000),
    passages: z.array(PolicyPassageSchema).min(1).max(8),
    staleCount: z.number().int().nonnegative().max(8),
    matchedTerms: z.array(z.string().min(1).max(40)).max(12),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type RetrieveArtifact = z.infer<typeof RetrieveArtifactSchema>;

/** Structured output of the HR help drafter agent. */
export const DraftModelOutputSchema = z
  .object({
    answer: z.string().min(20).max(4_000),
    citations: z.array(CitationSchema).min(1).max(8),
  })
  .strict();

export type DraftModelOutput = z.infer<typeof DraftModelOutputSchema>;

/** Guardrail flag kinds: legal-advice phrasing and PII leakage. */
export const HR_HELP_FLAG_KINDS = ["legal-advice", "pii-leakage"] as const;

export const HrHelpFlagKindSchema = z.enum(HR_HELP_FLAG_KINDS);

export type HrHelpFlagKind = z.infer<typeof HrHelpFlagKindSchema>;

/** One guardrail finding; the answer is cited as `answer` with its span. */
export const HrHelpFlagSchema = z
  .object({
    kind: HrHelpFlagKindSchema,
    detail: z.string().min(1).max(500),
    sourceId: z.string().max(200).nullable(),
    span: z.string().max(40).nullable(),
  })
  .strict();

export type HrHelpFlag = z.infer<typeof HrHelpFlagSchema>;

/** Structured output of the HR help guardrail agent. */
export const HrHelpGuardrailOutputSchema = z
  .object({
    allowed: z.boolean(),
    summary: z.string().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    flags: z.array(HrHelpFlagSchema).max(20),
  })
  .strict();

export type HrHelpGuardrailOutput = z.infer<typeof HrHelpGuardrailOutputSchema>;

/** `draft` artifact: the cited answer plus the guardrail verdict. */
export const DraftArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    question: z.string().min(5).max(2_000),
    answer: z.string().min(1).max(4_000),
    citations: z.array(CitationSchema).min(1).max(8),
    flags: z.array(HrHelpFlagSchema).max(20),
    guardrail: z
      .object({
        allowed: z.boolean(),
        summary: z.string().min(1).max(2_000),
        confidence: z.number().min(0).max(1),
      })
      .strict(),
    totalFlags: z.number().int().nonnegative().max(20),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type DraftArtifact = z.infer<typeof DraftArtifactSchema>;

/** `approve` artifact: the people-partner approval the receipt will back. */
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

/** The recorded answer the send checkpoint previews. */
export const AnswerPreviewSchema = z
  .object({
    answerId: z.string().min(3).max(80),
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    citationCount: z.number().int().nonnegative().max(8),
    status: z.literal("sent"),
  })
  .strict();

export type AnswerPreview = z.infer<typeof AnswerPreviewSchema>;

/** `send` artifact: the preview plus the idempotency key. */
export const SendArtifactSchema = z
  .object({
    response: AnswerPreviewSchema,
    idempotencyKey: z.string().min(5).max(200),
    existing: z
      .object({
        answerId: z.string().min(3).max(80),
        createdAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type SendArtifact = z.infer<typeof SendArtifactSchema>;

/** Receipt of the recorded answer (the `send` side effect). */
export const HrHelpReceiptSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    answerId: z.string().min(3).max(80),
    citations: z.array(CitationSchema).min(1).max(8),
    /** false when the send replayed (idempotent by case + ticket). */
    created: z.boolean(),
    registryRef: z.string().min(1).max(200),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type HrHelpReceipt = z.infer<typeof HrHelpReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const HrHelpEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: HrHelpReceiptSchema.optional(),
  })
  .strict();

export type HrHelpEffect = z.infer<typeof HrHelpEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const HrHelpRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("hr-help"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: HrHelpInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(HrHelpEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type HrHelpRunState = z.infer<typeof HrHelpRunStateSchema>;

export const HrHelpFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(HrHelpEffectSchema),
    receipt: HrHelpReceiptSchema.optional(),
  })
  .strict();

export type HrHelpFlowOutput = z.infer<typeof HrHelpFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const HrHelpSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type HrHelpSuspendPayload = z.infer<typeof HrHelpSuspendSchema>;
