import { z } from "zod";

import {
  PullRequestReceiptSchema,
  RepositoryPathSchema,
  ShaSchema,
} from "../programming/contracts.js";

/**
 * Named steps of the Mastra dependencies flow. Ids match the API run
 * definition (`runs/definitions.py` DEPENDENCIES_WORKFLOW) so the stepper,
 * decisions, and receipts line up across the two planes.
 */
export const DEPENDENCIES_FLOW_STEPS = [
  "scan",
  "group",
  "apply",
  "validate",
  "merge",
] as const;

export type DependenciesFlowStepId = (typeof DEPENDENCIES_FLOW_STEPS)[number];

/** Semver distance of the newest release from the version a manifest pins. */
export const ScanJumpSchema = z.enum(["major", "minor", "patch", "up_to_date"]);

export type ScanJump = z.infer<typeof ScanJumpSchema>;

/** Outdated packages only: the three groups the run bundles them into. */
export const JumpKindSchema = z.enum(["patch", "minor", "major"]);

export type JumpKind = z.infer<typeof JumpKindSchema>;

/** Group cards rendered by the group surface, in display order. */
export const DEPENDENCY_GROUPS: ReadonlyArray<{
  readonly id: JumpKind;
  readonly label: string;
  readonly riskNote: string;
}> = [
  { id: "patch", label: "Patch batch", riskNote: "Patch releases only — safe to auto-batch." },
  { id: "minor", label: "Minor", riskNote: "Check deprecations before merging." },
  {
    id: "major",
    label: "Major",
    riskNote: "Breaking-change assessment required — review each package.",
  },
];

export const DependencyKindSchema = z.enum(["dependency", "devDependency"]);

export type DependencyKind = z.infer<typeof DependencyKindSchema>;

/**
 * One advisory attached to a package row. `cvss` is null when the advisory
 * publishes only a qualitative severity (the npm bulk endpoint often does).
 */
export const VulnerabilitySchema = z
  .object({
    cve: z
      .string()
      .min(9)
      .max(50)
      .regex(/^CVE-[0-9]{4}-[0-9]+$/, "expected a CVE id"),
    cvss: z.number().min(0).max(10).nullable(),
    severity: z.enum(["low", "moderate", "high", "critical"]),
    summary: z.string().min(1).max(500),
  })
  .strict();

export type Vulnerability = z.infer<typeof VulnerabilitySchema>;

/** One inventory row of the scan table. */
export const ScanPackageSchema = z
  .object({
    name: z.string().min(1).max(214),
    kind: DependencyKindSchema,
    current: z.string().min(1).max(100),
    latest: z.string().min(1).max(100),
    jump: ScanJumpSchema,
    daysOutdated: z.number().int().nonnegative().max(100_000),
    changelogExcerpt: z.string().max(1_000),
    resolved: z.string().min(1).max(1_000).nullable(),
    integrity: z.string().min(1).max(500).nullable(),
    vulnerabilities: z.array(VulnerabilitySchema).max(20),
  })
  .strict();

export type ScanPackage = z.infer<typeof ScanPackageSchema>;

/** Run input supplied by the API (`POST /runs` input payload). */
export const DependenciesInputSchema = z
  .object({
    repository: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo")
      .optional(),
    baseBranch: z.string().min(1).max(250).optional(),
    manifestPath: z.string().min(1).max(500).optional(),
  })
  .passthrough();

export type DependenciesInput = z.infer<typeof DependenciesInputSchema>;

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

