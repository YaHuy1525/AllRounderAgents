"use client";

import { useEffect, useState } from "react";

import type { JiraIssue } from "@/lib/board";
import { BOARD_COLUMNS, boardStats, groupIssues } from "@/lib/board";
import { workflowProviderIndex } from "@/lib/integrations";
import type { JiraPrefs } from "@/lib/prefs";
import { listRunsPage, sortRunsNewestFirst } from "@/lib/runs";
import { listWorkflows } from "@/lib/workflows";

import {
  IconActivity,
  IconList,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconSparkles,
} from "./icons";
import { TicketCard } from "./TicketCard";

type OpenRunRef = { runId: string; workflow: string; ticketKey: string };

/** The latest run per ticket, with the platforms its workflow touches. */
type TicketRun = { runId: string; workflow: string; providers: string[] };

type BoardViewProps = {
  prefs: JiraPrefs;
  issues: JiraIssue[];
  boardTitle: string;
  status: string;
  lastSync: string;
  refreshing: boolean;
  search: string;
  activeTicketKey?: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onOpenDetails: (issue: JiraIssue) => void;
  /** Deep link into a ticket's latest run inspector (platform chips). */
  onOpenRun?: (run: OpenRunRef) => void;
};

/** Builds a chip click handler without relying on closure narrowing. */
function runOpener(
  onOpenRun: (run: OpenRunRef) => void,
  run: TicketRun,
  ticketKey: string,
): () => void {
  return () => onOpenRun({ runId: run.runId, workflow: run.workflow, ticketKey });
}

/**
 * View A — the sprint board on the Dashboard tab. One board at a time: the
 * filters and stats sit in one row, the sprint header carries the
 * project/board/sprint labels, and the kanban renders the four console
 * columns with dashed empty placeholders. Switching the Jira project or
 * board lives in Settings.
 */
export function BoardView({
  prefs,
  issues,
  boardTitle,
  status,
  lastSync,
  refreshing,
  search,
  activeTicketKey,
  onSearchChange,
  onRefresh,
  onOpenDetails,
  onOpenRun,
}: BoardViewProps) {
  const grouped = groupIssues(issues, search);
  const stats = boardStats(issues);
  const [ticketRuns, setTicketRuns] = useState<ReadonlyMap<string, TicketRun>>(new Map());

  // "Platforms touched" chips: the latest run per ticket, resolved once from
  // the catalog (active runs win ties against archived ones). A failed fetch
  // just leaves every card chipless — the board itself is unaffected.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listWorkflows(),
      listRunsPage({ scope: "active", limit: 200 }),
      listRunsPage({ scope: "history", limit: 200 }),
    ]).then(
      ([workflows, active, history]) => {
        if (cancelled) return;
        const providers = workflowProviderIndex(workflows);
        const latest = new Map<string, TicketRun>();
        for (const run of sortRunsNewestFirst([...active.runs, ...history.runs])) {
          if (latest.has(run.ticketKey)) continue;
          latest.set(run.ticketKey, {
            runId: run.runId,
            workflow: run.workflow,
            providers: providers.get(run.workflow) ?? [],
          });
        }
        setTicketRuns(latest);
      },
      () => {
        // Chips stay hidden; the board renders without them.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section id="board-view">
      <div className="filter-row">
        <span className="filter-label">Jira</span>
        <label className="search-field">
          <span>Search tickets</span>
          <span className="search-input">
            <IconSearch />
            <input
              id="search"
              type="search"
              placeholder="Key, title, type or label"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </span>
        </label>
        <div className="stat-chips" aria-label="Sprint stats">
          <span className="stat-chip">
            <span className="stat-chip-icon" aria-hidden="true">
              <IconList />
            </span>
            <span className="stat-chip-body">
              <strong id="total">{stats.total}</strong>
              <span>Total Issues</span>
            </span>
          </span>
          <span className="stat-chip">
            <span className="stat-chip-icon" aria-hidden="true">
              <IconActivity />
            </span>
            <span className="stat-chip-body">
              <strong id="progress">{`${stats.progress}%`}</strong>
              <span>Progress</span>
            </span>
          </span>
          <span className="stat-chip" title="Story points are not exposed by the Jira board API">
            <span className="stat-chip-icon" aria-hidden="true">
              <IconSparkles />
            </span>
            <span className="stat-chip-body">
              <strong>—</strong>
              <span>Story Points</span>
            </span>
          </span>
          <span className="stat-chip">
            <span className="stat-chip-icon" aria-hidden="true">
              <IconPlay />
            </span>
            <span className="stat-chip-body">
              <strong id="active-count">{stats.active}</strong>
              <span>In Progress</span>
            </span>
          </span>
        </div>
        <button id="refresh" type="button" className="refresh-button" disabled={refreshing} onClick={onRefresh}>
          <IconRefresh className={refreshing ? "spin" : undefined} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="sprint-header">
        <div>
          <p className="eyebrow">Current Sprint</p>
          <h2 id="board-title">{boardTitle}</h2>
          <p className="sprint-meta">
            <span>
              Project <strong>{prefs.project || "—"}</strong>
            </span>
            <span>
              Board <strong>{prefs.boardName || "—"}</strong>
            </span>
            <span>
              Sprint-ID <strong>{prefs.boardId ? `#${prefs.boardId}` : "—"}</strong>
            </span>
          </p>
        </div>
        <div className="sprint-side">
          <span className="sprint-badge">{`${issues.length} issues`}</span>
          <p id="status" role="status">
            {`${status} · last sync ${lastSync}`}
          </p>
        </div>
      </div>

      <section id="board" className="board" aria-live="polite">
        {BOARD_COLUMNS.map((column) => {
          const columnIssues = grouped[column.id] ?? [];
          return (
            <section key={column.id} className={`board-column column-${column.id}`}>
              <div className="column-heading">
                <h3>
                  <span className="column-dot" aria-hidden="true" />
                  {column.label}
                </h3>
                <span className="column-count" key={columnIssues.length}>
                  {columnIssues.length}
                </span>
              </div>
              <div className="cards">
                {columnIssues.length === 0 ? (
                  <p className="empty-column">No items</p>
                ) : (
                  columnIssues.map((issue) => {
                    const latest = ticketRuns.get(issue.key);
                    return (
                      <TicketCard
                        key={issue.key}
                        issue={issue}
                        selected={issue.key === activeTicketKey}
                        onOpenDetails={onOpenDetails}
                        platforms={latest?.providers ?? []}
                        onOpenRun={
                          latest !== undefined && onOpenRun !== undefined
                            ? runOpener(onOpenRun, latest, issue.key)
                            : undefined
                        }
                      />
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </section>
    </section>
  );
}
