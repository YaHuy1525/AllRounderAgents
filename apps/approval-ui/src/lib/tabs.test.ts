import { describe, expect, it } from "vitest";

import {
  closeTab,
  DASHBOARD_TAB,
  ensureDashboard,
  loadTabState,
  openNewTab,
  openSingletonTab,
  openTicketTab,
  saveTabState,
  shortSummary,
  ticketTabTitle,
  type Tab,
} from "./tabs.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const TICKET_TAB: Tab = {
  id: "ticket:ENG-42",
  kind: "ticket",
  title: "ENG-42 - Fix the refund flow",
  ticketKey: "ENG-42",
  ticketSummary: "Fix the refund flow",
};

describe("console tabs", () => {
  it("keeps the dashboard as the anchored first tab", () => {
    expect(ensureDashboard([])).toEqual([DASHBOARD_TAB]);
    const tabs = [DASHBOARD_TAB];
    expect(ensureDashboard(tabs)).toBe(tabs);
  });

  it("opens a ticket tab titled KEY - short summary and focuses it", () => {
    const result = openTicketTab([DASHBOARD_TAB], {
      key: "ENG-7",
      summary:
        "Fix the login flow that breaks whenever the session is refreshed and the token expires",
    });
    expect(result.activeId).toBe("ticket:ENG-7");
    expect(result.tabs).toHaveLength(2);
    const tab = result.tabs[1]!;
    expect(tab.kind).toBe("ticket");
    expect(tab.title.startsWith("ENG-7 - ")).toBe(true);
    expect(tab.title.endsWith("…")).toBe(true);
    expect(tab.title.length).toBeLessThan(60);
  });

  it("focuses an existing ticket tab instead of duplicating it", () => {
    const first = openTicketTab([DASHBOARD_TAB], { key: "ENG-7", summary: "One" });
    const second = openTicketTab(first.tabs, { key: "ENG-7", summary: "One updated" });
    expect(second.tabs).toHaveLength(2);
    expect(second.activeId).toBe("ticket:ENG-7");
    expect(second.tabs[1]!.ticketSummary).toBe("One updated");
  });

  it("closes a tab and falls back to the previous tab", () => {
    let state = openTicketTab([DASHBOARD_TAB], { key: "ENG-1", summary: "A" });
    state = openTicketTab(state.tabs, { key: "ENG-2", summary: "B" });
    const closed = closeTab(state.tabs, "ticket:ENG-2", state.activeId);
    expect(closed.tabs.map((tab) => tab.id)).toEqual(["dashboard", "ticket:ENG-1"]);
    expect(closed.activeId).toBe("ticket:ENG-1");
  });

  it("keeps the active tab when closing a background tab", () => {
    let state = openTicketTab([DASHBOARD_TAB], { key: "ENG-1", summary: "A" });
    state = openTicketTab(state.tabs, { key: "ENG-2", summary: "B" });
    const closed = closeTab(state.tabs, "ticket:ENG-1", state.activeId);
    expect(closed.activeId).toBe("ticket:ENG-2");
    expect(closed.tabs.map((tab) => tab.id)).toEqual(["dashboard", "ticket:ENG-2"]);
  });

  it("never closes the dashboard", () => {
    const state = openTicketTab([DASHBOARD_TAB], { key: "ENG-1", summary: "A" });
    const closed = closeTab(state.tabs, "dashboard", "ticket:ENG-1");
    expect(closed.tabs).toBe(state.tabs);
    expect(closed.activeId).toBe("ticket:ENG-1");
  });

  it("opens singleton panels once and numbers new tabs", () => {
    const first = openSingletonTab([DASHBOARD_TAB], "approvals");
    expect(first.activeId).toBe("approvals");
    const again = openSingletonTab(first.tabs, "approvals");
    expect(again.tabs).toHaveLength(first.tabs.length);
    expect(again.activeId).toBe("approvals");
    const newTab = openNewTab(again.tabs);
    const secondNew = openNewTab(newTab.tabs);
    expect(newTab.activeId).toBe("new-1");
    expect(secondNew.activeId).toBe("new-2");
    expect(secondNew.tabs).toHaveLength(first.tabs.length + 2);
  });

  it("collapses whitespace and truncates long summaries", () => {
    expect(shortSummary("a\n b   c")).toBe("a b c");
    expect(shortSummary("x".repeat(200))).toHaveLength(42);
    expect(ticketTabTitle({ key: "ENG-1", summary: "Short" })).toBe("ENG-1 - Short");
  });
});

describe("open tab persistence", () => {
  it("returns null when nothing is stored", () => {
    expect(loadTabState(new MemoryStorage())).toBeNull();
  });

  it("round-trips the tab strip and active tab", () => {
    const storage = new MemoryStorage();
    saveTabState(storage, { tabs: [DASHBOARD_TAB, TICKET_TAB], activeTabId: TICKET_TAB.id });
    expect(loadTabState(storage)).toEqual({
      tabs: [DASHBOARD_TAB, TICKET_TAB],
      activeTabId: TICKET_TAB.id,
    });
  });

  it("re-anchors the dashboard and drops an unknown active tab", () => {
    const storage = new MemoryStorage();
    saveTabState(storage, { tabs: [TICKET_TAB], activeTabId: "nope" });
    expect(loadTabState(storage)).toEqual({
      tabs: [DASHBOARD_TAB, TICKET_TAB],
      activeTabId: DASHBOARD_TAB.id,
    });
  });

  it("drops invalid entries but keeps the valid ones", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "allrounder.tabs.v1",
      JSON.stringify({
        tabs: [
          { id: "dashboard", kind: "dashboard", title: "Dashboard" },
          { id: "evil", kind: "not-a-kind", title: "Nope" },
          { id: "", kind: "docs", title: "No id" },
          "junk",
        ],
        activeTabId: "docs",
      }),
    );
    expect(loadTabState(storage)).toEqual({
      tabs: [DASHBOARD_TAB],
      activeTabId: DASHBOARD_TAB.id,
    });
  });

  it("deduplicates repeated tab ids and falls back on corrupt JSON", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "allrounder.tabs.v1",
      JSON.stringify({
        tabs: [DASHBOARD_TAB, { ...DASHBOARD_TAB }, { ...TICKET_TAB }],
        activeTabId: TICKET_TAB.id,
      }),
    );
    expect(loadTabState(storage)).toEqual({
      tabs: [DASHBOARD_TAB, TICKET_TAB],
      activeTabId: TICKET_TAB.id,
    });
    storage.setItem("allrounder.tabs.v1", "{not json");
    expect(loadTabState(storage)).toBeNull();
  });
});
