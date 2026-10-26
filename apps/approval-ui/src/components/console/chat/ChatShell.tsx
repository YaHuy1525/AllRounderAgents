"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import {
  appendUserTurn,
  assistantResource,
  deleteThread,
  endChatTurn,
  ensureThread,
  initialChatState,
  listThreads,
  loadMessages,
  renameThread,
  sendChat,
  startAssistantTurn,
  threadTitleFor,
  type AssistantMessage,
  type AssistantThread,
  type AssistantTicketRow,
  type ChatState,
  type ChatTurn,
} from "@/lib/assistant";
import { compactTickets } from "@/lib/board";
import {
  applyPrefill,
  buildStartInput,
  missingStartFields,
  parsePrefillReply,
  shortRunId,
  startDraftCaption,
  startDraftFromRow,
  startProblemLines,
  type ChatStartDraft,
} from "@/lib/chat-start";
import { openCase, prefillStartFields, startRun, workflowsForTicket } from "@/lib/runs";
import { listWorkflows } from "@/lib/workflows";

import { StartRunCard } from "../StartRunCard";
import { Composer } from "./Composer";
import { ThreadList } from "./ThreadList";
import { Transcript } from "./Transcript";

type CompactTicket = ReturnType<typeof compactTickets>[number];

/** One rendered assistant turn that also carries a confirmable start card. */
type StartAttachment = { turnIndex: number; draft: ChatStartDraft };

function turn(role: "user" | "assistant", body: string, error: string | null = null): ChatTurn {
  return { role, body, toolNotes: [], rows: [], error, stopped: false };
}

function turnsOf(messages: AssistantMessage[]): ChatTurn[] {
  return messages.map((message) => turn(message.role, message.body));
}

/**
 * The console's conversation: one assistant, host threads, streamed turns, and
 * the confirm card as the only writer. Nothing here decides what a message
 * means — the assistant does, by choosing a tool. This file is the seam between
 * the pure reducer in `lib/assistant.ts` and the cards the human acts on, so it
 * holds state and nothing else does.
 */
