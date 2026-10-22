"use client";

import { useEffect, useState, type FormEvent } from "react";

import { ApiError } from "@/lib/api";
import {
  connectConnector,
  disconnectConnector,
  listConnectors,
  type ConnectorStatus,
} from "@/lib/connectors";
import { integrationAccent, integrationLabel } from "@/lib/integrations";
import { CONNECTOR_HINT } from "@/lib/roles";

import { IconLink, IconLock, ProviderGlyph } from "./icons";

function connectorErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "Your role cannot manage connections — an agent or admin role is required.";
    }
    if (error.status === 404) {
      return "That provider is no longer in the reviewed catalog — reload the page.";
    }
    if (error.status >= 500) {
      return "The API could not reach its connector vault — check the API logs and retry.";
    }
  }
  return "The connection could not be saved — check the credential and try again.";
}

export type ConnectorListProps = {
  /** Null until the catalog resolves; an empty list means it failed or is bare. */
  connectors: readonly ConnectorStatus[] | null;
  loadFailed: boolean;
  canManage: boolean;
  /** The provider whose credential form is open. */
  formProvider: string | null;
  secret: string;
  busy: boolean;
  onSecretChange: (value: string) => void;
  onOpenForm: (provider: string) => void;
  onCloseForm: () => void;
  onConnect: (provider: string) => void;
  onDisconnect: (provider: string) => void;
};

/** Props-driven list so SSR tests can pin the catalog, status and role render. */
export function ConnectorList({
  connectors,
  loadFailed,
  canManage,
  formProvider,
  secret,
  busy,
  onSecretChange,
  onOpenForm,
  onCloseForm,
  onConnect,
  onDisconnect,
}: ConnectorListProps) {
  if (connectors === null) {
    return (
      <p className="settings-loading">
        <span className="spinner" aria-hidden="true" />
        Loading connections…
      </p>
    );
  }
  if (connectors.length === 0) {
    return (
      <p className="step-summary">
        {loadFailed
          ? "Connections are unavailable right now."
          : "No connectable providers — check the policy catalog."}
      </p>
    );
  }
  return (
    <ul className="connector-list">
      {connectors.map((connector) => {
        const label = integrationLabel(connector.provider);
        const open = formProvider === connector.provider;
        return (
          <li key={connector.provider} className="connector-row">
            <span className="connector-identity">
              <span
                className="connector-glyph"
                aria-hidden="true"
                style={{ color: integrationAccent(connector.provider) }}
              >
                <ProviderGlyph provider={connector.provider} />
              </span>
              <span className="connector-facts">
                <span className="connector-label">
                  {label}
                  {connector.connected && <span className="connector-badge">Connected</span>}
                </span>
                <span className="connector-desc">{connector.description}</span>
                <span className="connector-meta">
                  {connector.scope} · {connector.class}
                  {connector.connected && connector.secretHint !== ""
                    ? ` · ${connector.secretHint}`
                    : ""}
                </span>
              </span>
            </span>
            <span className="connector-actions">
              {connector.connected ? (
                <>
                  <button
                    type="button"
                    disabled={busy || !canManage}
                    title={canManage ? undefined : CONNECTOR_HINT}
                    onClick={() => onOpenForm(connector.provider)}
                  >
                    Replace credential
                  </button>
                  <button
                    type="button"
                    disabled={busy || !canManage}
                    title={canManage ? undefined : CONNECTOR_HINT}
                    onClick={() => onDisconnect(connector.provider)}
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy || !canManage}
                  title={canManage ? undefined : CONNECTOR_HINT}
                  onClick={() => onOpenForm(connector.provider)}
                >
                  Connect
                </button>
              )}
            </span>
            {open && (
              <form
                className="connector-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  onConnect(connector.provider);
                }}
              >
                <label>
                  <span>{connector.connected ? `New ${label} credential` : `${label} credential`}</span>
                  <input
                    type="password"
                    value={secret}
                    maxLength={500}
                    autoComplete="off"
                    placeholder="Paste the provider credential"
                    disabled={busy}
                    onChange={(event) => onSecretChange(event.target.value)}
                  />
                  <small className="field-hint">
                    Stored server-side and never shown again — the list shows only its last four
                    characters.
                  </small>
                </label>
                <div className="settings-actions">
                  <button
                    type="submit"
                    disabled={busy || !canManage}
                    title={canManage ? undefined : CONNECTOR_HINT}
                  >
                    {busy && <span className="spinner on-solid" aria-hidden="true" />}
                    {busy ? "Saving…" : "Save credential"}
                  </button>
                  <button type="button" disabled={busy} onClick={onCloseForm}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Connections section of Settings. Self-contained island (like the GitHub
 * accounts section): the catalog comes from `GET /connectors`, which serves
 * the reviewed `policy/tools.yaml` catalog merged with this tenant's vault
 * rows. Connecting registers a credential only — execution permissions stay
 * in the tool matrix, so this never widens what a run may do; disconnecting
 * deletes the row and the provider's badges leave the steps it served.
 */
export function ConnectionsSection({ canManage = true }: { canManage?: boolean }) {
  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [formProvider, setFormProvider] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setConnectors(await listConnectors());
  }

  useEffect(() => {
    let cancelled = false;
    listConnectors()
      .then((items) => {
        if (!cancelled) setConnectors(items);
      })
      .catch(() => {
        if (!cancelled) {
          setConnectors([]);
          setLoadFailed(true);
          setError("Connections could not be loaded — check the API connection.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openForm(provider: string): void {
    setFormProvider(provider);
    setSecret("");
    setError(null);
    setNotice(null);
  }

  function closeForm(): void {
    setFormProvider(null);
    setSecret("");
  }

  async function connect(provider: string): Promise<void> {
    if (!canManage) return;
    setError(null);
    setNotice(null);
    const credential = secret.trim();
    if (credential.length < 8) {
      setError("Paste the provider credential (at least 8 characters).");
      return;
    }
    setBusy(true);
    try {
      await connectConnector(provider, credential);
      await refresh();
      setFormProvider(null);
      setSecret("");
      setNotice(`Connected ${integrationLabel(provider)}.`);
    } catch (connectError) {
      setError(connectorErrorCopy(connectError));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(provider: string): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await disconnectConnector(provider);
      await refresh();
      if (formProvider === provider) closeForm();
      setNotice(`Disconnected ${integrationLabel(provider)} — its badges leave the steps it served.`);
    } catch {
      setError("The connection could not be removed — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" id="connections-section">
      <header className="settings-head">
        <span className="settings-head-icon" aria-hidden="true">
          <IconLink />
        </span>
        <div>
          <h3>Connections</h3>
          <p>
            Register the provider credentials this workspace may act with. Connecting never grants
            a tool — permissions stay in the review matrix — it only puts the provider&apos;s badge
            on the steps its channel serves.
          </p>
        </div>
      </header>
      {!canManage && (
        <p className="role-hint" role="note">
          <IconLock />
          {CONNECTOR_HINT}
        </p>
      )}
      <ConnectorList
        connectors={connectors}
        loadFailed={loadFailed}
        canManage={canManage}
        formProvider={formProvider}
        secret={secret}
        busy={busy}
        onSecretChange={setSecret}
        onOpenForm={openForm}
        onCloseForm={closeForm}
        onConnect={(provider) => void connect(provider)}
        onDisconnect={(provider) => void disconnect(provider)}
      />
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
