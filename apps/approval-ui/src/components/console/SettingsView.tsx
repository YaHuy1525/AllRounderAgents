import { apiUrl } from "@/lib/api";
import type { Workspace } from "@/lib/models";
import type { JiraPrefs, UiPrefs } from "@/lib/prefs";

import { GithubAccountsSection } from "./GithubAccountsSection";

type SettingsViewProps = {
  workspace: Workspace;
  prefs: JiraPrefs;
  uiPrefs: UiPrefs;
  status: string;
  onSave: () => void;
  onReload: () => void;
  onProjectChange: (project: string) => void;
  onBoardChange: (boardId: string) => void;
  onUiChange: (patch: Partial<UiPrefs>) => void;
};

const REFRESH_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 30, label: "Every 30 seconds" },
  { value: 60, label: "Every minute" },
  { value: 120, label: "Every 2 minutes" },
];

const LANES = [
  { id: "support", name: "Support", blurb: "Retrieval, draft, validation, approval gate, send." },
  { id: "coding", name: "Coding", blurb: "Investigate, RCA, surgical patch, preflight, PR close." },
  { id: "finance", name: "Finance", blurb: "Reconcile, exceptions, RCA, fan-out, audit, post." },
];

/**
 * Settings panel. App config and notification prefs are local-only and
 * persist through prefs.ts; lane config is a read-only projection of server
 * values — the markup is shaped so a future PUT endpoint can bind to it.
 */
export function SettingsView({
  workspace,
  prefs,
  uiPrefs,
  status,
  onSave,
  onReload,
  onProjectChange,
  onBoardChange,
  onUiChange,
}: SettingsViewProps) {
  const project = prefs.project || workspace.projects[0] || "";
  const boards = workspace.boards.filter((board) => board.project === project);
  const boardValue =
    prefs.boardId !== null && boards.some((board) => board.id === prefs.boardId)
      ? String(prefs.boardId)
      : boards[0]
        ? String(boards[0].id)
        : "";

  return (
    <section id="settings-view" className="panel-view">
      <div className="panel-heading">
        <p className="eyebrow">Settings</p>
        <h2>Console configuration</h2>
        <p id="settings-status" className="panel-note" role="status">
          {status}
        </p>
      </div>

      <section className="settings-section">
        <header>
          <h3>App config</h3>
          <p>Local preferences persist in this browser; the API base URL comes from the build environment.</p>
        </header>
        <form
          id="settings-form"
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <label>
            <span>API base URL</span>
            <input id="settings-api" type="url" readOnly value={apiUrl || "Not configured"} />
          </label>
          <label>
            <span>Jira site</span>
            <input id="jira-site" type="url" readOnly value={workspace.site} />
          </label>
          <label>
            <span>Default project</span>
            <select
              id="settings-project"
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
            <span>Default board</span>
            <select
              id="settings-board"
              value={boardValue}
              onChange={(event) => onBoardChange(event.target.value)}
            >
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
          <label>
            <span>Auto-refresh interval</span>
            <select
              id="settings-refresh"
              value={String(uiPrefs.autoRefreshSec)}
              onChange={(event) => onUiChange({ autoRefreshSec: Number(event.target.value) })}
            >
              {REFRESH_OPTIONS.map((option) => (
                <option key={option.value} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Theme</span>
            <select
              id="settings-theme"
              value={uiPrefs.theme}
              onChange={(event) =>
                onUiChange({ theme: event.target.value === "dark" ? "dark" : "light" })
              }
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <div className="settings-actions">
            <button type="submit">Save and open board</button>
            <button id="reload-workspace" type="button" onClick={onReload}>
              Reload from Jira
            </button>
          </div>
        </form>
      </section>

      <section className="settings-section">
        <header>
          <h3>Lane config</h3>
          <p>
            Managed by server config — thresholds, allowlists and risk bands come from the API and
            stay read-only here. The form is structured so a future PUT endpoint can bind to it.
          </p>
        </header>
        <div className="lane-config">
          {LANES.map((lane) => (
            <article key={lane.id} className="lane-card">
              <h4>{lane.name}</h4>
              <p>{lane.blurb}</p>
              <dl>
                <div className="fact-row">
                  <dt>Confidence threshold</dt>
                  <dd>—</dd>
                </div>
                <div className="fact-row">
                  <dt>Auto-approve allowlist</dt>
                  <dd>—</dd>
                </div>
                <div className="fact-row">
                  <dt>Risk bands</dt>
                  <dd>—</dd>
                </div>
              </dl>
              <p className="lane-note">Managed by server config</p>
            </article>
          ))}
        </div>
      </section>

      <GithubAccountsSection />

      <section className="settings-section">
        <header>
          <h3>Notifications</h3>
        </header>
        <label className="toggle-row" htmlFor="settings-badge">
          <input
            id="settings-badge"
            type="checkbox"
            checked={uiPrefs.badge}
            onChange={(event) => onUiChange({ badge: event.target.checked })}
          />
          <span>Show the pending-approval badge on the rail</span>
        </label>
        <label className="toggle-row" htmlFor="settings-confirm-reject">
          <input
            id="settings-confirm-reject"
            type="checkbox"
            checked={uiPrefs.confirmReject}
            onChange={(event) => onUiChange({ confirmReject: event.target.checked })}
          />
          <span>Confirm before rejecting an approval</span>
        </label>
      </section>
    </section>
  );
}
