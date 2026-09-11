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

export type LaneId = "generic" | "support" | "coding" | "finance";

export type LaneStep = { id: string; label: string; kinds: string[] };

export type StepState = "done" | "current" | "future";

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

/**
 * Lane step sequences, mirrored from the Mastra workflows in src/mastra:
 * support runs intake -> retrieval -> draft -> validation -> gate -> send,
 * coding adds an environment selection stage, and finance reconciles before
 * its audit and gate. Lanes only ever render the steps they actually have.
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
};

export function laneForDomain(domain: string): LaneId {
  const normalized = domain.trim().toLowerCase();
  if (normalized.includes("support")) return "support";
  if (normalized.includes("finance")) return "finance";
  if (normalized.includes("cod") || normalized.includes("program") || normalized.includes("dev")) {
    return "coding";
  }
  return "generic";
}

export function inferLane(ticket: { summary: string; labels: string[] }): LaneId {
  const text = `${ticket.summary} ${ticket.labels.join(" ")}`.toLowerCase();
  if (text.includes("support")) return "support";
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
