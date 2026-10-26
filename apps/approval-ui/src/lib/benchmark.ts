import { api } from "./api";
import { formatRate } from "./metrics";

/**
 * Browser-side model for `GET /metrics/benchmark`, which folds the durable
 * `run_archive` mirror into per-lane approval funnels, pass rates with
 * cost-per-pass, and the A7 self-correction counters. The numbers survive a
 * console restart because they come from archived runs, not Prometheus counters.
 * Like `metrics.ts`, the sanitizer drops malformed rows instead of failing.
 */

const SELF_CORRECTION_KEYS = [
  "repairApplied",
  "criticBlocked",
  "doomLoopStops",
  "validationAttempts",
  "checksRun",
] as const;

export type BenchmarkSelfCorrection = {
  repairApplied: number;
  criticBlocked: number;
  doomLoopStops: number;
  validationAttempts: number;
  checksRun: number;
};

export type BenchmarkStep = {
  stepId: string;
  title: string;
  gates: number;
  approvals: number;
  retries: number;
  stops: number;
  revisits: number;
  approvalRate: number | null;
};

export type BenchmarkLane = {
  workflow: string;
  title: string;
  terminalRuns: number;
  passes: number;
  passRate: number | null;
  costUsdMicro: number;
  costPerPassUsdMicro: number | null;
  gateReceipts: number;
  selfCorrection: BenchmarkSelfCorrection;
  steps: BenchmarkStep[];
};

export type BenchmarkTotals = {
  terminalRuns: number;
  passes: number;
  passRate: number | null;
  costUsdMicro: number;
  costPerPassUsdMicro: number | null;
  gateReceipts: number;
  selfCorrection: BenchmarkSelfCorrection;
};

export type BenchmarkSummary = {
  generatedAt: string;
  laneScope: string[];
  lanes: BenchmarkLane[];
  totals: BenchmarkTotals;
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The A7 counters are optional in the archive scan: a lane that has not
 * exercised them reports zero. Missing or malformed keys default to 0 rather
 * than dropping the lane, keeping the panel whole.
 */
function sanitizeSelfCorrection(value: unknown): BenchmarkSelfCorrection {
  const record = asRecord(value);
  const corrected: BenchmarkSelfCorrection = {
    repairApplied: 0,
    criticBlocked: 0,
    doomLoopStops: 0,
    validationAttempts: 0,
    checksRun: 0,
  };
  if (!record) return corrected;
  for (const key of SELF_CORRECTION_KEYS) {
    const count = asCount(record[key]);
    if (count !== null) corrected[key] = count;
  }
  return corrected;
}

/** One malformed step row is dropped, never the lane or the payload. */
function sanitizeStepRow(value: unknown): BenchmarkStep | null {
  const record = asRecord(value);
  if (!record) return null;
  const stepId = asString(record.stepId);
  const title = asString(record.title);
  const gates = asCount(record.gates);
  const approvals = asCount(record.approvals);
  const retries = asCount(record.retries);
  const stops = asCount(record.stops);
  const revisits = asCount(record.revisits);
  const approvalRate = nullableCount(record.approvalRate);
  if (
    stepId === null ||
    title === null ||
    gates === null ||
    approvals === null ||
    retries === null ||
    stops === null ||
    revisits === null ||
    approvalRate === undefined
  ) {
    return null;
  }
  return { stepId, title, gates, approvals, retries, stops, revisits, approvalRate };
}

/** A malformed lane row is dropped; the remaining lanes still render. */
function sanitizeLane(value: unknown): BenchmarkLane | null {
  const record = asRecord(value);
  if (!record) return null;
  const workflow = asString(record.workflow);
  const title = asString(record.title);
  const terminalRuns = asCount(record.terminalRuns);
  const passes = asCount(record.passes);
  const passRate = nullableCount(record.passRate);
  const costUsdMicro = asCount(record.costUsdMicro);
  const costPerPassUsdMicro = nullableCount(record.costPerPassUsdMicro);
  const gateReceipts = asCount(record.gateReceipts);
  if (
    workflow === null ||
    title === null ||
    terminalRuns === null ||
    passes === null ||
    passRate === undefined ||
    costUsdMicro === null ||
    costPerPassUsdMicro === undefined ||
    gateReceipts === null
  ) {
    return null;
  }
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps: BenchmarkStep[] = [];
  for (const item of rawSteps) {
    const row = sanitizeStepRow(item);
    if (row !== null) steps.push(row);
  }
  return {
    workflow,
    title,
    terminalRuns,
    passes,
    passRate,
    costUsdMicro,
    costPerPassUsdMicro,
    gateReceipts,
    selfCorrection: sanitizeSelfCorrection(record.selfCorrection),
    steps,
  };
}

function sanitizeTotals(value: unknown): BenchmarkTotals | null {
  const record = asRecord(value);
  if (!record) return null;
  const terminalRuns = asCount(record.terminalRuns);
  const passes = asCount(record.passes);
  const passRate = nullableCount(record.passRate);
  const costUsdMicro = asCount(record.costUsdMicro);
  const costPerPassUsdMicro = nullableCount(record.costPerPassUsdMicro);
  const gateReceipts = asCount(record.gateReceipts);
  if (
    terminalRuns === null ||
    passes === null ||
    passRate === undefined ||
    costUsdMicro === null ||
    costPerPassUsdMicro === undefined ||
    gateReceipts === null
  ) {
    return null;
  }
  return {
    terminalRuns,
    passes,
    passRate,
    costUsdMicro,
    costPerPassUsdMicro,
    gateReceipts,
    selfCorrection: sanitizeSelfCorrection(record.selfCorrection),
  };
}

export function sanitizeBenchmark(value: unknown): BenchmarkSummary | null {
  const record = asRecord(value);
  if (!record || typeof record.generatedAt !== "string") return null;
  const totals = sanitizeTotals(record.totals);
  if (!totals) return null;
  const laneScope = Array.isArray(record.laneScope)
    ? record.laneScope.filter((item): item is string => typeof item === "string")
    : [];
  const rawLanes = Array.isArray(record.lanes) ? record.lanes : [];
  const lanes: BenchmarkLane[] = [];
  for (const item of rawLanes) {
    const lane = sanitizeLane(item);
    if (lane !== null) lanes.push(lane);
  }
  return { generatedAt: record.generatedAt, laneScope, lanes, totals };
}

export async function getBenchmark(): Promise<BenchmarkSummary> {
  const payload = await api<unknown>("/metrics/benchmark");
  const summary = sanitizeBenchmark(payload);
  if (summary === null) throw new Error("Unexpected benchmark payload");
  return summary;
}

/**
 * Micro-US dollars → a compact money string. µUSD keeps the backend exact
 * (no float drift on tiny LLM costs); the panel shows dollars above a cent and
 * raw µUSD below, so a $0.0042 cost stays legible instead of rounding to "$0".
 */
export function formatMicroUsd(microUsd: number | null): string {
  if (microUsd === null) return "—";
  if (microUsd === 0) return "$0.00";
  const dollars = microUsd / 1_000_000;
  if (dollars >= 0.01) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.0001) return `$${dollars.toFixed(4)}`;
  return `${Math.round(microUsd)}µUSD`;
}

export { formatRate };
