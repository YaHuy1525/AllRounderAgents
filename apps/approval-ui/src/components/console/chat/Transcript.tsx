"use client";

import { useEffect, useRef } from "react";

import type { AssistantTicketRow, ChatState } from "@/lib/assistant";

import { IconFileText } from "../icons";
import { Markdown } from "../Markdown";
import { TicketPickerCard } from "./TicketPickerCard";

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
}: {
  state: ChatState;
  busy: boolean;
  onOpenTicket: (ticketKey: string) => void;
  onLaunch: (row: AssistantTicketRow) => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.turns]);

  return (
    <div id="chat-log" className="chat-log" aria-live="polite" ref={logRef}>
      {state.turns.length === 0 ? (
        <p className="chat-hint">Ask anything about this console. Every conversation keeps its history.</p>
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
