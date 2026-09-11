import { describe, expect, it } from "vitest";

import {
  emptyPrefs,
  emptyUiPrefs,
  loadPrefs,
  loadUiPrefs,
  rememberRecentTicket,
  savePrefs,
  saveUiPrefs,
  shellMode,
  type RecentTicket,
} from "./prefs.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("cached Jira preferences", () => {
  it("returns empty prefs when nothing is stored", () => {
    expect(loadPrefs(new MemoryStorage())).toEqual(emptyPrefs());
  });

  it("remembers a valid email, project, and board", () => {
    const storage = new MemoryStorage();
    savePrefs(storage, {
      email: "  you@company.com ",
      project: "scrum",
      boardId: 1,
      boardName: " SCRUM board ",
    });
    expect(loadPrefs(storage)).toEqual({
      email: "you@company.com",
      project: "SCRUM",
      boardId: 1,
      boardName: "SCRUM board",
    });
  });

  it("drops unsafe project keys and board ids", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "allrounder.jira.prefs",
      JSON.stringify({
        email: "you@company.com",
        project: 'ENG" OR project != "ENG',
        boardId: -3,
        boardName: "Bad",
      }),
    );
    expect(loadPrefs(storage)).toEqual({
      email: "you@company.com",
      project: "",
      boardId: null,
      boardName: "Bad",
    });
  });
});

describe("auth shell gating", () => {
  it("keeps the board hidden until a cached session is restored", () => {
    expect(
      shellMode({ configReady: true, sessionRestored: false, signedIn: true }),
    ).toBe("loading");
    expect(
      shellMode({ configReady: true, sessionRestored: true, signedIn: false }),
    ).toBe("auth");
    expect(
      shellMode({ configReady: true, sessionRestored: true, signedIn: true }),
    ).toBe("app");
  });

  it("stays on the sign-in screen when browser config is missing", () => {
    expect(
      shellMode({ configReady: false, sessionRestored: true, signedIn: true }),
    ).toBe("auth");
  });
});

describe("local UI preferences", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadUiPrefs(new MemoryStorage())).toEqual(emptyUiPrefs());
  });

  it("sanitizes invalid values on load", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "allrounder.ui.prefs",
      JSON.stringify({
        theme: "neon",
        autoRefreshSec: 9999,
        badge: "yes",
        confirmReject: false,
        recentTickets: [
          { key: "eng-1", summary: "A" },
          { key: "bad key", summary: "B" },
          { key: "ENG-1", summary: "duplicate" },
        ],
      }),
    );
    expect(loadUiPrefs(storage)).toEqual({
      theme: "light",
      autoRefreshSec: 0,
      badge: true,
      confirmReject: false,
      recentTickets: [{ key: "ENG-1", summary: "A" }],
    });
  });

  it("round-trips through storage", () => {
    const storage = new MemoryStorage();
    saveUiPrefs(storage, {
      theme: "dark",
      autoRefreshSec: 60,
      badge: false,
      confirmReject: true,
      recentTickets: [],
    });
    expect(loadUiPrefs(storage)).toEqual({
      theme: "dark",
      autoRefreshSec: 60,
      badge: false,
      confirmReject: true,
      recentTickets: [],
    });
  });

  it("keeps recent tickets deduplicated and capped", () => {
    let recent: RecentTicket[] = [];
    for (let index = 1; index <= 12; index += 1) {
      recent = rememberRecentTicket(recent, { key: `ENG-${index}`, summary: `S${index}` });
    }
    expect(recent).toHaveLength(10);
    expect(recent[0]!.key).toBe("ENG-12");
    const again = rememberRecentTicket(recent, { key: "ENG-5", summary: "updated" });
    expect(again).toHaveLength(10);
    expect(again[0]).toEqual({ key: "ENG-5", summary: "updated" });
  });

  it("refuses keys that are not ticket keys", () => {
    expect(rememberRecentTicket([], { key: "<script>", summary: "x" })).toEqual([]);
  });
});
