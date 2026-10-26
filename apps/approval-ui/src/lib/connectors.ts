import { ApiError, api, apiUrl, sessionHeaders } from "./api";

/**
 * Connector registry + vault client (Settings -> Connections). The catalog comes
 * from the API, which serves it from the reviewed `policy/tools.yaml`; this module
 * adds per-tenant connection state and a display-only badge overlay. Connecting
 * registers a credential only — permissions stay in the tool matrix, so a
 * connection never adds an execution path. Secrets are write-only.
 */

/** ApprovalClass mirror (policy.py): strongest posture across a provider's tools. */
export type ConnectorClass = "auto" | "approval" | "refuse" | "read-only";

export type ConnectorStatus = {
  provider: string;
  description: string;
  /** The reviewed permission scope the connection registers under. */
  scope: string;
  /** Strongest ApprovalClass posture across the tools the provider serves. */
  class: ConnectorClass;
  connected: boolean;
  /** Last-four hint for the stored credential; empty while disconnected. */
  secretHint: string;
  connectedAt: string | null;
};

/** The connectable catalog in reviewed order, each entry with this tenant's status. */
export async function listConnectors(): Promise<ConnectorStatus[]> {
  const payload = await api<{ connectors: ConnectorStatus[] }>("/connectors");
  return payload.connectors;
}

/** Connect (or rotate the credential of) one provider for the tenant. */
export async function connectConnector(
  provider: string,
  secret: string,
): Promise<ConnectorStatus> {
  return api<ConnectorStatus>(`/connectors/${encodeURIComponent(provider)}/connect`, {
    method: "POST",
    body: JSON.stringify({ secret }),
  });
}

/** DELETE answers 204 without a body, so the JSON helper cannot be used. */
async function apiVoid(path: string, init: RequestInit = {}): Promise<void> {
  if (!apiUrl) throw new Error("NEXT_PUBLIC_API_URL is not configured");
  const auth = await sessionHeaders();
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...auth,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new ApiError(response.status);
}

/** Disconnect one provider: the vault row is deleted and the badges revert. */
export async function disconnectConnector(provider: string): Promise<void> {
  await apiVoid(`/connectors/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}

/** Provider ids currently connected, in catalog order. */
export function connectedProviders(statuses: readonly ConnectorStatus[]): string[] {
  return statuses.filter((status) => status.connected).map((status) => status.provider);
}

/**
 * Which declared step providers each connector can badge. One connector may
 * back several channels; gmail backs the generic `email` channel, so a
 * connected Gmail swaps that glyph on hr-help:send with no seed edit, and
 * disconnecting reverts it.
 */
export const CONNECTOR_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  github: ["github"],
  jira: ["jira"],
  gmail: ["email"],
  calendar: ["calendar"],
  slack: ["slack"],
};

/**
 * Display-only overlay: replaces each declared provider with the first
 * connected connector that backs it (in catalog order), keeping declared
 * order. Purely cosmetic — execution permissions never ride on this, so a
 * connection cannot widen what a run may do.
 */
export function resolveStepProviders(
  declared: readonly string[],
  connected: readonly string[],
): string[] {
  return declared.map((provider) => {
    for (const connector of connected) {
      if (CONNECTOR_CHANNELS[connector]?.includes(provider)) return connector;
    }
    return provider;
  });
}
