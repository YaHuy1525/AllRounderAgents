"use client";

import type { AssistantTicketRow } from "@/lib/assistant";

/**
 * Rows the assistant's own `list_tickets` call returned. Opening a row jumps to
 * the ticket; Launch only drafts the start card. Neither writes: the run starts
 * when the human presses confirm on that card.
 */
export function TicketPickerCard({
  rows,
  busy,
  onOpen,
  onLaunch,
}: {
  rows: AssistantTicketRow[];
  busy: boolean;
  onOpen: (ticketKey: string) => void;
  onLaunch: (row: AssistantTicketRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="chat-tickets">
      {rows.map((row) => (
        <div key={row.key} className="chat-ticket-row">
          <button type="button" onClick={() => onOpen(row.key)}>
            <strong>{row.key}</strong>
            <span>{row.summary}</span>
          </button>
          <span className="chat-ticket-lanes">{row.matchedWorkflows.join(", ")}</span>
          <button
            type="button"
            className="chat-ticket-launch"
            disabled={busy || row.matchedWorkflows.length === 0}
            onClick={() => onLaunch(row)}
          >
            Launch
          </button>
        </div>
      ))}
    </div>
  );
}
