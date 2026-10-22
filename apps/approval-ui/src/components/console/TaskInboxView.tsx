"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { ApiError } from "@/lib/api";
import { DECIDE_HINT } from "@/lib/roles";
import {
  decideRunStep,
  getRunTopology,
  listRunsPage,
  workflowLabel,
  type RunDecision,
  type RunSummary,
  type RunTopology,
} from "@/lib/runs";
import {
  INBOX_STATUS_COPY,
  buildInboxTasks,
  sortInboxTasks,
  waitLabel,
  type InboxTask,
} from "@/lib/taskInbox";

import {
  IconActivity,
  IconArrowRight,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconFileText,
  IconLock,
  IconRefresh,
  IconXCircle,
} from "./icons";

const INBOX_PAGE_LIMIT = 50;
const INBOX_SKELETON_CARDS = 4;

export type InboxTicket = { key: string; summary: string };

/** Deep link the inbox hands to the Console (opens the run inspector tab). */
export type InboxRunRef = {
  runId: string;
  workflow: string;
  ticketKey?: string;
  focusStepId?: string;
};

export type InboxDecisionResult = {
  task: InboxTask;
  /** `receipt` when a signed receipt came back, `cancelled` for an abort. */
  kind: "receipt" | "cancelled";
  receipt: string | null;
};

type InboxState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; tasks: InboxTask[] };

function inboxErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sign in with a role that can view runs.";
    }
    return `The task inbox could not be loaded (API ${error.status}).`;
  }
  return "The task inbox could not be loaded.";
}

function decisionErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "The run advanced or the lock changed — refreshing the inbox.";
    if (error.status === 403) {
      return "Your account cannot make this decision (approver role required).";
    }
    if (error.status === 404) return "That run or step no longer exists.";
    return `The decision was rejected (${error.status}).`;
  }
  return "The decision could not reach the API.";
}

function shortReceipt(receipt: string): string {
  return receipt.length > 12 ? `${receipt.slice(0, 12)}…` : receipt;
}

export type TaskInboxListProps = {
  tasks: readonly InboxTask[];
  tickets: ReadonlyArray<InboxTicket>;
  canDecide: boolean;
  /** The run whose decision is in flight; every card locks while it posts. */
  busyRunId: string | null;
  /** The card armed for a second-click reject. */
  armedRunId: string | null;
  now: number;
  lastResult: InboxDecisionResult | null;
  actionError: string | null;
  onConfirm: (task: InboxTask) => void;
  onEdit: (task: InboxTask) => void;
  onReject: (task: InboxTask) => void;
  onRetryLock: (task: InboxTask) => void;
  onOpenRun: (task: InboxTask) => void;
  onOpenTicket: (task: InboxTask) => void;
};

function TaskCard({
  task,
  ticket,
  canDecide,
  busy,
  armed,
  now,
  index,
  onConfirm,
  onEdit,
  onReject,
  onRetryLock,
  onOpenTicket,
}: {
  task: InboxTask;
  ticket: InboxTicket | undefined;
  canDecide: boolean;
  busy: boolean;
  armed: boolean;
  now: number;
  index: number;
  onConfirm: (task: InboxTask) => void;
  onEdit: (task: InboxTask) => void;
  onReject: (task: InboxTask) => void;
  onRetryLock: (task: InboxTask) => void;
  onOpenTicket: (task: InboxTask) => void;
}) {
  const awaiting = task.status === "awaiting_human";
  const canAct = canDecide && task.stepId !== null && !busy;
  const title = canDecide ? (busy ? "A decision is already posting…" : undefined) : DECIDE_HINT;
  const rest = task.stepCount - task.stepsDone;
  return (
    <article className="inbox-card anim-fade-up" style={{ "--i": index } as CSSProperties}>
      <header className="inbox-head">
        <button
          type="button"
          className="inbox-ticket"
          title="Open the ticket"
          onClick={() => onOpenTicket(task)}
        >
          <IconFileText />
          <span>{task.ticketKey}</span>
        </button>
        <span className={`inbox-status st-${task.status}`}>{INBOX_STATUS_COPY[task.status]}</span>
      </header>
      {ticket !== undefined && ticket.summary !== "" ? (
        <p className="inbox-summary">{ticket.summary}</p>
      ) : null}
      <p className="inbox-what">
        <strong>{task.stepTitle ?? task.stepId ?? "Waiting on a human step"}</strong>
        <span className="inbox-wait">
          <IconClock />
          {waitLabel(task, now)}
        </span>
      </p>
      <p className="inbox-meta">
        <span>{workflowLabel(task.workflow)}</span>
        <span className="num">{`${task.stepsDone}/${task.stepCount} steps`}</span>
        {rest > 0 ? <span className="num">{`${rest} to go`}</span> : null}
        {task.receipts > 0 ? (
          <span>{`${task.receipts} receipt${task.receipts === 1 ? "" : "s"} signed`}</span>
        ) : null}
        {!awaiting && task.lockTarget !== null ? (
          <span className="inbox-lock">{`Lock ${task.lockTarget}`}</span>
        ) : null}
      </p>
      <div className="inbox-actions">
        {awaiting ? (
          <button
            type="button"
            className="inbox-confirm"
            disabled={!canAct}
            title={title}
            onClick={() => onConfirm(task)}
          >
            <IconCheck />
            <span>Confirm</span>
          </button>
        ) : (
          <button
            type="button"
            className="inbox-confirm"
            disabled={!canAct}
            title={title}
            onClick={() => onRetryLock(task)}
          >
            <IconRefresh />
            <span>Retry lock</span>
          </button>
        )}
        <button type="button" disabled={!canAct} title={title} onClick={() => onEdit(task)}>
          <span>Edit</span>
        </button>
        <button
          type="button"
          className={armed ? "danger armed" : "danger"}
          disabled={!canAct}
          title={title}
          onClick={() => onReject(task)}
        >
          <IconXCircle />
          <span>{armed ? "Confirm reject" : "Reject"}</span>
        </button>
      </div>
    </article>
  );
}

