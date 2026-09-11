"use client";

import { useState } from "react";

import type { Workspace } from "@/lib/models";
import type { JiraPrefs } from "@/lib/prefs";

/**
 * Empty "+" tab state: a board picker reusing the workspace catalog. Opening
 * a board focuses the Dashboard tab with that project/board applied.
 */
export function NewTabView({
  workspace,
  prefs,
  onOpenBoard,
}: {
  workspace: Workspace;
  prefs: JiraPrefs;
  onOpenBoard: (project: string, boardId: number | null) => void;
}) {
  const [project, setProject] = useState(prefs.project || workspace.projects[0] || "");
  const [boardId, setBoardId] = useState("");

  const boards = workspace.boards.filter((board) => board.project === project);
  const boardValue =
    boardId !== "" && boards.some((board) => String(board.id) === boardId)
      ? boardId
      : boards[0]
        ? String(boards[0].id)
        : "";

  return (
    <section id="new-tab-view" className="panel-view new-tab-view">
      <div className="panel-heading">
        <p className="eyebrow">New tab</p>
        <h2>Pick a board to open</h2>
        <p className="panel-note">
          The sprint board lives on the Dashboard tab. Choosing a board here focuses it with your
          selection applied.
        </p>
      </div>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          onOpenBoard(project, boardValue === "" ? null : Number(boardValue));
        }}
      >
        <label>
          <span>Project</span>
          <select
            id="new-tab-project"
            value={project}
            onChange={(event) => {
              setProject(event.target.value);
              setBoardId("");
            }}
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
          <select id="new-tab-board" value={boardValue} onChange={(event) => setBoardId(event.target.value)}>
            {boards.length === 0 ? (
              <option value="">None available</option>
            ) : (
              boards.map((board) => (
                <option key={board.id} value={String(board.id)}>
                  {`${board.name} (${board.type})`}
                </option>
              ))
            )}
          </select>
        </label>
        <div className="settings-actions">
          <button id="new-tab-open" type="submit">
            Open board
          </button>
        </div>
      </form>
    </section>
  );
}
