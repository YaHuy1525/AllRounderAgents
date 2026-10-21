"use client";

import { useMemo, useState } from "react";

import type { JiraIssue } from "@/lib/board";
import { START_RUN_HINT } from "@/lib/roles";
import {
  RUNNABLE_WORKFLOWS,
  syntheticTaskKey,
  workflowsForTicket,
  type RunDetail,
} from "@/lib/runs";

import { IconLock, IconPlay, IconSearch } from "./icons";
import { StartRunCard } from "./RunPanel";

type IntakeMode = "ticket" | "describe";

/**
 * Empty "+" tab state: start a run from a board ticket or from free text.
 * Ticket runs open in the ticket tab; describe-started runs carry a
 * synthetic TASK- key (no Jira record) and open in their own run tab.
 */
export function NewTabView({
  issues,
  status,
  onOpenTicket,
  onOpenRun,
  initialWorkflowId,
  canStart = true,
}: {
  issues: JiraIssue[];
  status: string;
  onOpenTicket: (issue: JiraIssue) => void;
  /** Describe-started runs deep-link into their run tab through this hook. */
  onOpenRun?: (run: { runId: string; workflow: string; ticketKey: string }) => void;
  initialWorkflowId?: string;
  /** False disables the run launcher; the server stays source of truth. */
  canStart?: boolean;
}) {
  const [mode, setMode] = useState<IntakeMode>("ticket");
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

  // A "Start run" CTA opens this tab with its workflow preselected; the
  // ticket's supported list wins when the two disagree.
  const initialWorkflow = useMemo(() => {
    if (
      initialWorkflowId !== undefined &&
      supported.some((item) => item.id === initialWorkflowId)
    ) {
      return initialWorkflowId;
    }
    return supported[0]?.id;
  }, [supported, initialWorkflowId]);

  return (
    <section id="new-tab-view" className="panel-view new-tab-view">
      <div className="panel-heading">
        <p className="eyebrow">New tab</p>
        <h2>Start a workflow run</h2>
        <p className="panel-note">
          Pick a ticket, or describe what you want run — either way the run opens in a tab and
          pauses at every checkpoint for your review.
        </p>
      </div>
      {!canStart && (
        <p className="role-hint" role="note">
          <IconLock />
          {START_RUN_HINT}
        </p>
      )}

      <div className="intake-mode" role="tablist" aria-label="How to start the run">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "ticket"}
          className={mode === "ticket" ? "selected" : ""}
          onClick={() => setMode("ticket")}
        >
          From a ticket
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "describe"}
          className={mode === "describe" ? "selected" : ""}
          onClick={() => setMode("describe")}
        >
          Describe it
        </button>
      </div>

      {mode === "ticket" ? (
        <div className="start-panel-grid">
          <section className="picker-pane" aria-label="Choose a ticket">
            <header>
              <h3>Choose a ticket</h3>
              <p role="status">{status}</p>
            </header>
            <label className="search-field">
              <span>Search tickets</span>
              <span className="search-input">
                <IconSearch />
                <input
                  id="new-tab-search"
                  type="search"
                  placeholder="Key, title, type or label"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </span>
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
                      <h4>
                        <IconPlay />
                        {item.label}
                      </h4>
                      <p>{item.description}</p>
                    </li>
                  ))}
                </ul>
                <StartRunCard
                  key={`${selected.key}:${initialWorkflow ?? ""}`}
                  issue={selected}
                  caseId={null}
                  initialWorkflow={initialWorkflow}
                  workflowOptions={supported.map((item) => ({ id: item.id, label: item.label }))}
                  onStarted={() => onOpenTicket(selected)}
                  canStart={canStart}
                />
              </>
            )}
          </section>
        </div>
      ) : (
        <DescribeRunForm
          initialWorkflowId={initialWorkflowId}
          canStart={canStart}
          onOpenRun={onOpenRun}
        />
      )}
    </section>
  );
}

/**
 * Pseudo-issue backing a describe-started run. The API opens a case for any
 * key matching the ticket pattern without a Jira lookup, so this TASK- key
 * stays local: nothing is written to Jira and no board card is created.
 */
export function describedIssue(key: string, title: string): JiraIssue {
  const summary = title.trim() === "" ? "Described run" : title.trim();
  return {
    key,
    project: "TASK",
    summary,
    issue_type: "Task",
    priority: "Medium",
    status: "Described",
    assignee: null,
    labels: ["described"],
    updated: new Date().toISOString(),
    browse_url: "",
  };
}

/**
 * Free-text intake: a title and description replace the Jira ticket, and the
 * workflow picker offers every runnable workflow (no type gating). Starting
 * a run hands the created run to `onOpenRun` so the console opens its tab.
 */
export function DescribeRunForm({
  initialWorkflowId,
  canStart = true,
  onOpenRun,
}: {
  initialWorkflowId?: string;
  canStart?: boolean;
  onOpenRun?: (run: { runId: string; workflow: string; ticketKey: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [syntheticKey] = useState(() => syntheticTaskKey());
  const issue = useMemo(() => describedIssue(syntheticKey, title), [syntheticKey, title]);
  const titleReady = title.trim().length >= 3;
  const titleHint = "Add a title with at least 3 characters to start the run.";
  const handleStarted = (started?: RunDetail): void => {
    if (started === undefined || onOpenRun === undefined) return;
    onOpenRun({
      runId: started.runId,
      workflow: started.workflow,
      ticketKey: started.ticketKey,
    });
  };

  return (
    <div className="start-panel-grid">
      <section className="picker-pane" aria-label="Describe the run">
        <header>
          <h3>Describe the run</h3>
          <p>
            {`Runs start on a local ${syntheticKey} key — nothing is written to Jira, and the run lands in its own tab.`}
          </p>
        </header>
        <label className="field-row">
          <span>Title</span>
          <input
            type="text"
            value={title}
            maxLength={500}
            placeholder="Fix the flaky checkout tests"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="field-row">
          <span>Description</span>
          <textarea
            value={description}
            maxLength={2000}
            rows={7}
            placeholder="What should this run do? Add the context an engineer would need — files, symptoms, the expected outcome."
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </section>

      <section className="picker-pane" aria-label="Workflows for described runs">
        <header>
          <h3>Pick a workflow</h3>
          <p>
            Every runnable workflow is available here — describe mode is not limited by the ticket
            type rules.
          </p>
        </header>
        <StartRunCard
          issue={issue}
          caseId={null}
          initialWorkflow={initialWorkflowId}
          canStart={canStart && titleReady}
          disabledHint={canStart && !titleReady ? titleHint : undefined}
          description={description}
          onStarted={handleStarted}
        />
      </section>
    </div>
  );
}
