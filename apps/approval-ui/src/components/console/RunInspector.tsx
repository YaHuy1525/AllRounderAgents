"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { JiraIssue } from "@/lib/board";
import type { CaseEvent } from "@/lib/cases";
import { connectedProviders, listConnectors, resolveStepProviders } from "@/lib/connectors";
import { integrationAccent, integrationLabel } from "@/lib/integrations";
import {
  LOG_FILTERS,
  filterRunEvents,
  mergeTimeline,
  receiptFlags,
  runSpendLine,
  stepLineage,
  type LogFilterId,
  type TimelineEntryKind,
  type TimelineRun,
} from "@/lib/runViews";
import {
  RUNNABLE_WORKFLOWS,
  getRun,
  getRunTopology,
  isRunTerminal,
  mergeRunEvents,
  runVisualState,
  subscribeToRunEvents,
  type RunDetail,
  type RunEvent,
  type RunStatus,
  type RunStep,
  type RunSummary,
  type RunTopology,
  type RunVisualState,
} from "@/lib/runs";
import { listWorkflows, type WorkflowDefinition } from "@/lib/workflows";

import { JsonView } from "./JsonView";
import { PayloadView } from "./PayloadView";
import { RunPanel } from "./RunPanel";
import {
  IconChevronRight,
  IconClock,
  IconClose,
  IconCode,
  IconExternalLink,
  IconFileText,
  IconList,
  IconLock,
  IconPlay,
  IconRefresh,
  IconWorkflow,
  ProviderGlyph,
} from "./icons";

/**
 * The run inspector wraps the run surface in five lenses:
 *
 * - Graph: the workflow graph with the live run overlay (node states, the
 *   active pulse, executed-path edges, recorded-effect chips, receipt dots,
 *   lock/queue badges) and a step drawer reusing the single-step display
 *   pattern. The frame's satellites come from the N1 topology, with the
 *   catalog as fallback.
 * - Form: the existing RunPanel rail experience, unchanged (kept mounted so
 *   its stream, drafts, and the History selector survive lens switches).
 * - Data: the full-run JSON, the side-effects ledger, and a steps table with
 *   the artifact → decision → receipt lineage.
 * - Timeline: the sequence-ordered SSE event history plus a by-time case/run
 *   merge, with jump-to-step and a JSON download (the trace-download analog).
 * - Logs: the same stream behind facet filter chips, with a cost/duration
 *   footer.
 *
 * Mounted two ways: embedded in `TicketTab` (issue + runs provided; the Form
 * lens is the full decision experience) and standalone as a `run` tab
 * (fetches the run itself; Form still works because RunPanel only keys on the
 * ticket key, which the run carries).
 */

const GraphCanvas = dynamic(() => import("./graph/GraphCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flow-canvas flow-canvas-loading" style={{ height: 380 }} role="status">
      <span className="spinner" aria-hidden="true" />
      Loading the graph canvas…
    </div>
  ),
});

export type InspectorLens = "graph" | "form" | "data" | "timeline" | "logs";

const LENS_META: ReadonlyArray<{ id: InspectorLens; label: string }> = [
  { id: "graph", label: "Graph" },
  { id: "form", label: "Form" },
  { id: "data", label: "Data" },
  { id: "timeline", label: "Timeline" },
  { id: "logs", label: "Logs" },
];

const RUN_STATUS_COPY: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_human: "Awaiting you",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STEP_VISUAL_COPY: Record<RunVisualState, string> = {
  done: "Done",
  current: "Running",
  awaiting: "Awaiting review",
  blocked: "Blocked",
  future: "Queued",
};

const EVENT_LABELS: Record<string, string> = {
  "run.created": "Created",
  "run.queued": "Queued",
  "run.status": "Status",
  "run.suspended": "Checkpoint",
  "run.decision": "Decision",
  "run.locked": "Locked",
  "run.unlocked": "Unlocked",
  "run.closed": "Closed",
};

type Tone = "good" | "warn" | "bad" | "info" | "muted";

const NOOP = (): void => {};

/** Stable identity for "no case trail" so the timeline memo does not thrash. */
const EMPTY_CASE_EVENTS: CaseEvent[] = [];

