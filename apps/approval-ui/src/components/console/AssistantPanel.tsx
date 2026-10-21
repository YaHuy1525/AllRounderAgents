"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ApiError, api } from "@/lib/api";
import { compactTickets } from "@/lib/board";
import { laneForWorkflow, type LaneId } from "@/lib/cases";
import {
  addContextChip,
  blockersReply,
  buildChatRequest,
  CHAT_AGENTS,
  createTaskReply,
  draftReply,
  ensureRunContextChip,
  parseCreateTaskIntent,
  quickActionsFor,
  removeContextChip,
  runContextSuffix,
  shortRunId,
  summarizeRunReply,
  type ChatAction,
  type ChatLink,
  type ChatReply,
  type ChatTaskDraft,
  type ChatTicket,
  type ContextChip,
} from "@/lib/chat";
import {
  getRun,
  getRunTopology,
  listRuns,
  listRunsPage,
  openCase,
  sortRunsNewestFirst,
  startRun,
  type RunDetail,
  type RunSummary,
  type RunTopology,
} from "@/lib/runs";
import { buildInboxTasks } from "@/lib/taskInbox";

import {
  IconActivity,
  IconBot,
  IconClose,
  IconFileText,
  IconLock,
  IconPlus,
  IconSend,
  IconSparkles,
} from "./icons";
import { Markdown } from "./Markdown";
import { TICKET_DRAG_TYPE } from "./TicketCard";

type ChatMessage = {
  role: "user" | "assistant";
  body: string;
  source?: string;
  links?: ChatLink[];
  task?: ChatTaskDraft;
};
type CompactTicket = ReturnType<typeof compactTickets>[number];

/** Icon per quick-action kind, falling back to the sparkles mark. */
const ACTION_ICONS: Record<string, typeof IconActivity> = {
  "summarize-run": IconActivity,
  "list-blockers": IconLock,
  "create-task": IconPlus,
  draft: IconFileText,
};

/** Icon per link kind; run and step links open the run panel. */
const LINK_ICONS: Record<string, typeof IconActivity> = {
  run: IconActivity,
  step: IconActivity,
  receipt: IconFileText,
  ticket: IconFileText,
  inbox: IconLock,
};

function chatTicket(ticket: CompactTicket): ChatTicket {
  return {
    key: ticket.key,
    summary: ticket.summary,
    status: ticket.status,
    issueType: ticket.issue_type,
    priority: ticket.priority,
    assignee: ticket.assignee,
    labels: ticket.labels,
  };
}

/**
 * Always-visible assistant rail (upgrade U8). The shell stays: tickets land
 * here as removable context chips and free text posts to /chat with the
 * board snapshot. On top of that the rail is lane-aware — quick actions swap
 * per lane, "summarize this run" / "list blockers" / drafts answer locally
 * (deterministically, from the run the ticket is looking at), every answer
 * carries run:step deep links plus receipt refs, and "create task" drafts a
 * task whose confirm starts a run through the existing writers: it parks at
 * its first checkpoint, which is exactly where the U4 inbox picks it up.
 */
