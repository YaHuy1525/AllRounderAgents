import { z } from "zod";

/**
 * Named steps of the Mastra review flow. Ids match the API run definition
 * (`runs/definitions.py` REVIEW_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const REVIEW_FLOW_STEPS = [
  "select-pr",
  "review-options",
  "ai-review",
  "complete",
] as const;

export type ReviewFlowStepId = (typeof REVIEW_FLOW_STEPS)[number];

/** Run input supplied by the API (`POST /runs` input payload). */
export const ReviewInputSchema = z
  .object({
    repository: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo"),
    prNumber: z.number().int().positive().optional(),
    lastReviewedSha: z
      .string()
      .regex(/^[a-f0-9]{7,64}$/, "expected a commit sha")
      .optional(),
  })
  .passthrough();

export type ReviewInput = z.infer<typeof ReviewInputSchema>;

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

export const ReviewVerdictSchema = z.enum(["approve", "comment", "request_changes"]);

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewCommentSchema = z
  .object({
    path: z.string().min(1).max(500),
    line: z.number().int().positive(),
    body: z.string().min(1).max(2_000),
  })
  .strict();

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

/** Receipt of a posted pull-request review (the `complete` side effect). */
export const ReviewReceiptSchema = z
  .object({
    reviewId: z.string().min(1).max(100),
    url: z.string().min(1).max(500),
    verdict: ReviewVerdictSchema,
    repository: z.string().min(1).max(200),
    prNumber: z.number().int().positive(),
    reviewedSha: z.string().regex(/^[a-f0-9]{7,64}$/),
    postedComments: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500),
            line: z.number().int().positive(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const ReviewEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: ReviewReceiptSchema.optional(),
  })
  .strict();

export type ReviewEffect = z.infer<typeof ReviewEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const ReviewRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("review"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: ReviewInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(ReviewEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type ReviewRunState = z.infer<typeof ReviewRunStateSchema>;

export const PullRequestCandidateSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(300),
    repository: z.string().min(1).max(200),
    author: z.string().max(200),
    baseBranch: z.string().min(1).max(200),
    headSha: z.string().regex(/^[a-f0-9]{7,64}$/),
    draft: z.boolean(),
  })
  .strict();

export type PullRequestCandidate = z.infer<typeof PullRequestCandidateSchema>;

/** `select-pr` artifact: the picker list plus the current selection. */
export const SelectPrArtifactSchema = z
  .object({
    repository: z.string().min(1).max(200),
    candidates: z.array(PullRequestCandidateSchema).max(50),
    selected: PullRequestCandidateSchema.nullable(),
  })
  .strict();

export type SelectPrArtifact = z.infer<typeof SelectPrArtifactSchema>;

/** Review categories offered as cards in `review-options`. */
export const REVIEW_CATEGORIES = [
  { id: "code-quality", label: "Code Quality" },
  { id: "security", label: "Security" },
  { id: "performance", label: "Performance" },
  { id: "best-practices", label: "Best Practices" },
  { id: "meets-requirements", label: "Meets Requirements" },
] as const;

export const ReviewCategoryIdSchema = z.enum([
  "code-quality",
  "security",
  "performance",
  "best-practices",
  "meets-requirements",
]);

export type ReviewCategoryId = z.infer<typeof ReviewCategoryIdSchema>;

export const ReviewCategorySelectionSchema = z
  .object({
    id: ReviewCategoryIdSchema,
    label: z.string().min(1).max(100),
    enabled: z.boolean(),
  })
  .strict();

/** `review-options` artifact: the selected PR plus the category picks. */
export const ReviewOptionsArtifactSchema = z
  .object({
    pullRequest: PullRequestCandidateSchema,
    categories: z.array(ReviewCategorySelectionSchema).min(1).max(10),
    guidance: z.string().max(4_000),
  })
  .strict();

export type ReviewOptionsArtifact = z.infer<typeof ReviewOptionsArtifactSchema>;

/** Structured output of the reviewer agent (judgment carries confidence). */
export const ReviewModelOutputSchema = z
  .object({
    verdict: ReviewVerdictSchema,
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(4_000),
    strengths: z.array(z.string().min(1).max(1_000)).max(20),
    improvements: z.array(z.string().min(1).max(1_000)).max(20),
    comments: z.array(ReviewCommentSchema).max(100),
  })
  .strict();

export type ReviewModelOutput = z.infer<typeof ReviewModelOutputSchema>;

/** `ai-review` artifact: the reviewed verdict, editable before any post. */
export const AiReviewArtifactSchema = z
  .object({
    pullRequest: PullRequestCandidateSchema,
    verdict: ReviewVerdictSchema,
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(4_000),
    strengths: z.array(z.string().min(1).max(1_000)).max(20),
    improvements: z.array(z.string().min(1).max(1_000)).max(20),
    comments: z.array(ReviewCommentSchema).max(100),
    categories: z.array(ReviewCategoryIdSchema).min(1),
    deltaOnly: z.boolean(),
    reviewedSha: z.string().regex(/^[a-f0-9]{7,64}$/),
  })
  .strict();

export type AiReviewArtifact = z.infer<typeof AiReviewArtifactSchema>;

/** `complete` artifact: the review preview shown before it is posted. */
export const CompleteArtifactSchema = z
  .object({
    pullRequest: PullRequestCandidateSchema,
    verdict: ReviewVerdictSchema,
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(4_000),
    strengths: z.array(z.string().min(1).max(1_000)).max(20),
    improvements: z.array(z.string().min(1).max(1_000)).max(20),
    comments: z.array(ReviewCommentSchema).max(100),
    deltaOnly: z.boolean(),
    reviewedSha: z.string().regex(/^[a-f0-9]{7,64}$/),
    followUp: z
      .object({
        reviewedSha: z.string().regex(/^[a-f0-9]{7,64}$/),
        deltaOnlyOnNewPush: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type CompleteArtifact = z.infer<typeof CompleteArtifactSchema>;

export const ReviewFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(ReviewEffectSchema),
    receipt: ReviewReceiptSchema.optional(),
  })
  .strict();

export type ReviewFlowOutput = z.infer<typeof ReviewFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const ReviewSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type ReviewSuspendPayload = z.infer<typeof ReviewSuspendSchema>;
