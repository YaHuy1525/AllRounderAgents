import { z } from "zod";

/**
 * Named steps of the Mastra qa flow. Ids match the API run definition
 * (`runs/definitions.py` QA_WORKFLOW) so the stepper, decisions, and receipts
 * line up across the two planes.
 *
 * Nine steps, two human gates, two side-effecting exits: `intake` resolves the
 * start, `analyse` and `design` are the model phases, `approve-cases` is the
 * first gate, `execute` drives the approved set, `assess` computes the verdict
 * from what it observed, `approve-defects` is the second gate, `file-defects`
 * performs the governed Jira writes, and `close` assembles the evidence pack.
 * The Python definition must list exactly what this flow emits, so both sides
 * change in the same commit.
 */
export const QA_FLOW_STEPS = [
  "intake",
  "analyse",
  "design",
  "approve-cases",
  "execute",
  "assess",
  "approve-defects",
  "file-defects",
  "close",
] as const;

export type QaFlowStepId = (typeof QA_FLOW_STEPS)[number];

/** Case-set budget: the console default and the hard ceiling per run. */
export const QA_DEFAULT_MAX_CASES = 10;
export const QA_MAX_CASES = 25;

/**
 * Actions a case step may ask the executor to take. Anything outside this
 * vocabulary is a contract violation, not a prompt failure.
 */
export const QA_TARGET_ACTIONS = ["navigate", "click", "fill", "read"] as const;

export type QaTargetAction = (typeof QA_TARGET_ACTIONS)[number];

/** Per-case wall-clock ceiling: the plan's 30s cap, floored at one second. */
export const QA_DEFAULT_MAX_STEP_MS = 30_000;

/**
 * Targets the squad may drive, as data rather than code. A profile carries the
 * browser's storage state, the actions it may take, the actions it must refuse,
 * and the per-case timeout — everything the executor needs in order to be safe
 * without consulting a prompt.
 */
export const QaTargetSchema = z
  .object({
    key: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    // The console the browser drives.
    baseUrl: z.string().min(1).max(500),
    // The same app's HTTP API, for `kind: "api"` cases.
    apiBase: z.string().min(1).max(500),
    // Playwright storage state from one human login; git-ignored. Relative
    // paths resolve from the process working directory.
    storageState: z.string().min(1).max(300).optional(),
    allowedActions: z
      .array(z.enum(QA_TARGET_ACTIONS))
      .min(1)
      .max(QA_TARGET_ACTIONS.length)
      .default([...QA_TARGET_ACTIONS]),
    /**
     * The blast-radius limit. These are console affordances the squad may not
     * press even when a case step names them: approving a run receipt, posting
     * to Jira from the UI, deleting a record.
     */
    denyActions: z.array(z.string().min(1).max(80)).max(20).default([]),
    maxStepMs: z.number().int().min(1_000).max(300_000).default(QA_DEFAULT_MAX_STEP_MS),
  })
  .strict();

export type QaTarget = z.infer<typeof QaTargetSchema>;

export const QA_TARGET_KEYS = ["local-console"] as const;

export type QaTargetKey = (typeof QA_TARGET_KEYS)[number];

export const QA_TARGETS: Readonly<Record<string, QaTarget>> = {
  "local-console": {
    key: "local-console",
    label: "Approval console (local)",
    baseUrl: "http://localhost:3000",
    apiBase: "http://localhost:8000",
    storageState: ".qa/auth/local-console.json",
    allowedActions: [...QA_TARGET_ACTIONS],
    denyActions: ["approve-run-receipt", "post-jira", "delete"],
    maxStepMs: QA_DEFAULT_MAX_STEP_MS,
  },
};

/** Loopback hosts a target may name without an explicit opt-in. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** True when a URL is http(s) on the loopback interface. */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** The one escape hatch, for an operator who means to drive a remote host. */
export function remoteTargetsAllowed(): boolean {
  return process.env.QA_ALLOW_REMOTE_TARGET === "true";
}

