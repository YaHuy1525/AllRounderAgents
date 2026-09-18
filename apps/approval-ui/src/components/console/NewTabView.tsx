"use client";

import { useMemo, useState } from "react";

import type { JiraIssue } from "@/lib/board";
import { RUNNABLE_WORKFLOWS, workflowsForTicket } from "@/lib/runs";

import { StartRunCard } from "./RunPanel";

/**
 * Empty "+" tab state: pick a ticket, see the workflows its type supports,
 * then start one — the run opens in the ticket tab where the action bar
 * drives every checkpoint. Board switching lives in Settings.
 */
export function NewTabView({
  issues,
  status,
  onOpenTicket,
}: {
  issues: JiraIssue[];
  status: string;
  onOpenTicket: (issue: JiraIssue) => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term === "") return issues;
    return issues.filter((issue) =>
      `${issue.key} ${issue.summary} ${issue.issue_type} ${issue.labels.join(" ")}`
        .toLowerCase()
        .includes(term),
    );
  }, [issues, search]);

  const selected = issues.find((issue) => issue.key === selectedKey) ?? null;
  const supported = useMemo(() => {
    if (selected === null) return [];
    const ids = workflowsForTicket({
      issueType: selected.issue_type,
      summary: selected.summary,
      labels: selected.labels,
    });
    return RUNNABLE_WORKFLOWS.filter((item) => ids.includes(item.id));
  }, [selected]);

  return (
    <section id="new-tab-view" className="panel-view new-tab-view">
      <div className="panel-heading">
        <p className="eyebrow">New tab</p>
        <h2>Start a workflow run</h2>
        <p className="panel-note">
          Pick a ticket to see the workflows its type supports, then start one — the run opens in
          the ticket tab and pauses at every checkpoint for your review.
        </p>
      </div>

      <div className="start-panel-grid">
        <section className="picker-pane" aria-label="Choose a ticket">
          <header>
            <h3>Choose a ticket</h3>
            <p role="status">{status}</p>
          </header>
          <label className="search-field">
            <span>Search tickets</span>
            <input
              id="new-tab-search"
              type="search"
              placeholder="Key, title, type or label"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="ticket-list">
            {filtered.length === 0 ? (
              <p className="step-empty">No tickets match this search.</p>
            ) : (
              filtered.map((issue) => (
                <button
                  key={issue.key}
                  type="button"
                  className={`ticket-option${issue.key === selectedKey ? " selected" : ""}`}
                  aria-pressed={issue.key === selectedKey}
                  onClick={() => setSelectedKey(issue.key)}
                >
                  <strong>{issue.key}</strong>
                  <span className="ticket-option-summary">{issue.summary}</span>
                  <span className="ticket-option-meta">
                    {`${issue.issue_type} · ${issue.status}`}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="picker-pane" aria-label="Workflows for the selected ticket">
          {selected === null ? (
            <p className="step-empty">Select a ticket to see the workflows you can run.</p>
          ) : (
            <>
              <header>
                <h3>{`Workflows for ${selected.key}`}</h3>
                <p>
                  {`${selected.issue_type} tickets support the workflows below — the dropdown is limited to this list.`}
                </p>
              </header>
              <ul className="workflow-list">
                {supported.map((item) => (
                  <li key={item.id} className="workflow-card">
                    <h4>{item.label}</h4>
                    <p>{item.description}</p>
                  </li>
                ))}
              </ul>
              <StartRunCard
                key={selected.key}
                issue={selected}
                caseId={null}
                initialWorkflow={supported[0]?.id}
                workflowOptions={supported.map((item) => ({ id: item.id, label: item.label }))}
                onStarted={() => onOpenTicket(selected)}
              />
            </>
          )}
        </section>
      </div>
    </section>
  );
}
