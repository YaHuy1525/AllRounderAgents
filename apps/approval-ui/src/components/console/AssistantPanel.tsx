"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

import { ApiError, api } from "@/lib/api";
import { compactTickets } from "@/lib/board";
import {
  addContextChip,
  buildChatRequest,
  CHAT_AGENTS,
  QUICK_PROMPTS,
  removeContextChip,
  type ContextChip,
} from "@/lib/chat";

import { IconClose } from "./icons";
import { TICKET_DRAG_TYPE } from "./TicketCard";

type ChatMessage = { role: "user" | "assistant"; body: string; source?: string };
type CompactTicket = ReturnType<typeof compactTickets>[number];

/**
 * Always-visible assistant rail. Tickets dragged from the board land here as
 * removable context chips; Send posts to /chat with the selected assistant,
 * the chips, and the board snapshot.
 */
export function AssistantPanel({
  tickets,
  selectedKey,
}: {
  tickets: CompactTicket[];
  selectedKey?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [agent, setAgent] = useState<string>(CHAT_AGENTS[0].id);
  const [chips, setChips] = useState<ContextChip[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  async function send(prompt?: string): Promise<void> {
    const message = (prompt ?? draft).trim();
    if (!message || sending) return;
    setDraft("");
    setMessages((previous) => [...previous, { role: "user", body: message }]);
    setSending(true);
    try {
      const payload = buildChatRequest({ message, agent, chips, tickets, selectedKey });
      const result = await api<{ reply: string; source?: string }>("/chat", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setMessages((previous) => [
        ...previous,
        { role: "assistant", body: result.reply, source: result.source },
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
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
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
        <h2>Welcome</h2>
        <p>What would you like to work on?</p>
      </header>

      <div className="agent-picker">
        <label htmlFor="agent-select">
          <span>Assistant</span>
        </label>
        <select id="agent-select" value={agent} onChange={(event) => setAgent(event.target.value)}>
          {CHAT_AGENTS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <p className="agent-context">{`Context: ${activeAgent.label}`}</p>
      </div>

      <div id="chat-log" className="chat-log" aria-live="polite" ref={logRef}>
        {messages.length === 0 ? (
          <p className="chat-hint">
            Ask about the board, drag a ticket here for context, or run one of the quick actions
            below.
          </p>
        ) : (
          messages.map((message, index) => (
            <article key={`${index}-${message.role}`} className={`chat-row chat-${message.role}`}>
              <p>{message.body}</p>
              {message.source ? <span className="chat-source">{message.source}</span> : null}
            </article>
          ))
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
        {chips.length > 0 && (
          <div className="context-chips" aria-label="Attached ticket context">
            {chips.map((chip) => (
              <span key={chip.key} className="context-chip">
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
        <div className="quick-chips">
          {QUICK_PROMPTS.map((quick) => (
            <button
              key={quick.id}
              type="button"
              disabled={sending}
              onClick={() => void send(quick.prompt)}
            >
              {quick.label}
            </button>
          ))}
        </div>
        <button id="chat-send" type="submit" disabled={sending}>
          Send
        </button>
      </form>
    </aside>
  );
}
