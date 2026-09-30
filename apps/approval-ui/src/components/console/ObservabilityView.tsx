"use client";

import { useEffect, useState, type ReactNode } from "react";

import { ApiError, api, apiUrl } from "@/lib/api";
import {
  decisionHistory,
  formatLatency,
  formatRate,
  getMetricsSummary,
  type DecisionHistoryRow,
  type MetricsSummary,
} from "@/lib/metrics";
import type { Approval } from "@/lib/models";
import { workflowLabel } from "@/lib/runs";

import {
  IconActivity,
  IconAlert,
  IconCheck,
  IconExternalLink,
  IconGauge,
  IconInbox,
  IconLock,
  IconRefresh,
} from "./icons";

const ROUTE_ROWS = 8;
const AUDIT_ROWS = 20;

type SummaryState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; summary: MetricsSummary };

type AuditState =
  | { phase: "loading" }
  | { phase: "denied" }
  | { phase: "error" }
  | { phase: "ready"; rows: DecisionHistoryRow[] };

function summaryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sign in with a role that can view metrics.";
    }
    return `The metrics summary could not be loaded (API ${error.status}).`;
  }
  return "The metrics summary could not be loaded.";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ObsStat({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "ok" | "warn" | "danger";
}) {
  return (
    <div className={`obs-stat${tone ? ` obs-tone-${tone}` : ""}`}>
      <span className="obs-stat-icon">{icon}</span>
      <span className="obs-stat-body">
        <strong className="obs-num">{value}</strong>
        <span className="obs-stat-label">{label}</span>
        <span className="obs-stat-detail">{detail}</span>
      </span>
    </div>
  );
}

/**
 * Observability dashboard: run counts, success rate, queue depth, and latency
 * percentiles from `GET /metrics/summary`, plus a read-only decision history
 * from the approvals ledger (approver role; degrades to a role hint). The raw
 * Prometheus exposition stays one link away for scrapers and deep dives.
 * Per-run and per-case timelines live on each run's Timeline tab.
 */
