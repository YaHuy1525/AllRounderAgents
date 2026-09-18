export type SignInMethod = "password" | "otp" | "magiclink";

export function chooseSignInMethod(input: {
  password: string;
  otp: string;
}): SignInMethod {
  if (input.otp.trim()) return "otp";
  if (input.password.trim()) return "password";
  return "magiclink";
}

export function signInStatusMessage(
  method: SignInMethod,
  error: { message?: string; code?: string } | null,
): string {
  if (method === "magiclink" && error === null) {
    return "Sign-in emails are turned off. Enter your password instead of sending another link.";
  }
  if (!error) {
    return "Signed in.";
  }
  const haystack = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  if (
    haystack.includes("rate limit") ||
    haystack.includes("over_email_send_rate_limit")
  ) {
    return (
      "Supabase blocked another sign-in email. Leave the code blank and sign in with your password."
    );
  }
  if (haystack.includes("invalid login") || haystack.includes("invalid_credentials")) {
    return "That email and password did not match.";
  }
  if (haystack.includes("otp") || haystack.includes("token")) {
    return "That one-time code is invalid or expired. Use your password instead.";
  }
  return error.message?.trim() || "Sign-in failed.";
}

export type StoredSessionSnapshot = {
  email: string;
  accessToken: string | null;
  expiresAt: number | null;
  appMetadata: Record<string, unknown> | null;
};

/**
 * Reads the session snapshot the Supabase client persists under its storage
 * key. The console treats it as a bounded fallback: when the auth client
 * stalls (hung token refresh, cross-tab lock wait) the restore gate and the
 * API auth headers can still settle from this snapshot instead of waiting on
 * a promise that may never resolve.
 */
export function readStoredSession(storage: Storage, key: string): StoredSessionSnapshot | null {
  let parsed: unknown;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as {
    access_token?: unknown;
    expires_at?: unknown;
    user?: { email?: unknown; app_metadata?: unknown } | null;
  };
  const email = typeof value.user?.email === "string" ? value.user.email : "";
  const accessToken =
    typeof value.access_token === "string" && value.access_token.length > 0
      ? value.access_token
      : null;
  const expiresAt =
    typeof value.expires_at === "number" && Number.isFinite(value.expires_at)
      ? value.expires_at
      : null;
  const appMetadata =
    typeof value.user?.app_metadata === "object" && value.user.app_metadata !== null
      ? (value.user.app_metadata as Record<string, unknown>)
      : null;
  if (!email && !accessToken) return null;
  return { email, accessToken, expiresAt, appMetadata };
}
