export type TabKind =
  | "dashboard"
  | "ticket"
  | "approvals"
  | "docs"
  | "settings"
  | "account"
  | "new";

const TAB_KINDS: readonly string[] = [
  "dashboard",
  "ticket",
  "approvals",
  "docs",
  "settings",
  "account",
  "new",
];

export type Tab = {
  id: string;
  kind: TabKind;
  title: string;
  ticketKey?: string;
  ticketSummary?: string;
};

export type TicketRef = { key: string; summary: string };

export const DASHBOARD_TAB: Tab = { id: "dashboard", kind: "dashboard", title: "Dashboard" };

export function ensureDashboard(tabs: Tab[]): Tab[] {
  return tabs.some((tab) => tab.id === DASHBOARD_TAB.id) ? tabs : [DASHBOARD_TAB, ...tabs];
}

export function shortSummary(summary: string, max = 42): string {
  const clean = summary.trim().replace(/\s+/g, " ");
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function ticketTabTitle(ticket: TicketRef): string {
  return `${ticket.key} - ${shortSummary(ticket.summary)}`;
}

export function openTicketTab(tabs: Tab[], ticket: TicketRef): { tabs: Tab[]; activeId: string } {
  const id = `ticket:${ticket.key}`;
  const existing = tabs.find((tab) => tab.id === id);
  if (existing) {
    return {
      tabs: tabs.map((tab) =>
        tab.id === id
          ? { ...tab, title: ticketTabTitle(ticket), ticketSummary: ticket.summary }
          : tab,
      ),
      activeId: id,
    };
  }
  return {
    tabs: [
      ...tabs,
      {
        id,
        kind: "ticket",
        title: ticketTabTitle(ticket),
        ticketKey: ticket.key,
        ticketSummary: ticket.summary,
      },
    ],
    activeId: id,
  };
}

const SINGLETON_TITLES: Record<"approvals" | "docs" | "settings" | "account", string> = {
  approvals: "Approvals",
  docs: "Docs & help",
  settings: "Settings",
  account: "Account",
};

export function openSingletonTab(
  tabs: Tab[],
  kind: "approvals" | "docs" | "settings" | "account",
): { tabs: Tab[]; activeId: string } {
  if (tabs.some((tab) => tab.kind === kind)) return { tabs, activeId: kind };
  return { tabs: [...tabs, { id: kind, kind, title: SINGLETON_TITLES[kind] }], activeId: kind };
}

export function openNewTab(tabs: Tab[]): { tabs: Tab[]; activeId: string } {
  let index = 1;
  while (tabs.some((tab) => tab.id === `new-${index}`)) index += 1;
  const id = `new-${index}`;
  return { tabs: [...tabs, { id, kind: "new", title: "New tab" }], activeId: id };
}

export function closeTab(
  tabs: Tab[],
  id: string,
  activeId: string,
): { tabs: Tab[]; activeId: string } {
  // The Dashboard stays open: it is the anchor every workspace returns to.
  if (id === DASHBOARD_TAB.id) return { tabs, activeId };
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return { tabs, activeId };
  const next = tabs.filter((tab) => tab.id !== id);
  if (activeId !== id) return { tabs: next, activeId };
  const fallback = next[Math.max(0, index - 1)]?.id ?? DASHBOARD_TAB.id;
  return { tabs: next, activeId: fallback };
}

const TAB_STATE_KEY = "allrounder.tabs.v1";

export type TabState = { tabs: Tab[]; activeTabId: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function sanitizeTab(value: unknown): Tab | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const kind = typeof record.kind === "string" ? record.kind : "";
  if (id === "" || !TAB_KINDS.includes(kind)) return null;
  const tab: Tab = {
    id,
    kind: kind as TabKind,
    title: typeof record.title === "string" ? record.title : "",
  };
  if (typeof record.ticketKey === "string" && record.ticketKey !== "") {
    tab.ticketKey = record.ticketKey;
  }
  if (typeof record.ticketSummary === "string" && record.ticketSummary !== "") {
    tab.ticketSummary = record.ticketSummary;
  }
  return tab;
}

/**
 * Restore the tab strip saved by `saveTabState`. Invalid entries are dropped
 * and the dashboard is re-anchored, so a corrupt payload can never wedge the
 * console — it just falls back to a fresh dashboard.
 */
export function loadTabState(storage: Pick<Storage, "getItem">): TabState | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(TAB_STATE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return null;
    const tabs: Tab[] = [];
    for (const item of Array.isArray(parsed.tabs) ? parsed.tabs : []) {
      const tab = sanitizeTab(item);
      if (tab !== null && !tabs.some((entry) => entry.id === tab.id)) tabs.push(tab);
    }
    if (tabs.length === 0) return null;
    const next = ensureDashboard(tabs);
    const activeTabId =
      typeof parsed.activeTabId === "string" &&
      next.some((tab) => tab.id === parsed.activeTabId)
        ? parsed.activeTabId
        : DASHBOARD_TAB.id;
    return { tabs: next, activeTabId };
  } catch {
    return null;
  }
}

/** Best-effort persistence: storage may be unavailable (private mode). */
export function saveTabState(storage: Pick<Storage, "setItem">, state: TabState): void {
  try {
    storage.setItem(
      TAB_STATE_KEY,
      JSON.stringify({ tabs: state.tabs, activeTabId: state.activeTabId }),
    );
  } catch {
    // The console still works when the tab strip cannot be persisted.
  }
}
