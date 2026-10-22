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

export type TimelineEntryKind = "case" | "run" | "step" | "decision" | "github";

export type TimelineEntry = {
  id: string;
  /** ISO timestamp; always parseable — unparseable rows are dropped. */
  at: string;
  kind: TimelineEntryKind;
  title: string;
  detail: string;
  /** External link for trail-derived rows (the PR behind a GitHub row). */
  href: string | null;
};

export type TimelineStep = Pick<RunStep, "stepId" | "title" | "state" | "updatedAt"> &
  Partial<Pick<RunStep, "decision" | "artifact">>;

export type TimelineRun = {
  /** Scopes row ids and labels them when one ticket merges several runs. */
  runId?: string;
  workflow: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  steps: ReadonlyArray<TimelineStep>;
};

const GITHUB_PULL_RE = /^https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\/?$/;

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function parseableTimestamp(value: string): string | null {
  if (value === "" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function caseEventTitle(event: CaseEvent): string {
  const title = event.kind.replace(/[._-]+/g, " ").trim();
  return title === "" ? "Case event" : title;
}

/** The decision's own clock, when it recorded one; regenerate rows carry none. */
function decisionTimestamp(decision: Record<string, unknown>): string | null {
  const value = decision.decidedAt;
  return typeof value === "string" ? parseableTimestamp(value) : null;
}

function decisionDetail(decision: Record<string, unknown>): string {
  const action =
    typeof decision.action === "string" && decision.action !== "" ? decision.action : "decision";
  const approver =
    typeof decision.approver === "string" && decision.approver !== "" ? decision.approver : null;
  return approver === null ? action : `${action} · ${approver}`;
}

function pullDetail(item: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof item.branch === "string" && item.branch !== "") parts.push(item.branch);
  if (item.draft === true) parts.push("draft");
  return parts.length === 0 ? "pull request" : parts.join(" · ");
}

function walkPullReferences(
  value: unknown,
  visit: (url: string, item: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkPullReferences(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.url === "string") visit(record.url, record);
  for (const item of Object.values(record)) walkPullReferences(item, visit);
}

/**
 * Every GitHub pull request the trail references, one row per URL. Lane
 * artifacts carry PR refs as `{url, branch, draft, ...}` (no dedicated checks
 * feed exists), so the walk surfaces them under the recording step's clock;
 * a URL sighted twice keeps its earliest clock.
 */
export function githubPullEvents(runs: ReadonlyArray<TimelineRun>): TimelineEntry[] {
  const found = new Map<string, TimelineEntry>();
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.artifact === undefined || step.artifact === null) continue;
      const at = parseableTimestamp(step.updatedAt);
      if (at === null) continue;
      walkPullReferences(step.artifact, (url, item) => {
        const match = GITHUB_PULL_RE.exec(url);
        if (match === null) return;
        const href = url.replace(/\/+$/, "");
        const key = href.toLowerCase();
        const existing = found.get(key);
        if (existing !== undefined && Date.parse(existing.at) <= Date.parse(at)) return;
        found.set(key, {
          id: `github:${key}`,
          at,
          kind: "github",
          title: `PR #${match[1]}`,
          detail: pullDetail(item),
          href,
        });
      });
    }
  }
  return [...found.values()];
}

/**
 * Merge the case's event trail with every run's milestones (start, finish,
 * decisions, touched steps) and the GitHub references their artifacts carry
 * into one chronological list — oldest first, matching how the sequence
 * stream reads. A decision replaces its step row with the decision's own
 * clock; a run id scopes the row ids so a ticket's several runs never clash
 * (an id-less run keeps the legacy unscoped ids). Run SSE events carry no
 * timestamps, so they stay in the raw stream. The sort is stable, so
 * same-timestamp entries keep insertion order.
 */
export function mergeTimeline(input: {
  caseEvents: readonly CaseEvent[];
  runs: ReadonlyArray<TimelineRun>;
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
      href: null,
    });
  });
  for (const run of input.runs) {
    const runId = run.runId ?? "";
    const scope = runId === "" ? "" : `${runId}:`;
    const label = runId === "" ? run.workflow : `${run.workflow} · ${shortRunId(runId)}`;
    const started = parseableTimestamp(run.startedAt);
    if (started !== null) {
      entries.push({
        id: `run:${scope}started`,
        at: started,
        kind: "run",
        title: "Run started",
        detail: label,
        href: null,
      });
    }
    for (const step of run.steps) {
      const decision = step.decision ?? null;
      const decidedAt = decision === null ? null : decisionTimestamp(decision);
      if (decision !== null && decidedAt !== null) {
        entries.push({
          id: `step:${scope}${step.stepId}`,
          at: decidedAt,
          kind: "decision",
          title: step.title,
          detail: decisionDetail(decision),
          href: null,
        });
        continue;
      }
      const at = parseableTimestamp(step.updatedAt);
      if (at === null) continue;
      // Untouched steps still carry the snapshot's clock; skip them so the
      // list reads as a story rather than a step inventory.
      if (step.state === "pending") continue;
      entries.push({
        id: `step:${scope}${step.stepId}`,
        at,
        kind: "step",
        title: step.title,
        detail: step.state,
        href: null,
      });
    }
    if (run.finishedAt !== null) {
      const finished = parseableTimestamp(run.finishedAt);
      if (finished !== null) {
        entries.push({
          id: `run:${scope}finished`,
          at: finished,
          kind: "run",
          title: "Run finished",
          detail: run.status,
          href: null,
        });
      }
    }
  }
  entries.push(...githubPullEvents(input.runs));
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
