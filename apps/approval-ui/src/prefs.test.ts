import { describe, expect, it } from "vitest";

import { emptyPrefs, loadPrefs, savePrefs, shellMode } from "./prefs.js";

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