/**
 * Resolve a target key, refusing an unknown one by name. A typo must stop the
 * run at `intake` rather than drive whatever URL happened to be lying around.
 * A non-loopback URL is refused for the same reason: a mis-set environment must
 * not be able to point the squad at production.
 */
export function resolveQaTarget(key: string): QaTarget {
  const entry = Object.entries(QA_TARGETS).find(([candidate]) => candidate === key);
  if (entry === undefined) {
    const known = Object.keys(QA_TARGETS).join(", ");
    throw new Error(`Unknown QA target "${key}"; known targets: ${known}`);
  }
  const target = QaTargetSchema.parse(entry[1]);
  if (!remoteTargetsAllowed()) {
    for (const url of [target.baseUrl, target.apiBase]) {
      if (!isLoopbackUrl(url)) {
        throw new Error(
          `QA target "${key}" points at ${url}, which is not localhost. `
          + "Set QA_ALLOW_REMOTE_TARGET=true to drive a remote host on purpose.",
        );
      }
    }
  }
  return target;
}

/** Run input supplied by the API (`POST /runs` input payload). */
export const QaInputSchema = z
  .object({
    storyKey: z
      .string()
      .min(3)
      .max(40)
      .regex(/^[A-Z][A-Z0-9_]*-\d+$/, "expected a Jira key such as OPS-123"),
    /** What to test, in the operator's words. */
    scope: z.string().min(3).max(2_000),
    target: z.string().min(1).max(60).default("local-console"),
    // The API accepts "10" or 10 for a number field, so the flow coerce-reads
    // it. The ceiling is enforced here, not by the model.
    maxCases: z.coerce.number().int().min(1).max(QA_MAX_CASES).default(QA_DEFAULT_MAX_CASES),
  })
  .passthrough();

