"use client";

import { useEffect, useState, type FormEvent } from "react";

import { ApiError } from "@/lib/api";
import {
  clientRefProblem,
  deleteMspClient,
  downloadAuditPack,
  getMspConnections,
  normalizeClientRef,
  packMonth,
  saveMspConnection,
  upsertMspClient,
  type MspClient,
  type MspConnection,
  type MspConnections,
} from "@/lib/runs";

import { IconInbox, IconLock } from "./icons";

const MSP_HINT = "Changing the MSP connection requires the agent or admin role.";

function mspErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "Your role cannot change MSP settings — an agent or admin role is required.";
    }
    if (error.status === 409) {
      return "Save the mailbox connection before adding clients.";
    }
    if (error.status === 422) {
      return "The server rejected these values — check the domain and the client ref.";
    }
    if (error.status >= 500) {
      return "The API could not reach its database — check the API logs and retry.";
    }
  }
  return "The change could not be saved — try again.";
}

function clientMeta(client: MspClient, domain: string): string {
  const parts = [
    domain !== "" ? `${client.clientRef}@${domain}` : client.clientRef,
    client.deskProject !== "" ? `desk ${client.deskProject}` : "",
    client.displayName,
    client.contactEmail,
  ];
  return parts.filter((part) => part !== "").join(" · ");
}

/**
 * MSP connection section of Settings. Self-contained island, like the GitHub
 * accounts section: it owns the tenant's inbound mailbox and the client refs
 * intake files against, and downloads the monthly audit pack per client. The
 * server stays the source of truth for validation — the form only pre-checks
 * what the client ref check would reject anyway.
 */
