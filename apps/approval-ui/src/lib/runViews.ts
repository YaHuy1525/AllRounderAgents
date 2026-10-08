import { formatCost, type CaseEvent } from "./cases";
import {
  formatDuration,
  runDurationSeconds,
  type RunDetail,
  type RunEvent,
  type RunStatus,
  type RunStep,
} from "./runs";

/**
 * Pure derivations shared by the run inspector's lenses: log filters, the
 * artifact → decision → receipt lineage, the by-time case/run merge, and the
 * spend footer. One module keeps the five lenses on one vocabulary and the
 * behavior trivially testable.
 */

export type LogFilterId = "all" | "lifecycle" | "decisions" | "locks";

export const LOG_FILTERS: ReadonlyArray<{ id: LogFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "decisions", label: "Decisions" },
  { id: "locks", label: "Locks" },
];

/**
 * Which SSE event types each chip keeps. `run.closed` rides along with the
 * lifecycle because it is the stream's own end marker.
 */
const LOG_FILTER_TYPES: Record<Exclude<LogFilterId, "all">, readonly string[]> = {
  lifecycle: ["run.created", "run.queued", "run.status", "run.suspended", "run.closed"],
  decisions: ["run.decision"],
  locks: ["run.locked", "run.unlocked"],
};

/** The Logs lens stream for one chip; "all" returns the stream unchanged. */
export function filterRunEvents(events: readonly RunEvent[], filter: LogFilterId): RunEvent[] {
  if (filter === "all") return [...events];
  const types = LOG_FILTER_TYPES[filter];
  return events.filter((event) => types.includes(event.type));
}

export type StepLineageLink = {
  id: "artifact" | "decision" | "receipt";
  label: string;
  on: boolean;
};

/** The artifact → decision → receipt trail of one step, as three chips. */
export function stepLineage(
  step: Pick<RunStep, "artifact" | "decision" | "receipt">,
): StepLineageLink[] {
  return [
    { id: "artifact", label: "Artifact", on: step.artifact !== null },
    { id: "decision", label: "Decision", on: step.decision !== null },
    { id: "receipt", label: "Receipt", on: step.receipt !== null },
  ];
}

/** Graph overlay: step id → true when the step carries a signed receipt. */
export function receiptFlags(
  steps: readonly Pick<RunStep, "stepId" | "receipt">[],
): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const step of steps) {
    if (step.receipt !== null) flags[step.stepId] = true;
  }
  return flags;
}

export type TimelineEntryKind = "case" | "run" | "step";

export type TimelineEntry = {
  id: string;
  /** ISO timestamp; always parseable — unparseable rows are dropped. */
  at: string;
  kind: TimelineEntryKind;
  title: string;
  detail: string;
};

type TimelineRun = {
  workflow: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  steps: ReadonlyArray<Pick<RunStep, "stepId" | "title" | "state" | "updatedAt">>;
};

function parseableTimestamp(value: string): string | null {
  if (value === "" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function caseEventTitle(event: CaseEvent): string {
  const title = event.kind.replace(/[._-]+/g, " ").trim();
  return title === "" ? "Case event" : title;
}

/**
 * Merge the case's event trail with the run's own milestones (start, finish,
 * touched steps) into one chronological list — oldest first, matching how the
 * sequence stream reads. Run SSE events carry no timestamps, so they stay in
 * the raw stream; the merge leans on `created_at` and each step's `updatedAt`.
 * The sort is stable, so same-timestamp entries keep insertion order.
 */
export function mergeTimeline(input: {
  caseEvents: readonly CaseEvent[];
  run: TimelineRun | null;
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  input.caseEvents.forEach((event, index) => {
    const at = parseableTimestamp(event.created_at);
    if (at === null) return;
    entries.push({
      id: `case:${index}`,
      at,
      kind: "case",
      title: caseEventTitle(event),
      detail: event.actor === "" ? "case" : `case · ${event.actor}`,
    });
  });
  const run = input.run;
  if (run !== null) {
    const started = parseableTimestamp(run.startedAt);
    if (started !== null) {
      entries.push({
        id: "run:started",
        at: started,
        kind: "run",
        title: "Run started",
        detail: run.workflow,
      });
    }
    for (const step of run.steps) {
      const at = parseableTimestamp(step.updatedAt);
      if (at === null) continue;
      // Untouched steps still carry the snapshot's clock; skip them so the
      // list reads as a story rather than a step inventory.
      if (step.state === "pending") continue;
      entries.push({
        id: `step:${step.stepId}`,
        at,
        kind: "step",
        title: step.title,
        detail: step.state,
      });
    }
    if (run.finishedAt !== null) {
      const finished = parseableTimestamp(run.finishedAt);
      if (finished !== null) {
        entries.push({
          id: "run:finished",
          at: finished,
          kind: "run",
          title: "Run finished",
          detail: run.status,
        });
      }
    }
  }
  return entries.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * The spend footer shared by the Logs and Timeline lenses: case cost (when a
 * case record is at hand) plus elapsed run time.
 */
export function runSpendLine(
  run: Pick<RunDetail, "startedAt" | "finishedAt"> | null,
  costMicro: number | null,
  now: number = Date.now(),
): string {
  const duration = run === null ? null : runDurationSeconds(run, now);
  const cost = costMicro === null ? "Cost not recorded" : `Cost ${formatCost(costMicro)}`;
  const elapsed = duration === null ? "Elapsed —" : `Elapsed ${formatDuration(duration)}`;
  return `${cost} · ${elapsed}`;
}