export type QaInput = z.infer<typeof QaInputSchema>;

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

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const QaRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("qa"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: QaInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(z.record(z.unknown())),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type QaRunState = z.infer<typeof QaRunStateSchema>;

/** Where a requirement came from, so a reader can tell fact from reading. */
export const QaRequirementSourceSchema = z.enum(["story", "scope", "knowledge"]);

/** One numbered, testable requirement extracted from the story. */
export const QaRequirementSchema = z
  .object({
    id: z.string().min(1).max(20),
    text: z.string().min(1).max(1_000),
    acceptance: z.array(z.string().min(1).max(500)).max(20),
    source: QaRequirementSourceSchema,
  })
  .strict();

export type QaRequirement = z.infer<typeof QaRequirementSchema>;

/** `analyse` artifact: the story read as requirements plus its open questions. */
export const QaAnalysisSchema = z
  .object({
    storyKey: z.string().min(1).max(40),
    summary: z.string().min(1).max(2_000),
    requirements: z.array(QaRequirementSchema).min(1).max(50),
    ambiguities: z.array(z.string().min(1).max(500)).max(20),
    coverageNotes: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();

export type QaAnalysis = z.infer<typeof QaAnalysisSchema>;

/** One step of a case: what to do, where, and what it should show. */
export const QaCaseStepSchema = z
  .object({
    action: z.string().min(1).max(500),
    target: z.string().min(1).max(500),
    expect: z.string().min(1).max(500).optional(),
  })
  .strict();

export type QaCaseStep = z.infer<typeof QaCaseStepSchema>;

/**
 * One executable test case. `expected` must be an observation, not an
 * intention: "the card shows `Needs: Leave type` and the start button is
 * disabled", never "the form validates". A case that only restates intent
 * cannot fail, so it cannot test anything.
 */
export const QaCaseSchema = z
  .object({
    id: z
      .string()
      .regex(/^QA-[A-Z][A-Z0-9]*-\d{3}$/, "expected a case id such as QA-RAIL-003"),
    requirementIds: z.array(z.string().min(1).max(20)).min(1).max(20),
    title: z.string().min(1).max(200),
    kind: z.enum(["ui", "api"]),
    preconditions: z.array(z.string().min(1).max(500)).max(10),
    steps: z.array(QaCaseStepSchema).min(1).max(20),
    expected: z.string().min(1).max(1_000),
    tags: z.array(z.string().min(1).max(40)).max(10),
    target: z.string().min(1).max(60),
  })
  .strict();

export type QaCase = z.infer<typeof QaCaseSchema>;

/**
 * Structured-output wrapper around the case set. The model answers with an
 * object rather than a bare array, which is the shape structured output
 * handles reliably; the flow still works with `QaCase[]`.
 */
export const QaCaseDraftSchema = z
  .object({
    cases: z.array(QaCaseSchema).min(1).max(QA_MAX_CASES),
  })
  .strict();

export type QaCaseDraft = z.infer<typeof QaCaseDraftSchema>;

/** A requirement no case reaches, with the reason it was left out. */
export const QaGapSchema = z
  .object({
    requirementId: z.string().min(1).max(20),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type QaGap = z.infer<typeof QaGapSchema>;

/** `intake` artifact: the resolved start, before any model work. */
export const QaIntakeArtifactSchema = z
  .object({
    storyKey: z.string().min(1).max(40),
    scope: z.string().min(1).max(2_000),
    target: QaTargetSchema,
    maxCases: z.number().int().min(1).max(QA_MAX_CASES),
  })
  .strict();

export type QaIntakeArtifact = z.infer<typeof QaIntakeArtifactSchema>;

/** `design` artifact: the case set, its hash, and its self-reported gaps. */
export const QaCaseSetArtifactSchema = z
  .object({
    storyKey: z.string().min(1).max(40),
    target: QaTargetSchema,
    cases: z.array(QaCaseSchema).min(1).max(QA_MAX_CASES),
    gaps: z.array(QaGapSchema).max(50),
    /** True when the designer returned more cases than `maxCases` allowed. */
    truncated: z.boolean(),
    /** Order-independent hash of `cases`, the idempotency key of the set. */
    caseSetHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type QaCaseSetArtifact = z.infer<typeof QaCaseSetArtifactSchema>;

/** One HTTP response the executor saw, kept short enough to quote in a ticket. */
export const QaNetworkEntrySchema = z
  .object({
    url: z.string().min(1).max(500),
    status: z.number().int().min(0).max(599),
    ok: z.boolean(),
  })
  .strict();

export type QaNetworkEntry = z.infer<typeof QaNetworkEntrySchema>;

/**
 * What the executor captured for one case. Evidence is the only material a
 * defect body may quote, so it is recorded for a passing case too: "it passed"
 * with no observation is not evidence either.
 */
export const QaEvidenceSchema = z
  .object({
    /** A path or `data:` reference to a screenshot, when one was taken. */
    screenshot: z.string().min(1).max(500).optional(),
    console: z.array(z.string().max(2_000)).max(50),
    network: z.array(QaNetworkEntrySchema).max(50),
    transcript: z.array(z.string().max(2_000)).max(100),
  })
  .strict();

export type QaEvidence = z.infer<typeof QaEvidenceSchema>;

export const QA_CASE_STATUSES = ["passed", "failed", "blocked", "not_run"] as const;

export const QaCaseStatusSchema = z.enum(QA_CASE_STATUSES);

export type QaCaseStatus = z.infer<typeof QaCaseStatusSchema>;

/**
 * One case's outcome. `observed` is what the target actually showed, not what
 * the case expected. `blocked` and `not_run` are honest non-answers: a missing
 * browser or session produces them, and neither ever becomes a defect.
 */
export const QaCaseResultSchema = z
  .object({
    caseId: z.string().regex(/^QA-[A-Z][A-Z0-9]*-\d{3}$/),
    status: QaCaseStatusSchema,
    observed: z.string().max(4_000),
    evidence: QaEvidenceSchema,
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type QaCaseResult = z.infer<typeof QaCaseResultSchema>;

/** `execute` artifact: one pass over the approved set, with its availability. */
export const QaExecutionArtifactSchema = z
  .object({
    runId: z.string().min(1).max(200),
    storyKey: z.string().min(1).max(40),
    targetKey: z.string().min(1).max(60),
    caseSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvedCaseIds: z.array(z.string().min(1).max(40)).min(1).max(QA_MAX_CASES),
    /** False when there is no browser or no session, so nothing was driven. */
    available: z.boolean(),
    /** Why execution could not run, in one operator-readable sentence. */
    blockedReason: z.string().min(1).max(500).optional(),
    results: z.array(QaCaseResultSchema).max(QA_MAX_CASES),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type QaExecutionArtifact = z.infer<typeof QaExecutionArtifactSchema>;

export const QA_DEFECT_SEVERITIES = ["high", "medium", "low"] as const;

export const QaDefectSeveritySchema = z.enum(QA_DEFECT_SEVERITIES);

export type QaDefectSeverity = z.infer<typeof QaDefectSeveritySchema>;

/**
 * One finding, ready to file. `correlationId` is `"{storyKey}:{caseId}"` — the
 * one-defect-per-case-per-story rule — so a later run of the same case comments
 * on this ticket rather than filing a twin.
 */
export const QaDefectSchema = z
  .object({
    caseId: z.string().regex(/^QA-[A-Z][A-Z0-9]*-\d{3}$/),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(4_000),
    severity: QaDefectSeveritySchema,
    /** Evidence the ticket cites; at least one, or the finding is a rumour. */
    evidenceRefs: z.array(z.string().min(1).max(300)).min(1).max(20),
    correlationId: z.string().min(1).max(200),
  })
  .strict();

export type QaDefect = z.infer<typeof QaDefectSchema>;

/** `assess` artifact: the verdict the console renders and the gate reviews. */
export const QaVerdictSchema = z
  .object({
    runId: z.string().min(1).max(200),
    executionAvailable: z.boolean(),
    /** Present exactly when `executionAvailable` is false. */
    blockedReason: z.string().min(1).max(500).optional(),
    results: z.array(QaCaseResultSchema).min(1).max(QA_MAX_CASES),
    gaps: z.array(QaGapSchema).max(50),
    defects: z.array(QaDefectSchema).max(QA_MAX_CASES),
  })
  .strict();

export type QaVerdict = z.infer<typeof QaVerdictSchema>;

/**
 * `approve-cases` effect. Once approval stops being the terminal step its
 * timestamp has nowhere else to live, so the effects map holds the record the
 * console and `close` both read.
 */
export const QaApprovalEffectSchema = z
  .object({
    caseSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvedCaseIds: z.array(z.string().min(1).max(40)).min(1).max(QA_MAX_CASES),
    approvedAt: z.string().min(1).max(40),
  })
  .strict();

export type QaApprovalEffect = z.infer<typeof QaApprovalEffectSchema>;

/** `approve-defects` artifact: the findings, and which ones a human chose. */
export const QaDefectSetArtifactSchema = z
  .object({
    runId: z.string().min(1).max(200),
    caseSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    defects: z.array(QaDefectSchema).max(QA_MAX_CASES),
    /**
     * Defaults to every finding: proceeding files all of them, and an `edit`
     * decision narrows the list. An id that names no finding is refused by the
     * filing step, so a narrowed list cannot invent work.
     */
    approvedDefectIds: z.array(z.string().min(1).max(40)).max(QA_MAX_CASES),
  })
  .strict();

export type QaDefectSetArtifact = z.infer<typeof QaDefectSetArtifactSchema>;

export const QA_DEFECT_RECEIPT_ACTIONS = [
  "created",
  "commented",
  "replayed",
  "failed",
  "skipped",
] as const;

export const QaDefectReceiptActionSchema = z.enum(QA_DEFECT_RECEIPT_ACTIONS);

/**
 * What one governed write did. `action` separates a new ticket from a comment
 * on the existing one, which is the difference the re-run rule turns on;
 * `skipped` records that the route knew no defect for this correlation (a
 * passing case on a story that never failed), and `ticketKey` is empty only for
 * a `failed` or `skipped` write.
 */
export const QaDefectReceiptSchema = z
  .object({
    caseId: z.string().regex(/^QA-[A-Z][A-Z0-9]*-\d{3}$/),
    correlationId: z.string().min(1).max(200),
    action: QaDefectReceiptActionSchema,
    ticketKey: z.string().max(40),
    status: z.string().min(1).max(40),
  })
  .strict();

export type QaDefectReceipt = z.infer<typeof QaDefectReceiptSchema>;

/** `file-defects` artifact: one receipt per write, failures included. */
export const QaFilingArtifactSchema = z
  .object({
    runId: z.string().min(1).max(200),
    caseSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    receipts: z.array(QaDefectReceiptSchema).max(QA_MAX_CASES * 2),
    filedAt: z.string().min(1).max(40),
  })
  .strict();

export type QaFilingArtifact = z.infer<typeof QaFilingArtifactSchema>;

/** Totals for the `close` step, so the console never recounts the arrays. */
export const QaRunCountsSchema = z
  .object({
    cases: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    notRun: z.number().int().nonnegative(),
    defects: z.number().int().nonnegative(),
    filed: z.number().int().nonnegative(),
  })
  .strict();

export type QaRunCounts = z.infer<typeof QaRunCountsSchema>;

/**
 * `execute` artifact: what the step is about to drive, shown before the write
 * so an unavailable browser or a missing session is visible at the checkpoint
 * rather than discovered as an empty result set.
 */
export const QaExecutionPlanSchema = z
  .object({
    runId: z.string().min(1).max(200),
    storyKey: z.string().min(1).max(40),
    targetKey: z.string().min(1).max(60),
    caseSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvedCaseIds: z.array(z.string().min(1).max(40)).min(1).max(QA_MAX_CASES),
    /** The cases themselves, so the plan is readable without the case store. */
    cases: z.array(QaCaseSchema).min(1).max(QA_MAX_CASES),
    available: z.boolean(),
    blockedReason: z.string().min(1).max(500).optional(),
    maxStepMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();

export type QaExecutionPlan = z.infer<typeof QaExecutionPlanSchema>;

/**
 * `file-defects` artifact: the approved findings a human is about to file. One
 * governed write each, so the checkpoint lists exactly what the write covers.
 */
export const QaFilingPlanSchema = z
  .object({
    runId: z.string().min(1).max(200),
    storyKey: z.string().min(1).max(40),
    targetKey: z.string().min(1).max(60),
    caseSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    defects: z.array(QaDefectSchema).max(QA_MAX_CASES),
  })
  .strict();

export type QaFilingPlan = z.infer<typeof QaFilingPlanSchema>;

/**
 * Output of the flow, produced by `close`: the approved set, how it ran, what
 * failed, and what was filed. `executionAvailable: false` is a first-class
 * outcome — an honest "nothing ran" rather than a run that looks complete.
 */
export const QaFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    storyKey: z.string().min(1).max(40),
    targetKey: z.string().min(1).max(60),
    caseSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvedCaseIds: z.array(z.string().min(1).max(40)).min(1).max(QA_MAX_CASES),
    caseCount: z.number().int().min(1).max(QA_MAX_CASES),
    /** When the store accepted the set (stamped by the store, not the flow). */
    approvedAt: z.string().min(1).max(40),
    executionAvailable: z.boolean(),
    counts: QaRunCountsSchema,
    gaps: z.array(QaGapSchema).max(50),
    failedCaseIds: z.array(z.string().min(1).max(40)).max(QA_MAX_CASES),
    filed: z.array(QaDefectReceiptSchema).max(QA_MAX_CASES),
  })
  .strict();

export type QaFlowOutput = z.infer<typeof QaFlowOutputSchema>;

/**
 * Suspend payload the API reads: the reviewable artifact, the lock target, and
 * the effects recorded so far. The effects map is echoed because a
 * side-effecting step writes before the next checkpoint, and the API persists
 * `side_effects` from whatever the suspended payload carries.
 */
export const QaSuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
    effects: z.record(z.record(z.unknown())).optional(),
  })
  .strict();

export type QaSuspendPayload = z.infer<typeof QaSuspendSchema>;

/** The lock a step holds while a human decides: one story, one target. */
export function qaTarget(storyKey: string, targetKey: string): string {
  return `qa:${targetKey}:${storyKey}`;
}
