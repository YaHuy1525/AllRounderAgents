"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import { safeBrowseUrl, ticketFacts, type JiraIssue } from "@/lib/board";
import {
  collectHttpsLinks,
  eventsForStep,
  formatCost,
  inferLane,
  laneForDomain,
  stepStates,
  stepsForLane,
  type CaseEvent,
  type CaseRecord,
  type LaneStep,
  type StepState,
  type TicketStatus,
} from "@/lib/cases";
import type { Approval } from "@/lib/models";
import { listRuns, type RunDetail, type RunSummary } from "@/lib/runs";

import { IconCode } from "./icons";
import { RunPanel, StartRunCard } from "./RunPanel";

type CaseState =
  | { status: "loading" }
  | { status: "ready"; record: CaseRecord }
  | { status: "missing" }
  | { status: "error" };

const STEP_STATE_COPY: Record<StepState, string> = {
  done: "Completed",
  current: "In progress",
  future: "Not started",
  awaiting: "Awaiting you",
  blocked: "Blocked",
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function EventPayload({ event }: { event: CaseEvent }) {
  return (
    <article className="step-event">
      <header>
        <span className="event-kind">{event.kind}</span>
        <span className="event-actor">{event.actor}</span>
        <span className="event-time">{formatTimestamp(event.created_at)}</span>
      </header>
      <pre className="event-payload">{JSON.stringify(event.payload, null, 2)}</pre>
    </article>
  );
}

/**
 * View B — the ticket execution tab. When the ticket has runs, the run panel
 * drives the experience (per-run SSE, queue/lock banners, the action bar,
 * History); otherwise the lane stepper derived from the case events renders
 * with a start-run card. Approval gates post to the real decision endpoint.
 */
export function TicketTab({
  issue,
  approvals,
  onDecide,
}: {
  issue: JiraIssue;
  approvals: Approval[];
  onDecide: (id: string, decision: "approved" | "rejected") => Promise<void>;
}) {
  const [caseState, setCaseState] = useState<CaseState>({ status: "loading" });
  const [caseTick, setCaseTick] = useState(0);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRun, setActiveRun] = useState<RunDetail | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const panelRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    setExpandedStep(null);
    setDebugOpen(false);
    let cancelled = false;
    async function load(): Promise<void> {
      setCaseState({ status: "loading" });
      try {
        const status = await api<TicketStatus>(`/tickets/${issue.key}/status`);
        const record = await api<CaseRecord>(`/cases/${encodeURIComponent(status.caseId)}`);
        if (!cancelled) setCaseState({ status: "ready", record });
      } catch (error) {
        if (cancelled) return;
        setCaseState(
          error instanceof ApiError && error.status === 404
            ? { status: "missing" }
            : { status: "error" },
        );
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [issue.key, caseTick]);

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      setRuns(await listRuns(issue.key));
    } catch {
      // The run list is supplemental; the case view still renders without it.
    }
  }, [issue.key]);

  useEffect(() => {
    setRuns([]);
    setActiveRun(null);
    void refreshRuns();
  }, [refreshRuns]);

  const record = caseState.status === "ready" ? caseState.record : null;
  const hasRun = record !== null;
  const events = record?.events ?? [];

  const lane = useMemo(
    () =>
      record
        ? laneForDomain(record.domain)
        : inferLane({ summary: issue.summary, labels: issue.labels }),
    [record, issue.summary, issue.labels],
  );
  const steps = useMemo(() => stepsForLane(lane), [lane]);
  const states = useMemo(() => stepStates(steps, events, hasRun), [steps, events, hasRun]);

  const defaultStepId = useMemo(() => {
    const currentIndex = states.findIndex((state) => state === "current");
    if (currentIndex !== -1) return steps[currentIndex]?.id ?? null;
    if (states.length > 0 && states.every((state) => state === "done")) {
      return steps[steps.length - 1]?.id ?? null;
    }
    return steps[0]?.id ?? null;
  }, [steps, states]);
  const activeStepId = expandedStep ?? defaultStepId;
  const activeStep = steps.find((step) => step.id === activeStepId) ?? steps[0] ?? null;
  const activeIndex = activeStep === null ? -1 : steps.indexOf(activeStep);
  const activeState = activeIndex >= 0 ? states[activeIndex] ?? "future" : "future";
  const activeStepEvents = activeStep === null ? [] : eventsForStep(activeStep, events);

  // Bring the freshly selected panel into view after it renders.
  useEffect(() => {
    if (expandedStep === null) return;
    panelRefs.current.get(expandedStep)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [expandedStep]);

  const relatedApprovals = useMemo(
    () =>
      approvals.filter((approval) => {
        if (record && approval.caseId === record.id) return true;
        return approval.action["ticketKey"] === issue.key;
      }),
    [approvals, record, issue.key],
  );

  const resultLinks = useMemo(() => {
    const links = record ? collectHttpsLinks(events.map((event) => event.payload)) : [];
    const browse = safeBrowseUrl(issue.browse_url);
    return browse === "#" ? links : [browse, ...links.filter((link) => link !== browse)];
  }, [record, events, issue.browse_url]);

  async function decide(id: string, decision: "approved" | "rejected"): Promise<void> {
    setDecidingId(id);
    try {
      await onDecide(id, decision);
    } finally {
      setDecidingId(null);
    }
  }

  function focusStep(step: LaneStep): void {
    setExpandedStep(step.id);
  }

  return (
    <section id="ticket-view" className="ticket-view">
      <header className="ticket-view-header">
        <div>
          <p className="ticket-key">{issue.key}</p>
          <h2>{issue.summary}</h2>
          <p className="ticket-view-meta">
            {[issue.status, issue.issue_type, issue.priority, issue.assignee ?? "Unassigned"]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="ticket-view-actions">
          {record ? (
            <span className="run-badge">
              {`Case ${record.id.slice(0, 8)} · ${record.status}`}
              {record.cost_usd_micro > 0 ? ` · ${formatCost(record.cost_usd_micro)}` : ""}
            </span>
          ) : null}
        </div>
      </header>

      {caseState.status === "loading" && (
        <p className="ticket-notice" role="status">
          Loading the run record…
        </p>
      )}
      {caseState.status === "missing" && (
        <p className="ticket-notice">
          No case has been opened for this ticket yet — starting a run opens one automatically.
        </p>
      )}
      {caseState.status === "error" && (
        <p className="ticket-notice">
          The case record could not be loaded. Sign out and back in, then open the tab again.
        </p>
      )}

      {runs.length > 0 ? (
        <RunPanel
          issue={issue}
          runs={runs}
          debugOpen={debugOpen}
          onToggleDebug={() => setDebugOpen((open) => !open)}
          onRunsChanged={() => void refreshRuns()}
          onActiveRun={setActiveRun}
        />
      ) : (
        <>
          {(caseState.status === "ready" || caseState.status === "missing") && (
            <StartRunCard
              issue={issue}
              caseId={caseState.status === "ready" ? caseState.record.id : null}
              onStarted={() => {
                void refreshRuns();
                setCaseTick((tick) => tick + 1);
              }}
            />
          )}

          <div className="stepper-row">
            <ol className="stepper" aria-label="Run steps">
              {steps.map((step, index) => {
                const state = states[index] ?? "future";
                return (
                  <li key={step.id} className={`step step-${state}`}>
                    <button
                      type="button"
                      className="step-button"
                      aria-expanded={activeStepId === step.id}
                      onClick={() => focusStep(step)}
                    >
                      <span className="step-dot" aria-hidden="true">
                        {state === "done" ? "✓" : index + 1}
                      </span>
                      <span className="step-label">
                        {step.label}
                        <span className="sr-only">{` — ${STEP_STATE_COPY[state]}`}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <button
              type="button"
              className="debug-toggle"
              aria-expanded={debugOpen}
              onClick={() => setDebugOpen((open) => !open)}
            >
              <IconCode />
              <span>Debug Info</span>
            </button>
          </div>

          <div className="step-panels">
            {activeStep === null ? null : (
              <section
                className="step-panel expanded"
                ref={(node) => {
                  if (node) panelRefs.current.set(activeStep.id, node);
                  else panelRefs.current.delete(activeStep.id);
                }}
              >
                <header>
                  <button
                    type="button"
                    className="step-panel-toggle"
                    aria-expanded
                    onClick={() => focusStep(activeStep)}
                  >
                    <span className={`step-state state-${activeState}`}>
                      {STEP_STATE_COPY[activeState]}
                    </span>
                    <h3>{activeStep.label}</h3>
                  </button>
                </header>
                <div className="step-panel-body">
                  {activeStep.id === "input" && (
                    <dl className="ticket-facts">
                      {ticketFacts(issue).map((fact) => (
                        <div key={fact.label} className="fact-row">
                          <dt>{fact.label}</dt>
                          <dd>{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {activeStep.id === "gate" && (
                    <div className="gate-list">
                      {relatedApprovals.length === 0 ? (
                        <p className="step-empty">No approval gate has been raised for this case yet.</p>
                      ) : (
                        relatedApprovals.map((approval) => (
                          <article key={approval.id} className="gate-card">
                            <p className="gate-meta">
                              {`Scope ${approval.scope} · approver ${approval.approver} · expires ${formatTimestamp(approval.expiresAt)}`}
                            </p>
                            <pre className="event-payload">
                              {JSON.stringify(approval.action, null, 2)}
                            </pre>
                            <p className="gate-evidence">
                              {`Evidence: ${
                                approval.evidence
                                  .map((item) => `${item.sourceId}:${item.span}`)
                                  .join(", ") || "none"
                              }`}
                            </p>
                            {approval.decision === null ? (
                              <div className="gate-actions">
                                <button
                                  type="button"
                                  className="approve"
                                  disabled={decidingId !== null}
                                  onClick={() => void decide(approval.id, "approved")}
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  disabled={decidingId !== null}
                                  onClick={() => void decide(approval.id, "rejected")}
                                >
                                  Reject
                                </button>
                              </div>
                            ) : (
                              <strong className="gate-decision">
                                {`Decision: ${approval.decision}${
                                  approval.decidedAt ? ` · ${formatTimestamp(approval.decidedAt)}` : ""
                                }`}
                              </strong>
                            )}
                          </article>
                        ))
                      )}
                    </div>
                  )}

                  {activeStep.id !== "input" && activeStep.id !== "gate" && (
                    <div className="step-events">
                      {activeStepEvents.length === 0 ? (
                        <p className="step-empty">No data recorded for this step yet.</p>
                      ) : (
                        activeStepEvents.map((event) => (
                          <EventPayload key={`${event.kind}-${event.created_at}-${event.actor}`} event={event} />
                        ))
                      )}
                    </div>
                  )}

                  {activeStep.id === "results" && resultLinks.length > 0 && (
                    <ul className="result-links">
                      {resultLinks.map((link) => (
                        <li key={link}>
                          <a href={link} target="_blank" rel="noopener noreferrer">
                            {link}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}

                  {activeStep.id === "input" && record && (
                    <p className="step-summary">
                      {`Lane ${lane} · case ${record.id} · status ${record.status}`}
                    </p>
                  )}
                </div>
              </section>
            )}
          </div>
        </>
      )}

      {debugOpen && (
        <div className="debug-drawer" id="debug-drawer">
          <header>
            <h3>Case and run JSON</h3>
            <button type="button" onClick={() => setDebugOpen(false)}>
              Close
            </button>
          </header>
          <pre>
            {JSON.stringify(
              {
                case: record ?? { note: "No case record loaded for this ticket." },
                runs,
                activeRun,
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </section>
  );
}
