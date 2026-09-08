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

export const ValidatorResultSchema = z
  .object({
    validator: z.string().min(1),
    path: RepositoryPathSchema,
    passed: z.boolean(),
    message: z.string().min(1).max(2_000),
  })
  .strict();

export const ValidationReportSchema = z
  .object({
    passed: z.boolean(),
    attempts: z.number().int().min(1).max(2),
    results: z.array(ValidatorResultSchema),
    ciStatus: z.enum(["pending", "success", "failure", "neutral"]).optional(),
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
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
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
  })
  .strict();

export type CodingWorkflowOutput = z.infer<typeof CodingWorkflowOutputSchema>;