export function ChatShell({
  tickets,
  selectedKey,
  onOpenRun,
  onOpenTicket,
  onOpenInbox,
  unusable = false,
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
  unusable?: boolean;
}) {
  const [threads, setThreads] = useState<AssistantThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [state, setState] = useState<ChatState>(() => initialChatState(unusable));
  const [draft, setDraft] = useState("");
  const [resource, setResource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [taskBusy, setTaskBusy] = useState(false);
  const [starts, setStarts] = useState<StartAttachment[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setState((current) => ({ ...current, unusable }));
  }, [unusable]);

  // Session first, then threads: the resource string is what the host filters
  // every thread call by, so the sidebar cannot load before it exists.
  useEffect(() => {
    let cancelled = false;
    void assistantResource()
      .then((value) => {
        if (cancelled) return;
        setResource(value);
        setState(initialChatState(value === null));
        return value === null ? undefined : listThreads();
      })
      .then((list) => {
        if (cancelled || !list) return;
        setThreads(list);
        const newest = list[0];
        if (newest === undefined) return;
        return loadMessages(newest.id).then((messages) => {
          if (cancelled) return;
          setThreadId(newest.id);
          setState({ ...initialChatState(false), turns: turnsOf(messages) });
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The console context, sent once per conversation as the first turn's prefix.
   * It lets the assistant talk about what is on screen without the panel
   * re-submitting the board on every message.
   */
  function contextPrefix(): string {
    const visible = tickets
      .slice(0, 20)
      .map((ticket) => `${ticket.key}: ${ticket.summary} [${ticket.status}]`)
      .join("\n");
    const selected = selectedKey === undefined ? "" : `Selected ticket: ${selectedKey}.`;
    if (visible === "" && selected === "") return "";
    return `Console context (a snapshot, not the whole board):\n${visible}\n${selected}\nQuestion:\n`;
  }

  const refreshThreads = useCallback(async () => {
    setThreads(await listThreads());
  }, []);

  async function submit(): Promise<void> {
    const message = draft.trim();
    if (message === "" || state.streaming || resource === null) return;
    setDraft("");
    let targetId = threadId;
    if (targetId === null) {
      const created = await ensureThread(threadTitleFor(message));
      if (created === null) {
        setState((current) => ({
          ...current,
          streaming: false,
          turns: [
            ...current.turns,
            turn("user", message),
            turn("assistant", "", "The conversation could not be opened on the host."),
          ],
        }));
        return;
      }
      targetId = created.id;
      setThreadId(targetId);
      setThreads((current) => [created, ...current]);
    }

    const firstTurn = threadId === null;
    const text = firstTurn ? `${contextPrefix()}${message}` : message;
    const next = startAssistantTurn(appendUserTurn(state, message));
    setState(next);

    const controller = new AbortController();
    abortRef.current = controller;
    await sendChat({
      threadId: targetId,
      message: text,
      resource,
      state: next,
      signal: controller.signal,
      onState: setState,
    });
    abortRef.current = null;
    inputRef.current?.focus();
    void refreshThreads();
  }

  function stop(): void {
    abortRef.current?.abort();
    setState((current) => endChatTurn(current, "stopped"));
  }

  async function selectThread(id: string): Promise<void> {
    if (id === threadId) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setThreadId(id);
    setStarts([]);
    const messages = await loadMessages(id);
    setState({ ...initialChatState(false), turns: turnsOf(messages) });
  }

  async function newChat(): Promise<void> {
    abortRef.current?.abort();
    abortRef.current = null;
    setThreadId(null);
    setStarts([]);
    setState(initialChatState(resource === null));
    inputRef.current?.focus();
  }

  async function rename(id: string, title: string): Promise<void> {
    await renameThread(id, title);
    await refreshThreads();
  }

  async function remove(id: string): Promise<void> {
    await deleteThread(id);
    if (id === threadId) await newChat();
    await refreshThreads();
  }

  /**
   * The launch seam. A listed row's matched lanes choose the workflow, the
   * catalog supplies the fields, and the card lands blank. Prefill fills only
   * what a record can prove, and the confirm button underneath the card stays
   * the only call that starts a run.
   */
  async function launch(row: AssistantTicketRow): Promise<void> {
    if (taskBusy || state.streaming) return;
    const workflows = await listWorkflows().catch(() => []);
    const candidates = row.matchedWorkflows.flatMap((id) => {
      const byId = workflows.find((workflow) => workflow.id === id);
      if (byId !== undefined) return [byId];
      return workflowsForTicket({
        issueType: row.issueType,
        summary: `${row.summary} ${id}`,
        labels: row.labels,
      })
        .map((label) => workflows.find((workflow) => workflow.id === label))
        .filter((workflow) => workflow !== undefined);
    });
    const workflow = candidates[0];
    if (workflow === undefined) {
      setState((current) => ({
        ...current,
        turns: [
          ...current.turns,
          turn(
            "assistant",
            `${row.key} matched no launchable workflow in the catalog, so nothing was drafted.`,
          ),
        ],
      }));
      return;
    }
    const draftCard = startDraftFromRow(row, workflow);
    const turnIndex = state.turns.length;
    setStarts((current) => [...current, { turnIndex, draft: draftCard }]);
    setState((current) => ({
      ...current,
      turns: [...current.turns, turn("assistant", startDraftCaption(draftCard))],
    }));
    void prefillInto(turnIndex, draftCard, row.summary);
  }

  /** Ask the API what records can prove for a card, then patch that card only. */
  async function prefillInto(index: number, card: ChatStartDraft, ticketSummary: string): Promise<void> {
    const answer = await prefillStartFields({
      workflow: card.workflow,
      ticketKey: card.ticketKey,
      ticketSummary,
      text: "",
      values: Object.fromEntries(
        card.fields.filter((field) => field.value.trim() !== "").map((field) => [field.id, field.value]),
      ),
    })
      .then((body) => parsePrefillReply(body))
      .catch(() => null);
    if (answer === null) return;
    const merged = applyPrefill(card, answer.fields);
    if (merged === card) return;
    setStarts((current) =>
      current.map((attachment) => (attachment.turnIndex === index ? { ...attachment, draft: merged } : attachment)),
    );
    setState((current) => ({
      ...current,
      turns: current.turns.map((existing, position) =>
        position === index ? { ...existing, body: startDraftCaption(merged) } : existing,
      ),
    }));
  }

  function dismissStart(index: number): void {
    setStarts((current) => current.filter((attachment) => attachment.turnIndex !== index));
  }

  /**
   * The only writer in the console. Everything above is a read; this is the
   * confirm button, and it posts through the same `POST /runs` the start card
   * has always used.
   */
  async function confirmStart(index: number, card: ChatStartDraft, values: Record<string, string>): Promise<void> {
    if (taskBusy) return;
    if (missingStartFields(card, values).length > 0) return;
    setTaskBusy(true);
    try {
      const caseId = (await openCase(card.ticketKey)).caseId;
      const run = await startRun({
        workflow: card.workflow,
        ticketKey: card.ticketKey,
        caseId,
        input: buildStartInput(card, values),
      });
      setStarts((current) => current.filter((attachment) => attachment.turnIndex !== index));
      setState((current) => ({
        ...current,
        turns: [
          ...current.turns,
          turn(
            "assistant",
            `Run **${shortRunId(run.runId)}** started for ${card.ticketKey} (**${card.workflowLabel}**). It parks at its first checkpoint, so it is now in the Task Inbox.`,
          ),
        ],
      }));
      onOpenRun({ runId: run.runId, workflow: run.workflow, ticketKey: card.ticketKey });
      onOpenInbox();
    } catch (error) {
      const problems = error instanceof ApiError ? startProblemLines(error.body) : [];
      setState((current) => ({
        ...current,
        turns: [
          ...current.turns,
          turn(
            "assistant",
            error instanceof ApiError && error.status === 403
              ? "Your role cannot start runs — ask an agent or admin to start it."
              : problems.length > 0
                ? `The run was not started — the server refused the start input:\n${problems.map((line) => `- ${line}`).join("\n")}`
                : "The run could not be started just now.",
          ),
        ],
      }));
    } finally {
      setTaskBusy(false);
    }
  }

  const placeholder = useMemo(() => {
    if (unusable || (resource === null && !loading)) {
      return "This account has no tenant, so the assistant has nothing to read.";
    }
    if (loading) return "Loading your conversations…";
    return "Ask me anything about your projects, tickets, people, or policy…";
  }, [loading, resource, unusable]);

  return (
    <div className="chat-shell">
      <ThreadList
        threads={threads}
        selectedId={threadId}
        busy={state.streaming || taskBusy}
        onSelect={(id) => void selectThread(id)}
        onNew={() => void newChat()}
        onRename={(id, title) => void rename(id, title)}
        onDelete={(id) => void remove(id)}
      />
      <div className="chat-main">
        <Transcript
          state={state}
          busy={taskBusy || state.streaming}
          onOpenTicket={onOpenTicket}
          onLaunch={(row) => void launch(row)}
        />
        {starts.map((attachment) => (
          <div key={attachment.turnIndex} className="chat-start-slot">
            <StartRunCard
              draft={attachment.draft}
              busy={taskBusy}
              onConfirm={(values) => void confirmStart(attachment.turnIndex, attachment.draft, values)}
              onDismiss={() => dismissStart(attachment.turnIndex)}
            />
          </div>
        ))}
        <Composer
          value={draft}
          streaming={state.streaming}
          disabled={resource === null || loading}
          placeholder={placeholder}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onStop={stop}
        />
      </div>
    </div>
  );
}
