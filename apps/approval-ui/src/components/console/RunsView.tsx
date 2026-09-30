"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { ApiError } from "@/lib/api";
import { integrationAccent, integrationLabel, workflowProviderIndex } from "@/lib/integrations";
import {
  RUNNABLE_WORKFLOWS,
  formatDuration,
  listRunsPage,
  runDurationSeconds,
  workflowLabel,
  type RunListFilters,
  type RunListScope,
  type RunStatus,
  type RunSummary,
} from "@/lib/runs";
import { isTypingTarget, moveIndex } from "@/lib/shortcuts";
import { listWorkflows } from "@/lib/workflows";

import { IconActivity, IconRefresh, ProviderGlyph } from "./icons";

const RUNS_PAGE_SIZE = 50;
const RUNS_SKELETON_ROWS = 8;

/** Status filter pills: the empty value is the "all statuses" reset. */
const STATUS_OPTIONS: ReadonlyArray<{ value: RunStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "awaiting_human", label: "Awaiting" },
  { value: "blocked", label: "Blocked" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_COPY: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_human: "Awaiting you",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

type RunsState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; runs: RunSummary[]; nextCursor: string | null };

type RunRef = { runId: string; workflow: string; ticketKey: string };

function runsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sign in with a role that can view runs.";
    }
    return `The run list could not be loaded (API ${error.status}).`;
  }
  return "The run list could not be loaded.";
}