/**
 * The presentational queue: result/error notes above a card per inbox task.
 * Exported so tests render fixed tasks without the fetch layer.
 */
export function TaskInboxList({
  tasks,
  tickets,
  canDecide,
  busyRunId,
  armedRunId,
  now,
  lastResult,
  actionError,
  onConfirm,
  onEdit,
  onReject,
  onRetryLock,
  onOpenRun,
  onOpenTicket,
}: TaskInboxListProps) {
  const ticketIndex = useMemo(
    () => new Map(tickets.map((ticket) => [ticket.key, ticket] as const)),
    [tickets],
  );
  return (
    <>
      {lastResult !== null ? (
        <p className={`inbox-result ${lastResult.kind}`} role="status">
          {lastResult.kind === "receipt" ? <IconCheckCircle /> : <IconXCircle />}
          <span>
            {lastResult.kind === "receipt" && lastResult.receipt !== null
              ? `Receipt signed · ${shortReceipt(lastResult.receipt)} — verifiable in ${
                  lastResult.task.ticketKey === ""
                    ? "the run's timeline"
                    : `${lastResult.task.ticketKey}'s timeline`
                }.`
              : `Run for ${lastResult.task.ticketKey} was rejected and cancelled.`}
          </span>
          <button type="button" className="inbox-result-link" onClick={() => onOpenRun(lastResult.task)}>
            Open run
            <IconArrowRight />
          </button>
        </p>
      ) : null}

      {actionError !== null ? (
        <p className="inbox-error" role="alert">
          <IconLock />
          <span>{actionError}</span>
        </p>
      ) : null}

      {tasks.length === 0 ? (
        <div className="view-hold">
          <IconCheckCircle />
          <strong>Inbox zero</strong>
          <p>
            No runs are waiting on a human decision. Gates land here the moment a run
            suspends; stalls land here when a lock blocks progress.
          </p>
        </div>
      ) : (
        <section className="inbox-list" aria-live="polite" aria-label="Runs waiting on you">
          {tasks.map((task, index) => (
            <TaskCard
              key={task.runId}
              task={task}
              ticket={ticketIndex.get(task.ticketKey)}
              canDecide={canDecide}
              busy={busyRunId !== null}
              armed={armedRunId === task.runId}
              now={now}
              index={index}
              onConfirm={onConfirm}
              onEdit={onEdit}
              onReject={onReject}
              onRetryLock={onRetryLock}
              onOpenTicket={onOpenTicket}
            />
          ))}
        </section>
      )}
    </>
  );
}

/**
 * U4 task inbox — the cross-ticket queue of runs waiting on a human: awaiting
 * gates and blocked stalls as what/who/when cards. Confirm and Reject post to
 * the run's existing decision endpoint (Confirm signs a receipt the run's
 * timeline shows); Edit deep-links to the run inspector at that step. The
 * inbox adds no execution path of its own.
 */
export function TaskInboxView({
  tickets = [],
  canDecide = true,
  onOpenRun,
  onOpenTicket,
}: {
  tickets?: ReadonlyArray<InboxTicket>;
  canDecide?: boolean;
  onOpenRun?: (run: InboxRunRef) => void;
  onOpenTicket?: (ticket: InboxTicket) => void;
}) {
  const [state, setState] = useState<InboxState>({ phase: "loading" });
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [armedRunId, setArmedRunId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<InboxDecisionResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const [awaiting, blocked] = await Promise.all([
          listRunsPage({ scope: "active", status: "awaiting_human", limit: INBOX_PAGE_LIMIT }),
          listRunsPage({ scope: "active", status: "blocked", limit: INBOX_PAGE_LIMIT }),
        ]);
        const runs: RunSummary[] = [...awaiting.runs, ...blocked.runs];
        const settled = await Promise.allSettled(runs.map((run) => getRunTopology(run.runId)));
        if (cancelled) return;
        const topologies = new Map<string, RunTopology>();
        settled.forEach((result, index) => {
          const run = runs[index];
          if (run === undefined) return;
          // Stale or malformed overlays drop; the card still renders from the summary.
          if (result.status === "fulfilled" && result.value !== null && result.value.runId === run.runId) {
            topologies.set(run.runId, result.value);
          }
        });
        setNow(Date.now());
        setState({ phase: "ready", tasks: sortInboxTasks(buildInboxTasks(runs, topologies)) });
      } catch (error) {
        if (!cancelled) setState({ phase: "error", message: inboxErrorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  async function decide(task: InboxTask, decision: RunDecision): Promise<void> {
    if (task.stepId === null || busyRunId !== null) return;
    setBusyRunId(task.runId);
    setActionError(null);
    try {
      const result = await decideRunStep(task.runId, task.stepId, decision);
      setArmedRunId(null);
      setLastResult({
        task,
        kind: result.receipt === null ? "cancelled" : "receipt",
        receipt: result.receipt,
      });
      // The decided run leaves (or moves inside) the queue: refetch it.
      setTick((value) => value + 1);
    } catch (error) {
      setArmedRunId(null);
      setActionError(decisionErrorCopy(error));
      if (error instanceof ApiError && error.status === 409) {
        setTick((value) => value + 1);
      }
    } finally {
      setBusyRunId(null);
    }
  }

  function openRunForTask(task: InboxTask): void {
    onOpenRun?.({
      runId: task.runId,
      workflow: task.workflow,
      ...(task.ticketKey === "" ? {} : { ticketKey: task.ticketKey }),
      ...(task.stepId === null ? {} : { focusStepId: task.stepId }),
    });
  }

  function openTicketForTask(task: InboxTask): void {
    const summary = tickets.find((ticket) => ticket.key === task.ticketKey)?.summary;
    onOpenTicket?.({ key: task.ticketKey, summary: summary ?? task.ticketKey });
  }

  function confirmTask(task: InboxTask): void {
    void decide(task, { action: "proceed" });
  }

  /** Abort is irreversible: the first click arms, the second confirms. */
  function rejectTask(task: InboxTask): void {
    if (armedRunId !== task.runId) {
      setArmedRunId(task.runId);
      return;
    }
    void decide(task, { action: "abort" });
  }

  function retryLockTask(task: InboxTask): void {
    void decide(task, { action: "retry_lock" });
  }

  // Edit is a deep link, never an inline post: the full edit surface lives in
  // the run inspector's step form.
  function editTask(task: InboxTask): void {
    openRunForTask(task);
  }

  const loading = state.phase === "loading";

  return (
    <section id="inbox-view" className="panel-view" aria-label="Task inbox">
      <div className="panel-heading">
        <p className="eyebrow">Human work</p>
        <h2>Task inbox</h2>
        <p className="panel-note">
          Every run waiting on a human, cross-ticket: awaiting gates first, then blocked
          stalls, oldest wait on top. Confirm signs the receipt inside that run's timeline.
        </p>
      </div>

      <div className="inbox-toolbar">
        <button
          type="button"
          className="wf-secondary"
          disabled={loading}
          onClick={() => setTick((value) => value + 1)}
        >
          <IconRefresh className={loading ? "spin" : undefined} />
          Refresh
        </button>
        {state.phase === "ready" && state.tasks.length > 0 ? (
          <span className="sprint-badge">{`${state.tasks.length} waiting`}</span>
        ) : null}
      </div>

      {state.phase === "loading" && (
        <div className="inbox-skeleton" role="status" aria-label="Loading the task inbox">
          {Array.from({ length: INBOX_SKELETON_CARDS }, (_, index) => (
            <div key={index} className="skeleton inbox-skeleton-card" />
          ))}
        </div>
      )}

      {state.phase === "error" && (
        <div className="view-hold" role="alert">
          <IconActivity />
          <strong>Inbox unavailable</strong>
          <p>{state.message}</p>
          <button type="button" className="wf-secondary" onClick={() => setTick((value) => value + 1)}>
            <IconRefresh />
            Retry
          </button>
        </div>
      )}

      {state.phase === "ready" && (
        <TaskInboxList
          tasks={state.tasks}
          tickets={tickets}
          canDecide={canDecide}
          busyRunId={busyRunId}
          armedRunId={armedRunId}
          now={now}
          lastResult={lastResult}
          actionError={actionError}
          onConfirm={confirmTask}
          onEdit={editTask}
          onReject={rejectTask}
          onRetryLock={retryLockTask}
          onOpenRun={openRunForTask}
          onOpenTicket={openTicketForTask}
        />
      )}
    </section>
  );
}
