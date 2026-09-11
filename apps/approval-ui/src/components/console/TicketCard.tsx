"use client";

import type { DragEvent } from "react";

import type { JiraIssue } from "@/lib/board";

import { IconClock } from "./icons";

export const TICKET_DRAG_TYPE = "application/x-allrounder-ticket";

/**
 * Board ticket card. Everything the server sends — key, summary, type,
 * priority — renders as React text nodes only, so a malicious summary can
 * never become markup. The card is draggable so it can be dropped onto the
 * assistant chat as context.
 */
export function TicketCard({
  issue,
  selected = false,
  onOpenDetails,
}: {
  issue: JiraIssue;
  selected?: boolean;
  onOpenDetails: (issue: JiraIssue) => void;
}) {
  function handleDragStart(event: DragEvent<HTMLElement>): void {
    const payload = JSON.stringify({ key: issue.key, summary: issue.summary });
    event.dataTransfer.setData(TICKET_DRAG_TYPE, payload);
    event.dataTransfer.setData("text/plain", payload);
    event.dataTransfer.effectAllowed = "copy";
  }

  return (
    <article
      className={`ticket-card${selected ? " selected" : ""}`}
      draggable
      onDragStart={handleDragStart}
      title={issue.assignee ? `Assigned to ${issue.assignee}` : "Unassigned"}
    >
      <span className="ticket-key">{issue.key}</span>
      <h4 className="ticket-title">{issue.summary}</h4>
      <div className="ticket-meta">
        <span className="ticket-type">{issue.issue_type}</span>
        <span className={`priority priority-${issue.priority.toLowerCase()}`}>{issue.priority}</span>
      </div>
      <button type="button" className="details-button" onClick={() => onOpenDetails(issue)}>
        <IconClock />
        <span>Details</span>
      </button>
    </article>
  );
}