/** `scan` artifact: the inventory table plus its totals. */
export const ScanArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    manifestPath: RepositoryPathSchema,
    packages: z.array(ScanPackageSchema).max(200),
    totals: z
      .object({
        packages: z.number().int().nonnegative(),
        outdated: z.number().int().nonnegative(),
        vulnerable: z.number().int().nonnegative(),
        major: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type ScanArtifact = z.infer<typeof ScanArtifactSchema>;

/** One package card inside a group (moves/excludes are recorded here). */
export const GroupPackageSchema = z
  .object({
    name: z.string().min(1).max(214),
    kind: DependencyKindSchema,
    from: z.string().min(1).max(100),
    to: z.string().min(1).max(100),
    jump: JumpKindSchema,
    daysOutdated: z.number().int().nonnegative().max(100_000),
    changelogExcerpt: z.string().max(1_000),
    resolved: z.string().min(1).max(1_000).nullable(),
    integrity: z.string().min(1).max(500).nullable(),
    vulnerabilities: z.array(VulnerabilitySchema).max(20),
    excluded: z.boolean(),
    excludeReason: z.string().max(500),
  })
  .strict();

export type GroupPackage = z.infer<typeof GroupPackageSchema>;

export const DependencyGroupSchema = z
  .object({
    id: JumpKindSchema,
    label: z.string().min(1).max(50),
    riskNote: z.string().min(1).max(500),
    packages: z.array(GroupPackageSchema).max(200),
  })
  .strict();

export type DependencyGroup = z.infer<typeof DependencyGroupSchema>;

/**
 * `group` artifact: the three bundling cards (patch/minor/major) with their
 * package lists, risk notes, and per-package exclude flags.
 */
export const GroupArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    manifestPath: RepositoryPathSchema,
    groups: z.array(DependencyGroupSchema).length(DEPENDENCY_GROUPS.length),
  })
  .strict();

export type GroupArtifact = z.infer<typeof GroupArtifactSchema>;

