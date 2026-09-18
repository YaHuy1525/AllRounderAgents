import type { SupabaseClient } from "@supabase/supabase-js";

import { readStoredSession } from "./auth";
import { AUTH_STORAGE_KEY, getSupabaseClient } from "./supabase";

export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * How long an API call waits for the auth client before falling back to the
 * session snapshot Supabase already persisted locally.
 */
export const SESSION_READ_TIMEOUT_MS = 3000;

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API request failed with status ${status}`);
  }
}

type SessionReader = Pick<SupabaseClient, "auth">;

/** Resolves with the value, or null once the timeout elapses or the promise rejects. */
function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Reads the access token for API calls. The auth client can stall (hung
 * token refresh, cross-tab lock wait), so the read is bounded and falls back
 * to the persisted session: a stale token then makes the API answer 401
 * instead of leaving every request pending forever.
 */
export async function resolveAccessToken(
  client: SessionReader,
  storage: Storage,
  timeoutMs: number = SESSION_READ_TIMEOUT_MS,
): Promise<string | null> {
  const result = await bounded(client.auth.getSession(), timeoutMs);
  const token = result?.data.session?.access_token;
  if (token) return token;
  return readStoredSession(storage, AUTH_STORAGE_KEY)?.accessToken ?? null;
}

/**
 * Browser-safe auth headers for direct fetches (streaming responses cannot
 * ride through the JSON helper below: SSE needs the raw response body).
 */
export async function sessionHeaders(): Promise<Record<string, string>> {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase browser configuration is incomplete");
  const token = await resolveAccessToken(client, window.localStorage);
  if (!token) throw new Error("Sign in first");
  return { Authorization: `Bearer ${token}` };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  return (await response.json()) as T;
}
