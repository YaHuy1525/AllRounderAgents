"use client";

import { compactTickets } from "@/lib/board";
import type { AssistantTicketRow } from "@/lib/assistant";

import { ChatShell } from "./chat/ChatShell";

type CompactTicket = ReturnType<typeof compactTickets>[number];

/**
 * The Assistant is a tab, not a rail: this wrapper only gives the conversation
 * a full-height frame. History, the transcript, and the composer all live in
 * `ChatShell`, and everything the assistant knows arrives from the host.
 */
export function AssistantPanel({
  tickets,
  selectedKey,
  onOpenRun,
  onOpenTicket,
  onOpenInbox,
  onExecuteTicket,
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
  onExecuteTicket: (ticket: AssistantTicketRow) => void;
}) {
  return (
    <div className="assistant-panel">
      <ChatShell
        tickets={tickets}
        selectedKey={selectedKey}
        onOpenRun={onOpenRun}
        onOpenTicket={onOpenTicket}
        onOpenInbox={onOpenInbox}
        onExecuteTicket={onExecuteTicket}
      />
    </div>
  );
}