/** Structured output of the engineer agent (breaking-change assessment). */
export const DependencyAssessmentOutputSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    groups: z
      .array(
        z
          .object({
            id: JumpKindSchema,
            breakingNotes: z.array(z.string().min(1).max(500)).max(10),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

export type DependencyAssessmentOutput = z.infer<typeof DependencyAssessmentOutputSchema>;

/** Structured output of the repair agent (one suggestion after a failure). */
export const DependencyRepairSuggestionSchema = z
  .object({
    suggestion: z.string().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type DependencyRepairSuggestion = z.infer<typeof DependencyRepairSuggestionSchema>;

/** One package row inside the apply artifact (per-package toggle). */
export const ApplyPackageSchema = z
  .object({
    name: z.string().min(1).max(214),
    kind: DependencyKindSchema,
    from: z.string().min(1).max(100),
    to: z.string().min(1).max(100),
    jump: JumpKindSchema,
    resolved: z.string().min(1).max(1_000).nullable(),
    integrity: z.string().min(1).max(500).nullable(),
    vulnerabilities: z.array(VulnerabilitySchema).max(20),
    included: z.boolean(),
  })
  .strict();

export type ApplyPackage = z.infer<typeof ApplyPackageSchema>;

/** One produced file (manifest or lockfile) with its diff preview. */
export const DependencyFileChangeSchema = z
  .object({
    path: RepositoryPathSchema,
    status: z.literal("modified"),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    diff: z.string().max(500_000),
    content: z.string().max(1_000_000),
    validators: z.array(z.enum(["json", "yaml", "xml", "basic-syntax"])).min(1).max(4),
  })
  .strict();

export type DependencyFileChange = z.infer<typeof DependencyFileChangeSchema>;

export const ApplyGroupSchema = z
  .object({
    id: JumpKindSchema,
    label: z.string().min(1).max(50),
    riskNote: z.string().min(1).max(500),
    accepted: z.boolean(),
    breakingNotes: z.array(z.string().min(1).max(500)).max(10),
    packages: z.array(ApplyPackageSchema).min(1).max(200),
    manifest: DependencyFileChangeSchema,
    lockfile: DependencyFileChangeSchema.nullable(),
  })
  .strict();

export type ApplyGroup = z.infer<typeof ApplyGroupSchema>;

/**
 * `apply` artifact: per-group manifest + lockfile diffs, the breaking-notes
 * callout for majors, and the per-group/per-package accept toggles.
 */
export const ApplyArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    manifestPath: RepositoryPathSchema,
    lockfilePath: RepositoryPathSchema.nullable(),
    summary: z.string().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    groups: z.array(ApplyGroupSchema).min(1).max(3),
  })
  .strict();

export type ApplyArtifact = z.infer<typeof ApplyArtifactSchema>;

/** One row of the per-group validation results table. */
export const ValidateTestFailureSchema = z
  .object({
    path: RepositoryPathSchema,
    validator: z.string().min(1).max(50),
    message: z.string().min(1).max(2_000),
    isNew: z.boolean(),
  })
  .strict();

export const ValidateGroupSchema = z
  .object({
    id: JumpKindSchema,
    label: z.string().min(1).max(50),
    skipped: z.boolean(),
    status: z.enum(["green", "failed", "skipped"]),
    install: z
      .object({
        passed: z.boolean(),
        message: z.string().min(1).max(2_000),
      })
      .strict(),
    tests: z
      .object({
        passed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        failures: z.array(ValidateTestFailureSchema).max(50),
      })
      .strict(),
    log: z.string().max(20_000),
    suggestion: z.string().min(1).max(2_000).nullable(),
  })
  .strict();

export type ValidateGroup = z.infer<typeof ValidateGroupSchema>;

/**
 * `validate` artifact: install + suite results per group, new failures
 * highlighted, expandable logs, and the single repair suggestion produced
 * when a group fails.
 */
export const ValidateArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    manifestPath: RepositoryPathSchema,
    lockfilePath: RepositoryPathSchema.nullable(),
    groups: z.array(ValidateGroupSchema).min(1).max(3),
  })
  .strict();

export type ValidateArtifact = z.infer<typeof ValidateArtifactSchema>;

/** One PR preview row of the merge step (CVE fixes called out). */
export const MergeGroupPreviewSchema = z
  .object({
    id: JumpKindSchema,
    label: z.string().min(1).max(50),
    branch: z.string().min(1).max(250),
    title: z.string().min(1).max(250),
    packageCount: z.number().int().positive(),
    cveFixes: z
      .array(
        z
          .string()
          .min(9)
          .max(50)
          .regex(/^CVE-[0-9]{4}-[0-9]+$/),
      )
      .max(50),
    packages: z
      .array(
        z
          .object({
            name: z.string().min(1).max(214),
            from: z.string().min(1).max(100),
            to: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(200),
    files: z
      .array(
        z
          .object({
            path: RepositoryPathSchema,
            status: z.literal("modified"),
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

export type MergeGroupPreview = z.infer<typeof MergeGroupPreviewSchema>;

/** `merge` artifact: the PR preview list shown before the PRs are opened. */
export const MergeArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(250),
    sourceSha: ShaSchema,
    manifestPath: RepositoryPathSchema,
    groups: z.array(MergeGroupPreviewSchema).min(1).max(3),
  })
  .strict();

export type MergeArtifact = z.infer<typeof MergeArtifactSchema>;

/** Receipt of one opened bump PR (the `merge` side effect, per group). */
export const DependencyPrReceiptSchema = z
  .object({
    groupId: JumpKindSchema,
    pr: PullRequestReceiptSchema,
  })
  .strict();

export type DependencyPrReceipt = z.infer<typeof DependencyPrReceiptSchema>;

export const DependencyReceiptSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    repository: z.string().min(1).max(200),
    baseBranch: z.string().min(1).max(250),
    prs: z.array(DependencyPrReceiptSchema).min(1).max(3),
    cveFixes: z.array(z.string().min(9).max(50)).max(100),
  })
  .strict();

export type DependencyReceipt = z.infer<typeof DependencyReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const DependencyEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: DependencyReceiptSchema.optional(),
  })
  .strict();

export type DependencyEffect = z.infer<typeof DependencyEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const DependenciesRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("dependencies"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: DependenciesInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(DependencyEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type DependenciesRunState = z.infer<typeof DependenciesRunStateSchema>;

export const DependenciesFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(DependencyEffectSchema),
    receipt: DependencyReceiptSchema.optional(),
  })
  .strict();

export type DependenciesFlowOutput = z.infer<typeof DependenciesFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const DependenciesSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type DependenciesSuspendPayload = z.infer<typeof DependenciesSuspendSchema>;
