import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
              storageKey: "allrounder-auth",
            },
          })
        : null;
  }
  return cached;
}
