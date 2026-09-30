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
import { DECIDE_HINT } from "@/lib/roles";
import { listRuns, type RunDetail, type RunSummary } from "@/lib/runs";

import {
  IconCheck,
  IconCode,
  IconClose,
  IconExternalLink,
  IconLock,
  IconXCircle,
} from "./icons";
import { JsonView } from "./JsonView";
import { PayloadView } from "./PayloadView";
import { RunInspector } from "./RunInspector";
import { StartRunCard, StepRail } from "./RunPanel";

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

/** Flags gates that expire within the half hour so their card can emphasize it. */
function expirySoon(value: string): boolean {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const diff = date.getTime() - Date.now();
  return diff > 0 && diff < 30 * 60 * 1000;
}

function EventPayload({ event }: { event: CaseEvent }) {
  return (
    <article className="step-event">
      <header>
        <span className="event-kind">{event.kind}</span>
        <span className="event-actor">{event.actor}</span>
        <span className="event-time">{formatTimestamp(event.created_at)}</span>
      </header>
      <div className="event-payload">
        <PayloadView value={event.payload} />
      </div>
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
  canDecide = true,
  canStart = true,
}: {
  issue: JiraIssue;
  approvals: Approval[];
  onDecide: (id: string, decision: "approved" | "rejected") => Promise<void>;
  /** False disables the gate buttons; the server stays source of truth. */
  canDecide?: boolean;
  /** False disables the run launcher; the server stays source of truth. */
  canStart?: boolean;
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
          <span className="spinner" aria-hidden="true" />
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
        <RunInspector
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
              canStart={canStart}
            />
          )}

          <div className="run-workbench">
            <div className="ticket-rail-col">
              <StepRail
                label="Run steps"
                steps={steps.map((step, index) => ({
                  id: step.id,
                  title: step.label,
                  state: states[index] ?? "future",
                }))}
                activeId={activeStepId}
                onSelect={(id) => {
                  const step = steps.find((item) => item.id === id);
                  if (step !== undefined) focusStep(step);
                }}
              />
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

            {activeStep === null ? null : (
              <section
                className="run-step-view anim-fade-up"
                key={activeStep.id}
                ref={(node) => {
                  if (node) panelRefs.current.set(activeStep.id, node);
                  else panelRefs.current.delete(activeStep.id);
                }}
              >
                <header className="run-step-head">
                  <span className={`step-state state-${activeState}`}>
                    {STEP_STATE_COPY[activeState]}
                  </span>
                  <h3>{activeStep.label}</h3>
                  <span className="run-step-meta">
                    {`Step ${activeIndex + 1} of ${steps.length}`}
                  </span>
                </header>
                <div className="run-step-body">
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
                            <header className="gate-card-head">
                              <span
                                className={`gate-status ${
                                  approval.decision === null
                                    ? "gate-pending"
                                    : approval.decision === "approved"
                                      ? "gate-approved"
                                      : "gate-rejected"
                                }`}
                              >
                                {approval.decision === null
                                  ? "Pending"
                                  : approval.decision === "approved"
                                    ? "Approved"
                                    : "Rejected"}
                              </span>
                              <div className="gate-meta">
                                <span>{`Scope ${approval.scope}`}</span>
                                <span>{`Approver ${approval.approver}`}</span>
                                <span
                                  className={
                                    expirySoon(approval.expiresAt)
                                      ? "gate-expiry soon"
                                      : "gate-expiry"
                                  }
                                >
                                  {`Expires ${formatTimestamp(approval.expiresAt)}`}
                                </span>
                              </div>
                            </header>
                            <div className="event-payload gate-action">
                              <PayloadView value={approval.action} />
                            </div>
                            <p className="gate-evidence">
                              <span className="gate-evidence-label">Evidence:</span>
                              {approval.evidence.length === 0 ? (
                                <span className="evidence-chip evidence-none">none</span>
                              ) : (
                                approval.evidence.map((item) => (
                                  <span
                                    key={`${item.sourceId}:${item.span}`}
                                    className="evidence-chip" title={`${item.sourceId}:${item.span}`}
                                  >
                                    {`${item.sourceId}:${item.span}`}
                                  </span>
                                ))
                              )}
                            </p>
                            {approval.decision === null ? (
                              <>
                                <div className="gate-actions">
                                  <button
                                    type="button"
                                    className="approve"
                                    disabled={decidingId !== null || !canDecide}
                                    title={canDecide ? undefined : DECIDE_HINT}
                                    onClick={() => void decide(approval.id, "approved")}
                                  >
                                    <IconCheck />
                                    <span>Approve</span>
                                  </button>
                                  <button
                                    type="button"
                                    disabled={decidingId !== null || !canDecide}
                                    title={canDecide ? undefined : DECIDE_HINT}
                                    onClick={() => void decide(approval.id, "rejected")}
                                  >
                                    <IconXCircle />
                                    <span>Reject</span>
                                  </button>
                                </div>
                                {!canDecide && (
                                  <p className="role-hint" role="note">
                                    <IconLock />
                                    {DECIDE_HINT}
                                  </p>
                                )}
                              </>
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
                            <IconExternalLink />
                            <span>{link}</span>
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
              <IconClose />
              <span>Close</span>
            </button>
          </header>
          <JsonView
            value={{
              case: record ?? { note: "No case record loaded for this ticket." },
              runs,
              activeRun,
            }}
          />
        </div>
      )}
    </section>
  );
}
