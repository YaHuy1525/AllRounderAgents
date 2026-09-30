import { z } from "zod";

import { DeskTicketRefSchema } from "../../desks/types.js";

/**
 * Named steps of the Mastra MSP flow. Ids match the API run definition
 * (`runs/definitions.py` MSP_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const MSP_FLOW_STEPS = ["intake", "ticket", "draft", "approve", "send"] as const;

export type MspFlowStepId = (typeof MSP_FLOW_STEPS)[number];

/**
 * Escalation ladder reused from the support workflow (`empty_retrieval`,
 * `stale_evidence`, `unsupported_claim`) plus `empty_draft` for a reply that
 * came back too thin to send. An escalated draft stays visible and a human
 * edit can still send it; the send receipt records every reason.
 */
export const MSP_ESCALATION_REASONS = [
  "empty_retrieval",
  "stale_evidence",
  "unsupported_claim",
  "empty_draft",
] as const;

export const MspEscalationReasonSchema = z.enum(MSP_ESCALATION_REASONS);

export type MspEscalationReason = z.infer<typeof MspEscalationReasonSchema>;

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

/** Reply citation discipline: a source id plus a character span. */
export const SPAN_PATTERN = /^\d+-\d+$/;

export const CitationSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    span: z.string().regex(SPAN_PATTERN),
  })
  .strict();

export type Citation = z.infer<typeof CitationSchema>;

/** One retrieved knowledge passage with its score and staleness flag. */
export const MspPassageSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    span: z.string().regex(SPAN_PATTERN),
    title: z.string().min(1).max(200),
    text: z.string().min(1).max(2_000),
    /** Deterministic term-overlap score between 0 and 1. */
    score: z.number().min(0).max(1),
    /** True when the knowledge document's review date is out of date. */
    stale: z.boolean(),
  })
  .strict();

export type MspPassage = z.infer<typeof MspPassageSchema>;

/**
 * Run input supplied by the API (`POST /runs` input payload): one normalized
 * inbound client email. `clientRef` may be set by the intake route when the
 * forwarder already knows the client; otherwise it derives from the
 * per-client ingest address.
 */
export const MspInputSchema = z
  .object({
    messageId: z.string().min(1).max(300),
    from: z.string().min(3).max(320),
    fromName: z.string().min(1).max(200).optional(),
    to: z.string().min(3).max(320),
    subject: z.string().min(1).max(500),
    text: z.string().min(1).max(20_000),
    receivedAt: z.string().datetime({ offset: true }).optional(),
    clientRef: z.string().min(1).max(80).optional(),
    /** Tenant scope for knowledge lookups; intake fills it from the caller. */
    tenantId: z.string().min(1).max(200).optional(),
  })
  .passthrough();

export type MspInput = z.infer<typeof MspInputSchema>;

/** `intake` artifact: the normalized email plus the derived client ref. */
export const IntakeArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    messageId: z.string().min(1).max(300),
    from: z.string().min(3).max(320),
    fromName: z.string().min(1).max(200).nullable(),
    clientRef: z.string().min(1).max(80),
    subject: z.string().min(1).max(500),
    receivedAt: z.string().datetime({ offset: true }),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type IntakeArtifact = z.infer<typeof IntakeArtifactSchema>;

/** `ticket` artifact: what the desk create will write, plus any existing ref. */
export const TicketArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    clientRef: z.string().min(1).max(80),
    provider: z.string().min(1).max(80),
    title: z.string().min(1).max(300),
    labels: z.array(z.string().min(1).max(40)).max(20),
    /** Stable correlation token; a desk that can dedupe replays on it. */
    correlationId: z.string().min(5).max(200),
    /** The desk ticket this case already created, when one is recorded. */
    existing: DeskTicketRefSchema.nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type TicketArtifact = z.infer<typeof TicketArtifactSchema>;

/** `ticket` side-effect receipt: the created desk ticket. */
export const MspTicketReceiptSchema = z
  .object({
    deskRef: DeskTicketRefSchema,
    provider: z.string().min(1).max(80),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type MspTicketReceipt = z.infer<typeof MspTicketReceiptSchema>;

/** Structured output of the MSP drafter agent. */
export const DraftModelOutputSchema = z
  .object({
    body: z.string().min(1).max(4_000),
    citations: z.array(CitationSchema).max(8),
  })
  .strict();

export type DraftModelOutput = z.infer<typeof DraftModelOutputSchema>;

/** `draft` artifact: the reply, its citations, and the escalation reasons. */
export const DraftArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    clientRef: z.string().min(1).max(80),
    subject: z.string().min(1).max(500),
    body: z.string().max(4_000),
    citations: z.array(CitationSchema).max(8),
    escalations: z.array(MspEscalationReasonSchema).max(8),
    escalated: z.boolean(),
    /** Passages the draft was grounded in, kept for the review trail. */
    passageCount: z.number().int().nonnegative().max(8),
    staleCount: z.number().int().nonnegative().max(8),
    summary: z.string().min(1).max(2_000),
  })
  .strict()
  .superRefine((draft, ctx) => {
    if (draft.escalated !== (draft.escalations.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "escalated must match a non-empty escalation list",
      });
    }
  });

export type DraftArtifact = z.infer<typeof DraftArtifactSchema>;

/** `approve` artifact: the service-desk approval the receipt will back. */
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

/** `send` artifact: the reply the send checkpoint previews before it leaves. */
export const SendArtifactSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    clientRef: z.string().min(1).max(80),
    to: z.string().min(3).max(320),
    subject: z.string().min(1).max(500),
    from: z.string().min(3).max(320),
    /** The desk ticket key the receipt comment posts to, when one exists. */
    deskKey: z.string().min(1).max(200).nullable(),
    idempotencyKey: z.string().min(5).max(200),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type SendArtifact = z.infer<typeof SendArtifactSchema>;

/** Receipt of the sent reply plus the desk comment (the `send` side effect). */
export const MspSendReceiptSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    clientRef: z.string().min(1).max(80),
    deskKey: z.string().min(1).max(200).nullable(),
    to: z.string().min(3).max(320),
    subject: z.string().min(1).max(500),
    mailArtifact: z.string().min(1).max(400),
    mailMessageId: z.string().min(1).max(400),
    /** false when the send replayed (idempotent by case and ticket). */
    mailCreated: z.boolean(),
    commentId: z.string().min(1).max(400).nullable(),
    commentPosted: z.boolean(),
    escalations: z.array(MspEscalationReasonSchema).max(8),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type MspSendReceipt = z.infer<typeof MspSendReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const MspEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: z.record(z.unknown()).optional(),
  })
  .strict();

export type MspEffect = z.infer<typeof MspEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const MspRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("msp"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: MspInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(MspEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type MspRunState = z.infer<typeof MspRunStateSchema>;

export const MspFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(MspEffectSchema),
    receipt: MspSendReceiptSchema.optional(),
  })
  .strict();

export type MspFlowOutput = z.infer<typeof MspFlowOutputSchema>;

/**
 * Suspend payload the API reads: the reviewable artifact plus lock target.
 * `effects` carries every side effect recorded so far, so a restarted or
 * re-driven run learns about a created ticket even while a later step is
 * suspended (the API merges it into the authoritative map).
 */
export const MspSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
    effects: z.record(MspEffectSchema).optional(),
  })
  .strict();

export type MspSuspendPayload = z.infer<typeof MspSuspendSchema>;