export function MspConnectionsSection({ canManage = true }: { canManage?: boolean }) {
  const [data, setData] = useState<MspConnections | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [domain, setDomain] = useState("");
  const [domainName, setDomainName] = useState("");
  const [clientRef, setClientRef] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientProject, setClientProject] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [month, setMonth] = useState(() => packMonth(new Date()));
  const [busy, setBusy] = useState(false);
  const [packing, setPacking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function apply(next: MspConnections): void {
    setData(next);
    if (next.connection !== null) {
      setDomain(next.connection.inboundDomain);
      setDomainName(next.connection.displayName);
    }
  }

  async function refresh(): Promise<void> {
    apply(await getMspConnections());
  }

  useEffect(() => {
    let cancelled = false;
    getMspConnections()
      .then((payload) => {
        if (!cancelled) apply(payload);
      })
      .catch(() => {
        if (!cancelled) {
          setData({ connection: null, clients: [] });
          setLoadFailed(true);
          setError("MSP settings could not be loaded — check the API connection.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveConnection(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    setError(null);
    setNotice(null);
    const inboundDomain = domain.trim().toLowerCase();
    if (!inboundDomain.includes(".") || /\s/.test(inboundDomain)) {
      setError("Enter the full inbox domain, for example in.msp.example.");
      return;
    }
    setBusy(true);
    try {
      const connection: MspConnection = await saveMspConnection({
        inboundDomain,
        ...(domainName.trim() === "" ? {} : { displayName: domainName.trim() }),
      });
      await refresh();
      setNotice(`Mailbox connection saved for ${connection.inboundDomain}.`);
    } catch (saveError) {
      setError(mspErrorCopy(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function addClient(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    setError(null);
    setNotice(null);
    const problem = clientRefProblem(clientRef);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const client = await upsertMspClient({
        clientRef: normalizeClientRef(clientRef),
        ...(clientName.trim() === "" ? {} : { displayName: clientName.trim() }),
        ...(clientProject.trim() === "" ? {} : { deskProject: clientProject.trim() }),
        ...(clientEmail.trim() === "" ? {} : { contactEmail: clientEmail.trim() }),
      });
      await refresh();
      setClientRef("");
      setClientName("");
      setClientProject("");
      setClientEmail("");
      setNotice(`Registered client ${client.clientRef}.`);
    } catch (addError) {
      setError(mspErrorCopy(addError));
    } finally {
      setBusy(false);
    }
  }

  async function removeClient(client: MspClient): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await deleteMspClient(client.clientRef);
      await refresh();
      setNotice(`Removed client ${client.clientRef}.`);
    } catch (removeError) {
      setError(mspErrorCopy(removeError));
    } finally {
      setBusy(false);
    }
  }

  async function download(client: MspClient): Promise<void> {
    setError(null);
    setNotice(null);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      setError("Pick the audit pack month first.");
      return;
    }
    setPacking(client.clientRef);
    try {
      await downloadAuditPack(client.clientRef, month);
      setNotice(`Audit pack downloaded for ${client.clientRef} (${month}).`);
    } catch (downloadError) {
      setError(mspErrorCopy(downloadError));
    } finally {
      setPacking(null);
    }
  }

  const connection = data?.connection ?? null;
  const clients = data?.clients ?? [];
  const inboundDomain = connection?.inboundDomain ?? "";

  return (
    <section className="settings-section" id="msp-connections-section">
      <header className="settings-head">
        <span className="settings-head-icon" aria-hidden="true">
          <IconInbox />
        </span>
        <div>
          <h3>MSP connection</h3>
          <p>
            The inbound mailbox this workspace watches and the client refs intake files against.
            Mail to a client ref&apos;s address starts an MSP run on that client&apos;s case.
          </p>
        </div>
      </header>
      {!canManage && (
        <p className="role-hint" role="note">
          <IconLock />
          {MSP_HINT}
        </p>
      )}
      {data === null ? (
        <p className="settings-loading">
          <span className="spinner" aria-hidden="true" />
          Loading MSP settings…
        </p>
      ) : (
        <>
          {connection === null ? (
            <p className="step-summary">
              {loadFailed
                ? "MSP settings are unavailable right now."
                : "No mailbox connection yet — save one below to start the desk."}
            </p>
          ) : (
            <dl className="msp-connection-facts">
              <div className="fact-row">
                <dt>Inbound domain</dt>
                <dd>{connection.inboundDomain}</dd>
              </div>
              <div className="fact-row">
                <dt>Display name</dt>
                <dd>{connection.displayName !== "" ? connection.displayName : "—"}</dd>
              </div>
            </dl>
          )}
          <form className="msp-form" onSubmit={(event) => void saveConnection(event)}>
            <label>
              <span>Inbound domain</span>
              <input
                value={domain}
                maxLength={253}
                placeholder="in.msp.example"
                onChange={(event) => setDomain(event.target.value)}
              />
              <small className="field-hint">
                The mailbox domain the forwarder delivers to. Client mail at{" "}
                {`acme@${domain.trim().toLowerCase() || "in.msp.example"}`} files against client
                ref acme.
              </small>
            </label>
            <label>
              <span>Display name (optional)</span>
              <input
                value={domainName}
                maxLength={100}
                placeholder="MSP desk"
                onChange={(event) => setDomainName(event.target.value)}
              />
            </label>
            <div className="settings-actions">
              <button
                type="submit"
                disabled={busy || !canManage}
                title={canManage ? undefined : MSP_HINT}
              >
                {busy && <span className="spinner on-solid" aria-hidden="true" />}
                {busy ? "Saving…" : connection === null ? "Save connection" : "Update connection"}
              </button>
            </div>
          </form>

          {connection === null ? (
            <p className="step-summary">
              Client refs register against the connection, so save it first.
            </p>
          ) : (
            <>
              <div className="msp-pack-controls">
                <label>
                  <span>Audit pack month</span>
                  <input
                    type="month"
                    value={month}
                    max={packMonth(new Date())}
                    onChange={(event) => setMonth(event.target.value)}
                  />
                </label>
              </div>
              {clients.length === 0 ? (
                <p className="step-summary">
                  No client refs yet — add one below so intake mail can file against it.
                </p>
              ) : (
                <ul className="msp-client-list">
                  {clients.map((client) => (
                    <li key={client.clientRef} className="msp-client-row">
                      <div className="msp-client-facts">
                        <span className="msp-client-label">{client.clientRef}</span>
                        <span className="msp-client-meta">
                          {clientMeta(client, inboundDomain)}
                        </span>
                      </div>
                      <div className="msp-client-actions">
                        <button
                          type="button"
                          disabled={packing !== null}
                          onClick={() => void download(client)}
                        >
                          {packing === client.clientRef && (
                            <span className="spinner" aria-hidden="true" />
                          )}
                          Download pack
                        </button>
                        <button
                          type="button"
                          disabled={busy || !canManage}
                          title={canManage ? undefined : MSP_HINT}
                          onClick={() => void removeClient(client)}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form className="msp-form" onSubmit={(event) => void addClient(event)}>
                <label>
                  <span>Client ref</span>
                  <input
                    value={clientRef}
                    maxLength={64}
                    placeholder="acme"
                    onChange={(event) => setClientRef(event.target.value)}
                  />
                  <small className="field-hint">
                    The mailbox local part before @{inboundDomain || "…"} — saved lowercased, dots
                    and dashes allowed.
                  </small>
                </label>
                <label>
                  <span>Display name (optional)</span>
                  <input
                    value={clientName}
                    maxLength={100}
                    placeholder="Acme Support"
                    onChange={(event) => setClientName(event.target.value)}
                  />
                </label>
                <label>
                  <span>Desk ticket project (optional)</span>
                  <input
                    value={clientProject}
                    maxLength={60}
                    placeholder="ACME"
                    onChange={(event) => setClientProject(event.target.value)}
                  />
                </label>
                <label>
                  <span>Contact email (optional)</span>
                  <input
                    type="email"
                    value={clientEmail}
                    maxLength={320}
                    placeholder="help@acme.example"
                    onChange={(event) => setClientEmail(event.target.value)}
                  />
                </label>
                <div className="settings-actions">
                  <button
                    type="submit"
                    disabled={busy || !canManage}
                    title={canManage ? undefined : MSP_HINT}
                  >
                    {busy && <span className="spinner on-solid" aria-hidden="true" />}
                    {busy ? "Saving…" : "Add client"}
                  </button>
                </div>
              </form>
            </>
          )}
        </>
      )}
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
