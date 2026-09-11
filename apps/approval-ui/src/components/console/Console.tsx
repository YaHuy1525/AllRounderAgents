"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { ApiError, api, apiUrl } from "@/lib/api";
import { chooseSignInMethod, signInStatusMessage, type SignInMethod } from "@/lib/auth";
import { compactTickets, type JiraIssue } from "@/lib/board";
import type { Approval, SessionInfo, Workspace } from "@/lib/models";
import {
  emptyPrefs,
  emptyUiPrefs,
  loadPrefs,
  loadUiPrefs,
  rememberRecentTicket,
  savePrefs,
  saveUiPrefs,
  shellMode,
  type JiraPrefs,
  type UiPrefs,
} from "@/lib/prefs";
import { getSupabaseClient } from "@/lib/supabase";
import {
  closeTab,
  DASHBOARD_TAB,
  ensureDashboard,
  openNewTab,
  openSingletonTab,
  openTicketTab,
  type Tab,
  type TicketRef,
} from "@/lib/tabs";

import { AccountPanel } from "./AccountPanel";
import { ApprovalsView } from "./ApprovalsView";
import { AssistantPanel } from "./AssistantPanel";
import { BoardView } from "./BoardView";
import { DocsPanel } from "./DocsPanel";
import {
  IconAccount,
  IconApprovals,
  IconBoard,
  IconChat,
  IconClock,
  IconClose,
  IconDocs,
  IconGrid,
  IconPlus,
  IconSettings,
} from "./icons";
import { NewTabView } from "./NewTabView";
import { SettingsView } from "./SettingsView";
import { TicketTab } from "./TicketTab";

type PanelKind = "approvals" | "docs" | "settings" | "account";

type BoardResult = {
  project: string;
  board_id: number | null;
  total: number;
  issues: JiraIssue[];
};

type SignInError = { message?: string; code?: string } | null;

const EMPTY_WORKSPACE: Workspace = { site: "", projects: [], boards: [] };

const BOARD_STATUS_COPY: Record<number, string> = {
  401: "Your session cannot load Jira. Sign out and sign back in.",
  403: "Your account cannot view this project.",
  422: "Enter a valid Jira project or board.",
  502: "Jira is temporarily unavailable.",
  503: "The Jira project is not configured.",
};

function sessionFrom(
  email: string,
  metadata: Record<string, unknown> | null,
  expiresAt: number | null,
): SessionInfo {
  const rolesRaw = metadata?.["roles"];
  const tenantRaw = metadata?.["tenant_id"];
  return {
    email,
    tenantId: typeof tenantRaw === "string" ? tenantRaw : "",
    roles: Array.isArray(rolesRaw)
      ? rolesRaw.filter((role): role is string => typeof role === "string")
      : [],
    expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
  };
}

function fallbackIssue(tab: Tab): JiraIssue {
  return {
    key: tab.ticketKey ?? "",
    project: "",
    summary: tab.ticketSummary ?? tab.title,
    issue_type: "Unknown",
    priority: "Unknown",
    status: "Unknown",
    assignee: null,
    labels: [],
    updated: "",
    browse_url: "",
  };
}

/**
 * Console shell: icon rail on the left, tab strip + history on top, the
 * active view in the middle, and the assistant rail on the right. Ticket
 * tabs are opened from the board (or the history menu) and render the
 * lane-correct run stepper for that ticket.
 */
