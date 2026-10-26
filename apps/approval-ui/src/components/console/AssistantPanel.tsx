"use client";

import { compactTickets } from "@/lib/board";

import { ChatShell } from "./chat/ChatShell";
import { IconSparkles } from "./icons";

type CompactTicket = ReturnType<typeof compactTickets>[number];

/**
 * The always-visible assistant rail. It is now a frame: the header and the
 * conversation itself. All routing, all answer generation, and all tenancy
 * live behind `ChatShell` and the host it talks to — the panel no longer knows
 * what a message means.
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
      <ChatShell
        tickets={tickets}
        selectedKey={selectedKey}
        onOpenRun={onOpenRun}
        onOpenTicket={onOpenTicket}
        onOpenInbox={onOpenInbox}
      />
    </aside>
  );
}