export function ObservabilityView() {
  const [state, setState] = useState<SummaryState>({ phase: "loading" });
  const [audit, setAudit] = useState<AuditState>({ phase: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    getMetricsSummary().then(
      (summary) => {
        if (!cancelled) setState({ phase: "ready", summary });
      },
      (error: unknown) => {
        if (!cancelled) setState({ phase: "error", message: summaryErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // The audit ledger rides the approvals endpoint; a 403 just means the
  // signed-in principal cannot read decisions — the dashboard still renders.
  useEffect(() => {
    let cancelled = false;
    setAudit({ phase: "loading" });
    api<Approval[]>("/approvals").then(
      (approvals) => {
        if (!cancelled) setAudit({ phase: "ready", rows: decisionHistory(approvals) });
      },
      (error: unknown) => {
        if (cancelled) return;
        const denied =
          error instanceof ApiError && (error.status === 401 || error.status === 403);
        setAudit(denied ? { phase: "denied" } : { phase: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const loading = state.phase === "loading";
  const summary = state.phase === "ready" ? state.summary : null;
  const routes =
    summary === null ? [] : [...summary.latency.http].sort((a, b) => b.count - a.count);
  const decisionChips = summary === null ? [] : Object.entries(summary.decisions);

  return (
    <section id="observability-view" className="panel-view" aria-label="Observability">
      <div className="panel-heading">
        <p className="eyebrow">Operations</p>
        <h2>Observability</h2>
        <p className="panel-note">
          Run counts, success rate, queue depth, and latency percentiles for the whole
          workspace — plus the read-only decision history.
        </p>
      </div>

      <div className="obs-toolbar">
        <button
          type="button"
          className="wf-secondary"
          disabled={loading}
          onClick={() => setTick((value) => value + 1)}
        >
          <IconRefresh className={loading ? "spin" : undefined} />
          Refresh
        </button>
        {summary !== null ? (
          <span className="obs-generated obs-num">{`Updated ${formatTimestamp(summary.generatedAt)}`}</span>
        ) : null}
        {apiUrl !== "" ? (
          <a
            className="obs-raw-link"
            href={`${apiUrl}/metrics`}
            target="_blank"
            rel="noreferrer"
          >
            <IconExternalLink />
            Raw metrics
          </a>
        ) : null}
      </div>

      {state.phase === "loading" && (
        <div className="view-hold" role="status">
          <IconGauge />
          <strong>Loading metrics…</strong>
          <p>Aggregating run counters, queue depth, and latency percentiles.</p>
        </div>
      )}

      {state.phase === "error" && (
        <div className="view-hold" role="alert">
          <IconGauge />
          <strong>Metrics unavailable</strong>
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

      {summary !== null && (
        <>
          <div className="obs-stats">
            <ObsStat
              icon={<IconActivity />}
              label="Terminal runs"
              value={String(summary.runs.total)}
              detail={`${summary.runs.completed} completed`}
            />
            <ObsStat
              icon={<IconCheck />}
              label="Success rate"
              value={formatRate(summary.runs.successRate)}
              detail={`${summary.runs.failed} failed · ${summary.runs.cancelled} cancelled`}
              tone="ok"
            />
            <ObsStat
              icon={<IconInbox />}
              label="Awaiting human"
              value={String(summary.queue.awaitingHuman)}
              detail="gates holding runs"
              tone="warn"
            />
            <ObsStat
              icon={<IconAlert />}
              label="Blocked"
              value={String(summary.queue.blocked)}
              detail="waiting on locks"
              tone="danger"
            />
          </div>

          <div className="obs-columns">
            <section className="obs-card" aria-label="Runs by workflow">
              <div className="obs-card-head">
                <h3>Runs by workflow</h3>
                <span className="obs-card-note">terminal outcomes</span>
              </div>
              {summary.workflows.length === 0 ? (
                <p className="obs-empty">No terminal runs recorded yet.</p>
              ) : (
                <div className="obs-table" role="table" aria-label="Runs by workflow">
                  <div className="obs-table-row obs-table-head obs-workflow-row" role="row">
                    <span role="columnheader">Workflow</span>
                    <span role="columnheader">Total</span>
                    <span role="columnheader">Completed</span>
                    <span role="columnheader">Failed</span>
                    <span role="columnheader">Cancelled</span>
                  </div>
                  {summary.workflows.map((row) => (
                    <div key={row.workflow} className="obs-table-row obs-workflow-row" role="row">
                      <strong>{workflowLabel(row.workflow)}</strong>
                      <span className="obs-num">{row.total}</span>
                      <span className="obs-num obs-ok">{row.completed}</span>
                      <span className="obs-num obs-danger">{row.failed}</span>
                      <span className="obs-num obs-muted">{row.cancelled}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <div className="obs-side">
              <section className="obs-card" aria-label="Queue depth">
                <div className="obs-card-head">
                  <h3>Queue depth</h3>
                  <span className="obs-card-note">live in this tenant</span>
                </div>
                <p className="obs-big obs-num">{summary.queue.active}</p>
                <div className="obs-queue-grid">
                  <span>
                    <strong className="obs-num">{summary.queue.queued}</strong> queued
                  </span>
                  <span>
                    <strong className="obs-num">{summary.queue.running}</strong> running
                  </span>
                  <span>
                    <strong className="obs-num">{summary.queue.awaitingHuman}</strong> awaiting
                    human
                  </span>
                  <span>
                    <strong className="obs-num">{summary.queue.blocked}</strong> blocked
                  </span>
                </div>
                {decisionChips.length > 0 ? (
                  <div className="obs-decisions">
                    {decisionChips.map(([action, count]) => (
                      <span key={action} className="obs-decision-chip">
                        {action} <strong className="obs-num">{count}</strong>
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="obs-card" aria-label="API latency">
                <div className="obs-card-head">
                  <h3>API latency</h3>
                  <span className="obs-card-note">{`${summary.latency.overall.count} requests`}</span>
                </div>
                <div className="obs-latency-overall">
                  <span>
                    p50
                    <strong className="obs-num">
                      {formatLatency(summary.latency.overall.p50)}
                    </strong>
                  </span>
                  <span>
                    p95
                    <strong className="obs-num">
                      {formatLatency(summary.latency.overall.p95)}
                    </strong>
                  </span>
                </div>
                {routes.length === 0 ? (
                  <p className="obs-empty">No HTTP samples yet.</p>
                ) : (
                  <div className="obs-table" role="table" aria-label="Latency by route">
                    <div className="obs-table-row obs-table-head obs-latency-row" role="row">
                      <span role="columnheader">Route</span>
                      <span role="columnheader">Reqs</span>
                      <span role="columnheader">p50</span>
                      <span role="columnheader">p95</span>
                    </div>
                    {routes.slice(0, ROUTE_ROWS).map((row) => (
                      <div key={row.route} className="obs-table-row obs-latency-row" role="row">
                        <code className="obs-route">{row.route}</code>
                        <span className="obs-num">{row.count}</span>
                        <span className="obs-num">{formatLatency(row.p50)}</span>
                        <span className="obs-num">{formatLatency(row.p95)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </>
      )}

      <section className="obs-card obs-audit" aria-label="Decision history">
        <div className="obs-card-head">
          <h3>Decision history</h3>
          <span className="obs-card-note">
            read-only · run timelines live in each run&apos;s inspector
          </span>
        </div>
        {audit.phase === "loading" && (
          <p className="obs-empty" role="status">
            <IconActivity />
            Loading decisions…
          </p>
        )}
        {audit.phase === "denied" && (
          <p className="obs-empty">
            <IconLock />
            Decision history requires the approver role.
          </p>
        )}
        {audit.phase === "error" && (
          <p className="obs-empty">
            <IconAlert />
            Decision history could not be loaded.
          </p>
        )}
        {audit.phase === "ready" && audit.rows.length === 0 && (
          <p className="obs-empty">
            <IconCheck />
            No human decisions recorded yet.
          </p>
        )}
        {audit.phase === "ready" && audit.rows.length > 0 && (
          <div className="obs-table" role="table" aria-label="Approval decisions">
            <div className="obs-table-row obs-table-head obs-audit-row" role="row">
              <span role="columnheader">Decided</span>
              <span role="columnheader">Scope</span>
              <span role="columnheader">Approver</span>
              <span role="columnheader">Outcome</span>
              <span role="columnheader">Comment</span>
            </div>
            {audit.rows.slice(0, AUDIT_ROWS).map((row) => (
              <div key={row.id} className="obs-table-row obs-audit-row" role="row">
                <span className="obs-muted obs-num">{formatTimestamp(row.decidedAt)}</span>
                <code className="obs-scope">{row.scope}</code>
                <span>{row.approver}</span>
                <span className={`obs-decision obs-decision-${row.decision}`}>
                  {row.decision}
                </span>
                <span className="obs-muted">{row.comment ?? "—"}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
