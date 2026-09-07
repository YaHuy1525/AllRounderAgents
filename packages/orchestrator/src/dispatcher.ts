import { createHash } from "node:crypto";

import {
  type Domain,
  type Gate,
  type RiskScore,
  RiskScoreSchema,
  type Ticket,
  TicketSchema,
  type TriageVerdict,
  TriageVerdictSchema,
} from "./contracts.js";

export interface RequestContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly actor: string;
}

export interface ExecuteInput {
  readonly inputData: unknown;
  readonly context: RequestContext;
}

export interface WorkflowStep {
  readonly id: "normalize" | "triage" | "preflight" | "route";
}

export interface DispatchResult {
  readonly ticket: Ticket;
  readonly verdict: TriageVerdict;
  readonly riskScores: readonly RiskScore[];
  readonly gate: Gate;
  readonly workflow: { readonly domain: Domain; readonly kind: "comment-only" };
  readonly comment: string;
}

export type TriageProvider = (ticket: Ticket, context: RequestContext) => Promise<unknown>;

export interface DispatcherOptions {
  readonly triage?: TriageProvider;
}

const domainTerms: Readonly<Record<Exclude<Domain, "unknown">, ReadonlySet<string>>> = {
  code: new Set(["bug", "code", "api", "compiler", "typescript", "build", "ci", "500"]),
  finance: new Set([
    "finance",
    "invoice",
    "ledger",
    "journal",
    "reconcile",
    "audit",
    "erp",
    "bank",
  ]),
  marketing: new Set([
    "marketing",
    "campaign",
    "brand",
    "newsletter",
    "social",
    "launch",
    "copy",
  ]),
  support: new Set([
    "support",
    "customer",
    "login",
    "password",
    "refund",
    "account",
    "faq",
    "help",
  ]),
};

const projectDomains: Readonly<Record<string, Exclude<Domain, "unknown">>> = {
  ENG: "code",
  FIN: "finance",
  MKT: "marketing",
  SUP: "support",
};

const steps = [
  { id: "normalize" },
  { id: "triage" },
  { id: "preflight" },
  { id: "route" },
] as const satisfies readonly WorkflowStep[];

export function createDispatcher(options: DispatcherOptions = {}) {
  return {
    steps,
    async execute(input: ExecuteInput): Promise<DispatchResult> {
      const ticket = normalizeJiraPayload(input.inputData);
      let verdict: TriageVerdict;
      try {
        verdict = options.triage
          ? TriageVerdictSchema.parse(await options.triage(ticket, input.context))
          : deterministicTriage(ticket);
      } catch {
        verdict = safeFallbackVerdict(ticket);
      }
      const riskScores = [preflight("jira_comment")];
      const riskGate = riskScores.reduce<Gate>(
        (highest, risk) => (gateRank(risk.gate) > gateRank(highest) ? risk.gate : highest),
        "auto",
      );
      const gate: Gate = verdict.needsHuman && riskGate === "auto" ? "approval" : riskGate;
      return {
        ticket,
        verdict,
        riskScores,
        gate,
        workflow: { domain: verdict.domain, kind: "comment-only" },
        comment:
          verdict.domain === "unknown"
            ? `Escalated to a human because the ticket could not be routed safely. ${verdict.rationale}`
            : `Routed to the ${verdict.domain} comment-only workflow. No external action was performed. ${verdict.rationale}`,
      };
    },
  };
}

export function normalizeJiraPayload(payload: unknown): Ticket {
  const root = asRecord(payload);
  const issue = asRecord(root.issue);
  const fields = asRecord(issue.fields);
  const project = asRecord(fields.project);
  const issueType = asRecord(fields.issuetype);
  const priority = asRecord(fields.priority);
  const reporter = asRecord(fields.reporter);
  const timestamp = asFiniteNumber(root.timestamp);
  const key = asString(issue.key);
  const eventSeed = `${asString(root.webhookEvent)}:${key}:${timestamp}`;
  const attachments = asArray(fields.attachment).map((item) => {
    const attachment = asRecord(item);
    return {
      id: asString(attachment.id),
      name: asString(attachment.filename ?? attachment.name),
      mime: asString(attachment.mimeType ?? attachment.mime ?? "application/octet-stream"),
      bytes: asFiniteNumber(attachment.size ?? attachment.bytes ?? 0),
    };
  });

  return TicketSchema.parse({
    key,
    project: asString(project.key),
    issueType: asString(issueType.name),
    labels: asArray(fields.labels).map(asString),
    priority: asString(priority.name ?? "Medium"),
    summary: asString(fields.summary),
    description:
      typeof fields.description === "string"
        ? fields.description
        : fields.description == null
          ? ""
          : JSON.stringify(fields.description),
    reporter: asString(reporter.accountId ?? reporter.displayName ?? "unknown"),
    attachments,
    eventId: createHash("sha256").update(eventSeed).digest("hex"),
    receivedAt: new Date(timestamp).toISOString(),
  });
}

function deterministicTriage(ticket: Ticket): TriageVerdict {
  const tokens = new Set(
    [
      ticket.project,
      ticket.issueType,
      ticket.summary,
      ticket.description,
      ...ticket.labels,
    ]
      .join(" ")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [],
  );
  const scores = Object.entries(domainTerms).map(([domain, terms]) => {
    let score = [...terms].filter((term) => tokens.has(term)).length;
    if (projectDomains[ticket.project] === domain) {
      score += 3;
    }
    return [domain as Exclude<Domain, "unknown">, score] as const;
  });
  const [domain, score] = scores.reduce((best, current) =>
    current[1] > best[1] ? current : best,
  );
  if (score === 0) {
    return safeFallbackVerdict(ticket);
  }
  const confidence = Math.min(0.99, 0.55 + score * 0.08);
  return TriageVerdictSchema.parse({
    domain,
    confidence,
    urgency: urgency(ticket.priority),
    needsHuman: confidence < 0.7,
    rationale: `Matched ${score} deterministic project or content signals for ${domain}.`,
  });
}

function safeFallbackVerdict(ticket: Ticket): TriageVerdict {
  return {
    domain: "unknown",
    confidence: 0,
    urgency: urgency(ticket.priority),
    needsHuman: true,
    rationale: "No domain had sufficient evidence or the triage provider failed; escalate with context.",
  };
}

function preflight(action: string): RiskScore {
  const lowered = action.toLowerCase();
  const irreversible = ["irreversible", "payment", "delete", "publish"].some((term) =>
    lowered.includes(term),
  );
  const highBlast = ["production", "global", "payment", "publish"].some((term) =>
    lowered.includes(term),
  );
  const score = irreversible && highBlast ? 90 : irreversible || highBlast ? 55 : 10;
  return RiskScoreSchema.parse({
    action,
    blastRadius: highBlast ? "high" : "low",
    reversibility: irreversible ? "irreversible" : "reversible",
    score,
    gate: score >= 80 ? "refuse" : score >= 40 ? "approval" : "auto",
    reasons: ["Phase 0 deterministic risk policy"],
  });
}

function urgency(priority: Ticket["priority"]): number {
  return { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 }[priority] ?? 3;
}

function gateRank(gate: Gate): number {
  return { auto: 0, approval: 1, refuse: 2 }[gate];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function asFiniteNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError("Expected a finite number");
  }
  return number;
}
