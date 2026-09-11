import type { JiraIssue } from "@/lib/board";
import { BOARD_COLUMNS, boardStats, groupIssues } from "@/lib/board";
import type { Workspace } from "@/lib/models";
import type { JiraPrefs } from "@/lib/prefs";

import { IconRefresh } from "./icons";
import { TicketCard } from "./TicketCard";

type BoardViewProps = {
  workspace: Workspace;
  prefs: JiraPrefs;
  issues: JiraIssue[];
  boardTitle: string;
  status: string;
  lastSync: string;
  refreshing: boolean;
  search: string;
  activeTicketKey?: string;
  onSearchChange: (value: string) => void;
  onProjectChange: (project: string) => void;
  onBoardChange: (boardId: string) => void;
  onRefresh: () => void;
  onOpenDetails: (issue: JiraIssue) => void;
};

/**
 * View A — the sprint board on the Dashboard tab. Filters and stats sit in
 * one row, the sprint header carries the project/board/sprint labels, and the
 * kanban renders the four console columns with dashed empty placeholders.
 */
export function BoardView({
  workspace,
  prefs,
  issues,
  boardTitle,
  status,
  lastSync,
  refreshing,
  search,
  activeTicketKey,
  onSearchChange,
  onProjectChange,
  onBoardChange,
  onRefresh,
  onOpenDetails,
}: BoardViewProps) {
  const project = prefs.project || workspace.projects[0] || "";
  const boards = workspace.boards.filter((board) => board.project === project);
  const boardValue =
    prefs.boardId !== null && boards.some((board) => board.id === prefs.boardId)
      ? String(prefs.boardId)
      : boards[0]
        ? String(boards[0].id)
        : "";
  const grouped = groupIssues(issues, search);
  const stats = boardStats(issues);

  return (
    <section id="board-view">
      <div className="filter-row">
        <span className="filter-label">Jira</span>
        <label>
          <span>Project</span>
          <select
            id="project"
            value={project}
            onChange={(event) => onProjectChange(event.target.value)}
          >
            {workspace.projects.length === 0 ? (
              <option value="">None available</option>
            ) : (
              workspace.projects.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))
            )}
          </select>
        </label>
        <label>
          <span>Board</span>
          <select
            id="board-select"
            value={boardValue}
            onChange={(event) => onBoardChange(event.target.value)}
          >
            {boards.length === 0 ? (
              <option value="">None available</option>
            ) : (
              boards.map((board) => (
                <option key={board.id} value={String(board.id)}>
                  {board.name}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="search-field">
          <span>Search tickets</span>
          <input
            id="search"
            type="search"
            placeholder="Key, title, type or label"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        <div className="stat-chips" aria-label="Sprint stats">
          <span className="stat-chip">
            <strong id="total">{stats.total}</strong>
            <span>Total Issues</span>
          </span>
          <span className="stat-chip">
            <strong id="progress">{`${stats.progress}%`}</strong>
            <span>Progress</span>
          </span>
          <span className="stat-chip" title="Story points are not exposed by the Jira board API">
            <strong>—</strong>
            <span>Story Points</span>
          </span>
          <span className="stat-chip">
            <strong id="active-count">{stats.active}</strong>
            <span>In Progress</span>
          </span>
        </div>
        <button id="refresh" type="button" className="refresh-button" disabled={refreshing} onClick={onRefresh}>
          <IconRefresh />
          <span>Refresh</span>
        </button>
      </div>

      <div className="sprint-header">
        <div>
          <p className="eyebrow">Current Sprint</p>
          <h2 id="board-title">{boardTitle}</h2>
          <p className="sprint-meta">
            <span>
              Project <strong>{project || "—"}</strong>
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
                <h3>{column.label}</h3>
                <span className="column-count">{columnIssues.length}</span>
              </div>
              <div className="cards">
                {columnIssues.length === 0 ? (
                  <p className="empty-column">No items</p>
                ) : (
                  columnIssues.map((issue) => (
                    <TicketCard
                      key={issue.key}
                      issue={issue}
                      selected={issue.key === activeTicketKey}
                      onOpenDetails={onOpenDetails}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </section>
    </section>
  );
}
