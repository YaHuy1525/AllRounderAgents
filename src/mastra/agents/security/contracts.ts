import { z } from "zod";

/**
 * Named steps of the Mastra security flow. Ids match the API run definition
 * (`runs/definitions.py` SECURITY_WORKFLOW) so the stepper, decisions, and
 * receipts line up across the two planes.
 */
export const SECURITY_FLOW_STEPS = [
  "ingest",
  "triage",
  "investigate",
  "decide",
  "approve",
  "contain",
] as const;

export type SecurityFlowStepId = (typeof SECURITY_FLOW_STEPS)[number];

/** Alert channels the lane accepts. */
export const ALERT_SOURCES = ["edr", "siem", "email", "cloud"] as const;

export const AlertSourceSchema = z.enum(ALERT_SOURCES);

export type AlertSource = z.infer<typeof AlertSourceSchema>;

/** Run input supplied by the API (`POST /runs` input payload). */
export const SecurityInputSchema = z
  .object({
    alertSource: AlertSourceSchema,
    title: z.string().min(5).max(300),
    rawAlert: z.string().max(20_000),
    host: z.string().max(200).optional(),
    user: z.string().max(200).optional(),
    indicators: z.array(z.string().min(1).max(300)).max(50).default([]),
    receivedAt: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();

export type SecurityInput = z.infer<typeof SecurityInputSchema>;

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

/** Validation-check outcomes shown by the ingest artifact. */
export const CHECK_STATUSES = ["pass", "flag", "fail"] as const;

export const CheckStatusSchema = z.enum(CHECK_STATUSES);

export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const IngestCheckSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    status: CheckStatusSchema,
    detail: z.string().min(1).max(1_000),
  })
  .strict();

export type IngestCheck = z.infer<typeof IngestCheckSchema>;

/** `ingest` artifact: the normalized alert, provenance, validation report. */
export const IngestArtifactSchema = z
  .object({
    alertId: z.string().min(1).max(200),
    alertSource: AlertSourceSchema,
    title: z.string().min(1).max(300),
    host: z.string().max(200).nullable(),
    user: z.string().max(200).nullable(),
    indicators: z.array(z.string().min(1).max(300)).max(50),
    provenance: z.string().min(1).max(300),
    checks: z.array(IngestCheckSchema).min(1).max(10),
    dedupe: z
      .object({
        seenBefore: z.boolean(),
        priorCaseId: z.string().max(200).nullable(),
      })
      .strict(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type IngestArtifact = z.infer<typeof IngestArtifactSchema>;

/** Alert classifications: true/false positive, benign, or not yet decided. */
export const CLASSIFICATIONS = ["tp", "fp", "benign", "unknown"] as const;

export const ClassificationSchema = z.enum(CLASSIFICATIONS);

export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * Injection tricks the guardrail detector recognizes inside untrusted alert
 * text (§8). A flagged alert is never auto-judged: the triage verdict is
 * pinned to `unknown` and the disposition escalates to a human.
 */
export const INJECTION_RULES = [
  "instruction-override",
  "fake-system-tag",
  "tool-directive",
  "encoded-instruction",
  "unicode-bidi",
  "padding-flood",
] as const;

export const InjectionRuleSchema = z.enum(INJECTION_RULES);

export type InjectionRule = z.infer<typeof InjectionRuleSchema>;

/** Severity ladder shared by triage and the risk tier. */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const SeveritySchema = z.enum(SEVERITIES);

export type Severity = z.infer<typeof SeveritySchema>;

/** One MITRE ATT&CK technique with its tactic. */
export const MitreTechniqueSchema = z
  .object({
    id: z.string().regex(/^T\d{4}(\.\d{3})?$/),
    name: z.string().min(1).max(200),
    tactic: z.string().min(1).max(120),
  })
  .strict();

export type MitreTechnique = z.infer<typeof MitreTechniqueSchema>;

/** `triage` artifact: classification, severity, confidence, ATT&CK map. */
export const AlertTriageSchema = z
  .object({
    classification: ClassificationSchema,
    severity: SeveritySchema,
    confidence: z.number().min(0).max(1),
    mitreTechniques: z.array(MitreTechniqueSchema).max(8),
    /** Injection tricks detected in the raw alert (empty on a clean alert). */
    injectionFlags: z.array(InjectionRuleSchema).max(10),
    rationale: z.string().min(1).max(4_000),
    needsInvestigation: z.boolean(),
  })
  .strict();

export type AlertTriage = z.infer<typeof AlertTriageSchema>;

/** A citation into a retrieved source: id plus character span. */
export const SnippetRefSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    span: z.string().regex(/^\d+-\d+$/),
  })
  .strict();

export type SnippetRef = z.infer<typeof SnippetRefSchema>;

/** One evidence claim; every claim must cite a retrieved item. */
export const EvidenceClaimSchema = z
  .object({
    claim: z.string().min(1).max(2_000),
    sourceTool: z.string().min(1).max(200),
    retrievedAt: z.string().datetime({ offset: true }),
    snippetRef: SnippetRefSchema,
  })
  .strict();

export type EvidenceClaim = z.infer<typeof EvidenceClaimSchema>;

/** One timeline row (event time + citation). */
export const TimelineEntrySchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    event: z.string().min(1).max(2_000),
    sourceId: z.string().min(1).max(200),
    span: z.string().regex(/^\d+-\d+$/),
  })
  .strict();

