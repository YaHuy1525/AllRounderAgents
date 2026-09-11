const STORAGE_KEY = "allrounder.jira.prefs";
const PROJECT_PATTERN = /^[A-Z][A-Z0-9_]{0,19}$/;

export type JiraPrefs = {
  email: string;
  project: string;
  boardId: number | null;
  boardName: string;
};

export function emptyPrefs(): JiraPrefs {
  return { email: "", project: "", boardId: null, boardName: "" };
}

export function loadPrefs(storage: Pick<Storage, "getItem">): JiraPrefs {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return emptyPrefs();
  try {
    const parsed = JSON.parse(raw) as Partial<JiraPrefs>;
    const project = typeof parsed.project === "string" ? parsed.project.toUpperCase() : "";
    const boardId =
      typeof parsed.boardId === "number" && Number.isInteger(parsed.boardId) && parsed.boardId > 0
        ? parsed.boardId
        : null;
    return {
      email: typeof parsed.email === "string" ? parsed.email.trim() : "",
      project: PROJECT_PATTERN.test(project) ? project : "",
      boardId,
      boardName: typeof parsed.boardName === "string" ? parsed.boardName : "",
    };
  } catch {
    return emptyPrefs();
  }
}

export function savePrefs(storage: Pick<Storage, "setItem">, prefs: JiraPrefs): JiraPrefs {
  const project = prefs.project.trim().toUpperCase();
  const next: JiraPrefs = {
    email: prefs.email.trim(),
    project: PROJECT_PATTERN.test(project) ? project : "",
    boardId:
      prefs.boardId !== null && Number.isInteger(prefs.boardId) && prefs.boardId > 0
        ? prefs.boardId
        : null,
    boardName: prefs.boardName.trim(),
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export type ShellMode = "loading" | "auth" | "app";

export function shellMode(input: {
  configReady: boolean;
  sessionRestored: boolean;
  signedIn: boolean;
}): ShellMode {
  if (!input.configReady) return "auth";
  if (!input.sessionRestored) return "loading";
  return input.signedIn ? "app" : "auth";
}

const UI_STORAGE_KEY = "allrounder.ui.prefs";
const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,19}-\d+$/;

export const RECENT_TICKET_LIMIT = 10;

export type RecentTicket = { key: string; summary: string };

/**
 * Local-only console preferences (theme, refresh cadence, notifications, and
 * the history rail). They ride a separate storage key from the Jira prefs so
 * the sign-in cache keeps its existing shape.
 */
export type UiPrefs = {
  theme: "light" | "dark";
  autoRefreshSec: number;
  badge: boolean;
  confirmReject: boolean;
  recentTickets: RecentTicket[];
};

export function emptyUiPrefs(): UiPrefs {
  return {
    theme: "light",
    autoRefreshSec: 0,
    badge: true,
    confirmReject: true,
    recentTickets: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function sanitizeRecent(value: unknown): RecentTicket[] {
  if (!Array.isArray(value)) return [];
  const recent: RecentTicket[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const key = typeof record.key === "string" ? record.key.trim().toUpperCase() : "";
    if (!TICKET_KEY_PATTERN.test(key)) continue;
    if (recent.some((entry) => entry.key === key)) continue;
    recent.push({
      key,
      summary: typeof record.summary === "string" ? record.summary.trim().slice(0, 240) : "",
    });
    if (recent.length === RECENT_TICKET_LIMIT) break;
  }
  return recent;
}

function sanitizeRefresh(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 600
    ? value
    : 0;
}

export function loadUiPrefs(storage: Pick<Storage, "getItem">): UiPrefs {
  const raw = storage.getItem(UI_STORAGE_KEY);
  if (!raw) return emptyUiPrefs();
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return emptyUiPrefs();
    return {
      theme: parsed.theme === "dark" ? "dark" : "light",
      autoRefreshSec: sanitizeRefresh(parsed.autoRefreshSec),
      badge: parsed.badge !== false,
      confirmReject: parsed.confirmReject !== false,
      recentTickets: sanitizeRecent(parsed.recentTickets),
    };
  } catch {
    return emptyUiPrefs();
  }
}

export function saveUiPrefs(storage: Pick<Storage, "setItem">, prefs: UiPrefs): UiPrefs {
  const next: UiPrefs = {
    theme: prefs.theme === "dark" ? "dark" : "light",
    autoRefreshSec: sanitizeRefresh(prefs.autoRefreshSec),
    badge: prefs.badge !== false,
    confirmReject: prefs.confirmReject !== false,
    recentTickets: sanitizeRecent(prefs.recentTickets),
  };
  storage.setItem(UI_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/**
 * Prepend a ticket to the history rail, deduplicating by key and capping the
 * list so it never grows past the documented limit.
 */
export function rememberRecentTicket(
  recent: RecentTicket[],
  ticket: RecentTicket,
  limit = RECENT_TICKET_LIMIT,
): RecentTicket[] {
  const key = ticket.key.trim().toUpperCase();
  if (!TICKET_KEY_PATTERN.test(key)) return recent;
  const entry: RecentTicket = { key, summary: ticket.summary.trim().slice(0, 240) };
  return [entry, ...recent.filter((item) => item.key !== key)].slice(0, Math.max(1, limit));
}
