import { api } from "./api";
import type { Approval } from "./models";

/**
 * Browser-side model for the console metrics summary (`GET /metrics/summary`).
 * The endpoint condenses the Prometheus registry into a small JSON document:
 * terminal runs by workflow and status, human decision counters, live queue
 * depth, and HTTP latency percentiles. The raw exposition at `/metrics`
 * stays available for scrapers (the console links out to it).
 */

export type MetricsRuns = {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  successRate: number | null;
};

export type WorkflowMetrics = {
  workflow: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
};

export type LatencyStats = {
  count: number;
  p50: number | null;
  p95: number | null;
};

export type RouteLatency = LatencyStats & { route: string };

export type MetricsQueue = {
  active: number;
  queued: number;
  running: number;
  awaitingHuman: number;
  blocked: number;
};

export type MetricsSummary = {
  generatedAt: string;
  runs: MetricsRuns;
  workflows: WorkflowMetrics[];
  decisions: Record<string, number>;
  queue: MetricsQueue;
  latency: { overall: LatencyStats; http: RouteLatency[] };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Returns undefined when malformed, null only when explicitly null. */
function nullableCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return asCount(value) ?? undefined;
}

function sanitizeRuns(value: unknown): MetricsRuns | null {
  const record = asRecord(value);
  if (!record) return null;
  const total = asCount(record.total);
  const completed = asCount(record.completed);
  const failed = asCount(record.failed);
  const cancelled = asCount(record.cancelled);
  const successRate = nullableCount(record.successRate);
  if (
    total === null ||
    completed === null ||
    failed === null ||
    cancelled === null ||
    successRate === undefined
  ) {
    return null;
  }
  return { total, completed, failed, cancelled, successRate };
}

/** One malformed workflow row is dropped, never the whole payload. */
function sanitizeWorkflowRow(value: unknown): WorkflowMetrics | null {
  const record = asRecord(value);
  if (!record) return null;
  const total = asCount(record.total);
  const completed = asCount(record.completed);
  const failed = asCount(record.failed);
  const cancelled = asCount(record.cancelled);
  if (
    total === null ||
    completed === null ||
    failed === null ||
    cancelled === null ||
    typeof record.workflow !== "string" ||
    record.workflow === ""
  ) {
    return null;
  }
  return { workflow: record.workflow, total, completed, failed, cancelled };
}

function sanitizeQueue(value: unknown): MetricsQueue | null {
  const record = asRecord(value);
  if (!record) return null;
  const active = asCount(record.active);
  const queued = asCount(record.queued);
  const running = asCount(record.running);
  const awaitingHuman = asCount(record.awaitingHuman);
  const blocked = asCount(record.blocked);
  if (
    active === null ||
    queued === null ||
    running === null ||
    awaitingHuman === null ||
    blocked === null
  ) {
    return null;
  }
  return { active, queued, running, awaitingHuman, blocked };
}

function sanitizeLatencyStats(value: unknown): LatencyStats | null {
  const record = asRecord(value);
  if (!record) return null;
  const count = asCount(record.count);
  const p50 = nullableCount(record.p50);
  const p95 = nullableCount(record.p95);
  if (count === null || p50 === undefined || p95 === undefined) return null;
  return { count, p50, p95 };
}

/** Decisions come as a bounded counter map; malformed entries are dropped. */
function sanitizeDecisions(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const decisions: Record<string, number> = {};
  for (const [action, count] of Object.entries(record)) {
    const parsed = asCount(count);
    if (parsed !== null && action !== "") decisions[action] = parsed;
  }
  return decisions;
}

export function sanitizeMetricsSummary(value: unknown): MetricsSummary | null {
  const record = asRecord(value);
  if (!record || typeof record.generatedAt !== "string") return null;
  const runs = sanitizeRuns(record.runs);
  const queue = sanitizeQueue(record.queue);
  const latency = asRecord(record.latency);
  const overall = latency ? sanitizeLatencyStats(latency.overall) : null;
  if (!runs || !queue || !overall || !latency) return null;
  const rawRoutes = Array.isArray(latency.http) ? latency.http : [];
  const routes: RouteLatency[] = [];
  for (const item of rawRoutes) {
    const stats = sanitizeLatencyStats(item);
    const row = asRecord(item);
    if (stats === null || !row || typeof row.route !== "string" || row.route === "") continue;
    routes.push({ route: row.route, ...stats });
  }
  const rawWorkflows = Array.isArray(record.workflows) ? record.workflows : [];
  const workflows: WorkflowMetrics[] = [];
  for (const item of rawWorkflows) {
    const row = sanitizeWorkflowRow(item);
    if (row !== null) workflows.push(row);
  }
  return {
    generatedAt: record.generatedAt,
    runs,
    workflows,
    decisions: sanitizeDecisions(record.decisions),
    queue,
    latency: { overall, http: routes },
  };
}

export async function getMetricsSummary(): Promise<MetricsSummary> {
  const payload = await api<unknown>("/metrics/summary");
  const summary = sanitizeMetricsSummary(payload);
  if (summary === null) throw new Error("Unexpected metrics summary payload");
  return summary;
}

/** Latency in seconds → compact display ("48ms", "1.24s"); "—" when unknown. */
export function formatLatency(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(2)}s`;
}

/** Success rate (0..1) → percent display ("75%", "98.7%"); "—" when unknown. */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  const percent = rate * 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

export type DecisionHistoryRow = {
  id: string;
  scope: string;
  approver: string;
  decision: "approved" | "rejected" | "expired";
  comment: string | null;
  decidedAt: string;
};

/**
 * Decided approvals as a read-only audit list, newest first. Undecided
 * approvals (still waiting on a human) and undated rows are skipped; ISO
 * timestamps compare lexicographically.
 */
export function decisionHistory(approvals: ReadonlyArray<Approval>): DecisionHistoryRow[] {
  const rows: DecisionHistoryRow[] = [];
  for (const approval of approvals) {
    if (approval.decision === null || approval.decidedAt === null) continue;
    rows.push({
      id: approval.id,
      scope: approval.scope,
      approver: approval.approver,
      decision: approval.decision,
      comment: approval.comment,
      decidedAt: approval.decidedAt,
    });
  }
  return rows.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
}
