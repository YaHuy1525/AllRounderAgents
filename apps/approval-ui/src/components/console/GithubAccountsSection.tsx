"use client";

import { useEffect, useState, type FormEvent } from "react";

import { ApiError } from "@/lib/api";
import {
  createGithubAccount,
  deleteGithubAccount,
  listGithubAccounts,
  setDefaultGithubAccount,
  type GithubAccount,
} from "@/lib/runs";
import { ACCOUNT_HINT } from "@/lib/roles";

import { IconGitBranch, IconLock } from "./icons";

function accountErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "An account with this label already exists.";
    if (error.status === 403) {
      return "Your role cannot manage GitHub accounts — an agent or admin role is required.";
    }
    if (error.status >= 500) {
      return "The API could not reach its database — check the API logs and retry.";
    }
  }
  return "The account could not be saved — check the token and try again.";
}

/**
 * GitHub accounts section of Settings. Self-contained island: the settings
 * view owns only browser-local prefs, so this section talks to the
 * `/github/accounts` endpoints directly. Tokens are write-only — the server
 * stores them and lists return a hint, so changing a token means removing
 * and re-adding the account.
 */
export function GithubAccountsSection({ canManage = true }: { canManage?: boolean }) {
  const [accounts, setAccounts] = useState<GithubAccount[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setAccounts(await listGithubAccounts());
  }

  useEffect(() => {
    let cancelled = false;
    listGithubAccounts()
      .then((items) => {
        if (!cancelled) setAccounts(items);
      })
      .catch(() => {
        if (!cancelled) {
          setAccounts([]);
          setLoadFailed(true);
          setError("GitHub accounts could not be loaded — check the API connection.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    setError(null);
    setNotice(null);
    if (label.trim().length === 0) {
      setError("Enter a label, for example Work.");
      return;
    }
    if (token.trim().length < 8) {
      setError("Paste a GitHub personal access token (at least 8 characters).");
      return;
    }
    setBusy(true);
    try {
      const account = await createGithubAccount({
        label: label.trim(),
        ...(username.trim() === "" ? {} : { username: username.trim() }),
        token: token.trim(),
      });
      await refresh();
      setLabel("");
      setUsername("");
      setToken("");
      setNotice(`Added ${account.label}.`);
    } catch (createError) {
      setError(accountErrorCopy(createError));
    } finally {
      setBusy(false);
    }
  }

  async function remove(account: GithubAccount): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await deleteGithubAccount(account.id);
      await refresh();
      setNotice(`Removed ${account.label}.`);
    } catch {
      setError("The account could not be removed — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(account: GithubAccount): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await setDefaultGithubAccount(account.id);
      await refresh();
      setNotice(`${account.label} is now the default account.`);
    } catch {
      setError("The default account could not be changed — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" id="github-accounts-section">
      <header className="settings-head">
        <span className="settings-head-icon" aria-hidden="true">
          <IconGitBranch />
        </span>
        <div>
          <h3>GitHub accounts</h3>
          <p>
            Register the GitHub identities runs may act as. Tokens are stored server-side and never
            leave it — the list shows only a hint. Start cards preselect the default account.
          </p>
        </div>
      </header>
      {!canManage && (
        <p className="role-hint" role="note">
          <IconLock />
          {ACCOUNT_HINT}
        </p>
      )}
      {accounts === null ? (
        <p className="settings-loading">
          <span className="spinner" aria-hidden="true" />
          Loading accounts…
        </p>
      ) : accounts.length === 0 ? (
        <p className="step-summary">
          {loadFailed
            ? "Accounts are unavailable right now."
            : "No accounts yet — add one below to choose it when starting a run."}
        </p>
      ) : (
        <ul className="github-account-list">
          {accounts.map((account) => (
            <li key={account.id} className="github-account-row">
              <div className="github-account-facts">
                <span className="github-account-label">
                  {account.label}
                  {account.isDefault && <span className="github-account-badge">Default</span>}
                </span>
                <span className="github-account-meta">
                  {account.username !== "" ? `${account.username} · ` : ""}
                  token {account.tokenHint || "—"}
                </span>
              </div>
              <div className="github-account-actions">
                {!account.isDefault && (
                  <button
                    type="button"
                    disabled={busy || !canManage}
                    title={canManage ? undefined : ACCOUNT_HINT}
                    onClick={() => void makeDefault(account)}
                  >
                    Make default
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || !canManage}
                  title={canManage ? undefined : ACCOUNT_HINT}
                  onClick={() => void remove(account)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="github-account-form" onSubmit={(event) => void create(event)}>
        <label>
          <span>Label</span>
          <input
            value={label}
            maxLength={60}
            placeholder="Work"
            onChange={(event) => setLabel(event.target.value)}
          />
          <small className="field-hint">
            A name for this account — unique in your workspace and shown in the start card's
            account picker (for example Work or Personal).
          </small>
        </label>
        <label>
          <span>GitHub username (optional)</span>
          <input
            value={username}
            maxLength={100}
            placeholder="octocat"
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          <span>Personal access token</span>
          <input
            type="password"
            value={token}
            maxLength={500}
            placeholder="ghp_…"
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
          <small className="field-hint">
            Stored on the server and never shown again — the list shows only its last four
            characters.
          </small>
        </label>
        <div className="settings-actions">
          <button
            type="submit"
            disabled={busy || !canManage}
            title={canManage ? undefined : ACCOUNT_HINT}
          >
            {busy && <span className="spinner on-solid" aria-hidden="true" />}
            {busy ? "Saving…" : "Add account"}
          </button>
        </div>
      </form>
      {notice !== null && (
        <p className="settings-status ok" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="settings-status error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