export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

/** Intel verdicts for one indicator. */
export const INDICATOR_VERDICTS = ["malicious", "suspicious", "benign", "unknown"] as const;

export const IndicatorVerdictSchema = z.enum(INDICATOR_VERDICTS);

export type IndicatorVerdict = z.infer<typeof IndicatorVerdictSchema>;

/** One indicator resolved by the investigation (with citation). */
export const ResolvedIndicatorSchema = z
  .object({
    indicator: z.string().min(1).max(300),
    verdict: IndicatorVerdictSchema,
    detail: z.string().min(1).max(1_000),
    sourceTool: z.string().min(1).max(200),
    retrievedAt: z.string().datetime({ offset: true }),
    snippetRef: SnippetRefSchema,
  })
  .strict();

export type ResolvedIndicator = z.infer<typeof ResolvedIndicatorSchema>;

/** `investigate` artifact: the cited evidence pack. */
export const InvestigateArtifactSchema = z
  .object({
    claims: z.array(EvidenceClaimSchema).min(1).max(50),
    timeline: z.array(TimelineEntrySchema).max(50),
    resolvedIndicators: z.array(ResolvedIndicatorSchema).max(50),
    missingEvidence: z.array(z.string().min(1).max(500)).max(10),
    /** The no-unsourced-claim invariant: always zero on a valid pack. */
    unsourcedCount: z.literal(0),
    summary: z.string().min(1).max(4_000),
  })
  .strict();

export type InvestigateArtifact = z.infer<typeof InvestigateArtifactSchema>;

/** Disposition actions the decide step can propose. */
export const DECIDE_ACTIONS = ["close", "escalate", "contain", "recommend"] as const;

export const DecideActionSchema = z.enum(DECIDE_ACTIONS);

export type DecideAction = z.infer<typeof DecideActionSchema>;

/** One risk factor with its point contribution and explanation. */
export const RiskFactorSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    points: z.number().int().nonnegative().max(100),
    detail: z.string().min(1).max(500),
  })
  .strict();

export type RiskFactor = z.infer<typeof RiskFactorSchema>;

/** Blast radius of a proposed action. */
export const BLAST_RADII = ["low", "medium", "high"] as const;

export const BlastRadiusSchema = z.enum(BLAST_RADII);

export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

/** Reversibility of a proposed action. */
export const REVERSIBILITIES = ["reversible", "compensable", "irreversible"] as const;

export const ReversibilitySchema = z.enum(REVERSIBILITIES);

export type Reversibility = z.infer<typeof ReversibilitySchema>;

/** Risk block: score, tier, factors, blast radius, reversibility, refusal. */
export const RiskSchema = z
  .object({
    score: z.number().int().min(0).max(100),
    tier: SeveritySchema,
    factors: z.array(RiskFactorSchema).max(10),
    blastRadius: BlastRadiusSchema,
    reversibility: ReversibilitySchema,
    /** True when the lane risk policy refuses the action outright. */
    refused: z.boolean(),
  })
  .strict();

export type Risk = z.infer<typeof RiskSchema>;

/** `decide` artifact: the disposition proposal with its risk policy. */
export const DecideArtifactSchema = z
  .object({
    action: DecideActionSchema,
    confidence: z.number().min(0).max(1),
    /** Indexes into the investigate artifact's `claims` array. */
    reasoningClaims: z.array(z.number().int().nonnegative()).max(50),
    risk: RiskSchema,
    requiresHuman: z.boolean(),
    /** Detection-tuning proposal (text only; never executed by the lane). */
    detectionProposal: z.string().max(2_000).nullable(),
    summary: z.string().min(1).max(4_000),
  })
  .strict();

export type DecideArtifact = z.infer<typeof DecideArtifactSchema>;

/** Sign-off states of one approver in the chain. */
export const SIGNER_STATES = ["pending", "approved", "rejected"] as const;

export const SignerStateSchema = z.enum(SIGNER_STATES);

export type SignerState = z.infer<typeof SignerStateSchema>;

/** One signer in the approve chain. */
export const SignerSchema = z
  .object({
    role: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    state: SignerStateSchema,
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    comment: z.string().max(1_000).nullable(),
  })
  .strict();

export type Signer = z.infer<typeof SignerSchema>;

