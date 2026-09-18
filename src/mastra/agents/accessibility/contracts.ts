import { z } from "zod";

import { PatchFileSchema, PullRequestReceiptSchema } from "../programming/contracts.js";

/**
 * Named steps of the Mastra accessibility flow. Ids match the API run
 * definition (`runs/definitions.py` ACCESSIBILITY_WORKFLOW) so the stepper,
 * decisions, and receipts line up across the two planes.
 */
export const ACCESSIBILITY_FLOW_STEPS = ["crawl", "violations", "fix", "re-scan"] as const;

export type AccessibilityFlowStepId = (typeof ACCESSIBILITY_FLOW_STEPS)[number];

/** Run input supplied by the API (`POST /runs` input payload). */
export const AccessibilityInputSchema = z
  .object({
    repository: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo"),
    baseBranch: z.string().min(1).max(200).optional(),
    targetUrl: z.string().url().max(500),
    routeLimit: z.number().int().positive().max(200).optional(),
  })
  .passthrough();

export type AccessibilityInput = z.infer<typeof AccessibilityInputSchema>;

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

/** axe impact levels, most severe first; null axe impacts fold into minor. */
export const IMPACT_LEVELS = ["critical", "serious", "moderate", "minor"] as const;

export const ImpactLevelSchema = z.enum(IMPACT_LEVELS);

export type ImpactLevel = z.infer<typeof ImpactLevelSchema>;