function workflowLabel(workflowId: string): string {
  return RUNNABLE_WORKFLOWS.find((workflow) => workflow.id === workflowId)?.label ?? workflowId;
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** The RunPanel-compatible summary of one detail (standalone bootstrap). */
function runSummaryOf(run: RunDetail): RunSummary {
  return {
    runId: run.runId,
    workflow: run.workflow,
    ticketKey: run.ticketKey,
    status: run.status,
    queuePosition: run.queuePosition,
    waitingOn: run.waitingOn,
    heldSlots: run.heldSlots,
    currentStepId: run.currentStepId,
    stepCount: run.stepCount,
    stepsDone: run.stepsDone,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/** Minimal issue for the standalone run tab — RunPanel keys on `issue.key`. */
function issueForRun(run: RunDetail): JiraIssue {
  return {
    key: run.ticketKey,
    project: "",
    summary: `${workflowLabel(run.workflow)} run`,
    issue_type: "Unknown",
    priority: "Unknown",
    status: "Unknown",
    assignee: null,
    labels: [],
    updated: "",
    browse_url: "",
  };
}

function eventTone(event: RunEvent): Tone {
  switch (event.type) {
    case "run.status": {
      if (event.status === "completed") return "good";
      if (event.status === "failed" || event.status === "cancelled") return "bad";
      return "info";
    }
    case "run.locked":
      return "bad";
    case "run.unlocked":
      return "good";
    case "run.queued":
      return "warn";
    case "run.suspended":
      return event.stepState === "blocked" ? "bad" : "warn";
    case "run.decision":
      return "info";
    default:
      return "muted";
  }
}

const FACT_KEYS: ReadonlyArray<[string, string]> = [
  ["status", "Status"],
  ["action", "Action"],
  ["stepState", "Step state"],
  ["target", "Target"],
  ["reason", "Reason"],
  ["error", "Error"],
  ["workflow", "Workflow"],
];

function eventFacts(event: RunEvent): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  for (const [key, label] of FACT_KEYS) {
    const value = event[key];
    if (typeof value === "string" && value !== "") facts.push([label, value]);
  }
  if (typeof event.queuePosition === "number") {
    facts.push(["Queue position", `#${event.queuePosition}`]);
  }
  if (typeof event.receipt === "string" && event.receipt !== "") facts.push(["Receipt", "signed"]);
  return facts;
}

/** The event payload without the duplicated run snapshot (shown as Run JSON). */
function payloadWithoutSnapshot(event: RunEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "run") continue;
    payload[key] = value;
  }
  return payload;
}

/** Badge tone per merged-timeline row kind. */
const TIMELINE_KIND_TONE: Record<TimelineEntryKind, Tone> = {
  case: "info",
  run: "warn",
  step: "muted",
  decision: "good",
  github: "muted",
};

const LENS_STORAGE_KEY = "allrounder.run.lenses.v1";
const DEFAULT_LENS: InspectorLens = "graph";

function isInspectorLens(value: unknown): value is InspectorLens {
  return (
    value === "graph" ||
    value === "form" ||
    value === "data" ||
    value === "timeline" ||
    value === "logs"
  );
}

/** Lens choices persist per scope: a ticket tab or a standalone run tab. */
function readLens(scope: string): InspectorLens {
  if (typeof window === "undefined") return DEFAULT_LENS;
  try {
    const raw = window.localStorage.getItem(LENS_STORAGE_KEY);
    if (raw === null) return DEFAULT_LENS;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_LENS;
    const value = (parsed as Record<string, unknown>)[scope];
    return isInspectorLens(value) ? value : DEFAULT_LENS;
  } catch {
    return DEFAULT_LENS;
  }
}

function writeLens(scope: string, lens: InspectorLens): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(LENS_STORAGE_KEY);
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    const store =
      typeof parsed === "object" && parsed !== null
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    store[scope] = lens;
    window.localStorage.setItem(LENS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Persistence is best-effort; the lens still switches in-memory.
  }
}

function LensIcon({ lens }: { lens: InspectorLens }) {
  switch (lens) {
    case "graph":
      return <IconWorkflow />;
    case "form":
      return <IconFileText />;
    case "data":
      return <IconCode />;
    case "timeline":
      return <IconClock />;
    case "logs":
      return <IconList />;
  }
}

/** A signed receipt renders parsed when it is JSON, as text otherwise. */
function ReceiptView({ receipt }: { receipt: string }) {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(receipt) as unknown;
  } catch {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === "object") return <PayloadView value={parsed} />;
  return <p className="inspector-receipt">{receipt}</p>;
}

/**
 * The graph's step drawer: the single-step display pattern (state pill, title,
 * position) plus the artifact / decision / receipt record.
 */
