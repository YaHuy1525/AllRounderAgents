import { z } from "zod";

import {
  PullRequestReceiptSchema,
  RepositoryPathSchema,
  ShaSchema,
  ValidationReportSchema,
} from "../programming/contracts.js";

/**
 * Named steps of the Mastra features flow. Ids match the API run definition
 * (`runs/definitions.py` FEATURES_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const FEATURES_FLOW_STEPS = [
  "feature-selection",
  "scope-design",
  "implementation",
  "complete",
] as const;

export type FeaturesFlowStepId = (typeof FEATURES_FLOW_STEPS)[number];

export const ValidatorNameSchema = z.enum(["json", "yaml", "xml", "basic-syntax"]);

export type ValidatorName = z.infer<typeof ValidatorNameSchema>;

/** Implementation areas the scope cards toggle (step 2 of the run). */
export const AREA_IDS = ["ui", "api-data", "state-logic", "tests", "docs-flags"] as const;

export const AreaIdSchema = z.enum(AREA_IDS);

export type AreaId = z.infer<typeof AreaIdSchema>;

/** Card labels rendered by the scope-design surface, in display order. */
export const FEATURE_AREAS: ReadonlyArray<{ readonly id: AreaId; readonly label: string }> = [
  { id: "ui", label: "UI" },
  { id: "api-data", label: "API & Data" },
  { id: "state-logic", label: "State & Logic" },
  { id: "tests", label: "Tests" },
  { id: "docs-flags", label: "Docs & Flags" },
];

export const ImplementationAreaSchema = z
  .object({
    id: AreaIdSchema,
    label: z.string().min(1).max(50),
    enabled: z.boolean(),
  })
  .strict();

export type ImplementationArea = z.infer<typeof ImplementationAreaSchema>;

/** One feature ticket offered as a chip in `feature-selection`. */
export const FeatureTicketCandidateSchema = z
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

export type FeatureTicketCandidate = z.infer<typeof FeatureTicketCandidateSchema>;

/** One acceptance criterion with its include/exclude toggle. */
export const AcceptanceCriterionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(50)
      .regex(/^ac-[0-9]+$/, "expected an ac-N id"),
    text: z.string().min(1).max(1_000),
    included: z.boolean(),
  })
  .strict();

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/**
 * Run input supplied by the API (`POST /runs` input payload). `candidates`
 * are the feature tickets the runner offers (typically the open features
 * loaded in the console); `acceptanceCriteria` are the must-serve criteria
 * the ticket carries (the flow falls back to the summary when absent).
 */
export const FeatureInputSchema = z
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
    candidates: z.array(FeatureTicketCandidateSchema).max(50).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(1_000)).max(25).optional(),
  })
  .passthrough();

export type FeatureInput = z.infer<typeof FeatureInputSchema>;

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
export const FeatureReceiptSchema = z
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
    criteriaTotal: z.number().int().positive(),
    criteriaCovered: z.number().int().nonnegative(),
  })
  .strict();

export type FeatureReceipt = z.infer<typeof FeatureReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const FeatureEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: FeatureReceiptSchema.optional(),
  })
  .strict();

export type FeatureEffect = z.infer<typeof FeatureEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const FeaturesRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("features"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: FeatureInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(FeatureEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type FeaturesRunState = z.infer<typeof FeaturesRunStateSchema>;

/**
 * `feature-selection` artifact: ticket chips, repo/branch pickers, the
 * acceptance-criteria checklist, and the advanced settings.
 */
export const FeatureSelectionArtifactSchema = z
  .object({
    ticket: FeatureTicketCandidateSchema,
    candidates: z.array(FeatureTicketCandidateSchema).max(50),
    repositories: z
      .array(z.string().min(3).max(200).regex(/^[\w.-]+\/[\w.-]+$/))
      .min(1)
      .max(50),
    repository: z.string().min(3).max(200),
    branches: z.array(z.string().min(1).max(250)).min(1).max(20),
    baseBranch: z.string().min(1).max(250),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(25),
    advanced: z
      .object({
        maxChangedFiles: z.number().int().min(1).max(25),
        guidance: z.string().max(4_000),
      })
      .strict(),
  })
  .strict();

export type FeatureSelectionArtifact = z.infer<typeof FeatureSelectionArtifactSchema>;

/** Structured output of the planner agent (judgment carries confidence). */
export const FeaturePlanOutputSchema = z
  .object({
    targetSummary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
    areas: z.array(AreaIdSchema).min(1).max(5),
  })
  .strict();

export type FeaturePlanOutput = z.infer<typeof FeaturePlanOutputSchema>;

/**
 * `scope-design` artifact: the target summary bar, the implementation-area
 * cards, and the custom guidance seeded from the advanced settings.
 */
export const ScopeDesignArtifactSchema = z
  .object({
    ticket: FeatureTicketCandidateSchema,
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    targetSummary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
    areas: z.array(ImplementationAreaSchema).length(FEATURE_AREAS.length),
    guidance: z.string().max(4_000),
  })
  .strict();

export type ScopeDesignArtifact = z.infer<typeof ScopeDesignArtifactSchema>;

/** Structured output of the engineer agent (full replacement contents). */
export const FeaturePatchOutputFileSchema = z
  .object({
    path: RepositoryPathSchema,
    content: z.string().max(200_000),
    changeDescription: z.string().min(1).max(2_000),
    criteriaIds: z
      .array(
        z
          .string()
          .min(1)
          .max(50)
          .regex(/^ac-[0-9]+$/, "expected an ac-N id"),
      )
      .max(25),
    area: AreaIdSchema,
  })
  .strict();

export type FeaturePatchOutputFile = z.infer<typeof FeaturePatchOutputFileSchema>;

export const FeatureImplementationOutputSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    verdict: z.enum(["ready", "needs_attention"]),
    confidence: z.number().min(0).max(1),
    strengths: z.array(z.string().min(1).max(500)).max(10),
    risksOpenQuestions: z.array(z.string().min(1).max(500)).max(10),
    crossCuttingNotes: z.array(z.string().min(1).max(500)).max(10),
    files: z.array(FeaturePatchOutputFileSchema).min(1).max(50),
  })
  .strict();