export const ImpactTotalsSchema = z
  .object({
    critical: z.number().int().nonnegative(),
    serious: z.number().int().nonnegative(),
    moderate: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type ImpactTotals = z.infer<typeof ImpactTotalsSchema>;

/** Count violations per impact level (the totals every checkpoint shows). */
export function impactTotals(
  violations: readonly { readonly impact: ImpactLevel }[],
): ImpactTotals {
  const counts: Record<ImpactLevel, number> = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };
  for (const violation of violations) {
    counts[violation.impact] += 1;
  }
  return { ...counts, total: violations.length };
}

/** One crawlable route with its renderer and the estimated check count. */
export const RouteEntrySchema = z
  .object({
    path: z.string().min(1).max(300),
    component: z.string().min(1).max(300),
    selected: z.boolean(),
    authenticated: z.boolean(),
    checks: z.number().int().nonnegative().max(10_000),
  })
  .strict();

export type RouteEntry = z.infer<typeof RouteEntrySchema>;

/** `crawl` artifact: the route tree picker plus the current selection. */
export const CrawlArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(200),
    sourceSha: z.string().regex(/^[a-f0-9]{7,64}$/),
    targetUrl: z.string().url().max(500),
    routes: z.array(RouteEntrySchema).max(200),
    totals: z
      .object({
        routes: z.number().int().nonnegative(),
        selected: z.number().int().nonnegative(),
        authenticated: z.number().int().nonnegative(),
        checks: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type CrawlArtifact = z.infer<typeof CrawlArtifactSchema>;

/** One grouped axe finding, keyed by a per-artifact row id. */
export const ViolationSchema = z
  .object({
    id: z.string().min(1).max(200),
    rule: z.string().min(1).max(200),
    wcagRef: z.string().min(1).max(300),
    impact: ImpactLevelSchema,
    elementPath: z.string().min(1).max(500),
    routePath: z.string().min(1).max(300),
    occurrences: z.number().int().positive().max(10_000),
    description: z.string().min(1).max(2_000),
    screenshotUrl: z.string().url().max(500).nullable(),
  })
  .strict();

export type Violation = z.infer<typeof ViolationSchema>;

/** Structured output of the auditor agent (report frame + confidence). */
export const AuditModelOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type AuditModelOutput = z.infer<typeof AuditModelOutputSchema>;

/** `violations` artifact: the grouped findings with the audit framing. */
export const ViolationsArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    targetUrl: z.string().url().max(500),
    analyzer: z.string().min(1).max(200),
    ruleset: z.string().min(1).max(200),
    violations: z.array(ViolationSchema).max(500),
    totals: ImpactTotalsSchema,
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ViolationsArtifact = z.infer<typeof ViolationsArtifactSchema>;

/** One fix draft as the fixer agent returns it (validated at the flow). */
export const FixDraftSchema = z
  .object({
    violationId: z.string().min(1).max(200),
    explanation: z.string().min(1).max(2_000),
    manualRedesign: z.boolean(),
    before: z.string().max(4_000),
    after: z.string().max(4_000),
    files: z.array(PatchFileSchema).max(20),
  })
  .strict();

export type FixDraft = z.infer<typeof FixDraftSchema>;

/** Structured output of the fixer agent. */
export const FixModelOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
    fixes: z.array(FixDraftSchema).max(500),
  })
  .strict();

export type FixModelOutput = z.infer<typeof FixModelOutputSchema>;

/** One fix row the checkpoint reviews: applied toggles the patch. */
export const FixSchema = z
  .object({
    violationId: z.string().min(1).max(200),
    rule: z.string().min(1).max(200),
    wcagRef: z.string().min(1).max(300),
    impact: ImpactLevelSchema,
    elementPath: z.string().min(1).max(500),
    routePath: z.string().min(1).max(300),
    explanation: z.string().min(1).max(2_000),
    before: z.string().max(4_000),
    after: z.string().max(4_000),
    manualRedesign: z.boolean(),
    applied: z.boolean(),
    files: z.array(PatchFileSchema).max(20),
  })
  .strict();

export type Fix = z.infer<typeof FixSchema>;

/** `fix` artifact: the per-violation fix cards plus the file totals. */
export const FixArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    targetUrl: z.string().url().max(500),
    summary: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
    fixes: z.array(FixSchema).max(500),
    totals: z
      .object({
        fixes: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        manualRedesign: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type FixArtifact = z.infer<typeof FixArtifactSchema>;

/**
 * Waiver the approver records for a remaining violation: the reason and the
 * expiry are supplied at the re-scan checkpoint; `approvedBy` is filled from
 * the signed decision, never from client input.
 */
export const WaiverInputSchema = z
  .object({
    violationId: z.string().min(1).max(200),
    reason: z.string().min(1).max(1_000),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type WaiverInput = z.infer<typeof WaiverInputSchema>;

export const WaiverSchema = WaiverInputSchema.extend({
  approvedBy: z.string().min(1).max(200),
}).strict();

export type Waiver = z.infer<typeof WaiverSchema>;

/** Re-scan gate: open criticals block the fix pull request unless waived. */
export const ReScanGateSchema = z
  .object({
    criticalsOpen: z.number().int().nonnegative(),
    criticalsWaived: z.number().int().nonnegative(),
    passing: z.boolean(),
  })
  .strict();

export type ReScanGate = z.infer<typeof ReScanGateSchema>;

/** `re-scan` artifact: the before/after comparison and the waiver gate. */
export const ReScanArtifactSchema = z
  .object({
    repository: z.string().min(3).max(200),
    baseBranch: z.string().min(1).max(200),
    sourceSha: z.string().regex(/^[a-f0-9]{7,64}$/),
    targetUrl: z.string().url().max(500),
    branch: z.string().min(1).max(200),
    analyzer: z.string().min(1).max(200),
    ruleset: z.string().min(1).max(200),
    before: ImpactTotalsSchema,
    after: ImpactTotalsSchema,
    delta: z
      .object({
        critical: z.number().int(),
        serious: z.number().int(),
        moderate: z.number().int(),
        minor: z.number().int(),
      })
      .strict(),
    resolvedIds: z.array(z.string().min(1).max(200)).max(500),
    remaining: z.array(ViolationSchema).max(500),
    introduced: z.array(ViolationSchema).max(500),
    waivers: z.array(WaiverSchema).max(500),
    gate: ReScanGateSchema,
    summary: z.string().min(1).max(4_000),
  })
  .strict();

export type ReScanArtifact = z.infer<typeof ReScanArtifactSchema>;

/** Receipt of the opened fix pull request (the `re-scan` side effect). */
export const AccessibilityReceiptSchema = z
  .object({
    pr: PullRequestReceiptSchema,
    caseId: z.string().min(1).max(200),
    repository: z.string().min(3).max(200),
    branch: z.string().min(1).max(200),
    resolvedCount: z.number().int().nonnegative(),
    waivedCount: z.number().int().nonnegative(),
    remainingCount: z.number().int().nonnegative(),
    gate: ReScanGateSchema,
  })
  .strict();

export type AccessibilityReceipt = z.infer<typeof AccessibilityReceiptSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const AccessibilityEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: AccessibilityReceiptSchema.optional(),
  })
  .strict();

export type AccessibilityEffect = z.infer<typeof AccessibilityEffectSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const AccessibilityRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("accessibility"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: AccessibilityInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(AccessibilityEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type AccessibilityRunState = z.infer<typeof AccessibilityRunStateSchema>;

export const AccessibilityFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(AccessibilityEffectSchema),
    receipt: AccessibilityReceiptSchema.optional(),
  })
  .strict();

export type AccessibilityFlowOutput = z.infer<typeof AccessibilityFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const AccessibilitySuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type AccessibilitySuspendPayload = z.infer<typeof AccessibilitySuspendSchema>;
