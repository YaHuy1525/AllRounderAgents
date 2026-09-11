import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import { resolve } from "node:path";

// The repo keeps a single .env at the workspace root (npm workspace scripts
// run with the working directory inside apps/approval-ui). The Next.js CLI
// has already called loadEnvConfig for the app folder — which has no .env —
// so its cached result must be bypassed with forceReload or the root values
// are silently ignored and the browser bundle loses its configuration.
loadEnvConfig(
  resolve(process.cwd(), "../.."),
  process.env.NODE_ENV !== "production",
  console,
  true,
);

/**
 * The CLI can pre-seed NEXT_PUBLIC_* variables as empty strings, and both
 * Next.js and dotenv treat an existing (empty) value as the source of truth
 * over the .env file. Treat blanks as missing and fall back to the VITE_*
 * names the rest of the repo already uses.
 */
function preferEnv(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value;
  }
  return "";
}

const supabaseUrl = preferEnv(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.VITE_SUPABASE_URL,
);
const supabaseAnonKey = preferEnv(
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  process.env.VITE_SUPABASE_ANON_KEY,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);
const apiUrl = preferEnv(process.env.NEXT_PUBLIC_API_URL, process.env.VITE_API_URL);

// Keep both channels in sync: mutating process.env fixes Next.js' own
// NEXT_PUBLIC_* inlining, and the env key is the documented mechanism that
// guarantees the values reach the client bundle.
process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = supabaseAnonKey;
process.env.NEXT_PUBLIC_API_URL = apiUrl;

const nextConfig: NextConfig = {
  // The console is a session-gated SPA with no server-side rendering needs:
  // ship it as static HTML/JS so the existing nginx container (and the
  // pinned CORS origin on port 5173) keep working without a Node runtime.
  output: "export",
  env: {
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
    NEXT_PUBLIC_API_URL: apiUrl,
  },
};

export default nextConfig;