/** `approve` artifact: the signer chain for the proposed disposition. */
export const ApproveArtifactSchema = z
  .object({
    alertId: z.string().min(1).max(200),
    action: DecideActionSchema,
    tier: SeveritySchema,
    requiredSigners: z.array(z.string().min(1).max(80)).min(1).max(5),
    signers: z.array(SignerSchema).min(1).max(5),
    allApproved: z.boolean(),
    /** Rejection note: set when Approve sends the run back to investigate. */
    returnedNote: z.string().max(500).nullable(),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ApproveArtifact = z.infer<typeof ApproveArtifactSchema>;

/** Terminal outcomes of the contain checkpoint. */
export const CONTAIN_OUTCOMES = ["contained", "closed", "escalated", "recommended"] as const;

export const ContainOutcomeSchema = z.enum(CONTAIN_OUTCOMES);

export type ContainOutcome = z.infer<typeof ContainOutcomeSchema>;

/** `contain` suspend artifact: what the approved disposition will execute. */
export const ContainPreviewSchema = z
  .object({
    alertId: z.string().min(1).max(200),
    action: DecideActionSchema,
    outcome: ContainOutcomeSchema,
    containmentId: z.string().min(5).max(40),
    idempotencyKey: z.string().min(1).max(200),
    target: z.string().min(1).max(300),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ContainPreview = z.infer<typeof ContainPreviewSchema>;

/** Executed contain receipt (the `contain` side effect, replay-safe). */
export const ContainArtifactSchema = z
  .object({
    alertId: z.string().min(1).max(200),
    action: DecideActionSchema,
    outcome: ContainOutcomeSchema,
    containmentId: z.string().min(5).max(40),
    idempotencyKey: z.string().min(1).max(200),
    target: z.string().min(1).max(300),
    registryRef: z.string().min(1).max(200),
    completedAt: z.string().datetime({ offset: true }),
    evidenceRef: z.string().min(1).max(300),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ContainArtifact = z.infer<typeof ContainArtifactSchema>;

/** Recorded side effect for one step, keyed by its idempotency action hash. */
export const SecurityEffectSchema = z
  .object({
    actionHash: z.string().min(1).max(128),
    receipt: ContainArtifactSchema.optional(),
  })
  .strict();

export type SecurityEffect = z.infer<typeof SecurityEffectSchema>;

/** Structured output of the triage agent: the analyst rationale. */
export const TriageModelOutputSchema = z
  .object({
    rationale: z.string().min(1).max(4_000),
  })
  .strict();

export type TriageModelOutput = z.infer<typeof TriageModelOutputSchema>;

/** One claim draft the investigator model proposes, cited by source + span. */
export const ClaimDraftSchema = z
  .object({
    claim: z.string().min(1).max(2_000),
    sourceId: z.string().min(1).max(200),
    span: z.string().regex(/^\d+-\d+$/),
  })
  .strict();

export type ClaimDraft = z.infer<typeof ClaimDraftSchema>;

/** Structured output of the investigation agent (the evidence-pack draft). */
export const InvestigateModelOutputSchema = z
  .object({
    claims: z.array(ClaimDraftSchema).min(1).max(20),
    missingEvidence: z.array(z.string().min(1).max(500)).max(10),
    summary: z.string().min(1).max(4_000),
  })
  .strict();

export type InvestigateModelOutput = z.infer<typeof InvestigateModelOutputSchema>;

/** Structured output of the containment advisor (the decide narrative). */
export const DecideModelOutputSchema = z
  .object({
    reasoningClaims: z.array(z.number().int().nonnegative()).max(50),
    detectionProposal: z.string().max(2_000).nullable(),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(4_000),
  })
  .strict();

export type DecideModelOutput = z.infer<typeof DecideModelOutputSchema>;

/** Structured output of the reporting agent (the case-close narrative). */
export const ReportModelOutputSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type ReportModelOutput = z.infer<typeof ReportModelOutputSchema>;

/**
 * The engine-facing envelope the API sends on every Mastra pass: it is the
 * workflow input on `start` and the resume payload (plus `decision`) on
 * `resume`. `decisions`/`artifacts`/`effects` are the API's authoritative
 * maps; `decision` is present only on a resume pass.
 */
export const SecurityRunStateSchema = z
  .object({
    runId: z.string().min(1).max(200),
    workflow: z.literal("security"),
    ticketKey: z.string().min(1).max(200),
    caseId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    input: SecurityInputSchema,
    decisions: z.record(StepDecisionSchema),
    artifacts: z.record(z.record(z.unknown())),
    effects: z.record(SecurityEffectSchema),
    decision: StepDecisionSchema.optional(),
  })
  .strict();

export type SecurityRunState = z.infer<typeof SecurityRunStateSchema>;

export const SecurityFlowOutputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    status: z.literal("completed"),
    effects: z.record(SecurityEffectSchema),
    receipt: ContainArtifactSchema.optional(),
  })
  .strict();

export type SecurityFlowOutput = z.infer<typeof SecurityFlowOutputSchema>;

/** Suspend payload the API reads: the reviewable artifact plus lock target. */
export const SecuritySuspendSchema = z
  .object({
    artifact: z.record(z.unknown()),
    target: z.string().min(1).max(300).optional(),
  })
  .strict();

export type SecuritySuspendPayload = z.infer<typeof SecuritySuspendSchema>;
