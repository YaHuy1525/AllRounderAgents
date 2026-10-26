import { ApiError, api, apiUrl, sessionHeaders } from "./api";

export type CaseEvent = {
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type CaseRecord = {
  id: string;
  tenant_id: string;
  ticket_key: string;
  domain: string;
  status: string;
  events: CaseEvent[];
  cost_usd_micro: number;
  outcome: string | null;
};

export type TicketStatus = {
  ticketKey: string;
  caseId: string;
  status: string;
  costUsdMicro: number;
};

/** One auto-check result on a doc-snap draft (U7). */
export type CaseDocSnapFlag = {
  code: string;
  severity: "ok" | "warning" | "error";
  message: string;
  field: string;
};

/** One doc-snap draft as stored on the case trail (U7). */
export type CaseDocSnap = {
  snapId: string;
  docType: string;
  source: {
    filename: string;
    contentType: string;
    sha256: string;
    bytes: number;
  };
  fields: Record<string, string>;
  flags: CaseDocSnapFlag[];
  extractor: string;
  createdAt: string;
};

/** The base64 body one snap sends; the browser reads the picked file. */
export type CaseDocSnapRequest = {
  filename: string;
  contentType: string;
  contentBase64: string;
};

export type LaneId =
  | "generic"
  | "support"
  | "coding"
  | "finance"
  | "review"
  | "issues"
  | "features"
  | "dependencies"
  | "accessibility"
  | "vendors"
  | "leave"
  | "onboarding"
  | "offboarding"
  | "screening"
  | "hr-help";

export type LaneStep = { id: string; label: string; kinds: string[] };

/**
 * Stepper state. Legacy lanes derive done/current/future from case events;
 * run-driven lanes additionally surface the suspended/blocked checkpoints.
 */
export type StepState = "done" | "current" | "future" | "awaiting" | "blocked";

const INPUT_STEP: LaneStep = {
  id: "input",
  label: "Input",
  kinds: ["input", "intake", "context", "start", "created"],
};

const RETRIEVE_STEP: LaneStep = {
  id: "retrieve",
  label: "Retrieve & Input Data",
  kinds: ["retriev", "investigat", "rca", "sourc", "search", "knowledge", "data"],
};

const ENVIRONMENT_STEP: LaneStep = {
  id: "environment",
  label: "Environment Selection",
  kinds: ["environ", "preflight", "setup", "sandbox", "worktree", "clone", "toolchain"],
};

const PLAN_STEP: LaneStep = {
  id: "plan",
  label: "Plan Execution",
  kinds: ["plan", "propos", "schedule"],
};

const EXECUTE_STEP: LaneStep = {
  id: "execute",
  label: "Execute",
  kinds: ["execut", "apply", "patch", "run", "recon", "validat", "merge", "fanout", "send", "post"],
};

const DRAFT_STEP: LaneStep = {
  id: "draft",
  label: "Draft",
  kinds: ["draft", "compose", "write"],
};

const VALIDATION_STEP: LaneStep = {
  id: "validation",
  label: "Validation",
  kinds: ["validat", "check", "verify", "report"],
};

const GATE_STEP: LaneStep = {
  id: "gate",
  label: "Approval Gate",
  kinds: ["approv", "gate", "decision", "receipt", "suspend"],
};

const RECONCILE_STEP: LaneStep = {
  id: "reconcile",
  label: "Reconcile Ledger",
  kinds: ["recon"],
};

const AUDIT_STEP: LaneStep = {
  id: "audit",
  label: "Audit & Exceptions",
  kinds: ["audit", "exception", "fanout", "merge"],
};

const RESULTS_STEP: LaneStep = {
  id: "results",
  label: "Final Results",
  kinds: ["result", "evidence", "outcome", "close", "final", "sent", "posted", "deliver"],
};

const SELECT_PR_STEP: LaneStep = {
  id: "select-pr",
  label: "Select PR",
  kinds: ["select", "pr.selected"],
};

const REVIEW_OPTIONS_STEP: LaneStep = {
  id: "review-options",
  label: "Review Options",
  kinds: ["options", "categor", "guidance"],
};

const AI_REVIEW_STEP: LaneStep = {
  id: "ai-review",
  label: "AI Review",
  kinds: ["review", "verdict", "comment"],
};

const ISSUE_SELECTION_STEP: LaneStep = {
  id: "issue-selection",
  label: "Issue Selection",
  kinds: ["issue.selected", "ticket.selected", "fix.selected"],
};

const ANALYSIS_STEP: LaneStep = {
  id: "analysis",
  label: "Analysis",
  kinds: ["analy", "similar", "affected", "rca"],
};

const IMPLEMENTATION_STEP: LaneStep = {
  id: "implementation",
  label: "Implementation",
  kinds: ["implement", "patch", "repair"],
};

const COMPLETE_STEP: LaneStep = {
  id: "complete",
  label: "Complete",
  kinds: ["complete", "posted", "receipt", "follow"],
};

const FEATURE_SELECTION_STEP: LaneStep = {
  id: "feature-selection",
  label: "Feature Selection",
  kinds: ["feature.selected", "feature-select", "ticket.selected"],
};

const SCOPE_DESIGN_STEP: LaneStep = {
  id: "scope-design",
  label: "Scope & Design",
  kinds: ["scope", "design", "area"],
};

const SCAN_STEP: LaneStep = {
  id: "scan",
  label: "Scan",
  kinds: ["scan", "inventory", "outdated", "dependenc"],
};

const GROUP_STEP: LaneStep = {
  id: "group",
  label: "Group",
  kinds: ["dependency.group"],
};

const APPLY_STEP: LaneStep = {
  id: "apply",
  label: "Apply",
  kinds: ["dependency.apply", "bump"],
};

const VALIDATE_STEP: LaneStep = {
  id: "validate",
  label: "Validate",
  kinds: ["dependency.validate", "install"],
};

const MERGE_STEP: LaneStep = {
  id: "merge",
  label: "Merge",
  kinds: ["dependency.merge", "deps.pr"],
};

const CRAWL_STEP: LaneStep = {
  id: "crawl",
  label: "Crawl",
  kinds: ["a11y.crawl", "accessibility.crawl", "crawl"],
};

const VIOLATIONS_STEP: LaneStep = {
  id: "violations",
  label: "Violations",
  kinds: ["a11y.violation", "axe", "violation"],
};

const FIX_STEP: LaneStep = {
  id: "fix",
  label: "Fix",
  kinds: ["a11y.fix", "accessibility.fix"],
};

const RESCAN_STEP: LaneStep = {
  id: "re-scan",
  label: "Re-scan",
  kinds: ["a11y.rescan", "a11y.gate", "rescan"],
};

const COLLECT_STEP: LaneStep = {
  id: "collect",
  label: "Collect",
  kinds: ["vendor.collect", "document", "upload"],
};

const VERIFY_STEP: LaneStep = {
  id: "verify",
  label: "Verify",
  kinds: ["vendor.verify", "duplicate", "screening"],
};

const RISK_SCORE_STEP: LaneStep = {
  id: "risk-score",
  label: "Risk Score",
  kinds: ["vendor.risk", "risk"],
};

const APPROVE_CHAIN_STEP: LaneStep = {
  id: "approve",
  label: "Approve",
  kinds: ["vendor.approve", "signer", "chain"],
};

const CREATE_VENDOR_STEP: LaneStep = {
  id: "create",
  label: "Create",
  kinds: ["vendor.create", "master"],
};

const LEAVE_INTAKE_STEP: LaneStep = {
  id: "intake",
  label: "Intake",
  kinds: ["leave.intake", "leave.request", "hr.intake"],
};

const LEAVE_POLICY_STEP: LaneStep = {
  id: "policy-check",
  label: "Policy Check",
  kinds: ["leave.policy", "policy.check", "leave.balance"],
};

const LEAVE_APPROVE_STEP: LaneStep = {
  id: "approve",
  label: "Approve",
  kinds: ["leave.approve", "leave.gate", "hr.approve"],
};

const LEAVE_APPLY_STEP: LaneStep = {
  id: "apply",
  label: "Book Leave",
  kinds: ["leave.apply", "leave.booked", "hr.booked"],
};

const ONBOARDING_COLLECT_STEP: LaneStep = {
  id: "collect",
  label: "Collect",
  kinds: ["onboarding.collect", "new-hire.collect"],
};

const ONBOARDING_VERIFY_STEP: LaneStep = {
  id: "verify",
  label: "Verify",
  kinds: ["onboarding.verify"],
};

const ONBOARDING_RISK_SCORE_STEP: LaneStep = {
  id: "risk-score",
  label: "Risk Score",
  kinds: ["onboarding.risk"],
};

const ONBOARDING_APPROVE_STEP: LaneStep = {
  id: "approve",
  label: "Approve",
  kinds: ["onboarding.approve"],
};

const ONBOARDING_PROVISION_STEP: LaneStep = {
  id: "provision",
  label: "Provision",
  kinds: ["onboarding.provision", "hris.provision"],
};

const OFFBOARDING_INTAKE_STEP: LaneStep = {
  id: "intake",
  label: "Intake",
  kinds: ["offboarding.intake", "offboarding.request"],
};

const OFFBOARDING_AUDIT_STEP: LaneStep = {
  id: "access-audit",
  label: "Access Audit",
  kinds: ["offboarding.audit", "access.audit"],
};

const OFFBOARDING_APPROVE_STEP: LaneStep = {
  id: "approve",
  label: "Approve",
  kinds: ["offboarding.approve", "revocation.approve"],
};

const OFFBOARDING_REVOKE_STEP: LaneStep = {
  id: "revoke",
  label: "Revoke",
  kinds: ["offboarding.revoke", "access.revoked"],
};

const OFFBOARDING_ATTEST_STEP: LaneStep = {
  id: "attest",
  label: "Attest",
  kinds: ["offboarding.attest", "offboarding.close"],
};

const SCREENING_REQUISITION_STEP: LaneStep = {
  id: "requisition",
  label: "Requisition",
  kinds: ["screening.requisition", "candidate.requisition"],
};

const SCREENING_SCREEN_STEP: LaneStep = {
  id: "screen",
  label: "Screen",
  kinds: ["screening.screen", "candidate.screen"],
};

const SCREENING_SHORTLIST_STEP: LaneStep = {
  id: "shortlist",
  label: "Shortlist",
  kinds: ["screening.shortlist", "candidate.shortlist"],
};

const SCREENING_SCHEDULE_STEP: LaneStep = {
  id: "schedule",
  label: "Schedule",
  kinds: ["screening.schedule", "interview.scheduled"],
};

const HR_HELP_INTAKE_STEP: LaneStep = {
  id: "intake",
  label: "Intake",
  kinds: ["hr-help.intake"],
};

const HR_HELP_RETRIEVE_STEP: LaneStep = {
  id: "retrieve",
  label: "Retrieve",
  kinds: ["hr-help.retrieve"],
};

const HR_HELP_DRAFT_STEP: LaneStep = {
  id: "draft",
  label: "Draft",
  kinds: ["hr-help.draft"],
};

const HR_HELP_APPROVE_STEP: LaneStep = {
  id: "approve",
  label: "Approve",
  kinds: ["hr-help.approve"],
};

const HR_HELP_SEND_STEP: LaneStep = {
  id: "send",
  label: "Send",
  kinds: ["hr-help.send", "hr-help.sent"],
};

/**
 * Lane step sequences, mirrored from the Mastra workflows and the API run
 * definitions. A lane only ever renders the steps it actually has, and the table
 * below is the single source — the definitions are not restated here.
 */
export const LANE_STEPS: Record<LaneId, LaneStep[]> = {
  generic: [INPUT_STEP, RETRIEVE_STEP, PLAN_STEP, EXECUTE_STEP, RESULTS_STEP],
  coding: [
    INPUT_STEP,
    RETRIEVE_STEP,
    ENVIRONMENT_STEP,
    PLAN_STEP,
    EXECUTE_STEP,
    RESULTS_STEP,
  ],
  support: [INPUT_STEP, RETRIEVE_STEP, DRAFT_STEP, VALIDATION_STEP, GATE_STEP, RESULTS_STEP],
  finance: [INPUT_STEP, RETRIEVE_STEP, RECONCILE_STEP, AUDIT_STEP, GATE_STEP, RESULTS_STEP],
  review: [SELECT_PR_STEP, REVIEW_OPTIONS_STEP, AI_REVIEW_STEP, COMPLETE_STEP],
  issues: [ISSUE_SELECTION_STEP, ANALYSIS_STEP, IMPLEMENTATION_STEP, COMPLETE_STEP],
  features: [FEATURE_SELECTION_STEP, SCOPE_DESIGN_STEP, IMPLEMENTATION_STEP, COMPLETE_STEP],
  dependencies: [SCAN_STEP, GROUP_STEP, APPLY_STEP, VALIDATE_STEP, MERGE_STEP],
  accessibility: [CRAWL_STEP, VIOLATIONS_STEP, FIX_STEP, RESCAN_STEP],
  vendors: [COLLECT_STEP, VERIFY_STEP, RISK_SCORE_STEP, APPROVE_CHAIN_STEP, CREATE_VENDOR_STEP],
  leave: [LEAVE_INTAKE_STEP, LEAVE_POLICY_STEP, LEAVE_APPROVE_STEP, LEAVE_APPLY_STEP],
  onboarding: [
    ONBOARDING_COLLECT_STEP,
    ONBOARDING_VERIFY_STEP,
    ONBOARDING_RISK_SCORE_STEP,
    ONBOARDING_APPROVE_STEP,
    ONBOARDING_PROVISION_STEP,
  ],
  offboarding: [
    OFFBOARDING_INTAKE_STEP,
    OFFBOARDING_AUDIT_STEP,
    OFFBOARDING_APPROVE_STEP,
    OFFBOARDING_REVOKE_STEP,
    OFFBOARDING_ATTEST_STEP,
  ],
  screening: [
    SCREENING_REQUISITION_STEP,
    SCREENING_SCREEN_STEP,
    SCREENING_SHORTLIST_STEP,
    SCREENING_SCHEDULE_STEP,
  ],
  "hr-help": [
    HR_HELP_INTAKE_STEP,
    HR_HELP_RETRIEVE_STEP,
    HR_HELP_DRAFT_STEP,
    HR_HELP_APPROVE_STEP,
    HR_HELP_SEND_STEP,
  ],
};

/** The lane a runs-API workflow renders as (only shipped workflows map). */
export function laneForWorkflow(workflow: string): LaneId | null {
  if (workflow === "review") return "review";
  if (workflow === "issues") return "issues";
  if (workflow === "features") return "features";
  if (workflow === "dependencies") return "dependencies";
  if (workflow === "accessibility") return "accessibility";
  if (workflow === "vendors") return "vendors";
  if (workflow === "leave") return "leave";
  if (workflow === "onboarding") return "onboarding";
  if (workflow === "offboarding") return "offboarding";
  if (workflow === "screening") return "screening";
  if (workflow === "hr-help") return "hr-help";
  return null;
}

export function laneForDomain(domain: string): LaneId {
  const normalized = domain.trim().toLowerCase();
  if (normalized.includes("support")) return "support";
  if (normalized.includes("vendor")) return "vendors";
  if (normalized.includes("finance")) return "finance";
  if (normalized.includes("cod") || normalized.includes("program") || normalized.includes("dev")) {
    return "coding";
  }
  return "generic";
}

export function inferLane(ticket: { summary: string; labels: string[] }): LaneId {
  const text = `${ticket.summary} ${ticket.labels.join(" ")}`.toLowerCase();
  if (text.includes("support")) return "support";
  if (text.includes("vendor") || text.includes("onboard")) return "vendors";
  if (text.includes("finance") || text.includes("ledger") || text.includes("recon")) {
    return "finance";
  }
  if (text.includes("code") || text.includes("repo") || text.includes("patch")) return "coding";
  return "generic";
}

export function stepsForLane(lane: LaneId): LaneStep[] {
  return LANE_STEPS[lane];
}

function eventMatchesStep(event: CaseEvent, step: LaneStep): boolean {
  const kind = event.kind.toLowerCase();
  return step.kinds.some((token) => kind.includes(token));
}

export function eventsForStep(step: LaneStep, events: CaseEvent[]): CaseEvent[] {
  return events.filter((event) => eventMatchesStep(event, step));
}

/**
 * Derive the stepper state from the case events. Completed steps show a
 * checkmark, the first step without evidence is the current one, and the rest
 * stay greyed until a run records them. Without a run every step is future.
 */
export function stepStates(steps: LaneStep[], events: CaseEvent[], hasRun: boolean): StepState[] {
  const matched = steps.map((step) => events.some((event) => eventMatchesStep(event, step)));
  const firstOpen = matched.findIndex((done) => !done);
  return matched.map((done, index) => {
    if (done) return "done";
    if (!hasRun) return "future";
    return index === firstOpen ? "current" : "future";
  });
}

// ------------------------------------------------------------ case header

/** Status pill / risk tones for the Case-360 header blocks. */
export type CaseHeaderTone = "neutral" | "info" | "ok" | "warn" | "danger";

export type CaseHeaderStatus = { label: string; tone: CaseHeaderTone };

export type CaseHeaderFact = { label: string; value: string };

/**
 * One clickable header entry. ``stepId`` names the step whose panel holds
 * the evidence, so the header never states anything it cannot show.
 */
export type CaseHeaderLink = {
  label: string;
  detail: string;
  tone: CaseHeaderTone;
  stepId: string | null;
  /** Provenance of the claim, surfaced on hover and asserted in tests. */
  source: string;
};

export type CaseHeaderReceipt = {
  label: string;
  state: "signed" | "pending" | "expired" | "rejected";
  source: string;
};

export type CaseHeaderModel = {
  key: string;
  lane: LaneId;
  laneLabel: string;
  status: CaseHeaderStatus;
  title: string;
  summary: string;
  facts: CaseHeaderFact[];
  risks: CaseHeaderLink[];
  next: CaseHeaderLink;
  receipts: { signed: number; pending: number; items: CaseHeaderReceipt[] };
};

/** Minimal run step shape; RunStep satisfies it structurally. */
export type CaseHeaderRunStep = {
  stepId: string;
  title: string;
  index: number;
  state: string;
  artifact: Record<string, unknown> | null;
  receipt: string | null;
  actionHash: string | null;
  regenerations: number;
};

/** Minimal run shape; RunSummary / RunDetail satisfy it structurally. */
export type CaseHeaderRun = {
  runId: string;
  workflow: string;
  status: string;
  attempt: number;
  queuePosition: number | null;
  /** Ceiling kind a queued run waits on ("run" | "apply" | "model"); null
   *  when the server recorded no pass. */
  waitingOn: string | null;
  /** Ceiling slots the recorded pass already holds. */
  heldSlots: string[];
  currentStepId: string | null;
  stepCount: number;
  stepsDone: number;
  startedAt: string;
  finishedAt: string | null;
  lockTarget: string | null;
  lockedBy: string | null;
  outcome: string | null;
  cancelReason: string | null;
  /** Empty on list rows; a loaded run detail carries its steps. */
  steps: CaseHeaderRunStep[];
};

export type CaseHeaderApproval = {
  id: string;
  scope: string;
  approver: string;
  decision: string | null;
  expiresAt: string;
};

export type CaseHeaderInput = {
  ticket: {
    key: string;
    summary: string;
    status: string;
    issueType: string;
    priority: string;
    assignee: string | null;
    labels: string[];
    project: string;
  };
  record: { id: string; domain: string; status: string; events: CaseEvent[] } | null;
  lane: LaneId;
  steps: ReadonlyArray<{ id: string; label: string }>;
  states: ReadonlyArray<StepState>;
  runs: ReadonlyArray<CaseHeaderRun>;
  /** The loaded run detail; summaries-only input falls back to `runs`. */
  run: CaseHeaderRun | null;
  approvals: ReadonlyArray<CaseHeaderApproval>;
  /** Injectable clock for expiry assertions. */
  now?: number;
};

export const LANE_LABELS: Record<LaneId, string> = {
  generic: "General",
  support: "Support",
  coding: "Coding",
  finance: "Finance",
  review: "PR Review",
  issues: "Issue Resolution",
  features: "Feature Delivery",
  dependencies: "Dependencies",
  accessibility: "Accessibility",
  vendors: "Vendors",
  leave: "Leave",
  onboarding: "Onboarding",
  offboarding: "Offboarding",
  screening: "Screening",
  "hr-help": "HR Help",
};

/** Values every lane field draws from; missing data yields null. */
export type CaseHeaderFieldContext = {
  input: CaseHeaderInput;
  /** Featured run: the loaded detail, else the newest summary. */
  run: CaseHeaderRun | null;
  /** Most urgent pending gate (earliest expiry), when one exists. */
  gate: CaseHeaderApproval | null;
  /** "2 of 5 steps done" from the featured run, else the lane stepper. */
  progress: string;
};

export type CaseHeaderField = {
  label: string;
  value: (context: CaseHeaderFieldContext) => string | null;
};

function artifactValues(run: CaseHeaderRun | null, keys: readonly string[]): unknown[] {
  if (run === null) return [];
  const values: unknown[] = [];
  for (const step of run.steps) {
    if (step.artifact === null) continue;
    for (const key of keys) {
      const value = step.artifact[key];
      if (value !== undefined && value !== null) values.push(value);
    }
  }
  return values;
}

function artifactText(run: CaseHeaderRun | null, keys: readonly string[]): string | null {
  for (const value of artifactValues(run, keys)) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function artifactCount(run: CaseHeaderRun | null, keys: readonly string[]): number | null {
  for (const value of artifactValues(run, keys)) {
    if (Array.isArray(value)) return value.length;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

const FIELD_REPOSITORY: CaseHeaderField = {
  label: "Repo",
  value: ({ run }) => artifactText(run, ["repository"]),
};

const FIELD_FILES: CaseHeaderField = {
  label: "Files",
  value: ({ run }) => {
    const count = artifactCount(run, ["files", "affectedFiles"]);
    return count === null ? null : String(count);
  },
};

const FIELD_VIOLATIONS: CaseHeaderField = {
  label: "Violations",
  value: ({ run }) => {
    const count = artifactCount(run, ["violations"]);
    return count === null ? null : String(count);
  },
};

const FIELD_FLAGS: CaseHeaderField = {
  label: "Flags",
  value: ({ run }) => {
    const count = artifactCount(run, ["totalFlags", "flags"]);
    return count === null ? null : String(count);
  },
};

const FIELD_TARGET: CaseHeaderField = {
  label: "Target",
  value: ({ run }) => run?.lockTarget ?? null,
};

const FIELD_PROGRESS: CaseHeaderField = {
  label: "Progress",
  value: ({ progress }) => progress,
};

const FIELD_ATTEMPT: CaseHeaderField = {
  label: "Attempt",
  value: ({ run }) => (run !== null && run.attempt > 1 ? String(run.attempt) : null),
};

const FIELD_APPROVER: CaseHeaderField = {
  label: "Approver",
  value: ({ gate }) => gate?.approver ?? null,
};

const FIELD_PRIORITY: CaseHeaderField = {
  label: "Priority",
  value: ({ input }) => {
    const priority = input.ticket.priority.trim();
    return priority === "" ? null : priority;
  },
};

const FIELD_ASSIGNEE: CaseHeaderField = {
  label: "Assignee",
  value: ({ input }) => input.ticket.assignee ?? "Unassigned",
};

const FIELD_TYPE: CaseHeaderField = {
  label: "Type",
  value: ({ input }) => {
    const type = input.ticket.issueType.trim();
    return type === "" ? null : type;
  },
};

/**
 * Per-lane fact selection, beside LANE_STEPS: the same Case-360 component
 * swaps which fields it emphasizes per lane, most relevant first. Missing
 * data is skipped and caseHeaderModel tops the block up, so no lane renders
 * an empty header.
 */
export const LANE_HEADER_FIELDS: Record<LaneId, ReadonlyArray<CaseHeaderField>> = {
  generic: [FIELD_PROGRESS, FIELD_PRIORITY, FIELD_ASSIGNEE, FIELD_TYPE],
  support: [FIELD_PROGRESS, { ...FIELD_APPROVER, label: "Gate" }, FIELD_PRIORITY, FIELD_ASSIGNEE],
  coding: [FIELD_REPOSITORY, FIELD_FILES, FIELD_PROGRESS, FIELD_TARGET],
  finance: [FIELD_PROGRESS, { ...FIELD_APPROVER, label: "Gate" }, FIELD_PRIORITY, FIELD_ASSIGNEE],
  review: [
    { ...FIELD_TARGET, label: "Pull request" },
    FIELD_REPOSITORY,
    FIELD_PROGRESS,
    FIELD_ATTEMPT,
  ],
  issues: [FIELD_REPOSITORY, FIELD_FILES, FIELD_PROGRESS, FIELD_ASSIGNEE],
  features: [FIELD_REPOSITORY, FIELD_FILES, FIELD_PROGRESS, FIELD_PRIORITY],
  dependencies: [FIELD_REPOSITORY, FIELD_PROGRESS, FIELD_PRIORITY, FIELD_ASSIGNEE],
  accessibility: [FIELD_REPOSITORY, FIELD_VIOLATIONS, FIELD_FILES, FIELD_PROGRESS],
  vendors: [FIELD_APPROVER, FIELD_PROGRESS, FIELD_PRIORITY, FIELD_ASSIGNEE],
  leave: [FIELD_ASSIGNEE, FIELD_APPROVER, FIELD_PROGRESS, FIELD_PRIORITY],
  onboarding: [FIELD_APPROVER, FIELD_PROGRESS, FIELD_ASSIGNEE, FIELD_PRIORITY],
  offboarding: [FIELD_APPROVER, FIELD_PROGRESS, FIELD_ASSIGNEE, FIELD_PRIORITY],
  screening: [FIELD_FLAGS, FIELD_PROGRESS, FIELD_ASSIGNEE, FIELD_PRIORITY],
  "hr-help": [FIELD_FLAGS, FIELD_PROGRESS, FIELD_ASSIGNEE, FIELD_PRIORITY],
};

const HIGH_PRIORITIES: ReadonlySet<string> = new Set([
  "highest",
  "high",
  "critical",
  "blocker",
]);

const HEADER_RISK_LIMIT = 3;
const HEADER_FACT_LIMIT = 4;

function featuredRun(input: CaseHeaderInput): CaseHeaderRun | null {
  if (input.run !== null) return input.run;
  let newest: CaseHeaderRun | null = null;
  for (const run of input.runs) {
    if (newest === null || run.startedAt > newest.startedAt) newest = run;
  }
  return newest;
}

function runStepTitle(run: CaseHeaderRun, stepId: string | null): string {
  if (stepId === null) return "the current step";
  return run.steps.find((step) => step.stepId === stepId)?.title ?? stepId;
}

/** The step a run-state claim points at: current, else the flagged step. */
function runEvidenceStep(run: CaseHeaderRun | null): string | null {
  if (run === null) return null;
  if (run.currentStepId !== null) return run.currentStepId;
  const flagged = run.steps.find(
    (step) => step.state === "blocked" || step.state === "failed" || step.state === "awaiting_human",
  );
  return flagged?.stepId ?? run.steps.at(-1)?.stepId ?? null;
}

function runStatus(run: CaseHeaderRun): CaseHeaderStatus {
  switch (run.status) {
    case "queued":
      return {
        label: run.queuePosition === null ? "Queued" : `Queued #${run.queuePosition}`,
        tone: "neutral",
      };
    case "running":
      return { label: "Running", tone: "info" };
    case "awaiting_human":
      return { label: "Awaiting you", tone: "warn" };
    case "blocked":
      return { label: "Blocked", tone: "danger" };
    case "completed":
      return { label: "Completed", tone: "ok" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    default:
      return { label: run.status, tone: "neutral" };
  }
}

function statusFromText(value: string): CaseHeaderStatus {
  const text = value.trim().toLowerCase();
  if (text === "") return { label: "Unknown", tone: "neutral" };
  const label = text.charAt(0).toUpperCase() + text.slice(1);
  if (/done|closed|resolved|complete/.test(text)) return { label, tone: "ok" };
  if (/block|fail/.test(text)) return { label, tone: "danger" };
  if (/progress|review|active|open/.test(text)) return { label, tone: "info" };
  return { label, tone: "neutral" };
}

function latestArtifactSummary(run: CaseHeaderRun | null): string | null {
  if (run === null) return null;
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const value = run.steps[index]?.artifact?.["summary"];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 240);
  }
  return null;
}

/** Name the ceiling a queued run actually waits on; the server records the
 *  kind on the run's pass, an absent kind stays the historical "run slot". */
function ceilingPhrase(run: CaseHeaderRun): string {
  if (run.waitingOn === "apply") return "an apply slot";
  if (run.waitingOn === "model") return "a model-call slot";
  return "a run slot";
}

function runStatePhrase(run: CaseHeaderRun): string {
  const title = runStepTitle(run, run.currentStepId);
  switch (run.status) {
    case "awaiting_human":
      return `Waiting for your decision at ${title}`;
    case "blocked":
      return `Blocked on ${run.lockTarget ?? "a held target"}`;
    case "failed":
      return run.outcome ?? "The run failed";
    case "cancelled":
      return `Cancelled: ${run.cancelReason ?? "no reason recorded"}`;
    case "completed":
      return run.outcome ?? "The run completed";
    case "running":
      return `Working on ${title}`;
    case "queued":
      return run.queuePosition === null
        ? `Waiting for ${ceilingPhrase(run)}`
        : `Queued at position ${run.queuePosition}`;
    default:
      return `Status ${run.status}`;
  }
}

function formatStamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Flags gates that expire within the half hour; mirrors the gate card. */
function expiresSoon(value: string, now: number): boolean {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const diff = date.getTime() - now;
  return diff > 0 && diff < 30 * 60 * 1000;
}

/** Most urgent pending gate: earliest expiry wins. */
function urgentGate(approvals: ReadonlyArray<CaseHeaderApproval>): CaseHeaderApproval | null {
  let urgent: CaseHeaderApproval | null = null;
  for (const approval of approvals) {
    if (approval.decision !== null) continue;
    if (urgent === null || approval.expiresAt < urgent.expiresAt) urgent = approval;
  }
  return urgent;
}

/**
 * The step a gate's evidence lands on. Side-effecting scopes read
 * ``workflow:step``; run-scoped ones (``run:workflow``) fall back to the
 * lane's gate step.
 */
function gateStepId(scope: string, steps: ReadonlyArray<{ id: string }>): string | null {
  if (!scope.startsWith("run:")) {
    const step = scope.split(":", 2)[1];
    if (step !== undefined && step !== "") return step;
  }
  return steps.find((step) => step.id === "gate" || step.id === "approve")?.id ?? null;
}

type ArtifactRisk = { stepId: string; label: string; detail: string; tone: CaseHeaderTone };

function firstText(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 160);
  }
  return null;
}

/** Verified artifact flags the lanes already emit: offboarding risks, screening/hr-help flags. */
function artifactRisks(run: CaseHeaderRun): ArtifactRisk[] {
  const entries: ArtifactRisk[] = [];
  for (const step of run.steps) {
    const artifact = step.artifact;
    if (artifact === null) continue;
    for (const key of ["risks", "flags"]) {
      const value = artifact[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const record =
          typeof item === "object" && item !== null && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : null;
        const label = firstText(record ?? {}, ["label", "title", "kind", "severity", "role", "name"]) ?? "Flag";
        const detail =
          firstText(record ?? {}, ["summary", "detail", "reason", "description", "message", "impact"]) ??
          "Flagged for review";
        const severity = firstText(record ?? {}, ["severity", "tier"]) ?? "";
        entries.push({
          stepId: step.stepId,
          label,
          detail,
          tone: /high|critical/.test(severity.toLowerCase()) ? "danger" : "warn",
        });
      }
    }
  }
  return entries;
}

/**
 * Build the Case-360 header model (upgrade U2) from the surfaces the ticket
 * tab already holds: the ticket, the case record, run summaries plus the
 * loaded run detail, the lane stepper states, and the approval gates. Pure
 * and deterministic — every risk and the next entry carry the step id whose
 * panel proves the claim.
 */
export function caseHeaderModel(input: CaseHeaderInput): CaseHeaderModel {
  const now = input.now ?? Date.now();
  const run = featuredRun(input);
  const doneCount = input.states.filter((state) => state === "done").length;
  const progress =
    run !== null
      ? `${run.stepsDone} of ${run.stepCount} steps done`
      : `${doneCount} of ${input.steps.length} steps done`;
  const gate = urgentGate(input.approvals);
  const context: CaseHeaderFieldContext = { input, run, gate, progress };

  const facts: CaseHeaderFact[] = [];
  const seenLabels = new Set<string>();
  const pushFact = (label: string, value: string | null): void => {
    if (value === null || value.trim() === "" || seenLabels.has(label)) return;
    if (facts.length === HEADER_FACT_LIMIT) return;
    seenLabels.add(label);
    facts.push({ label, value: value.trim() });
  };
  for (const field of LANE_HEADER_FIELDS[input.lane]) pushFact(field.label, field.value(context));
  for (const field of [FIELD_PROGRESS, FIELD_PRIORITY, FIELD_ASSIGNEE]) {
    pushFact(field.label, field.value(context));
  }
  if (facts.length === 0) {
    facts.push({ label: "Status", value: input.ticket.status || "Unknown" });
  }

  const status =
    run !== null
      ? runStatus(run)
      : statusFromText(input.record?.status ?? input.ticket.status);

  const artifactLine = latestArtifactSummary(run);
  const lastEvent = input.record?.events.at(-1) ?? null;
  const summary =
    artifactLine ??
    (run !== null
      ? runStatePhrase(run)
      : lastEvent !== null
        ? `Latest event: ${lastEvent.kind}`
        : "No activity recorded yet");

  const fallbackStep = input.steps[0]?.id ?? null;
  const risks: CaseHeaderLink[] = [];
  if (run !== null) {
    const evidence = runEvidenceStep(run) ?? fallbackStep;
    if (run.status === "blocked" || run.steps.some((step) => step.state === "blocked")) {
      risks.push({
        label: run.lockTarget === null ? "Blocked" : `Blocked on ${run.lockTarget}`,
        detail:
          run.lockedBy === null
            ? "The target lock is held elsewhere. Retry the lock from the step panel."
            : `Held by run ${run.lockedBy.slice(0, 8)}. Retry the lock from the step panel.`,
        tone: "danger",
        stepId: evidence,
        source: `run:${run.runId}:lock`,
      });
    }
    if (run.status === "failed") {
      risks.push({
        label: "Run failed",
        detail: run.outcome ?? "The engine reported a failure.",
        tone: "danger",
        stepId: evidence,
        source: `run:${run.runId}:failed`,
      });
    }
    if (run.status === "cancelled") {
      risks.push({
        label: "Run cancelled",
        detail: run.cancelReason ?? "No reason recorded.",
        tone: "warn",
        stepId: evidence,
        source: `run:${run.runId}:cancelled`,
      });
    }
    for (const step of run.steps) {
      if (step.regenerations === 0) continue;
      risks.push({
        label: `Rework on ${step.title}`,
        detail: `Regenerated ${step.regenerations} time(s). Apply the reviewer guidance before proceeding.`,
        tone: "warn",
        stepId: step.stepId,
        source: `run:${run.runId}:${step.stepId}:rework`,
      });
    }
    for (const entry of artifactRisks(run)) {
      risks.push({
        label: entry.label,
        detail: entry.detail,
        tone: entry.tone,
        stepId: entry.stepId,
        source: `artifact:${run.runId}:${entry.stepId}`,
      });
    }
  }
  for (const approval of input.approvals) {
    if (approval.decision === "expired") {
      risks.push({
        label: "Gate expired",
        detail: `${approval.scope} expired before a decision`,
        tone: "warn",
        stepId: gateStepId(approval.scope, input.steps) ?? fallbackStep,
        source: `approval:${approval.id}`,
      });
    } else if (approval.decision === "rejected") {
      risks.push({
        label: "Gate rejected",
        detail: `${approval.scope} was rejected by ${approval.approver}`,
        tone: "danger",
        stepId: gateStepId(approval.scope, input.steps) ?? fallbackStep,
        source: `approval:${approval.id}`,
      });
    }
  }
  if (gate !== null && expiresSoon(gate.expiresAt, now)) {
    risks.push({
      label: "Gate expires soon",
      detail: `${gate.scope} expires at ${formatStamp(gate.expiresAt)}`,
      tone: "warn",
      stepId: gateStepId(gate.scope, input.steps) ?? fallbackStep,
      source: `approval:${gate.id}`,
    });
  }
  if (
    run === null &&
    input.runs.length === 0 &&
    HIGH_PRIORITIES.has(input.ticket.priority.trim().toLowerCase())
  ) {
    risks.push({
      label: "No run yet",
      detail: `${input.ticket.priority} priority ticket with no run started`,
      tone: "warn",
      stepId: fallbackStep,
      source: `ticket:${input.ticket.key}:priority`,
    });
  }

  let next: CaseHeaderLink;
  if (run !== null) {
    const stepId = runEvidenceStep(run);
    const title = runStepTitle(run, run.currentStepId ?? stepId);
    switch (run.status) {
      case "awaiting_human":
        next = {
          label: title,
          detail: "Waiting for your decision on this step",
          tone: "warn",
          stepId,
          source: `run:${run.runId}:${stepId ?? ""}`,
        };
        break;
      case "blocked":
        next = {
          label: "Retry the lock",
          detail: `Blocked on ${run.lockTarget ?? "a held target"}${run.lockedBy === null ? "" : `, held by run ${run.lockedBy.slice(0, 8)}`}`,
          tone: "danger",
          stepId,
          source: `run:${run.runId}:lock`,
        };
        break;
      case "running":
        next = {
          label: title,
          detail: "In progress now. Open the step to follow along",
          tone: "info",
          stepId,
          source: `run:${run.runId}:${stepId ?? ""}`,
        };
        break;
      case "queued":
        next = {
          label: `Waiting for ${ceilingPhrase(run)}`,
          detail:
            run.queuePosition === null
              ? run.waitingOn === null
                ? "Queued behind other runs"
                : `Queued behind other runs on ${ceilingPhrase(run)}`
              : `Queue position ${run.queuePosition}`,
          tone: "neutral",
          stepId,
          source: `run:${run.runId}:queue`,
        };
        break;
      case "failed":
        next = {
          label: "Inspect the failure",
          detail: run.outcome ?? "The engine reported a failure",
          tone: "danger",
          stepId,
          source: `run:${run.runId}:failed`,
        };
        break;
      case "cancelled":
        next = {
          label: "Review the cancellation",
          detail: run.cancelReason ?? "The run was cancelled",
          tone: "warn",
          stepId,
          source: `run:${run.runId}:cancelled`,
        };
        break;
      default:
        next = {
          label: "Review the outcome",
          detail: run.outcome ?? "Every step completed",
          tone: "ok",
          stepId: run.steps.at(-1)?.stepId ?? stepId,
          source: `run:${run.runId}:outcome`,
        };
        break;
    }
  } else if (gate !== null) {
    next = {
      label: "Decide the gate",
      detail: `${gate.scope} · ${gate.approver} must act before this gate expires`,
      tone: "warn",
      stepId: gateStepId(gate.scope, input.steps) ?? fallbackStep,
      source: `approval:${gate.id}`,
    };
  } else {
    const openIndex = input.states.findIndex(
      (state) => state === "current" || state === "awaiting" || state === "blocked",
    );
    if (openIndex !== -1) {
      const step = input.steps[openIndex];
      next = {
        label: step?.label ?? "The next step",
        detail: "The next step with no recorded evidence",
        tone: "info",
        stepId: step?.id ?? fallbackStep,
        source:
          input.record !== null
            ? `case:${input.record.id}:${step?.id ?? ""}`
            : `ticket:${input.ticket.key}:${step?.id ?? ""}`,
      };
    } else if (input.states.length > 0 && input.states.every((state) => state === "done")) {
      const last = input.steps.at(-1);
      next = {
        label: "Close out the case",
        detail: "Every step has recorded evidence",
        tone: "ok",
        stepId: last?.id ?? fallbackStep,
        source: input.record !== null ? `case:${input.record.id}:${last?.id ?? ""}` : `ticket:${input.ticket.key}`,
      };
    } else {
      next = {
        label: "Start the run",
        detail: `No run has been started for ${input.ticket.key} yet`,
        tone: "info",
        stepId: fallbackStep,
        source: `ticket:${input.ticket.key}`,
      };
    }
  }

  const receiptItems: CaseHeaderReceipt[] = [];
  let signed = 0;
  if (run !== null) {
    for (const step of run.steps) {
      if (step.receipt === null) continue;
      signed += 1;
      receiptItems.push({
        label:
          step.actionHash === null
            ? step.title
            : `${step.title} · action ${step.actionHash.slice(0, 12)}`,
        state: "signed",
        source: `run:${run.runId}:${step.stepId}:receipt`,
      });
    }
  }
  let pending = 0;
  for (const approval of input.approvals) {
    if (approval.decision === null) {
      pending += 1;
      receiptItems.push({
        label: `${approval.scope} · ${approval.approver}`,
        state: "pending",
        source: `approval:${approval.id}`,
      });
    } else if (approval.decision === "expired" || approval.decision === "rejected") {
      receiptItems.push({
        label: `${approval.scope} · ${approval.approver}`,
        state: approval.decision,
        source: `approval:${approval.id}`,
      });
    }
  }

  return {
    key: input.ticket.key,
    lane: input.lane,
    laneLabel: LANE_LABELS[input.lane],
    status,
    title: input.ticket.summary,
    summary,
    facts,
    risks: risks.slice(0, HEADER_RISK_LIMIT),
    next,
    receipts: { signed, pending, items: receiptItems.slice(0, 6) },
  };
}

export function formatCost(micro: number): string {
  const amount = micro / 1_000_000;
  return `$${amount.toFixed(micro === 0 ? 2 : 4)}`;
}

export function casePackFilename(ticketKey: string): string {
  return `case-pack-${ticketKey}.pdf`;
}

/**
 * Downloads the per-case audit pack as a PDF (U6): decisions, receipts,
 * citations, diffs, and cost from the immutable trail. Binary responses
 * cannot ride through the JSON helper, so the body becomes a blob and the
 * browser saves it under the server's filename.
 */
export async function downloadCasePack(caseId: string, ticketKey: string): Promise<void> {
  if (!apiUrl) throw new Error("NEXT_PUBLIC_API_URL is not configured");
  const auth = await sessionHeaders();
  const response = await fetch(`${apiUrl}/cases/${encodeURIComponent(caseId)}/pack?format=pdf`, {
    headers: auth,
  });
  if (!response.ok) throw new ApiError(response.status);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = casePackFilename(ticketKey);
  anchor.click();
  URL.revokeObjectURL(url);
}

function snapRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseSnapFlag(value: unknown): CaseDocSnapFlag | null {
  const record = snapRecord(value);
  if (record === null) return null;
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";
  if (code === "" || message === "") return null;
  const severity = record.severity;
  return {
    code,
    severity:
      severity === "ok" || severity === "warning" || severity === "error" ? severity : "warning",
    message,
    field: typeof record.field === "string" ? record.field : "",
  };
}

/** Validate one doc-snap draft payload; anything malformed returns null. */
export function parseCaseDocSnap(value: unknown): CaseDocSnap | null {
  const record = snapRecord(value);
  if (record === null) return null;
  const snapId = typeof record.snapId === "string" ? record.snapId : "";
  const source = snapRecord(record.source);
  if (snapId === "" || source === null) return null;
  const fields: Record<string, string> = {};
  const rawFields = snapRecord(record.fields);
  if (rawFields !== null) {
    for (const [key, entry] of Object.entries(rawFields)) {
      if (typeof entry === "string" && entry !== "") fields[key] = entry;
    }
  }
  const flags: CaseDocSnapFlag[] = [];
  if (Array.isArray(record.flags)) {
    for (const item of record.flags) {
      const flag = parseSnapFlag(item);
      if (flag !== null) flags.push(flag);
    }
  }
  return {
    snapId,
    docType: typeof record.docType === "string" ? record.docType : "unknown",
    source: {
      filename: typeof source.filename === "string" ? source.filename : "",
      contentType: typeof source.contentType === "string" ? source.contentType : "",
      sha256: typeof source.sha256 === "string" ? source.sha256 : "",
      bytes: typeof source.bytes === "number" ? source.bytes : 0,
    },
    fields,
    flags,
    extractor: typeof record.extractor === "string" ? record.extractor : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
  };
}

/**
 * Snaps one document onto the case trail (U7) and returns the draft the
 * server built: extracted fields plus validation flags. The snap itself
 * posts nothing — its values become a change only through the normal edit
 * decision and its receipt gate.
 */
export async function snapCaseDocument(
  caseId: string,
  request: CaseDocSnapRequest,
): Promise<CaseDocSnap | null> {
  const payload = await api<unknown>(`/cases/${encodeURIComponent(caseId)}/doc-snaps`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  return parseCaseDocSnap(payload);
}

/** The case's snap drafts, newest first; malformed entries are skipped. */
export async function listCaseDocSnaps(caseId: string): Promise<CaseDocSnap[]> {
  const payload = await api<unknown>(`/cases/${encodeURIComponent(caseId)}/doc-snaps`);
  const record = snapRecord(payload);
  if (record === null || !Array.isArray(record.docSnaps)) return [];
  const drafts: CaseDocSnap[] = [];
  for (const item of record.docSnaps) {
    const draft = parseCaseDocSnap(item);
    if (draft !== null) drafts.push(draft);
  }
  return drafts;
}

/**
 * Reads one picked file into the base64 snap request the API expects
 * (``FileReader`` keeps older embedded browsers working; the data-URL
 * prefix is stripped so only the content is sent).
 */
export function fileToSnapRequest(file: File): Promise<CaseDocSnapRequest> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve({
        filename: file.name,
        contentType: file.type !== "" ? file.type : "application/octet-stream",
        contentBase64: comma >= 0 ? result.slice(comma + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Collect HTTPS links from a case payload so the results panel can surface
 * PR / post / ticket references without trusting arbitrary strings as URLs.
 */
export function collectHttpsLinks(value: unknown, limit = 10): string[] {
  const links: string[] = [];
  const visit = (node: unknown): void => {
    if (links.length >= limit) return;
    if (typeof node === "string") {
      try {
        const url = new URL(node);
        if (url.protocol === "https:" && !links.includes(url.toString())) {
          links.push(url.toString());
        }
      } catch {
        // Not a URL; plain text stays text.
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(value);
  return links;
}
