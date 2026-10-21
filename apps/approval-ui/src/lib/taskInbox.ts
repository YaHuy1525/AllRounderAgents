import type { RunStatus, RunSummary, RunTopology } from "./runs";

/**
 * The U4 task inbox derives cross-ticket cards from the runs that already wait
 * on a human: gates (`awaiting_human`) and stalls (`blocked`). Confirm and
 * Reject post through `decideRunStep` — the inbox adds no execution path of
 * its own; every derivation here stays pure so the queue shape is testable.
 */

export type InboxTaskStatus = "awaiting_human" | "blocked";

export function isInboxTaskStatus(status: RunStatus): status is InboxTaskStatus {
  return status === "awaiting_human" || status === "blocked";
}

export const INBOX_STATUS_COPY: Record<InboxTaskStatus, string> = {
  awaiting_human: "Awaiting you",
  blocked: "Blocked",
};

export type InboxTask = {
  runId: string;
  workflow: string;
  ticketKey: string;
  status: InboxTaskStatus;
  stepId: string | null;
  /** Topology step title; null while the overlay is missing or unreadable. */
  stepTitle: string | null;
  stepsDone: number;
  stepCount: number;
  startedAt: string;
  /** When the current step entered its state (step `updatedAt`), else the run start. */
  waitingSince: string;
  /** Signed receipts so far — a run partway through shows partial proof. */
  receipts: number;
  lockTarget: string | null;
  lockedBy: string | null;
};

/**
 * One run summary plus its N1 topology overlay, as an inbox card. Returns null
 * for every status the inbox does not carry, so callers can map a full list
 * without pre-filtering.
 */
export function buildInboxTask(
  summary: RunSummary,
  topology: RunTopology | null,
): InboxTask | null {
  if (!isInboxTaskStatus(summary.status)) return null;
  const stepId = topology?.currentStepId ?? summary.currentStepId;
  const step =
    stepId === null || topology === null
      ? null
      : topology.steps.find((item) => item.stepId === stepId) ?? null;
  return {
    runId: summary.runId,
    workflow: summary.workflow,
    ticketKey: summary.ticketKey,
    status: summary.status,
    stepId,
    stepTitle: step?.title ?? null,
    stepsDone: topology?.stepsDone ?? summary.stepsDone,
    stepCount: topology?.stepCount ?? summary.stepCount,
    startedAt: summary.startedAt,
    waitingSince: step !== null && step.updatedAt !== "" ? step.updatedAt : summary.startedAt,
    receipts: topology?.receipts.signed ?? 0,
    lockTarget: topology?.lock?.target ?? null,
    lockedBy: topology?.lock?.lockedBy ?? null,
  };
}

/** All inbox cards for a page of summaries; unknown statuses and dupes drop. */
export function buildInboxTasks(
  runs: readonly RunSummary[],
  topologies: ReadonlyMap<string, RunTopology>,
): InboxTask[] {
  const tasks: InboxTask[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.runId)) continue;
    const task = buildInboxTask(run, topologies.get(run.runId) ?? null);
    if (task === null) continue;
    seen.add(run.runId);
    tasks.push(task);
  }
  return tasks;
}

/** Awaiting gates outrank blocked stalls — the lead decides before unblocking. */
const PRIORITY: Record<InboxTaskStatus, number> = { awaiting_human: 0, blocked: 1 };

function waitingTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Supervisor order: awaiting gates first, then blocked stalls, and inside each
 * group the oldest wait on top — the stalled card is the one to look at. The
 * run id tie-break keeps the sort deterministic; unreadable timestamps sort
 * last inside their group.
 */
export function compareInboxTasks(left: InboxTask, right: InboxTask): number {
  const rank = PRIORITY[left.status] - PRIORITY[right.status];
  if (rank !== 0) return rank;
  const leftTime = waitingTime(left.waitingSince);
  const rightTime = waitingTime(right.waitingSince);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

export function sortInboxTasks(tasks: readonly InboxTask[]): InboxTask[] {
  return [...tasks].sort(compareInboxTasks);
}

/** Seconds the current gate has been waiting; null when the timestamp is unreadable. */
export function waitingSeconds(task: InboxTask, now: number): number | null {
  const parsed = Date.parse(task.waitingSince);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / 1000));
}

/** Compact wait copy: "<1m", "42m", "3h 12m", "2d 5h". */
export function formatWait(seconds: number): string {
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/** The card's clock line; an unreadable timestamp degrades to a bare "waiting". */
export function waitLabel(task: InboxTask, now: number): string {
  const seconds = waitingSeconds(task, now);
  return seconds === null ? "waiting" : `waiting ${formatWait(seconds)}`;
}
