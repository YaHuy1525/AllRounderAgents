import { describe, expect, it } from "vitest";

import { resolveAccessToken } from "./api.js";

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

const cachedSession = JSON.stringify({
  access_token: "cached-token",
  expires_at: 1893456000,
  user: { email: "louis@omnidewalt.com", app_metadata: {} },
});

type SessionReaderArg = Parameters<typeof resolveAccessToken>[0];

function liveClient(token: string): SessionReaderArg {
  return {
    auth: {
      getSession: async () => ({ data: { session: { access_token: token } }, error: null }),
    },
  } as unknown as SessionReaderArg;
}

function stalledClient(): SessionReaderArg {
  return {
    auth: { getSession: () => new Promise(() => {}) },
  } as unknown as SessionReaderArg;
}

function failingClient(): SessionReaderArg {
  return {
    auth: {
      getSession: async () => {
        throw new Error("network down");
      },
    },
  } as unknown as SessionReaderArg;
}

describe("access token resolution", () => {
  it("prefers the live session token when the auth client answers", async () => {
    await expect(
      resolveAccessToken(
        liveClient("live-token"),
        fakeStorage({ "allrounder-auth": cachedSession }),
      ),
    ).resolves.toBe("live-token");
  });

  it("falls back to the cached token when the auth client stalls", async () => {
    await expect(
      resolveAccessToken(stalledClient(), fakeStorage({ "allrounder-auth": cachedSession }), 20),
    ).resolves.toBe("cached-token");
  });

  it("falls back to the cached token when the auth client rejects", async () => {
    await expect(
      resolveAccessToken(failingClient(), fakeStorage({ "allrounder-auth": cachedSession }), 20),
    ).resolves.toBe("cached-token");
  });

  it("resolves to null when neither the client nor the cache has a token", async () => {
    await expect(resolveAccessToken(stalledClient(), fakeStorage({}), 20)).resolves.toBeNull();
    await expect(resolveAccessToken(failingClient(), fakeStorage({}), 20)).resolves.toBeNull();
  });
});