export function Console() {
  const [mounted, setMounted] = useState(false);
  const [prefs, setPrefs] = useState<JiraPrefs>(emptyPrefs);
  const [uiPrefs, setUiPrefs] = useState<UiPrefs>(emptyUiPrefs);
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([DASHBOARD_TAB]);
  const [activeTabId, setActiveTabId] = useState(DASHBOARD_TAB.id);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("Loading Jira tickets…");
  const [settingsStatus, setSettingsStatus] = useState(
    "Choose the Jira site, project, and board for this browser.",
  );
  const [boardTitle, setBoardTitle] = useState("Jira issues");
  const [lastSync, setLastSync] = useState("—");
  const [refreshing, setRefreshing] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalsFailed, setApprovalsFailed] = useState(false);
  const [authStatus, setAuthStatus] = useState(
    "The Jira board stays locked until you sign in.",
  );
  const [signedInEmail, setSignedInEmail] = useState("");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionRestored, setSessionRestored] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [remember, setRemember] = useState(false);

  const prefsRef = useRef(prefs);
  const uiPrefsRef = useRef(uiPrefs);
  uiPrefsRef.current = uiPrefs;
  const workspaceRef = useRef(workspace);
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const historyRef = useRef<HTMLDivElement>(null);

  const applyPrefs = useCallback((next: JiraPrefs): JiraPrefs => {
    const saved = savePrefs(window.localStorage, next);
    prefsRef.current = saved;
    setPrefs(saved);
    return saved;
  }, []);

  const applyUiPrefs = useCallback((patch: Partial<UiPrefs>): void => {
    setUiPrefs((current) => saveUiPrefs(window.localStorage, { ...current, ...patch }));
  }, []);

  const loadWorkspace = useCallback(async (): Promise<Workspace> => {
    const result = await api<Workspace>("/jira/workspace");
    workspaceRef.current = result;
    setWorkspace(result);
    const current = prefsRef.current;
    const next: JiraPrefs = { ...current };
    if (!next.project && result.projects[0]) next.project = result.projects[0];
    const available = result.boards.filter((board) => board.project === next.project);
    // Mirrors the Vite-era selector semantics: a missing (or no longer
    // available) board is bound to the first board of the project, so ticket
    // fetches always carry a board id instead of falling back to a
    // project-wide search.
    if (!available.some((board) => board.id === next.boardId)) {
      next.boardId = available[0]?.id ?? null;
    }
    next.boardName = available.find((board) => board.id === next.boardId)?.name ?? "";
    applyPrefs(next);
    return result;
  }, [applyPrefs]);

  const loadBoard = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setStatus("Loading Jira tickets…");
    try {
      const loadedWorkspace = await loadWorkspace();
      const current = prefsRef.current;
      const params = new URLSearchParams();
      if (current.project) params.set("project", current.project);
      if (current.boardId) params.set("board_id", String(current.boardId));
      const encoded = params.toString();
      const result = await api<BoardResult>(
        `/jira/issues${encoded ? `?${encoded}` : ""}`,
      );
      setIssues(result.issues);
      const next = applyPrefs({
        ...prefsRef.current,
        project: result.project,
        boardId: result.board_id,
        boardName:
          loadedWorkspace.boards.find((board) => board.id === result.board_id)?.name ??
          prefsRef.current.boardName,
      });
      setBoardTitle(
        next.boardName ? `${next.boardName} · ${result.project}` : `${result.project} issues`,
      );
      setLastSync(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      );
      setStatus(`${result.total} tickets fetched from Jira`);
      setSettingsStatus(
        `Using ${loadedWorkspace.site || "the connected Jira site"} with project ${result.project}.`,
      );
    } catch (error) {
      setIssues([]);
      setStatus(
        error instanceof ApiError
          ? (BOARD_STATUS_COPY[error.status] ?? "Jira tickets could not be loaded.")
          : "Sign in and verify the browser configuration.",
      );
    } finally {
      setRefreshing(false);
    }
  }, [applyPrefs, loadWorkspace]);

  const loadApprovals = useCallback(async (): Promise<void> => {
    try {
      const result = await api<Approval[]>("/approvals");
      setApprovals(result);
      setApprovalsFailed(false);
    } catch {
      setApprovals([]);
      setApprovalsFailed(true);
    }
  }, []);

  const decide = useCallback(
    async (id: string, decision: "approved" | "rejected"): Promise<void> => {
      await api(`/approvals/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      await loadApprovals();
    },
    [loadApprovals],
  );

  const decideSafely = useCallback(
    async (id: string, decision: "approved" | "rejected"): Promise<void> => {
      if (
        decision === "rejected" &&
        uiPrefsRef.current.confirmReject &&
        !window.confirm("Reject this approval? The run stays blocked until a new decision is made.")
      ) {
        return;
      }
      await decide(id, decision);
    },
    [decide],
  );

  const focusDashboard = useCallback((): void => {
    const next = ensureDashboard(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
    activeTabIdRef.current = DASHBOARD_TAB.id;
    setActiveTabId(DASHBOARD_TAB.id);
  }, []);

  useEffect(() => {
    setMounted(true);
    const loaded = loadPrefs(window.localStorage);
    prefsRef.current = loaded;
    setPrefs(loaded);
    setEmail(loaded.email);
    setRemember(Boolean(loaded.email));
    setUiPrefs(loadUiPrefs(window.localStorage));
    const client = getSupabaseClient();
    if (!client) return;
    const { data } = client.auth.onAuthStateChange((event, session) => {
      const nextEmail = session?.user.email ?? "";
      setSignedInEmail(nextEmail);
      setSession(
        sessionFrom(
          nextEmail,
          (session?.user.app_metadata as Record<string, unknown> | undefined) ?? null,
          session?.expires_at ?? null,
        ),
      );
      if (session && rememberRef.current) {
        applyPrefs({ ...prefsRef.current, email: nextEmail || prefsRef.current.email });
      }
      setSessionRestored(true);
      if (session && event !== "TOKEN_REFRESHED") {
        focusDashboard();
        void Promise.all([loadBoard(), loadApprovals()]);
      }
      if (!session) {
        setIssues([]);
        setApprovals([]);
        setTabs([DASHBOARD_TAB]);
        tabsRef.current = [DASHBOARD_TAB];
        setActiveTabId(DASHBOARD_TAB.id);
        activeTabIdRef.current = DASHBOARD_TAB.id;
      }
    });
    return () => {
      data.subscription.unsubscribe();
    };
  }, [applyPrefs, focusDashboard, loadApprovals, loadBoard]);

  useEffect(() => {
    document.documentElement.dataset.theme = uiPrefs.theme;
  }, [uiPrefs.theme]);

  useEffect(() => {
    if (!signedInEmail || uiPrefs.autoRefreshSec <= 0) return;
    const timer = window.setInterval(() => {
      void loadBoard();
      void loadApprovals();
    }, uiPrefs.autoRefreshSec * 1000);
    return () => window.clearInterval(timer);
  }, [signedInEmail, uiPrefs.autoRefreshSec, loadBoard, loadApprovals]);

  useEffect(() => {
    if (!historyOpen) return;
    function handlePointerDown(event: MouseEvent): void {
      const target = event.target as Node;
      if (historyRef.current && !historyRef.current.contains(target)) setHistoryOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [historyOpen]);

  function rememberTicket(ref: TicketRef): void {
    setUiPrefs((current) =>
      saveUiPrefs(window.localStorage, {
        ...current,
        recentTickets: rememberRecentTicket(current.recentTickets, ref),
      }),
    );
  }

  function focusTicket(ref: TicketRef): void {
    const next = openTicketTab(tabsRef.current, ref);
    tabsRef.current = next.tabs;
    setTabs(next.tabs);
    activeTabIdRef.current = next.activeId;
    setActiveTabId(next.activeId);
    rememberTicket(ref);
    void loadApprovals();
  }

  function openTicket(issue: JiraIssue): void {
    focusTicket({ key: issue.key, summary: issue.summary });
  }

  function selectTab(id: string): void {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!tab) return;
    activeTabIdRef.current = id;
    setActiveTabId(id);
    if (tab.kind === "approvals") void loadApprovals();
  }

  function addTab(): void {
    const next = openNewTab(tabsRef.current);
    tabsRef.current = next.tabs;
    setTabs(next.tabs);
    activeTabIdRef.current = next.activeId;
    setActiveTabId(next.activeId);
  }

  function removeTab(id: string): void {
    const next = closeTab(tabsRef.current, id, activeTabIdRef.current);
    tabsRef.current = next.tabs;
    setTabs(next.tabs);
    activeTabIdRef.current = next.activeId;
    setActiveTabId(next.activeId);
  }

  function openPanel(kind: PanelKind): void {
    const next = openSingletonTab(tabsRef.current, kind);
    tabsRef.current = next.tabs;
    setTabs(next.tabs);
    activeTabIdRef.current = next.activeId;
    setActiveTabId(next.activeId);
    if (kind === "approvals") void loadApprovals();
    if (kind === "settings") {
      void loadWorkspace().catch(() => {
        setSettingsStatus("Jira workspace could not be loaded.");
      });
    }
  }

  function focusChat(): void {
    const input = document.getElementById("chat-input");
    if (input instanceof HTMLTextAreaElement) input.focus();
  }

  function openBoardFromNewTab(project: string, boardId: number | null): void {
    const boards = workspaceRef.current.boards.filter((board) => board.project === project);
    const chosen =
      boardId !== null && boards.some((board) => board.id === boardId)
        ? boardId
        : (boards[0]?.id ?? null);
    applyPrefs({
      ...prefsRef.current,
      project,
      boardId: chosen,
      boardName: boards.find((board) => board.id === chosen)?.name ?? "",
    });
    focusDashboard();
    void loadBoard();
  }

  const changeProject = useCallback(
    (project: string): void => {
      const boards = workspaceRef.current.boards.filter((board) => board.project === project);
      applyPrefs({
        ...prefsRef.current,
        project,
        boardId: boards[0]?.id ?? null,
        boardName: boards[0]?.name ?? "",
      });
      void loadBoard();
    },
    [applyPrefs, loadBoard],
  );

  const changeBoard = useCallback(
    (boardId: string): void => {
      applyPrefs({
        ...prefsRef.current,
        boardId: boardId ? Number(boardId) : null,
        boardName:
          workspaceRef.current.boards.find((board) => String(board.id) === boardId)?.name ?? "",
      });
      void loadBoard();
    },
    [applyPrefs, loadBoard],
  );

  const changeSettingsProject = useCallback(
    (project: string): void => {
      const boards = workspaceRef.current.boards.filter((board) => board.project === project);
      applyPrefs({
        ...prefsRef.current,
        project,
        boardId: boards[0]?.id ?? null,
        boardName: boards[0]?.name ?? "",
      });
    },
    [applyPrefs],
  );

  const changeSettingsBoard = useCallback(
    (boardId: string): void => {
      applyPrefs({
        ...prefsRef.current,
        boardId: boardId ? Number(boardId) : null,
        boardName:
          workspaceRef.current.boards.find((board) => String(board.id) === boardId)?.name ?? "",
      });
    },
    [applyPrefs],
  );

  const saveSettings = useCallback((): void => {
    const current = prefsRef.current;
    applyPrefs({
      ...current,
      email: rememberRef.current ? current.email || signedInEmail : current.email,
    });
    focusDashboard();
    void loadBoard();
  }, [applyPrefs, focusDashboard, loadBoard, signedInEmail]);

  const reloadWorkspace = useCallback((): void => {
    setSettingsStatus("Reloading Jira workspace…");
    void loadWorkspace()
      .then((result) => {
        setSettingsStatus(
          `Loaded ${result.projects.length} projects and ${result.boards.length} boards.`,
        );
      })
      .catch(() => {
        setSettingsStatus("Jira workspace could not be loaded.");
      });
  }, [loadWorkspace]);

  const signOut = useCallback((): void => {
    const client = getSupabaseClient();
    if (!client) return;
    setSignOutBusy(true);
    void client.auth.signOut({ scope: "local" }).finally(() => setSignOutBusy(false));
  }, []);

  async function handleSignIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    const client = getSupabaseClient();
    if (!client) {
      setAuthStatus("Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      return;
    }
    applyPrefs({ ...prefsRef.current, email: remember ? trimmed : "" });
    const method: SignInMethod = chooseSignInMethod({ password, otp });
    if (method === "magiclink") {
      setAuthStatus(signInStatusMessage("magiclink", null));
      return;
    }
    setSignInBusy(true);
    setAuthStatus(method === "otp" ? "Checking one-time code…" : "Signing in…");
    try {
      let error: SignInError = null;
      if (method === "password") {
        const result = await client.auth.signInWithPassword({
          email: trimmed,
          password,
        });
        error = result.error;
      } else {
        const first = await client.auth.verifyOtp({
          email: trimmed,
          token: otp.trim(),
          type: "magiclink",
        });
        error = first.error;
        if (first.error) {
          const second = await client.auth.verifyOtp({
            email: trimmed,
            token: otp.trim(),
            type: "email",
          });
          error = second.error;
        }
      }
      setAuthStatus(signInStatusMessage(method, error));
    } catch {
      setAuthStatus("Sign-in failed.");
    } finally {
      setSignInBusy(false);
      if (method === "password") setPassword("");
      if (method === "otp") setOtp("");
    }
  }

  const chatTickets = useMemo(() => compactTickets(issues), [issues]);
  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.decision === null).length,
    [approvals],
  );
  const configReady = Boolean(getSupabaseClient() && apiUrl);
  const shell = !mounted
    ? "loading"
    : shellMode({
        configReady,
        sessionRestored,
        signedIn: Boolean(signedInEmail),
      });

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? DASHBOARD_TAB;
  const activeTicketKey = activeTab.kind === "ticket" ? activeTab.ticketKey : undefined;
  const activeIssue =
    activeTab.kind === "ticket"
      ? (issues.find((issue) => issue.key === activeTab.ticketKey) ?? fallbackIssue(activeTab))
      : null;
  const accountInfo: SessionInfo = session ?? {
    email: signedInEmail || "Signed in",
    tenantId: "",
    roles: [],
    expiresAt: null,
  };

  return (
    <>
      {shell === "loading" && (
        <section id="loading-screen" className="gate-screen" aria-live="polite">
          <p className="eyebrow">AllRounderAgent</p>
          <h1>Restoring session</h1>
          <p>Checking the cached sign-in…</p>
        </section>
      )}

      {shell === "auth" && (
        <section id="auth-screen" className="gate-screen">
          <div className="auth-card">
            <p className="eyebrow">AllRounderAgent</p>
            <h1>Sign in to open the board</h1>
            <p>
              Email sign-in links are turned off. Use your password. Hard-refresh this page if you
              still see the old “send link” form.
            </p>
            <form id="login" className="login-form" onSubmit={(event) => void handleSignIn(event)}>
              <label>
                <span>Email</span>
                <input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label>
                <span>One-time code</span>
                <input
                  id="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={12}
                  placeholder="Only if you already have a code"
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                />
              </label>
              <label className="remember-row">
                <input
                  id="remember-email"
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span>Remember email on this device</span>
              </label>
              <button type="submit" disabled={signInBusy}>
                Sign in
              </button>
            </form>
            <p id="auth-status" role="status">
              {configReady
                ? authStatus
                : "Configure NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and NEXT_PUBLIC_API_URL."}
            </p>
          </div>
        </section>
      )}

      {shell === "app" && (
        <div id="app-shell" className="app-shell">
          <aside className="rail" aria-label="Primary navigation">
            <button
              type="button"
              className={`rail-button${activeTab.kind === "dashboard" ? " active" : ""}`}
              data-view="dashboard"
              aria-label="Dashboard"
              title="Dashboard"
              onClick={focusDashboard}
            >
              <IconGrid />
            </button>
            <button
              type="button"
              className={`rail-button${activeTab.kind === "dashboard" ? " active" : ""}`}
              data-view="board"
              aria-label="Sprint board"
              title="Sprint board"
              onClick={focusDashboard}
            >
              <IconBoard />
            </button>
            <button
              type="button"
              className={`rail-button${activeTab.kind === "approvals" ? " active" : ""}`}
              data-view="approvals"
              aria-label="Approvals"
              title="Approvals"
              onClick={() => openPanel("approvals")}
            >
              <IconApprovals />
              {uiPrefs.badge && pendingApprovals > 0 && (
                <span className="rail-badge" id="approvals-badge">
                  {pendingApprovals}
                </span>
              )}
            </button>
            <button
              type="button"
              className="rail-button"
              data-view="chat"
              aria-label="Chat and cases"
              title="Chat"
              onClick={focusChat}
            >
              <IconChat />
            </button>
            <button
              type="button"
              className={`rail-button${activeTab.kind === "docs" ? " active" : ""}`}
              data-view="docs"
              aria-label="Docs and help"
              title="Docs & help"
              onClick={() => openPanel("docs")}
            >
              <IconDocs />
            </button>
            <div className="rail-spacer" />
            <button
              type="button"
              className={`rail-button${activeTab.kind === "settings" ? " active" : ""}`}
              data-view="settings"
              aria-label="Settings"
              title="Settings"
              onClick={() => openPanel("settings")}
            >
              <IconSettings />
            </button>
            <button
              type="button"
              className={`rail-button${activeTab.kind === "account" ? " active" : ""}`}
              data-view="account"
              aria-label="Account"
              title="Account"
              onClick={() => openPanel("account")}
            >
              <IconAccount />
            </button>
          </aside>

          <main className="workspace">
            <header className="topbar">
              <div className="tab-strip" role="tablist" aria-label="Open tabs">
                {tabs.map((tab) => {
                  const active = tab.id === activeTabId;
                  return (
                    <span key={tab.id} className={`tab-chip${active ? " active" : ""}`}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className="tab-open"
                        onClick={() => selectTab(tab.id)}
                      >
                        {tab.title}
                      </button>
                      {tab.id !== DASHBOARD_TAB.id && (
                        <button
                          type="button"
                          className="tab-close"
                          aria-label={`Close ${tab.title}`}
                          onClick={() => removeTab(tab.id)}
                        >
                          <IconClose />
                        </button>
                      )}
                    </span>
                  );
                })}
                <button
                  type="button"
                  id="tab-add"
                  className="tab-add"
                  aria-label="New tab"
                  title="New tab"
                  onClick={addTab}
                >
                  <IconPlus />
                </button>
              </div>
              <div className="history-wrap" ref={historyRef}>
                <button
                  type="button"
                  id="history-button"
                  className="history-button"
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <IconClock />
                  <span>History</span>
                </button>
                {historyOpen && (
                  <div className="history-menu" role="menu" aria-label="Recently viewed tickets">
                    {uiPrefs.recentTickets.length === 0 ? (
                      <p className="history-empty">No tickets viewed yet.</p>
                    ) : (
                      uiPrefs.recentTickets.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          role="menuitem"
                          className="history-item"
                          onClick={() => {
                            setHistoryOpen(false);
                            focusTicket({ key: item.key, summary: item.summary });
                          }}
                        >
                          <strong>{item.key}</strong>
                          <span>{item.summary}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </header>

            <div className="view-area">
              {activeTab.kind === "dashboard" && (
                <BoardView
                  workspace={workspace}
                  prefs={prefs}
                  issues={issues}
                  boardTitle={boardTitle}
                  status={status}
                  lastSync={lastSync}
                  refreshing={refreshing}
                  search={search}
                  activeTicketKey={activeTicketKey}
                  onSearchChange={setSearch}
                  onProjectChange={changeProject}
                  onBoardChange={changeBoard}
                  onRefresh={() => void loadBoard()}
                  onOpenDetails={openTicket}
                />
              )}

              {activeTab.kind === "ticket" && activeIssue && (
                <TicketTab
                  key={activeTab.id}
                  issue={activeIssue}
                  approvals={approvals}
                  onDecide={decideSafely}
                />
              )}

              {activeTab.kind === "approvals" && (
                <ApprovalsView
                  approvals={approvals}
                  failed={approvalsFailed}
                  onDecide={(id, decision) => void decideSafely(id, decision)}
                />
              )}

              {activeTab.kind === "docs" && <DocsPanel />}

              {activeTab.kind === "settings" && (
                <SettingsView
                  workspace={workspace}
                  prefs={prefs}
                  uiPrefs={uiPrefs}
                  status={settingsStatus}
                  onSave={saveSettings}
                  onReload={reloadWorkspace}
                  onProjectChange={changeSettingsProject}
                  onBoardChange={changeSettingsBoard}
                  onUiChange={applyUiPrefs}
                />
              )}

              {activeTab.kind === "account" && (
                <AccountPanel
                  session={accountInfo}
                  signOutBusy={signOutBusy}
                  onSignOut={signOut}
                />
              )}

              {activeTab.kind === "new" && (
                <NewTabView workspace={workspace} prefs={prefs} onOpenBoard={openBoardFromNewTab} />
              )}
            </div>
          </main>

          <AssistantPanel tickets={chatTickets} selectedKey={activeTicketKey} />
        </div>
      )}
    </>
  );
}
