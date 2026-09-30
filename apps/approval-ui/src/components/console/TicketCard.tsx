"use client";

import type { CSSProperties, DragEvent } from "react";

import type { JiraIssue } from "@/lib/board";
import { integrationAccent, integrationLabel } from "@/lib/integrations";

import {
  IconAlert,
  IconArrowRight,
  IconCheckCircle,
  IconFileText,
  IconList,
  ProviderGlyph,
} from "./icons";

export const TICKET_DRAG_TYPE = "application/x-allrounder-ticket";

const TYPE_ICONS: Record<string, typeof IconList> = {
  bug: IconAlert,
  story: IconFileText,
  task: IconCheckCircle,
  epic: IconList,
};

/** Assignee avatar initials — at most two letters, derived from the name. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? "" : "";
  return `${first}${last}`.toUpperCase();
}

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
  platforms = [],
  onOpenRun,
}: {
  issue: JiraIssue;
  selected?: boolean;
  onOpenDetails: (issue: JiraIssue) => void;
  /** Platforms the ticket's latest run touched (provider ids). */
  platforms?: readonly string[];
  /** Deep link into the ticket's latest run inspector; chips become buttons. */
  onOpenRun?: () => void;
}) {
  const TypeIcon = TYPE_ICONS[issue.issue_type.toLowerCase()] ?? IconList;

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
      <div className="ticket-card-top">
        <span className="ticket-key">{issue.key}</span>
        {issue.assignee ? (
          <span className="ticket-avatar" aria-hidden="true">
            {initials(issue.assignee)}
          </span>
        ) : null}
      </div>
      <h4 className="ticket-title">{issue.summary}</h4>
      <div className="ticket-meta">
        <span className="ticket-type">
          <TypeIcon />
          {issue.issue_type}
        </span>
        <span className={`priority priority-${issue.priority.toLowerCase()}`}>{issue.priority}</span>
      </div>
      {issue.labels.length > 0 ? (
        <div className="ticket-labels">
          {issue.labels.map((label) => (
            <span key={label} className="ticket-label">
              {label}
            </span>
          ))}
        </div>
      ) : null}
      {platforms.length > 0 ? (
        <div className="ticket-platforms" aria-label="Platforms touched">
          {platforms.map((provider) => {
            const style = {
              "--provider-accent": integrationAccent(provider),
            } as CSSProperties;
            return onOpenRun ? (
              <button
                key={provider}
                type="button"
                className="integration-chip ticket-platform-chip"
                style={style}
                title={`Open the latest run — touches ${integrationLabel(provider)}`}
                onClick={onOpenRun}
              >
                <ProviderGlyph provider={provider} />
                {integrationLabel(provider)}
              </button>
            ) : (
              <span key={provider} className="integration-chip" style={style}>
                <ProviderGlyph provider={provider} />
                {integrationLabel(provider)}
              </span>
            );
          })}
        </div>
      ) : null}
      <button type="button" className="details-button" onClick={() => onOpenDetails(issue)}>
        <span>Details</span>
        <IconArrowRight />
      </button>
    </article>
  );
}
