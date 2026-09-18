import { z } from "zod";

import {
  PullRequestReceiptSchema,
  RepositoryPathSchema,
  ShaSchema,
  ValidationReportSchema,
} from "../programming/contracts.js";

/**
 * Named steps of the Mastra issues flow. Ids match the API run definition
 * (`runs/definitions.py` ISSUES_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const ISSUES_FLOW_STEPS = [
  "issue-selection",
  "analysis",
  "implementation",
  "complete",
] as const;

export type IssuesFlowStepId = (typeof ISSUES_FLOW_STEPS)[number];

export const ValidatorNameSchema = z.enum(["json", "yaml", "xml", "basic-syntax"]);

export type ValidatorName = z.infer<typeof ValidatorNameSchema>;

/** One bug ticket offered as a chip in `issue-selection`. */
export const IssueTicketCandidateSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "expected a ticket key"),
    summary: z.string().min(1).max(500),
    status: z.string().min(1).max(100),
  })
  .strict();

export type IssueTicketCandidate = z.infer<typeof IssueTicketCandidateSchema>;

/**
 * Run input supplied by the API (`POST /runs` input payload). `candidates`
 * are the bug tickets the runner offers (typically the open bugs loaded in
 * the console); the flow falls back to the run's own ticket when absent.
 */
export const IssueInputSchema = z
  .object({
    ticketKey: z.string().min(1).max(200),
    ticketSummary: z.string().min(1).max(2_000).optional(),
    repository: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo")
      .optional(),
    baseBranch: z.string().min(1).max(250).optional(),
    candidates: z.array(IssueTicketCandidateSchema).max(50).optional(),
  })
  .passthrough();

export type IssueInput = z.infer<typeof IssueInputSchema>;

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

/** Receipt of the opened Draft PR (the `complete` side effect). */
export const IssueReceiptSchema = z
  .object({
    pr: PullRequestReceiptSchema,
    caseId: z.string().min(1).max(200),
    ticketKey: z.string().min(1).max(200),
    branch: z.string().min(1).max(250),
    ticketTransition: z
      .object({
        ticketKey: z.string().min(1).max(200),
        targetStatus: z.string().min(1).max(100),
      })
      .strict(),
    validation: z
      .object({
        passed: z.boolean(),
        attempts: z.number().int().min(1).max(2),
      })
      .strict(),
    regressionTestPath: z.string().min(1).max(500).nullable(),
  })
  .strict();

export type IssueReceipt = z.infer<typeof IssueReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const IssueEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: IssueReceiptSchema.optional(),
  })
  .strict();

