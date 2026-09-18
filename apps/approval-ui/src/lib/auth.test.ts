import { describe, expect, it } from "vitest";

import { chooseSignInMethod, readStoredSession, signInStatusMessage } from "./auth.js";

describe("sign-in method", () => {
  it("prefers a one-time code over a leftover password", () => {
    expect(chooseSignInMethod({ password: "secret", otp: "123456" })).toBe("otp");
    expect(chooseSignInMethod({ password: "secret", otp: "" })).toBe("password");
    expect(chooseSignInMethod({ password: "", otp: "123456" })).toBe("otp");
    expect(chooseSignInMethod({ password: "  ", otp: "" })).toBe("magiclink");
  });
});

describe("sign-in status copy", () => {
  it("tells the user to use a password instead of sending another email", () => {
    expect(signInStatusMessage("magiclink", null)).toContain("password");
    expect(signInStatusMessage("magiclink", null)).not.toContain("Check your email");
    expect(
      signInStatusMessage("magiclink", {
        code: "over_email_send_rate_limit",
        message: "email rate limit exceeded",
      }),
    ).toContain("password");
  });
});

function fakeStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("persisted session snapshot", () => {
  it("reads the session Supabase stores under the auth key", () => {
    const storage = fakeStorage({
      "allrounder-auth": JSON.stringify({
        access_token: "token-123",
        expires_at: 1893456000,
        user: {
          email: "louis@omnidewalt.com",
          app_metadata: { tenant_id: "omnidewalt", roles: ["admin"] },
        },
      }),
    });
    expect(readStoredSession(storage, "allrounder-auth")).toEqual({
      email: "louis@omnidewalt.com",
      accessToken: "token-123",
      expiresAt: 1893456000,
      appMetadata: { tenant_id: "omnidewalt", roles: ["admin"] },
    });
  });

  it("returns null when nothing is cached or the payload is unusable", () => {
    expect(readStoredSession(fakeStorage({}), "allrounder-auth")).toBeNull();
    expect(
      readStoredSession(fakeStorage({ "allrounder-auth": "not json" }), "allrounder-auth"),
    ).toBeNull();
    expect(
      readStoredSession(fakeStorage({ "allrounder-auth": "42" }), "allrounder-auth"),
    ).toBeNull();
    expect(
      readStoredSession(
        fakeStorage({
          "allrounder-auth": JSON.stringify({ access_token: "", user: { email: "" } }),
        }),
        "allrounder-auth",
      ),
    ).toBeNull();
  });

  it("keeps a token-only snapshot usable when the user block is missing", () => {
    const storage = fakeStorage({
      "allrounder-auth": JSON.stringify({ access_token: "token-123" }),
    });
    expect(readStoredSession(storage, "allrounder-auth")).toEqual({
      email: "",
      accessToken: "token-123",
      expiresAt: null,
      appMetadata: null,
    });
  });
});