function StepDrawer({
  step,
  total,
  onClose,
  onOpenForm,
}: {
  step: RunStep;
  total: number;
  onClose: () => void;
  onOpenForm: () => void;
}) {
  const visual = runVisualState(step);
  return (
    <aside className="inspector-drawer" aria-label={`Step ${step.index + 1} details`}>
      <header className="inspector-drawer-head">
        <span className={`step-state state-${visual}`}>{STEP_VISUAL_COPY[visual]}</span>
        <h3>{step.title}</h3>
        <button
          type="button"
          className="inspector-close"
          aria-label="Close step details"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </header>
      <p className="inspector-note">
        {`Step ${step.index + 1} of ${total}`}
        {step.regenerations > 0 ? ` · regenerated ${step.regenerations}×` : ""}
      </p>
      <section className="inspector-drawer-section">
        <h4>Artifact</h4>
        {step.artifact === null ? (
          <p className="step-empty">No artifact recorded yet.</p>
        ) : (
          <PayloadView value={step.artifact} />
        )}
      </section>
      <section className="inspector-drawer-section">
        <h4>Decision</h4>
        {step.decision === null ? (
          <p className="step-empty">No decision recorded.</p>
        ) : (
          <PayloadView value={step.decision} />
        )}
      </section>
      <section className="inspector-drawer-section">
        <h4>Receipt</h4>
        {step.receipt === null ? (
          <p className="step-empty">No signed receipt on this step.</p>
        ) : (
          <ReceiptView receipt={step.receipt} />
        )}
      </section>
      {visual === "awaiting" && (
        <button type="button" className="wf-cta" onClick={onOpenForm}>
          Review in the form lens
        </button>
      )}
    </aside>
  );
}