export type IssueEffect = z.infer<typeof IssueEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const IssuesRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("issues"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: IssueInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(IssueEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type IssuesRunState = z.infer<typeof IssuesRunStateSchema>;

/** `issue-selection` artifact: ticket chips, repo/branch pickers, settings. */
export const IssueSelectionArtifactSchema = z
  .object({
    ticket: IssueTicketCandidateSchema,
    candidates: z.array(IssueTicketCandidateSchema).max(50),
    repositories: z
      .array(z.string().min(3).max(200).regex(/^[\w.-]+\/[\w.-]+$/))
      .min(1)
      .max(50),
    repository: z.string().min(3).max(200),
    branches: z.array(z.string().min(1).max(250)).min(1).max(20),
    baseBranch: z.string().min(1).max(250),
    advanced: z
      .object({
        includeRegressionTest: z.boolean(),
        maxChangedFiles: z.number().int().min(1).max(25),
        guidance: z.string().max(4_000),
      })
      .strict(),
  })
  .strict();

export type IssueSelectionArtifact = z.infer<typeof IssueSelectionArtifactSchema>;

export const SimilarUpdateSchema = z
  .object({
    reference: z.string().min(1).max(300),
    note: z.string().min(1).max(1_000),
  })
  .strict();

/** One cited file in the analysis, editable before implementation. */
export const IssueAffectedFileSchema = z
  .object({
    path: RepositoryPathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    changeDescription: z.string().min(1).max(2_000),
    validators: z.array(ValidatorNameSchema).min(1).max(4),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, "Invalid evidence line range");

export type IssueAffectedFile = z.infer<typeof IssueAffectedFileSchema>;

export const RegressionTestPlanSchema = z
  .object({
    path: RepositoryPathSchema,
    description: z.string().min(1).max(1_000),
  })
  .strict();

export type RegressionTestPlan = z.infer<typeof RegressionTestPlanSchema>;

/** Structured output of the analyst agent (judgment carries confidence). */
export const IssueAnalysisOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
    similarUpdates: z.array(SimilarUpdateSchema).max(10),
    affectedFiles: z.array(IssueAffectedFileSchema).min(1).max(25),
    regressionTest: RegressionTestPlanSchema.nullable(),
  })
  .strict();

export type IssueAnalysisOutput = z.infer<typeof IssueAnalysisOutputSchema>;

/** `analysis` artifact: the cited plan plus the regression-test cross-link. */
export const IssueAnalysisArtifactSchema = z
  .object({
    ticket: IssueTicketCandidateSchema,
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
    similarUpdates: z.array(SimilarUpdateSchema).max(10),
    affectedFiles: z.array(IssueAffectedFileSchema).min(1).max(25),
    regressionTest: RegressionTestPlanSchema.nullable(),
  })
  .strict();

export type IssueAnalysisArtifact = z.infer<typeof IssueAnalysisArtifactSchema>;

/** Structured output of the engineer agent (full replacement contents). */
export const IssuePatchOutputFileSchema = z
  .object({
    path: RepositoryPathSchema,
    content: z.string().max(200_000),
    validators: z.array(ValidatorNameSchema).min(1).max(4),
  })
  .strict();

export const IssueImplementationOutputSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    files: z.array(IssuePatchOutputFileSchema).min(1).max(50),
    regressionTest: z
      .object({
        path: RepositoryPathSchema,
        content: z.string().max(200_000),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type IssueImplementationOutput = z.infer<typeof IssueImplementationOutputSchema>;

const IssueFileSummaryFields = {
  path: RepositoryPathSchema,
  status: z.enum(["added", "modified"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
};

/** One patched file rendered as a diff (content kept for the apply step). */
export const ImplementationFileSchema = z
  .object({
    ...IssueFileSummaryFields,
    diff: z.string().max(500_000),
    content: z.string().max(200_000),
    validators: z.array(ValidatorNameSchema).min(1).max(4),
  })
  .strict();

export type ImplementationFile = z.infer<typeof ImplementationFileSchema>;

export const RegressionTestPatchSchema = z
  .object({
    path: RepositoryPathSchema,
    content: z.string().max(200_000),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    diff: z.string().max(500_000),
  })
  .strict();

export type RegressionTestPatch = z.infer<typeof RegressionTestPatchSchema>;

/** `implementation` artifact: per-file patches, validators, repair trail. */
export const IssueImplementationArtifactSchema = z
  .object({
    ticket: IssueTicketCandidateSchema,
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    summary: z.string().min(1).max(2_000),
    files: z.array(ImplementationFileSchema).min(1).max(25),
    regressionTest: RegressionTestPatchSchema.nullable(),
    validation: ValidationReportSchema,
    repair: z
      .object({
        attempted: z.boolean(),
        applied: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type IssueImplementationArtifact = z.infer<typeof IssueImplementationArtifactSchema>;

/** `complete` artifact: the Draft-PR preview shown before it is opened. */
export const IssueCompletionArtifactSchema = z
  .object({
    ticket: IssueTicketCandidateSchema,
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    branch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    summary: z.string().min(1).max(2_000),
    files: z.array(z.object(IssueFileSummaryFields).strict()).min(1).max(26),
    validation: ValidationReportSchema,
    regressionTestPath: z.string().min(1).max(500).nullable(),
    ticketTransition: z
      .object({
        ticketKey: z.string().min(1).max(200),
        targetStatus: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();

export type IssueCompletionArtifact = z.infer<typeof IssueCompletionArtifactSchema>;

export const IssuesFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(IssueEffectSchema),
    receipt: IssueReceiptSchema.optional(),
  })
  .strict();

export type IssuesFlowOutput = z.infer<typeof IssuesFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const IssuesSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type IssuesSuspendPayload = z.infer<typeof IssuesSuspendSchema>;
