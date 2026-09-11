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