export type FeatureImplementationOutput = z.infer<typeof FeatureImplementationOutputSchema>;

const FeatureFileSummaryFields = {
  path: RepositoryPathSchema,
  status: z.enum(["added", "modified"]),
  area: AreaIdSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
};

/** One planned change rendered as a diff (content kept for the apply step). */
export const FeatureFileSchema = z
  .object({
    ...FeatureFileSummaryFields,
    changeDescription: z.string().min(1).max(2_000),
    criteriaIds: z.array(z.string().min(1).max(50)).max(25),
    diff: z.string().max(500_000),
    content: z.string().max(200_000),
    validators: z.array(ValidatorNameSchema).min(1).max(4),
  })
  .strict();

export type FeatureFile = z.infer<typeof FeatureFileSchema>;

/** Per-criterion coverage row of the `complete` checklist. */
export const CriterionCoverageSchema = z
  .object({
    id: z.string().min(1).max(50),
    text: z.string().min(1).max(1_000),
    covered: z.boolean(),
    evidence: RepositoryPathSchema.nullable(),
  })
  .strict();

export type CriterionCoverage = z.infer<typeof CriterionCoverageSchema>;

/**
 * `implementation` artifact: the planned-changes file list, the engineering
 * review summary, per-criterion coverage, and the repair trail.
 */
export const FeatureImplementationArtifactSchema = z
  .object({
    ticket: FeatureTicketCandidateSchema,
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    summary: z.string().min(1).max(2_000),
    verdict: z.enum(["ready", "needs_attention"]),
    confidence: z.number().min(0).max(1),
    strengths: z.array(z.string().min(1).max(500)).max(10),
    risksOpenQuestions: z.array(z.string().min(1).max(500)).max(10),
    crossCuttingNotes: z.array(z.string().min(1).max(500)).max(10),
    areas: z.array(ImplementationAreaSchema).length(FEATURE_AREAS.length),
    files: z.array(FeatureFileSchema).min(1).max(25),
    criteriaCoverage: z.array(CriterionCoverageSchema).min(1).max(25),
    validation: ValidationReportSchema,
    repair: z
      .object({
        attempted: z.boolean(),
        applied: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type FeatureImplementationArtifact = z.infer<typeof FeatureImplementationArtifactSchema>;

/** `complete` artifact: the Draft-PR preview shown before it is opened. */
export const FeatureCompletionArtifactSchema = z
  .object({
    ticket: FeatureTicketCandidateSchema,
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    branch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    summary: z.string().min(1).max(2_000),
    files: z.array(z.object(FeatureFileSummaryFields).strict()).min(1).max(25),
    validation: ValidationReportSchema,
    criteriaCoverage: z.array(CriterionCoverageSchema).min(1).max(25),
    criteriaTotal: z.number().int().positive(),
    criteriaCovered: z.number().int().nonnegative(),
    ticketTransition: z
      .object({
        ticketKey: z.string().min(1).max(200),
        targetStatus: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();

export type FeatureCompletionArtifact = z.infer<typeof FeatureCompletionArtifactSchema>;

export const FeaturesFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(FeatureEffectSchema),
    receipt: FeatureReceiptSchema.optional(),
  })
  .strict();

export type FeaturesFlowOutput = z.infer<typeof FeaturesFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const FeaturesSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type FeaturesSuspendPayload = z.infer<typeof FeaturesSuspendSchema>;