export function AssistantPanel({
  tickets,
  selectedKey,
  onOpenRun,
  onOpenTicket,
  onOpenInbox,
}: {
  tickets: CompactTicket[];
  selectedKey?: string;
  onOpenRun: (run: {
    runId: string;
    workflow: string;
    ticketKey?: string;
    focusStepId?: string;
  }) => void;
  onOpenTicket: (ticketKey: string) => void;
  onOpenInbox: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [agent, setAgent] = useState<string>(CHAT_AGENTS[0].id);
  const [chips, setChips] = useState<ContextChip[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [context, setContext] = useState<{ run: RunSummary; detail: RunDetail | null } | null>(null);
  const [contextTick, setContextTick] = useState(0);
  const [taskBusy, setTaskBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const selectedTicket = useMemo(
    () =>
      selectedKey === undefined ? null : tickets.find((item) => item.key === selectedKey) ?? null,
    [tickets, selectedKey],
  );

  // The lane comes from the newest run's workflow; a ticket without runs
  // keeps the neutral action set. The context powers every local answer.
  const lane: LaneId =
    context === null ? "generic" : laneForWorkflow(context.run.workflow) ?? "generic";
  const quickActions = quickActionsFor(lane, {
    hasTicket: selectedTicket !== null,
    hasRun: context !== null,
  });

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  // Newest run for the selected ticket, plus its detail when the server
  // answers — the summary alone still feeds the deterministic answers.
  useEffect(() => {
    if (selectedKey === undefined || selectedKey === "") {
      setContext(null);
      return undefined;
    }
    let cancelled = false;
    setContext(null);
    listRuns(selectedKey)
      .then(async (runs) => {
        const newest = sortRunsNewestFirst(runs)[0];
        if (newest === undefined || cancelled) return;
        let detail: RunDetail | null = null;
        try {
          detail = await getRun(newest.runId);
        } catch {
          detail = null; // The summary lane still answers.
        }
        if (!cancelled) setContext({ run: newest, detail });
      })
      .catch(() => {
        if (!cancelled) setContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, contextTick]);

  // The selected ticket's chip carries its run:step context (U8); the
  // helper is idempotent, so re-running this effect never duplicates work.
  useEffect(() => {
    if (selectedKey === undefined || selectedKey === "" || context === null) return;
    const summary = selectedTicket?.summary ?? "";
    setChips((current) =>
      ensureRunContextChip(current, {
        key: selectedKey,
        summary,
        run: { runId: context.run.runId, currentStepId: context.run.currentStepId },
      }),
    );
  }, [selectedKey, selectedTicket, context]);

  function pushReply(reply: ChatReply): void {
    setMessages((previous) => [
      ...previous,
      {
        role: "assistant",
        body: reply.body,
        source: reply.source,
        links: reply.links,
        ...(reply.task === undefined ? {} : { task: reply.task }),
      },
    ]);
  }

  /** The context links every free-text answer carries. */
  function contextLinks(): ChatLink[] {
    if (selectedTicket === null) return [];
    const links: ChatLink[] = [
      { kind: "ticket", label: `Open ${selectedTicket.key}`, ticketKey: selectedTicket.key },
    ];
    if (context !== null) {
      const { runId, workflow, currentStepId } = context.run;
      links.push({
        kind: "run",
        label: `Open run ${shortRunId(runId)}`,
        runId,
        workflow,
        ticketKey: selectedTicket.key,
      });
      if (currentStepId !== null && currentStepId !== "") {
        links.push({
          kind: "step",
          label: `${currentStepId} (waiting step)`,
          runId,
          workflow,
          ticketKey: selectedTicket.key,
          stepId: currentStepId,
        });
      }
    }
    return links;
  }

  function openLink(link: ChatLink): void {
    if (link.kind === "inbox") {
      onOpenInbox();
      return;
    }
    if (link.kind === "ticket") {
      if (link.ticketKey !== undefined) onOpenTicket(link.ticketKey);
      return;
    }
    if (link.runId !== undefined) {
      onOpenRun({
        runId: link.runId,
        workflow: link.workflow ?? "",
        ...(link.ticketKey === undefined ? {} : { ticketKey: link.ticketKey }),
        ...(link.stepId === undefined ? {} : { focusStepId: link.stepId }),
      });
    }
  }

  /** Quick actions answer locally — no run data ever rides the /chat body. */
  async function runAction(action: ChatAction): Promise<void> {
    if (sending || selectedTicket === null) return;
    setMessages((previous) => [...previous, { role: "user", body: action.prompt }]);
    if (action.kind === "summarize-run") {
      if (context === null) {
        pushReply({
          body: `No run has been started for ${selectedTicket.key} yet.`,
          source: "local · run summary",
          links: [
            { kind: "ticket", label: `Open ${selectedTicket.key}`, ticketKey: selectedTicket.key },
          ],
        });
        return;
      }
      pushReply(
        summarizeRunReply({
          ticket: chatTicket(selectedTicket),
          run: context.run,
          detail: context.detail,
        }),
      );
      return;
    }
    if (action.kind === "create-task") {
      pushReply(createTaskReply({ ticket: chatTicket(selectedTicket), taskText: "" }));
      return;
    }
    if (action.kind === "draft") {
      pushReply(
        draftReply({
          actionId: action.id,
          ticket: chatTicket(selectedTicket),
          run: context?.run ?? null,
          detail: context?.detail ?? null,
        }),
      );
      return;
    }
    setSending(true);
    try {
      const [awaiting, blocked] = await Promise.all([
        listRunsPage({ scope: "active", status: "awaiting_human", limit: 25 }),
        listRunsPage({ scope: "active", status: "blocked", limit: 25 }),
      ]);
      const runs = [...awaiting.runs, ...blocked.runs];
      const topologies = new Map<string, RunTopology>();
      await Promise.all(
        runs.slice(0, 10).map(async (item) => {
          const topology = await getRunTopology(item.runId).catch(() => null);
          if (topology !== null) topologies.set(item.runId, topology);
        }),
      );
      pushReply(blockersReply(buildInboxTasks(runs, topologies)));
    } catch {
      pushReply({
        body: "The blockers could not be loaded just now.",
        source: "local · inbox",
        links: [{ kind: "inbox", label: "Open the Task Inbox" }],
      });
    } finally {
      setSending(false);
    }
  }

  async function send(prompt?: string): Promise<void> {
    const message = (prompt ?? draft).trim();
    if (!message || sending) return;
    setDraft("");
    setMessages((previous) => [...previous, { role: "user", body: message }]);

    // "create task[: …]" rides the local lane — task intent becomes a
    // confirmable draft instead of a model answer.
    const intent = parseCreateTaskIntent(message);
    if (intent !== null && selectedTicket !== null) {
      pushReply(createTaskReply({ ticket: chatTicket(selectedTicket), taskText: intent.text }));
      inputRef.current?.focus();
      return;
    }

    setSending(true);
    try {
      const payload = buildChatRequest({ message, agent, chips, tickets, selectedKey });
      const result = await api<{ reply: string; source?: string }>("/chat", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          body: result.reply,
          source: result.source,
          links: contextLinks(),
        },
      ]);
    } catch (error) {
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          body:
            error instanceof ApiError && error.status === 401
              ? "Sign out and sign back in so chat can use your session."
              : "The assistant could not answer just now.",
          links: contextLinks(),
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  /**
   * Confirm a task draft: open the case (idempotent) and start the run
   * through the same writers the console's start card uses. The run parks
   * at its first checkpoint, which is where the U4 inbox surfaces it.
   */
  async function confirmTask(index: number, task: ChatTaskDraft): Promise<void> {
    if (taskBusy) return;
    setTaskBusy(true);
    try {
      const caseId = context?.detail?.caseId ?? (await openCase(task.ticketKey)).caseId;
      const run = await startRun({
        workflow: task.workflow,
        ticketKey: task.ticketKey,
        caseId,
        input: task.input,
      });
      setMessages((previous) => {
        const cleared = previous.map((item, position) =>
          position === index ? { ...item, task: undefined } : item,
        );
        return [
          ...cleared,
          {
            role: "assistant",
            body:
              `Task created — run **${shortRunId(run.runId)}** started for ${task.ticketKey} ` +
              `(**${task.workflowLabel}**). It parks at its first checkpoint, so it is now in the ` +
              `Task Inbox; every decision from there lands in its receipt trail.`,
            source: "local · task created",
            links: [
              {
                kind: "run",
                label: `Open run ${shortRunId(run.runId)}`,
                runId: run.runId,
                workflow: run.workflow,
                ticketKey: task.ticketKey,
              },
              { kind: "inbox", label: "Open the Task Inbox" },
            ],
          },
        ];
      });
      setContextTick((tick) => tick + 1);
    } catch (error) {
      pushReply({
        body:
          error instanceof ApiError && error.status === 403
            ? "Your role cannot start runs — ask an agent or admin to create the task."
            : "The task could not be created just now.",
        source: "local · task created",
        links: [{ kind: "inbox", label: "Open the Task Inbox" }],
      });
    } finally {
      setTaskBusy(false);
    }
  }

  function dismissTask(index: number): void {
    setMessages((previous) =>
      previous.map((item, position) => (position === index ? { ...item, task: undefined } : item)),
    );
  }

  function renderTaskCard(task: ChatTaskDraft, index: number): ReactNode {
    return (
      <div className="chat-task">
        <div className="chat-task-head">
          <IconPlus />
          <strong>{task.title}</strong>
        </div>
        <p className="chat-task-meta">{`${task.workflowLabel} · ${task.ticketKey}`}</p>
        {task.detail !== task.title && <p className="chat-task-detail">{task.detail}</p>}
        <div className="chat-task-actions">
          <button
            type="button"
            className="chat-task-create"
            disabled={taskBusy}
            onClick={() => void confirmTask(index, task)}
          >
            {taskBusy ? <span className="spinner on-solid" aria-hidden="true" /> : <IconPlus />}
            <span>Create task</span>
          </button>
          <button type="button" disabled={taskBusy} onClick={() => dismissTask(index)}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function handleDrop(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDropActive(false);
    const raw =
      event.dataTransfer.getData(TICKET_DRAG_TYPE) || event.dataTransfer.getData("text/plain");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { key?: unknown; summary?: unknown };
      if (typeof parsed.key !== "string") return;
      const next = addContextChip(chips, {
        key: parsed.key,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
      });
      // Invalid keys leave the chip list untouched (same reference).
      if (next !== chips) setChips(next);
    } catch {
      // Non-ticket drag payloads are ignored as context.
    }
  }

  const activeAgent = CHAT_AGENTS.find((item) => item.id === agent) ?? CHAT_AGENTS[0];

  return (
    <aside className="assistant-panel">
      <header className="assistant-header">
        <span className="assistant-brand" aria-hidden="true">
          <IconSparkles />
        </span>
        <div>
          <h2>Welcome</h2>
          <p>What would you like to work on?</p>
        </div>
      </header>

      <div className="agent-picker">
        <label htmlFor="agent-select">
          <span>Assistant</span>
        </label>
        <span className="agent-select-wrap">
          <IconBot />
          <select id="agent-select" value={agent} onChange={(event) => setAgent(event.target.value)}>
            {CHAT_AGENTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </span>
        <p className="agent-context">{`Context: ${activeAgent.label}`}</p>
      </div>

      <div id="chat-log" className="chat-log" aria-live="polite" ref={logRef}>
        {messages.length === 0 ? (
          <p className="chat-hint">
            Ask about the board, drag a ticket here for context, or pick a quick action below.
          </p>
        ) : (
          messages.map((message, index) => (
            <article
              key={`${index}-${message.role}`}
              className={`chat-row chat-${message.role} anim-fade-up`}
            >
              <Markdown text={message.body} />
              {message.task !== undefined && renderTaskCard(message.task, index)}
              {message.links !== undefined && message.links.length > 0 && (
                <div className="chat-links">
                  {message.links.map((link, position) => {
                    const LinkIcon = LINK_ICONS[link.kind] ?? IconFileText;
                    return (
                      <button
                        key={`${link.kind}-${position}-${link.stepId ?? link.runId ?? link.ticketKey ?? ""}`}
                        type="button"
                        onClick={() => openLink(link)}
                      >
                        <LinkIcon />
                        <span>{link.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {message.source ? (
                <span className="chat-source">
                  <IconFileText />
                  {message.source}
                </span>
              ) : null}
            </article>
          ))
        )}
        {sending && (
          <article className="chat-row chat-assistant chat-typing" aria-label="Assistant is typing">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </article>
        )}
      </div>

      <form
        id="chat-form"
        className={`assistant-input${dropActive ? " drop-active" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={handleDrop}
      >
        {context !== null && selectedKey !== undefined && selectedKey !== "" && (
          <div className="chat-run-context" aria-label="Run context">
            <IconActivity />
            <button
              type="button"
              onClick={() =>
                onOpenRun({
                  runId: context.run.runId,
                  workflow: context.run.workflow,
                  ticketKey: selectedKey,
                  ...(context.run.currentStepId === null
                    ? {}
                    : { focusStepId: context.run.currentStepId }),
                })
              }
            >
              {runContextSuffix(context.run)}
            </button>
          </div>
        )}
        {chips.length > 0 && (
          <div className="context-chips" aria-label="Attached ticket context">
            {chips.map((chip) => (
              <span key={chip.key} className="context-chip">
                <IconFileText className="chip-icon" />
                <span className="chip-text">{`${chip.key}: ${chip.summary}`}</span>
                <button
                  type="button"
                  aria-label={`Remove ${chip.key} from context`}
                  onClick={() => setChips((current) => removeContextChip(current, chip.key))}
                >
                  <IconClose />
                </button>
              </span>
            ))}
          </div>
        )}
        <label className="sr-only" htmlFor="chat-input">
          Message
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          placeholder="Ask me anything about your project, or drag a ticket here for context…"
          rows={4}
          maxLength={2000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {quickActions.length > 0 && (
          <div className="quick-chips">
            {quickActions.map((action) => {
              const ActionIcon = ACTION_ICONS[action.kind] ?? IconSparkles;
              return (
                <button
                  key={action.id}
                  type="button"
                  disabled={sending}
                  onClick={() => void runAction(action)}
                >
                  <ActionIcon />
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        )}
        <button id="chat-send" type="submit" disabled={sending}>
          {sending ? (
            <span className="spinner on-solid" aria-hidden="true" />
          ) : (
            <IconSend />
          )}
          <span>Send</span>
        </button>
      </form>
    </aside>
  );
}
