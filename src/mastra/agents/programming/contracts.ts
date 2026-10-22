import { z } from "zod";

export const ShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
export const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => {
      const segments = value.split("/");
      return (
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !/[?#%\u0000-\u001f\u007f]/.test(value) &&
        segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
      );
    },
    { message: "Repository path must be relative and normalized" },
  );

export const RcaEvidenceSchema = z
  .object({
    path: RepositoryPathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    excerpt: z.string().min(1).max(4_000),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, "Invalid evidence line range");

export const RootCauseAnalysisSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
    evidence: z.array(RcaEvidenceSchema).max(20),
    fixable: z.boolean(),
  })
  .strict();

export const PatchFileSchema = z
  .object({
    path: RepositoryPathSchema,
    content: z.string().max(1_000_000),
    validators: z.array(z.enum(["json", "yaml", "xml", "basic-syntax"])).min(1).max(4),
  })
  .strict();

export const PatchPlanSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    files: z.array(PatchFileSchema).min(1).max(50),
  })
  .strict();

/**
 * One changed file as the sandbox path represents it: the bytes live on disk
 * inside the container, run state only carries the fingerprint. Mirrors the
 * `PreviewManifest.files` entry shape so the approval hash is the same
 * computation whether the patch came from `PatchFile[]` or from disk.
 */
export const ChangeManifestEntrySchema = z
  .object({
    path: RepositoryPathSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    validators: z.array(z.enum(["json", "yaml", "xml", "basic-syntax"])).min(1).max(4),
  })
  .strict();

export const ChangeManifestSchema = z.array(ChangeManifestEntrySchema).min(1).max(50);

/**
 * Actor output on the sandbox path: the agent edited files in the working
 * tree, so it declares intent (summary + touched paths) and never returns
 * file bodies. The manifest is computed from disk afterwards.
 */
export const PatchIntentSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    touched: z.array(
      z
        .object({
          path: RepositoryPathSchema,
          validators: z.array(z.enum(["json", "yaml", "xml", "basic-syntax"])).min(1).max(4),
        })
        .strict(),
    ).min(1).max(50),
  })
  .strict();

export const ValidatorResultSchema = z
  .object({
    validator: z.string().min(1),
    path: RepositoryPathSchema,
    passed: z.boolean(),
    message: z.string().min(1).max(2_000),
  })
  .strict();

export type ValidatorResult = z.infer<typeof ValidatorResultSchema>;

export const ValidationReportSchema = z
  .object({
    passed: z.boolean(),
    attempts: z.number().int().min(1).max(2),
    results: z.array(ValidatorResultSchema),
    ciStatus: z.enum(["pending", "success", "failure", "neutral"]).optional(),
  })
  .strict();

/**
 * The spec-based critic verdict (A2). It scores the patch against the ticket
 * acceptance criteria and the cited evidence, never against the model's own
 * restatement of the goal. `checkedCriteria` names each criterion the critic
 * actually judged so the verdict is auditable, not vibes.
 */
export const CriticReportSchema = z
  .object({
    passed: z.boolean(),
    critique: z.string().min(1).max(2_000),
    checkedCriteria: z.array(z.string().min(1).max(300)).max(20),
  })
  .strict();

export const PullRequestReceiptSchema = z
  .object({
    url: z.string().url(),
    number: z.number().int().positive(),
    draft: z.literal(true),
    branch: z.string().min(1).max(250),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    commitSha: ShaSchema,
    patchHash: z.string().regex(/^[a-f0-9]{64}$/),
    replayed: z.boolean(),
  })
  .strict();

export const EscalationSchema = z
  .object({
    reason: z.enum([
      "insufficient_evidence",
      "unfixable",
      "path_denied",
      "approval_required",
      "approval_rejected",
      "stale_source",
      "validation_failed_after_repair",
      "ci_failed",
      // Harness self-correction gates (Part A):
      // critic_blocked  — the spec-based critic refused an off-spec patch (A2).
      // doom_loop       — a repair reproduced an identical failed patch (A3).
      "critic_blocked",
      "doom_loop",
    ]),
    diagnosisOnly: z.boolean(),
    detail: z.string().min(1).max(2_000),
  })
  .strict();

export const PreviewManifestSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().min(1),
    sourceSha: ShaSchema,
    branch: z.string().min(1),
    patchHash: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(
      z.object({
        path: RepositoryPathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().nonnegative(),
        validators: z.array(z.string().min(1)),
      }).strict(),
    ),
    risk: z.enum(["low", "medium", "high"]),
    evidence: z.array(RcaEvidenceSchema).min(1),
  })
  .strict();

export type RootCauseAnalysis = z.infer<typeof RootCauseAnalysisSchema>;
export type PatchFile = z.infer<typeof PatchFileSchema>;
export type PatchPlan = z.infer<typeof PatchPlanSchema>;
export type ChangeManifestEntry = z.infer<typeof ChangeManifestEntrySchema>;
export type ChangeManifest = z.infer<typeof ChangeManifestSchema>;
export type PatchIntent = z.infer<typeof PatchIntentSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
export type CriticReport = z.infer<typeof CriticReportSchema>;
export type PullRequestReceipt = z.infer<typeof PullRequestReceiptSchema>;
export type Escalation = z.infer<typeof EscalationSchema>;
export type PreviewManifest = z.infer<typeof PreviewManifestSchema>;

const printableAscii = /^[\x20-\x7e]+$/;

/**
 * Zod mirror of `CodingWorkflowInput` (workflow.ts) so Mastra can validate
 * and suspend/resume coding runs with structured input. The type alias is
 * intentionally not exported: workflow.ts already owns the `CodingWorkflowInput`
 * interface name.
 */
export const CodingWorkflowInputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    tenantId: z.string().min(1).max(200),
    ticketKey: z.string().regex(printableAscii).max(250),
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    branch: z.string().regex(printableAscii).max(250),
    problem: z.string().min(1).max(4_000),
    approvedDestructivePaths: z.array(z.string().max(500)).default([]),
  })
  .strict();

export const CodingWorkflowOutputSchema = z
  .object({
    runId: z.string().min(1),
    status: z.enum(["draft_pr_opened", "awaiting_ci", "escalated"]),
    rca: RootCauseAnalysisSchema,
    validation: ValidationReportSchema,
    manifest: PreviewManifestSchema.optional(),
    pr: PullRequestReceiptSchema.optional(),
    escalation: EscalationSchema.optional(),
    // Actual token-derived spend for the run in micro-USD. Defaults to 0 so a
    // lane/model that never instruments usage still yields a valid output, and
    // so the Python run service can read it straight off the completed result.
    costUsdMicro: z.number().int().min(0).default(0),
  })
  .strict();

export type CodingWorkflowOutput = z.infer<typeof CodingWorkflowOutputSchema>;