function formatStarted(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function pageFilters(
  scope: RunListScope,
  status: RunStatus | "",
  workflow: string,
  cursor?: string,
): RunListFilters {
  return {
    scope,
    limit: RUNS_PAGE_SIZE,
    ...(status !== "" ? { status } : {}),
    ...(workflow !== "" ? { workflow } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/** At most four platform glyphs per row; the rest collapse into a +N chip. */
const MAX_ROW_CHIPS = 4;

function PlatformChips({ providers }: { providers: readonly string[] }) {
  if (providers.length === 0) return <span className="runs-cell-empty">—</span>;
  const shown = providers.slice(0, MAX_ROW_CHIPS);
  const overflow = providers.length - shown.length;
  return (
    <span className="runs-platforms">
      {shown.map((provider) => (
        <span
          key={provider}
          className="runs-platform-glyph"
          title={integrationLabel(provider)}
          style={{ "--provider-accent": integrationAccent(provider) } as CSSProperties}
        >
          <ProviderGlyph provider={provider} />
        </span>
      ))}
      {overflow > 0 ? <span className="runs-platform-more">{`+${overflow}`}</span> : null}
    </span>
  );
}

function RowBody({
  run,
  providers,
}: {
  run: RunSummary;
  providers: ReadonlyMap<string, string[]> | null;
}) {
  const progress = run.stepCount > 0 ? Math.round((run.stepsDone / run.stepCount) * 100) : 0;
  return (
    <>
      <span className="runs-cell-run">
        <strong>{workflowLabel(run.workflow)}</strong>
        <span className="runs-run-id">{run.runId.slice(0, 8)}</span>
      </span>
      <span className="runs-ticket num">{run.ticketKey}</span>
      <span className={`runs-status st-${run.status}`}>{STATUS_COPY[run.status]}</span>
      <span className="runs-progress">
        <span className="runs-progress-track" aria-hidden="true">
          <span className="runs-progress-fill" style={{ width: `${progress}%` }} />
        </span>
        <span className="runs-progress-copy num">{`${run.stepsDone}/${run.stepCount}`}</span>
      </span>
      <PlatformChips providers={providers?.get(run.workflow) ?? []} />
      <span className="runs-duration num">{formatDuration(runDurationSeconds(run))}</span>
      <span className="runs-started num">{formatStarted(run.startedAt)}</span>
    </>
  );
}

/**
 * Runs explorer: every workflow run the tenant has — live ones on the active
 * scope, the archive ∪ Redis history behind the history toggle — with status
 * pills, step progress, the platforms each workflow touches, and duration.
 * A row opens the standalone run inspector tab.
 */
export function RunsView({
  onOpenRun,
}: {
  onOpenRun?: (run: RunRef) => void;
}) {
  const [scope, setScope] = useState<RunListScope>("active");
  const [status, setStatus] = useState<RunStatus | "">("");
  const [workflow, setWorkflow] = useState("");
  const [state, setState] = useState<RunsState>({ phase: "loading" });
  const [busyMore, setBusyMore] = useState(false);
  const [tick, setTick] = useState(0);
  const [providers, setProviders] = useState<ReadonlyMap<string, string[]> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    listRunsPage(pageFilters(scope, status, workflow)).then(
      (page) => {
        if (!cancelled) {
          setState({ phase: "ready", runs: page.runs, nextCursor: page.nextCursor });
        }
      },
      (error: unknown) => {
        if (!cancelled) setState({ phase: "error", message: runsErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope, status, workflow, tick]);

  // The catalog resolves the platform chips; a failed fetch just hides them.
  useEffect(() => {
    let cancelled = false;
    listWorkflows().then(
      (workflows) => {
        if (!cancelled) setProviders(workflowProviderIndex(workflows));
      },
      () => {
        // Chips stay hidden; the explorer itself is unaffected.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // j/k walks the rendered rows; the DOM focus ring is the cursor, so the
  // listener reads the rows at event time and can never go stale.
  const tableWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleListKeys(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "j" && event.key !== "k") return;
      if (isTypingTarget(event.target)) return;
      const wrap = tableWrapRef.current;
      if (wrap === null) return;
      const rows = Array.from(wrap.querySelectorAll<HTMLButtonElement>("button.runs-row"));
      const current =
        document.activeElement instanceof HTMLButtonElement
          ? rows.indexOf(document.activeElement)
          : -1;
      const next = moveIndex(current, rows.length, event.key === "j" ? 1 : -1);
      if (next < 0) return;
      event.preventDefault();
      rows[next]?.focus();
    }
    window.addEventListener("keydown", handleListKeys);
    return () => window.removeEventListener("keydown", handleListKeys);
  }, []);

  async function loadMore(): Promise<void> {
    if (state.phase !== "ready" || state.nextCursor === null || busyMore) return;
    setBusyMore(true);
    try {
      const page = await listRunsPage(
        pageFilters(scope, status, workflow, state.nextCursor),
      );
      setState((previous) =>
        previous.phase === "ready"
          ? { phase: "ready", runs: [...previous.runs, ...page.runs], nextCursor: page.nextCursor }
          : previous,
      );
    } catch {
      // The existing page stays; Load more can be retried.
    } finally {
      setBusyMore(false);
    }
  }

  const loading = state.phase === "loading";

  return (
    <section id="runs-view" className="panel-view" aria-label="Runs">
      <div className="panel-heading">
        <p className="eyebrow">Operations</p>
        <h2>Runs</h2>
        <p className="panel-note">
          Every workflow run — active and archived — with status, step progress, and the
          platforms each run touched.
        </p>
      </div>

      <div className="runs-toolbar">
        <div className="runs-scope" role="group" aria-label="Run scope">
          <button
            type="button"
            className={scope === "active" ? "active" : undefined}
            aria-pressed={scope === "active"}
            onClick={() => setScope("active")}
          >
            Active
          </button>
          <button
            type="button"
            className={scope === "history" ? "active" : undefined}
            aria-pressed={scope === "history"}
            onClick={() => setScope("history")}
          >
            History
          </button>
        </div>

        <div className="runs-pills" role="group" aria-label="Status filter">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value === "" ? "all" : option.value}
              type="button"
              className={`runs-pill${status === option.value ? " active" : ""}`}
              aria-pressed={status === option.value}
              onClick={() => setStatus(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="runs-filter">
          <span>Workflow</span>
          <select value={workflow} onChange={(event) => setWorkflow(event.target.value)}>
            <option value="">All workflows</option>
            {RUNNABLE_WORKFLOWS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="wf-secondary runs-refresh"
          disabled={loading}
          onClick={() => setTick((value) => value + 1)}
        >
          <IconRefresh className={loading ? "spin" : undefined} />
          Refresh
        </button>

        {state.phase === "ready" && state.runs.length > 0 ? (
          <span className="sprint-badge">{`${state.runs.length} runs`}</span>
        ) : null}
      </div>

      {state.phase === "loading" && (
        <div className="runs-skeleton" role="status" aria-label="Loading runs">
          {Array.from({ length: RUNS_SKELETON_ROWS }, (_, index) => (
            <div key={index} className="skeleton runs-skeleton-row" />
          ))}
        </div>
      )}

      {state.phase === "error" && (
        <div className="view-hold" role="alert">
          <IconActivity />
          <strong>Runs unavailable</strong>
          <p>{state.message}</p>
          <button
            type="button"
            className="wf-secondary"
            onClick={() => setTick((value) => value + 1)}
          >
            <IconRefresh />
            Retry
          </button>
        </div>
      )}

      {state.phase === "ready" && state.runs.length === 0 && (
        <div className="view-hold">
          <IconActivity />
          <strong>{scope === "history" ? "No run history yet" : "No active runs"}</strong>
          <p>
            {scope === "history"
              ? "Completed, failed, and cancelled runs land here once they finish."
              : "Runs appear here the moment a workflow starts — from a ticket or the Workflows catalog."}
          </p>
        </div>
      )}

      {state.phase === "ready" && state.runs.length > 0 && (
        <>
          <div className="runs-table-wrap" ref={tableWrapRef}>
            <div className="runs-table" role="table" aria-label="Workflow runs">
              <div className="runs-row runs-head" role="row">
                <span role="columnheader">Run</span>
                <span role="columnheader">Ticket</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Progress</span>
                <span role="columnheader">Platforms</span>
                <span role="columnheader">Duration</span>
                <span role="columnheader">Started</span>
              </div>
              {state.runs.map((run) =>
                onOpenRun ? (
                  <button
                    key={run.runId}
                    type="button"
                    className="runs-row"
                    role="row"
                    aria-label={`Open run ${run.runId} for ${run.ticketKey}`}
                    onClick={() =>
                      onOpenRun({
                        runId: run.runId,
                        workflow: run.workflow,
                        ticketKey: run.ticketKey,
                      })
                    }
                  >
                    <RowBody run={run} providers={providers} />
                  </button>
                ) : (
                  <div key={run.runId} className="runs-row" role="row">
                    <RowBody run={run} providers={providers} />
                  </div>
                ),
              )}
            </div>
          </div>
          {state.nextCursor !== null ? (
            <div className="runs-more">
              <button
                type="button"
                className="wf-secondary"
                disabled={busyMore}
                onClick={() => void loadMore()}
              >
                <IconRefresh className={busyMore ? "spin" : undefined} />
                {busyMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