function TimelineRow({
  event,
  steps,
  onJumpStep,
}: {
  event: RunEvent;
  steps: RunStep[];
  onJumpStep: (stepId: string) => void;
}) {
  const sequence = typeof event.sequence === "number" ? event.sequence : null;
  const stepId = typeof event.stepId === "string" ? event.stepId : null;
  const step = stepId === null ? null : (steps.find((item) => item.stepId === stepId) ?? null);
  const facts = eventFacts(event);
  return (
    <li className="inspector-event">
      <div className="inspector-event-head">
        {sequence !== null && <span className="inspector-event-seq">{`#${sequence}`}</span>}
        <span className={`payload-badge tone-${eventTone(event)}`} title={event.type}>
          {EVENT_LABELS[event.type] ?? event.type}
        </span>
        {step !== null && (
          <button
            type="button"
            className="inspector-event-jump"
            title="Show this step on the graph"
            onClick={() => onJumpStep(step.stepId)}
          >
            <span>{`Step ${step.index + 1} · ${step.title}`}</span>
            <IconChevronRight />
          </button>
        )}
      </div>
      {facts.length > 0 && (
        <dl className="inspector-event-facts">
          {facts.map(([label, value]) => (
            <div key={label} className="inspector-event-fact">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <details className="inspector-event-raw">
        <summary>Payload</summary>
        <PayloadView value={payloadWithoutSnapshot(event)} />
      </details>
    </li>
  );
}

export function RunInspector({
  issue,
  runs,
  debugOpen: debugOpenProp,
  onToggleDebug,
  onRunsChanged,
  onActiveRun,
  caseId,
  caseEvents = EMPTY_CASE_EVENTS,
  costMicro = null,
  runId,
  focusStepId,
  focusNonce,
}: {
  /** Embedded (ticket) mode: RunPanel renders the Form lens with these props. */
  issue?: JiraIssue;
  runs?: RunSummary[];
  debugOpen?: boolean;
  onToggleDebug?: () => void;
  onRunsChanged?: () => void;
  onActiveRun?: (run: RunDetail | null) => void;
  /** The case backing this ticket (embedded mode) — where snaps find their trail. */
  caseId?: string;
  /** The case's event trail, merged into the Timeline lens (embedded mode). */
  caseEvents?: CaseEvent[];
  /** The case's spend in micro-USD for the Logs/Timeline footer. */
  costMicro?: number | null;
  /** Standalone (run tab) mode: fetch this run and derive everything. */
  runId?: string;
  /** Command-bar deep link: open this step's drawer once per nonce. */
  focusStepId?: string;
  focusNonce?: number;
}) {
  const embedded = issue !== undefined && runs !== undefined;
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [lens, setLens] = useState<InspectorLens>(DEFAULT_LENS);
  const [lensLoaded, setLensLoaded] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<WorkflowDefinition[] | null>(null);
  const [bootstrapError, setBootstrapError] = useState(false);
  const [bootstrapTick, setBootstrapTick] = useState(0);
  const [localDebugOpen, setLocalDebugOpen] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [timelineDown, setTimelineDown] = useState(false);
  const [timelineTick, setTimelineTick] = useState(0);
  const [topology, setTopology] = useState<RunTopology | null>(null);
  // N2 connectors: provider ids connected for this tenant, so a connected
  // Gmail can claim the generic `email` satellite on the steps it serves.
  // Failures fall back to no overlay — the declared glyphs stay.
  const [connected, setConnected] = useState<string[]>([]);
  const [logFilter, setLogFilter] = useState<LogFilterId>("all");
  // Every run of the case, fetched lazily for the ticket-level timeline; the
  // ref keeps failed lookups from looping until the user retries.
  const [runCache, setRunCache] = useState<Record<string, RunDetail>>({});
  const timelineFetchedRef = useRef<Set<string>>(new Set());

  const scope = embedded ? `ticket:${issue.key}` : `run:${runId ?? ""}`;

  // Lens choice: stored per scope, applied after mount so SSR stays neutral.
  useEffect(() => {
    setLensLoaded(false);
    setLens(readLens(scope));
    setSelectedStepId(null);
    timelineFetchedRef.current = new Set();
    setRunCache({});
    setLensLoaded(true);
  }, [scope]);

  useEffect(() => {
    if (lensLoaded) writeLens(scope, lens);
  }, [lens, lensLoaded, scope]);

  // Workflow catalog (integrations per step); the run's own steps are the
  // fallback so the graph and the ledger render even when it is unavailable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listWorkflows();
        if (!cancelled) setCatalog(list);
      } catch {
        // Display-only enrichment; the run's step titles still render.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Standalone mode: the tab carries only a run id — bootstrap the detail so
  // RunPanel can mount against the right run (it edits the latest of `runs`).
  useEffect(() => {
    if (embedded) return;
    if (runId === undefined || runId === "") return;
    let cancelled = false;
    setBootstrapError(false);
    void (async () => {
      try {
        const run = await getRun(runId);
        if (!cancelled) setDetail(run);
      } catch {
        if (!cancelled) setBootstrapError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embedded, runId, bootstrapTick]);

  const capture = useCallback(
    (run: RunDetail | null) => {
      setDetail(run);
      onActiveRun?.(run);
    },
    [onActiveRun],
  );

  // Timeline/Logs: subscribe only while a stream lens is visible; the stream
  // replays the full history, so re-entering a lens rebuilds the list from zero.
  const timelineRunId = detail === null ? null : detail.runId;
  useEffect(() => {
    if ((lens !== "timeline" && lens !== "logs") || timelineRunId === null) return;
    let cancelled = false;
    let close: (() => void) | null = null;
    setEvents([]);
    setTimelineDown(false);
    void (async () => {
      const closer = await subscribeToRunEvents(timelineRunId, {
        onEvent: (event) => setEvents((previous) => mergeRunEvents(previous, event)),
        onError: () => setTimelineDown(true),
      });
      if (cancelled) {
        closer();
        return;
      }
      close = closer;
    })();
    return () => {
      cancelled = true;
      close?.();
    };
  }, [lens, timelineRunId, timelineTick]);

  // Retry affordance: bumping the timeline tick re-attempts failed detail
  // lookups along with the stream reconnect.
  useEffect(() => {
    timelineFetchedRef.current = new Set();
  }, [timelineTick]);

  // Ticket-level feed: the Timeline lens covers every run of the case, not
  // just the selected one, so fetch each listed run's detail once. Failures
  // (and slow loads) fall back to summary rows; a run appearing in the list
  // later fetches on the next pass.
  useEffect(() => {
    if (!embedded || lens !== "timeline" || runs === undefined) return;
    const wanted = runs.filter((item) => !timelineFetchedRef.current.has(item.runId));
    if (wanted.length === 0) return;
    for (const item of wanted) timelineFetchedRef.current.add(item.runId);
    let cancelled = false;
    void (async () => {
      const settled = await Promise.allSettled(wanted.map((item) => getRun(item.runId)));
      if (cancelled) return;
      setRunCache((previous) => {
        const next = { ...previous };
        settled.forEach((result, index) => {
          const summary = wanted[index];
          if (result.status === "fulfilled" && summary !== undefined) {
            next[summary.runId] = result.value;
          }
        });
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [embedded, lens, runs, timelineTick]);

  // N1 topology: one fetch per run supplies the graph frame (side-effecting
  // steps, integration satellites, receipts, lock); failures fall back to the
  // catalog frame, and the guard below ignores a stale run's payload.
  useEffect(() => {
    if (timelineRunId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const payload = await getRunTopology(timelineRunId);
        if (!cancelled) setTopology(payload);
      } catch {
        if (!cancelled) setTopology(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [timelineRunId]);

  // N2 overlay: one catalog fetch feeds the display-only provider swap below;
  // a failure simply keeps the glyphs each workflow declares.
  useEffect(() => {
    let cancelled = false;
    listConnectors()
      .then((items) => {
        if (!cancelled) setConnected(connectedProviders(items));
      })
      .catch(() => {
        if (!cancelled) setConnected([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const graphTopology =
    topology !== null && detail !== null && topology.runId === detail.runId ? topology : null;

  // The graph's workflow frame: the N1 topology when it matches the run, else
  // the catalog definition, else a minimal frame from the run's step titles.
  // Declared integrations ride the N2 connector overlay (a connected Gmail
  // badges the steps its `email` channel serves) — display only, so the swap
  // never grants an execution path.
  const workflowPick = useMemo((): Pick<WorkflowDefinition, "id" | "steps"> | null => {
    if (detail === null) return null;
    if (graphTopology !== null) {
      return {
        id: graphTopology.workflow,
        steps: graphTopology.steps.map((step) => ({
          id: step.stepId,
          title: step.title,
          sideEffecting: step.sideEffecting,
          integrations: resolveStepProviders(step.integrations, connected),
        })),
      };
    }
    const fromCatalog = catalog?.find((workflow) => workflow.id === detail.workflow) ?? null;
    if (fromCatalog !== null) {
      return {
        id: fromCatalog.id,
        steps: fromCatalog.steps.map((step) => ({
          ...step,
          integrations: resolveStepProviders(step.integrations, connected),
        })),
      };
    }
    return {
      id: detail.workflow,
      steps: detail.steps.map((step) => ({
        id: step.stepId,
        title: step.title,
        sideEffecting: false,
        integrations: [] as string[],
      })),
    };
  }, [catalog, connected, detail, graphTopology]);

  const workflowStepsById = useMemo(() => {
    const map = new Map<string, { title: string; integrations: string[] }>();
    for (const step of workflowPick?.steps ?? []) {
      map.set(step.id, { title: step.title, integrations: step.integrations });
    }
    return map;
  }, [workflowPick]);

  const stepStates = useMemo(() => {
    const states: Record<string, RunVisualState> = {};
    for (const step of detail?.steps ?? []) states[step.stepId] = runVisualState(step);
    return states;
  }, [detail]);

  const effectFlags = useMemo(() => {
    const flags: Record<string, boolean> = {};
    for (const stepId of Object.keys(detail?.sideEffects ?? {})) flags[stepId] = true;
    return flags;
  }, [detail]);

  const receiptMarks = useMemo(() => receiptFlags(detail?.steps ?? []), [detail]);
  const receiptTotal = Object.keys(receiptMarks).length;

  const selectedStep = useMemo(
    () =>
      detail === null || selectedStepId === null
        ? null
        : (detail.steps.find((step) => step.stepId === selectedStepId) ?? null),
    [detail, selectedStepId],
  );

  const effectEntries = useMemo(
    () => (detail === null ? [] : Object.entries(detail.sideEffects)),
    [detail],
  );

  // The Timeline lens covers the whole case: every listed run, enriched with
  // its fetched detail, and the selected run's freshest state on top (it is
  // the one the SSE stream keeps current).
  const timelineRuns = useMemo((): TimelineRun[] => {
    if (!embedded) return detail === null ? [] : [detail];
    return (runs ?? []).map((item) => {
      const fresh =
        detail !== null && detail.runId === item.runId
          ? detail
          : (runCache[item.runId] ?? null);
      return {
        runId: item.runId,
        workflow: item.workflow,
        status: fresh?.status ?? item.status,
        startedAt: fresh?.startedAt ?? item.startedAt,
        finishedAt: fresh?.finishedAt ?? item.finishedAt,
        steps: fresh?.steps ?? [],
      };
    });
  }, [detail, embedded, runCache, runs]);

  const timelineEntries = useMemo(
    () => mergeTimeline({ caseEvents, runs: timelineRuns }),
    [caseEvents, timelineRuns],
  );

  const filteredEvents = useMemo(() => filterRunEvents(events, logFilter), [events, logFilter]);

  const spendLine = runSpendLine(detail, costMicro);

  const handleGraphStepSelect = useCallback((stepId: string): void => {
    setSelectedStepId(stepId);
  }, []);

  const jumpToStep = useCallback((stepId: string): void => {
    setSelectedStepId(stepId);
    setLens("graph");
  }, []);

  // Command-bar deep link: once the run is loaded, open the linked step's
  // drawer on the graph lens. The nonce guard keeps later snapshot refreshes
  // from re-opening a drawer the user closed.
  const commandFocusSeen = useRef<number | null>(null);
  useEffect(() => {
    if (focusStepId === undefined || focusStepId === "") return;
    const nonce = focusNonce ?? 0;
    if (commandFocusSeen.current === nonce) return;
    if (detail === null) return;
    if (!detail.steps.some((step) => step.stepId === focusStepId)) return;
    commandFocusSeen.current = nonce;
    setSelectedStepId(focusStepId);
    setLens("graph");
  }, [focusStepId, focusNonce, detail]);

  function downloadTimeline(): void {
    if (detail === null || events.length === 0) return;
    const blob = new Blob([JSON.stringify({ run: detail, events }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `run-${shortRunId(detail.runId)}-timeline.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const standaloneSummary = useMemo(
    () => (detail === null ? null : runSummaryOf(detail)),
    [detail],
  );
  const standaloneIssue = useMemo(() => (detail === null ? null : issueForRun(detail)), [detail]);

  const debugOpen = embedded ? (debugOpenProp ?? false) : localDebugOpen;
  const toggleDebug = embedded
    ? (onToggleDebug ?? NOOP)
    : (): void => setLocalDebugOpen((open) => !open);

  if (!embedded && (runId === undefined || runId === "")) {
    return (
      <section id="run-view" className="panel-view" aria-label="Run inspector">
        <div className="panel-heading">
          <p className="eyebrow">Run</p>
          <h2>Run inspector</h2>
          <p className="panel-note">
            Every run tab carries one run — open one from the runs list or a ticket.
          </p>
        </div>
        <div className="view-hold">
          <IconPlay />
          <strong>No run selected</strong>
          <p>The Graph, Form, Data, Timeline, and Logs lenses appear once a run is opened.</p>
        </div>
      </section>
    );
  }

  const ready = embedded || detail !== null;

  return (
    <section
      id="run-view"
      className={embedded ? "run-inspector" : "run-inspector panel-view"}
      aria-label="Run inspector"
    >
      {!embedded && (
        <div className="panel-heading">
          <p className="eyebrow">Run</p>
          <h2>{detail !== null ? workflowLabel(detail.workflow) : "Run inspector"}</h2>
          <p className="panel-note">
            {detail !== null
              ? `Run ${shortRunId(detail.runId)} · ${detail.ticketKey} · one live run, five lenses.`
              : "One run, five lenses — live graph, decision form, raw data, the ordered event timeline, and filtered logs."}
          </p>
        </div>
      )}

      {!embedded && bootstrapError && detail === null ? (
        <div className="run-banner failed" role="alert">
          <p>The run could not be loaded.</p>
          <div className="run-banner-actions">
            <button type="button" onClick={() => setBootstrapTick((tick) => tick + 1)}>
              Retry
            </button>
          </div>
        </div>
      ) : !ready ? (
        <p className="ticket-notice" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading the run…
        </p>
      ) : (
        <div className="run-inspector-body">
          <nav className="inspector-rail" aria-label="Run lenses">
            {LENS_META.map((meta) => (
              <button
                key={meta.id}
                type="button"
                className={`inspector-rail-btn${lens === meta.id ? " active" : ""}`}
                aria-pressed={lens === meta.id}
                title={`${meta.label} lens`}
                onClick={() => setLens(meta.id)}
              >
                <LensIcon lens={meta.id} />
                <span>{meta.label}</span>
              </button>
            ))}
          </nav>

          <div className="inspector-stage">
            {/* The Form lens stays mounted (hidden) so RunPanel keeps its SSE
                stream, drafts, and the latest-run selector alive. */}
            <div className="inspector-pane" hidden={lens !== "form"}>
              {embedded ? (
                <RunPanel
                  issue={issue}
                  runs={runs}
                  debugOpen={debugOpen}
                  onToggleDebug={toggleDebug}
                  onRunsChanged={onRunsChanged ?? NOOP}
                  onActiveRun={capture}
                  caseId={caseId}
                />
              ) : standaloneIssue !== null && standaloneSummary !== null ? (
                <RunPanel
                  issue={standaloneIssue}
                  runs={[standaloneSummary]}
                  debugOpen={debugOpen}
                  onToggleDebug={toggleDebug}
                  onRunsChanged={NOOP}
                  onActiveRun={capture}
                />
              ) : null}
            </div>

            {lens === "graph" &&
              (detail === null || workflowPick === null ? (
                <p className="ticket-notice" role="status">
                  <span className="spinner" aria-hidden="true" />
                  Loading the live run graph…
                </p>
              ) : (
                <div className="inspector-graph-grid">
                  <div className="inspector-graph-col">
                    <div className="inspector-status-row">
                      <span className={`run-status status-${detail.status}`}>
                        <span className="run-status-dot" aria-hidden="true" />
                        {RUN_STATUS_COPY[detail.status]}
                      </span>
                      <span className="inspector-chip">{`${detail.stepsDone}/${detail.stepCount} steps`}</span>
                      {detail.attempt > 0 && (
                        <span className="inspector-chip">{`Attempt ${detail.attempt + 1}`}</span>
                      )}
                      {receiptTotal > 0 && (
                        <span className="inspector-chip">
                          {`${receiptTotal} receipt${receiptTotal === 1 ? "" : "s"}`}
                        </span>
                      )}
                      {detail.status === "queued" && (
                        <span className="inspector-chip warn">
                          <IconClock />
                          {detail.queuePosition !== null
                            ? `Queue position #${detail.queuePosition}`
                            : "Queued"}
                        </span>
                      )}
                      {detail.status === "blocked" && (
                        <span className="inspector-chip danger">
                          <IconLock />
                          {detail.lockTarget !== null ? `Lock on ${detail.lockTarget}` : "Locked"}
                          {detail.lockedBy !== null
                            ? ` · held by ${shortRunId(detail.lockedBy)}`
                            : ""}
                        </span>
                      )}
                      {detail.finishedAt !== null && (
                        <span className="inspector-chip">{`Finished ${formatTimestamp(detail.finishedAt)}`}</span>
                      )}
                    </div>
                    <GraphCanvas
                      workflow={workflowPick}
                      states={stepStates}
                      effects={effectFlags}
                      receipts={receiptMarks}
                      activeStepId={detail.currentStepId}
                      animated={!isRunTerminal(detail.status)}
                      onStepSelect={handleGraphStepSelect}
                      height={380}
                    />
                    <p className="inspector-note">
                      Click a step to inspect its artifact, decision, and receipt.
                    </p>
                  </div>
                  {selectedStep !== null && (
                    <StepDrawer
                      step={selectedStep}
                      total={detail.steps.length}
                      onClose={() => setSelectedStepId(null)}
                      onOpenForm={() => setLens("form")}
                    />
                  )}
                </div>
              ))}

            {lens === "data" &&
              (detail === null ? (
                <p className="ticket-notice" role="status">
                  Loading the run data…
                </p>
              ) : (
                <div className="inspector-stack">
                  <section className="inspector-card">
                    <header className="inspector-card-head">
                      <h3>Side effects</h3>
                      <span className="inspector-note">
                        {effectEntries.length === 0
                          ? "Nothing recorded yet"
                          : `${effectEntries.length} recorded`}
                      </span>
                    </header>
                    {effectEntries.length === 0 ? (
                      <p className="step-empty">
                        No side effect has been recorded yet — this run has not written to a
                        target system.
                      </p>
                    ) : (
                      <ul className="effect-ledger">
                        {effectEntries.map(([stepId, effect]) => {
                          const meta = workflowStepsById.get(stepId);
                          const step = detail.steps.find((item) => item.stepId === stepId);
                          return (
                            <li key={stepId} className="effect-row">
                              <header className="effect-head">
                                <div className="effect-target">
                                  <strong>{step?.title ?? meta?.title ?? stepId}</strong>
                                  <span className="inspector-note">{stepId}</span>
                                </div>
                                <span className="effect-providers">
                                  {(meta?.integrations ?? []).map((provider) => (
                                    <span
                                      key={provider}
                                      className="workflow-step-provider"
                                      style={
                                        {
                                          "--provider-accent": integrationAccent(provider),
                                        } as CSSProperties
                                      }
                                      title={integrationLabel(provider)}
                                    >
                                      <ProviderGlyph provider={provider} />
                                    </span>
                                  ))}
                                </span>
                              </header>
                              <PayloadView value={effect} />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="inspector-card">
                    <header className="inspector-card-head">
                      <h3>Steps</h3>
                      <span className="inspector-note">{`${detail.stepsDone}/${detail.stepCount} done`}</span>
                    </header>
                    <div className="inspector-table-wrap">
                      <table className="inspector-table">
                        <thead>
                          <tr>
                            <th scope="col">#</th>
                            <th scope="col">Step</th>
                            <th scope="col">State</th>
                            <th scope="col">Decision</th>
                            <th scope="col">Lineage</th>
                            <th scope="col">Updated</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.steps.map((step) => {
                            const visual = runVisualState(step);
                            const action =
                              typeof step.decision?.action === "string"
                                ? step.decision.action
                                : null;
                            return (
                              <tr key={step.stepId}>
                                <td className="num">{step.index + 1}</td>
                                <td>{step.title}</td>
                                <td>
                                  <span className={`step-state state-${visual}`}>
                                    {STEP_VISUAL_COPY[visual]}
                                  </span>
                                </td>
                                <td>
                                  {action === null ? (
                                    "—"
                                  ) : (
                                    <span className="payload-badge tone-info">{action}</span>
                                  )}
                                </td>
                                <td>
                                  <span className="inspector-lineage">
                                    {stepLineage(step).map((link) => (
                                      <span
                                        key={link.id}
                                        className={`lineage-chip${link.on ? " on" : ""}`}
                                        title={
                                          link.on
                                            ? `${link.label} recorded`
                                            : `${link.label} not recorded`
                                        }
                                      >
                                        {link.label}
                                      </span>
                                    ))}
                                  </span>
                                </td>
                                <td className="num">{formatTimestamp(step.updatedAt)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="inspector-card">
                    <header className="inspector-card-head">
                      <h3>Run JSON</h3>
                      <span className="inspector-note">{`GET /runs/${shortRunId(detail.runId)}`}</span>
                    </header>
                    <JsonView value={detail} />
                  </section>
                </div>
              ))}

            {lens === "timeline" &&
              (detail === null ? (
                <p className="ticket-notice" role="status">
                  Loading the event timeline…
                </p>
              ) : (
                <div className="inspector-stack">
                  <section className="inspector-card">
                    <header className="inspector-card-head">
                      <h3>Case timeline</h3>
                      <span className="inspector-note">
                        {timelineEntries.length === 0
                          ? "No timestamped rows yet"
                          : `${timelineEntries.length} rows · oldest first`}
                      </span>
                    </header>
                    {timelineEntries.length === 0 ? (
                      <p className="step-empty">
                        Case events and run milestones appear here as they carry timestamps.
                      </p>
                    ) : (
                      <ol className="inspector-timeline">
                        {timelineEntries.map((entry) => (
                          <li key={entry.id} className="inspector-event">
                            <div className="inspector-event-head">
                              <span className="inspector-event-seq">
                                {formatTimestamp(entry.at)}
                              </span>
                              <span
                                className={`payload-badge tone-${TIMELINE_KIND_TONE[entry.kind]}`}
                              >
                                {entry.kind}
                              </span>
                              <span className="inspector-event-title">{entry.title}</span>
                              {entry.href !== null && (
                                <a
                                  className="inspector-event-link"
                                  href={entry.href}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`Open ${entry.title} in a new tab`}
                                >
                                  <IconExternalLink />
                                </a>
                              )}
                            </div>
                            <p className="inspector-note">{entry.detail}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                    <p className="inspector-note">
                      Jira comments, decisions, and GitHub activity merge here; Gmail and Calendar
                      rows arrive with the connectors vault.
                    </p>
                  </section>
                  <div className="inspector-timeline-bar">
                    <span className="inspector-note">
                      {events.length === 0
                        ? "Replaying the run's event stream…"
                        : `${events.length} event${events.length === 1 ? "" : "s"} · sequence order`}
                    </span>
                    <div className="inspector-timeline-actions">
                      {timelineDown && (
                        <button
                          type="button"
                          className="wf-secondary"
                          onClick={() => setTimelineTick((tick) => tick + 1)}
                        >
                          <IconRefresh />
                          <span>Retry stream</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="wf-secondary"
                        disabled={events.length === 0}
                        onClick={downloadTimeline}
                      >
                        Download JSON
                      </button>
                    </div>
                  </div>
                  {timelineDown && (
                    <p className="run-action-error" role="alert">
                      The live stream dropped — the list below may be stale.
                    </p>
                  )}
                  {events.length === 0 ? (
                    <p className="step-empty" role="status">
                      Waiting for the first event…
                    </p>
                  ) : (
                    <ol className="inspector-timeline">
                      {events.map((event, index) => (
                        <TimelineRow
                          key={
                            typeof event.sequence === "number"
                              ? event.sequence
                              : `event-${index}`
                          }
                          event={event}
                          steps={detail.steps}
                          onJumpStep={jumpToStep}
                        />
                      ))}
                    </ol>
                  )}
                  <p className="inspector-spend-line">{spendLine}</p>
                </div>
              ))}

            {lens === "logs" &&
              (detail === null ? (
                <p className="ticket-notice" role="status">
                  Loading the run log…
                </p>
              ) : (
                <div className="inspector-stack">
                  <div className="inspector-log-filters" role="group" aria-label="Log filters">
                    {LOG_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        type="button"
                        className={`inspector-filter-chip${logFilter === filter.id ? " active" : ""}`}
                        aria-pressed={logFilter === filter.id}
                        onClick={() => setLogFilter(filter.id)}
                      >
                        {filter.label}
                      </button>
                    ))}
                    <span className="inspector-note">
                      {`${filteredEvents.length} of ${events.length} event${events.length === 1 ? "" : "s"}`}
                    </span>
                    {timelineDown && (
                      <button
                        type="button"
                        className="wf-secondary"
                        onClick={() => setTimelineTick((tick) => tick + 1)}
                      >
                        <IconRefresh />
                        <span>Retry stream</span>
                      </button>
                    )}
                  </div>
                  {timelineDown && (
                    <p className="run-action-error" role="alert">
                      The live stream dropped — the list below may be stale.
                    </p>
                  )}
                  {filteredEvents.length === 0 ? (
                    <p className="step-empty" role="status">
                      {events.length === 0
                        ? "Waiting for the first event…"
                        : "No events match this filter yet."}
                    </p>
                  ) : (
                    <ol className="inspector-timeline">
                      {filteredEvents.map((event, index) => (
                        <TimelineRow
                          key={typeof event.sequence === "number" ? event.sequence : `log-${index}`}
                          event={event}
                          steps={detail.steps}
                          onJumpStep={jumpToStep}
                        />
                      ))}
                    </ol>
                  )}
                  <p className="inspector-spend-line">{spendLine}</p>
                </div>
              ))}
          </div>
        </div>
      )}

      {!embedded && localDebugOpen && detail !== null && (
        <div className="debug-drawer" id="debug-drawer">
          <header>
            <h3>Run JSON</h3>
            <button type="button" onClick={() => setLocalDebugOpen(false)}>
              <IconClose />
              <span>Close</span>
            </button>
          </header>
          <JsonView value={{ run: detail, events }} />
        </div>
      )}
    </section>
  );
}
