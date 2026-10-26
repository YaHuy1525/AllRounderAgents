"use client";

import { useEffect, useRef } from "react";

import type { AssistantTicketRow, ChatState } from "@/lib/assistant";

import { IconFileText, IconSparkles } from "../icons";
import { Markdown } from "../Markdown";
import { TicketPickerCard } from "./TicketPickerCard";

const SUGGESTIONS = [
  "What is waiting on me right now?",
  "Summarise the highest risk open ticket.",
  "Which runs are parked at a checkpoint?",
];

/**
 * Renders the reducer's state and nothing else: no fetching, no formatting
 * decisions beyond what the turn already carries. Auto-scroll is the only side
 * effect, and it hangs off the turn list rather than a timer.
 */
export function Transcript({
  state,
  busy,
  onOpenTicket,
  onLaunch,
  onExecute,
  onSuggest,
}: {
  state: ChatState;
  busy: boolean;
  onOpenTicket: (ticketKey: string) => void;
  onLaunch: (row: AssistantTicketRow) => void;
  onExecute: (row: AssistantTicketRow) => void;
  onSuggest: (text: string) => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.turns]);

  return (
    <div id="chat-log" className="chat-log" aria-live="polite" ref={logRef}>
      {state.turns.length === 0 ? (
        <div className="chat-empty">
          <span className="chat-empty-mark" aria-hidden="true">
            <IconSparkles />
          </span>
          <h2>What would you like to work on?</h2>
          <p className="chat-hint">Ask anything about this console. Every conversation keeps its history.</p>
          <div className="chat-suggestions">
            {SUGGESTIONS.map((text) => (
              <button key={text} type="button" onClick={() => onSuggest(text)}>
                {text}
              </button>
            ))}
          </div>
        </div>
      ) : (
        state.turns.map((turn, index) => (
          <article key={`${index}-${turn.role}`} className={`chat-row chat-${turn.role} anim-fade-up`}>
            {turn.toolNotes.length > 0 && (
              <p className="chat-tools">{`looking up: ${turn.toolNotes.join(", ")}`}</p>
            )}
            {turn.body !== "" && <Markdown text={turn.body} />}
            {turn.role === "assistant" && (
              <TicketPickerCard rows={turn.rows} busy={busy} onOpen={onOpenTicket} onLaunch={onLaunch} />
            )}
            {turn.role === "assistant" && turn.execute !== null && ((ticket) => (
              <div className="chat-execute">
                <button
                  type="button"
                  className="chat-execute-btn"
                  disabled={busy}
                  onClick={() => onExecute(ticket)}
                >
                  {`Execute ${ticket.key}`}
                </button>
                <span className="chat-execute-hint">
                  {`Opens ${ticket.key} in its run tab with only its matched workflows selectable.`}
                </span>
              </div>
            ))(turn.execute)}
            {turn.stopped && <p className="chat-stopped">Stopped.</p>}
            {turn.error !== null && (
              <p className="chat-error" role="alert">
                {turn.error}
              </p>
            )}
            {turn.role === "assistant" && turn.rows.length > 0 && turn.body === "" && (
              <p className="chat-source">
                <IconFileText />
                rows from the ticket tool
              </p>
            )}
          </article>
        ))
      )}
      {state.streaming && (
        <article className="chat-row chat-assistant chat-typing" aria-label="Assistant is typing">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </article>
      )}
    </div>
  );
}
