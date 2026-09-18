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
 * Lane step sequences, mirrored from the Mastra workflows in src/mastra:
 * support runs intake -> retrieval -> draft -> validation -> gate -> send,
 * coding adds an environment selection stage, finance reconciles before
 * its audit and gate, the review lane follows the `review` run definition
 * (select-pr -> review-options -> ai-review -> complete), the issues lane
 * follows the `issues` run definition (issue-selection -> analysis ->
 * implementation -> complete), the features lane follows the `features`
 * run definition (feature-selection -> scope-design -> implementation ->
 * complete), and the dependencies lane follows the `dependencies` run
 * definition (scan -> group -> apply -> validate -> merge). The accessibility
 * lane follows the `accessibility` run definition (crawl -> violations ->
 * fix -> re-scan), the vendors lane follows the `vendors` run definition
 * (collect -> verify -> risk-score -> approve -> create), the leave lane
 * follows the `leave` run definition (intake -> policy-check -> approve ->
 * apply), and the onboarding lane follows the `onboarding` run definition
 * (collect -> verify -> risk-score -> approve -> provision). The offboarding
 * lane follows the `offboarding` run definition (intake -> access-audit ->
 * approve -> revoke -> attest), the screening lane follows the
 * `screening` run definition (requisition -> screen -> shortlist ->
 * schedule), and the hr-help lane follows the `hr-help` run definition
 * (intake -> retrieve -> draft -> approve -> send). Lanes only ever
 * render the steps they actually have.
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

export function formatCost(micro: number): string {
  const amount = micro / 1_000_000;
  return `$${amount.toFixed(micro === 0 ? 2 : 4)}`;
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
