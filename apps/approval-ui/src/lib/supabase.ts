import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const AUTH_STORAGE_KEY = "allrounder-auth";

/**
 * Auth requests must never hang forever: a stalled token refresh blocks the
 * client's initialization (and every getSession() caller) until the network
 * stack gives up. Aborting converts the stall into the retryable network
 * error the auth client already knows how to recover from.
 */
const AUTH_FETCH_TIMEOUT_MS = 15_000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const external = init?.signal ?? null;
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, AUTH_FETCH_TIMEOUT_MS);
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", abort);
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  });
}

let cached: SupabaseClient | null | undefined;

/**
 * Browser-only Supabase client. Returns null during prerender (no window) or
 * when the public configuration is missing, mirroring the shell gating in
 * the console: no client means the sign-in screen explains what to configure.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (typeof window === "undefined") return null;
  if (cached === undefined) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    cached =
      url && anonKey
        ? createClient(url, anonKey, {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true,
              storageKey: AUTH_STORAGE_KEY,
            },
            global: { fetch: fetchWithTimeout },
          })
        : null;
  }
  return cached;
}
