import { createClient } from "@supabase/supabase-js";

import { chooseSignInMethod, signInStatusMessage } from "./auth.js";
import {
  BOARD_COLUMNS,
  boardStats,
  compactTickets,
  groupIssues,
  safeBrowseUrl,
  ticketFacts,
  type JiraIssue,
} from "./board.js";
import { loadPrefs, savePrefs, shellMode, type JiraPrefs } from "./prefs.js";
import "./styles.css";

type Approval = {
  id: string;
  caseId: string;
  action: Record<string, unknown>;
  evidence: Array<{ sourceId: string; span: string }>;
  decision: "approved" | "rejected" | "expired" | null;
  expiresAt: string;
};

type JiraBoardOption = {
  id: number;
  name: string;
  type: string;
  project: string;
};

type Workspace = {
  site: string;
  projects: string[];
  boards: JiraBoardOption[];
};

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: "allrounder-auth",
        },
      })
    : null;

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Required UI node is missing: ${selector}`);
  return node;
}

const loadingScreen = required<HTMLElement>("#loading-screen");
const authScreen = required<HTMLElement>("#auth-screen");
const appShell = required<HTMLElement>("#app-shell");
const authStatus = required<HTMLParagraphElement>("#auth-status");
const statusNode = required<HTMLParagraphElement>("#status");
const settingsStatus = required<HTMLParagraphElement>("#settings-status");
const approvalsNode = required<HTMLElement>("#approvals");
const login = required<HTMLFormElement>("#login");
const emailInput = required<HTMLInputElement>("#email");
const passwordInput = required<HTMLInputElement>("#password");
const otpInput = required<HTMLInputElement>("#otp");
const rememberEmail = required<HTMLInputElement>("#remember-email");
const signInButton = required<HTMLButtonElement>("#login button[type='submit']");
const boardNode = required<HTMLElement>("#board");
const projectSelect = required<HTMLSelectElement>("#project");
const boardSelect = required<HTMLSelectElement>("#board-select");
const searchInput = required<HTMLInputElement>("#search");
const refreshButton = required<HTMLButtonElement>("#refresh");
const boardTitle = required<HTMLElement>("#board-title");
const workspaceTitle = required<HTMLElement>("#workspace-title");
const totalNode = required<HTMLElement>("#total");
const progressNode = required<HTMLElement>("#progress");
const activeNode = required<HTMLElement>("#active-count");
const syncNode = required<HTMLElement>("#last-sync");
const boardView = required<HTMLElement>("#board-view");
const approvalsView = required<HTMLElement>("#approvals-view");
const settingsView = required<HTMLElement>("#settings-view");
const sessionEmail = required<HTMLElement>("#session-email");
const signOutButton = required<HTMLButtonElement>("#sign-out");
const settingsForm = required<HTMLFormElement>("#settings-form");
const settingsEmail = required<HTMLInputElement>("#settings-email");
const jiraSiteInput = required<HTMLInputElement>("#jira-site");
const settingsProject = required<HTMLSelectElement>("#settings-project");
const settingsBoard = required<HTMLSelectElement>("#settings-board");
const reloadWorkspace = required<HTMLButtonElement>("#reload-workspace");
const ticketDialog = required<HTMLDialogElement>("#ticket-dialog");
const ticketDialogKey = required<HTMLElement>("#ticket-dialog-key");
const ticketDialogTitle = required<HTMLElement>("#ticket-dialog-title");
const ticketDialogFacts = required<HTMLElement>("#ticket-dialog-facts");
const ticketDialogJira = required<HTMLAnchorElement>("#ticket-dialog-jira");
const chatLog = required<HTMLElement>("#chat-log");
const chatForm = required<HTMLFormElement>("#chat-form");
const chatInput = required<HTMLTextAreaElement>("#chat-input");
const chatSend = required<HTMLButtonElement>("#chat-send");
const viewButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-view]"),
);

let issues: JiraIssue[] = [];
let selectedIssue: JiraIssue | null = null;
let prefs: JiraPrefs = loadPrefs(window.localStorage);
let workspace: Workspace = { site: "", projects: [], boards: [] };
let signedInEmail = "";

emailInput.value = prefs.email;
rememberEmail.checked = Boolean(prefs.email);

class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API request failed with status ${status}`);
  }
}

function text(tag: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function option(value: string, label: string, selected = false): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  node.selected = selected;
  return node;
}

function applyShell(signedIn: boolean, restored = true): void {
  const mode = shellMode({
    configReady: Boolean(supabase && apiUrl),
    sessionRestored: restored,
    signedIn,
  });
  loadingScreen.hidden = mode !== "loading";
  authScreen.hidden = mode !== "auth";
  appShell.hidden = mode !== "app";
  if (!supabase || !apiUrl) {
    authStatus.textContent = "Configure VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and VITE_API_URL.";
  }
}

function persistPrefs(next: JiraPrefs): void {
  prefs = savePrefs(window.localStorage, next);
}

async function token(): Promise<string> {
  if (!supabase) throw new Error("Supabase browser configuration is incomplete");
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Sign in first");
  return data.session.access_token;
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!apiUrl) throw new Error("VITE_API_URL is not configured");
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}

function boardsForProject(project: string): JiraBoardOption[] {
  return workspace.boards.filter((board) => board.project === project);
}

function fillSelect(
  node: HTMLSelectElement,
  items: Array<{ value: string; label: string }>,
  selected: string,
): void {
  node.replaceChildren();
  if (items.length === 0) {
    node.append(option("", "None available", true));
    return;
  }
  for (const item of items) {
    node.append(option(item.value, item.label, item.value === selected));
  }
  if (!items.some((item) => item.value === selected)) node.selectedIndex = 0;
}

function syncSelectors(): void {
  const project = prefs.project || workspace.projects[0] || "";
  const boards = boardsForProject(project);
  const boardId = prefs.boardId ? String(prefs.boardId) : boards[0] ? String(boards[0].id) : "";
  fillSelect(
    projectSelect,
    workspace.projects.map((key) => ({ value: key, label: key })),
    project,
  );
  fillSelect(
    boardSelect,
    boards.map((board) => ({ value: String(board.id), label: board.name })),
    boardId,
  );
  fillSelect(
    settingsProject,
    workspace.projects.map((key) => ({ value: key, label: key })),
    project,
  );
  fillSelect(
    settingsBoard,
    boards.map((board) => ({
      value: String(board.id),
      label: `${board.name} (${board.type})`,
    })),
    boardId,
  );
  prefs = {
    ...prefs,
    project: projectSelect.value,
    boardId: boardSelect.value ? Number(boardSelect.value) : null,
    boardName: boards.find((board) => String(board.id) === boardSelect.value)?.name ?? "",
  };
  jiraSiteInput.value = workspace.site;
  settingsEmail.value = signedInEmail;
  sessionEmail.textContent = signedInEmail || "Signed in";
}

function selectedQuery(): string {
  const params = new URLSearchParams();
  if (projectSelect.value) params.set("project", projectSelect.value);
  if (boardSelect.value) params.set("board_id", boardSelect.value);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function decide(id: string, decision: "approved" | "rejected"): Promise<void> {
  await api(`/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
  await loadApprovals();
}

function issueCard(issue: JiraIssue): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "ticket-card";
  if (selectedIssue?.key === issue.key) card.classList.add("selected");

  const key = text("span", issue.key);
  key.className = "ticket-key";
  const title = text("h4", issue.summary);
  title.className = "ticket-title";
  const meta = document.createElement("div");
  meta.className = "ticket-meta";
  const issueType = text("span", issue.issue_type);
  issueType.className = "ticket-type";
  const priority = text("span", issue.priority);
  priority.className = `priority priority-${issue.priority.toLowerCase()}`;
  meta.append(issueType, priority);
  card.append(key, title, meta);
  card.title = issue.assignee ? `Assigned to ${issue.assignee}` : "Unassigned";
  card.addEventListener("click", () => openTicket(issue));
  return card;
}

function openTicket(issue: JiraIssue): void {
  selectedIssue = issue;
  ticketDialogKey.textContent = issue.key;
  ticketDialogTitle.textContent = issue.summary;
  ticketDialogFacts.replaceChildren();
  for (const fact of ticketFacts(issue)) {
    const term = text("dt", fact.label);
    const detail = text("dd", fact.value);
    ticketDialogFacts.append(term, detail);
  }
  const href = safeBrowseUrl(issue.browse_url);
  ticketDialogJira.href = href;
  ticketDialogJira.hidden = href === "#";
  if (!ticketDialog.open) ticketDialog.showModal();
  renderBoard();
}

function renderBoard(): void {
  const grouped = groupIssues(issues, searchInput.value);
  boardNode.replaceChildren();
  for (const column of BOARD_COLUMNS) {
    const section = document.createElement("section");
    section.className = "board-column";
    const heading = document.createElement("div");
    heading.className = "column-heading";
    heading.append(text("h3", column.label));
    const count = text("span", String(grouped[column.id].length));
    count.className = "column-count";
    heading.append(count);
    const cards = document.createElement("div");
    cards.className = "cards";
    for (const issue of grouped[column.id]) cards.append(issueCard(issue));
    if (grouped[column.id].length === 0) {
      const empty = text("p", "No tickets");
      empty.className = "empty-column";
      cards.append(empty);
    }
    section.append(heading, cards);
    boardNode.append(section);
  }

  const stats = boardStats(issues);
  totalNode.textContent = String(stats.total);
  progressNode.textContent = `${stats.progress}%`;
  activeNode.textContent = String(stats.active);
}

function showView(view: string): void {
  boardView.hidden = view !== "board";
  approvalsView.hidden = view !== "approvals";
  settingsView.hidden = view !== "settings";
  workspaceTitle.textContent =
    view === "settings" ? "Jira settings" : view === "approvals" ? "Approvals" : "Jira project console";
  for (const button of viewButtons) {
    button.classList.toggle("active", button.dataset.view === view);
  }
}

async function loadWorkspace(): Promise<void> {
  workspace = (await api("/jira/workspace")) as Workspace;
  if (!prefs.project && workspace.projects[0]) prefs.project = workspace.projects[0];
  const available = boardsForProject(prefs.project);
  if (prefs.boardId && !available.some((board) => board.id === prefs.boardId)) {
    prefs.boardId = available[0]?.id ?? null;
    prefs.boardName = available[0]?.name ?? "";
  }
  syncSelectors();
  persistPrefs(prefs);
}

async function loadBoard(): Promise<void> {
  refreshButton.disabled = true;
  statusNode.textContent = "Loading Jira tickets…";
  try {
    await loadWorkspace();
    const result = (await api(`/jira/issues${selectedQuery()}`)) as {
      project: string;
      board_id: number | null;
      total: number;
      issues: JiraIssue[];
    };
    issues = result.issues;
    if (selectedIssue && !issues.some((issue) => issue.key === selectedIssue?.key)) {
      selectedIssue = null;
    }
    persistPrefs({
      ...prefs,
      project: result.project,
      boardId: result.board_id,
      boardName: boardsForProject(result.project).find((board) => board.id === result.board_id)?.name ?? prefs.boardName,
    });
    syncSelectors();
    boardTitle.textContent = prefs.boardName
      ? `${prefs.boardName} · ${result.project}`
      : `${result.project} issues`;
    syncNode.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    statusNode.textContent = `${result.total} tickets fetched from Jira`;
    settingsStatus.textContent = `Using ${workspace.site || "the connected Jira site"} with project ${result.project}.`;
    renderBoard();
  } catch (error) {
    issues = [];
    renderBoard();
    statusNode.textContent =
      error instanceof ApiError
        ? {
            401: "Your session cannot load Jira. Sign out and sign back in.",
            403: "Your account cannot view this project.",
            422: "Enter a valid Jira project or board.",
            502: "Jira is temporarily unavailable.",
            503: "The Jira project is not configured.",
          }[error.status] ?? "Jira tickets could not be loaded."
        : "Sign in and verify the browser configuration.";
  } finally {
    refreshButton.disabled = false;
  }
}

async function loadApprovals(): Promise<void> {
  try {
    const approvals = (await api("/approvals")) as Approval[];
    approvalsNode.replaceChildren();
    for (const approval of approvals) {
      const card = document.createElement("article");
      card.className = "approval-card";
      card.append(
        text("h2", `Case ${approval.caseId}`),
        text("pre", JSON.stringify(approval.action, null, 2)),
        text(
          "p",
          `Evidence: ${approval.evidence.map((item) => `${item.sourceId}:${item.span}`).join(", ")}`,
        ),
        text("p", `Expires: ${approval.expiresAt}`),
      );
      if (approval.decision === null) {
        const actions = document.createElement("div");
        actions.className = "approval-actions";
        for (const decision of ["approved", "rejected"] as const) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = decision === "approved" ? "Approve" : "Reject";
          button.addEventListener("click", () => void decide(approval.id, decision));
          actions.append(button);
        }
        card.append(actions);
      } else {
        card.append(text("strong", `Decision: ${approval.decision}`));
      }
      approvalsNode.append(card);
    }
    if (approvals.length === 0) approvalsNode.append(text("p", "No approvals waiting."));
  } catch {
    approvalsNode.replaceChildren(text("p", "Sign in to view approvals."));
  }
}

login.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = emailInput.value.trim();
  if (!email) return;
  if (!supabase) {
    authStatus.textContent = "Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.";
    return;
  }
  if (rememberEmail.checked) persistPrefs({ ...prefs, email });
  else persistPrefs({ ...prefs, email: "" });
  const method = chooseSignInMethod({
    password: passwordInput.value,
    otp: otpInput.value,
  });
  if (method === "magiclink") {
    authStatus.textContent = signInStatusMessage("magiclink", null);
    return;
  }
  signInButton.disabled = true;
  authStatus.textContent =
    method === "otp" ? "Checking one-time code…" : "Signing in…";
  const request =
    method === "password"
      ? supabase.auth.signInWithPassword({ email, password: passwordInput.value })
      : supabase.auth
          .verifyOtp({
            email,
            token: otpInput.value.trim(),
            type: "magiclink",
          })
          .then(async (first) => {
            if (!first.error) return first;
            return supabase.auth.verifyOtp({
              email,
              token: otpInput.value.trim(),
              type: "email",
            });
          });
  void request
    .then(({ error }) => {
      authStatus.textContent = signInStatusMessage(method, error);
      signInButton.disabled = false;
      if (method === "password") passwordInput.value = "";
      if (method === "otp") otpInput.value = "";
    })
    .catch(() => {
      authStatus.textContent = "Sign-in failed.";
      signInButton.disabled = false;
    });
});

settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  persistPrefs({
    ...prefs,
    project: settingsProject.value,
    boardId: settingsBoard.value ? Number(settingsBoard.value) : null,
    boardName: workspace.boards.find((board) => String(board.id) === settingsBoard.value)?.name ?? "",
    email: rememberEmail.checked ? prefs.email || signedInEmail : prefs.email,
  });
  syncSelectors();
  showView("board");
  void loadBoard();
});

reloadWorkspace.addEventListener("click", () => {
  settingsStatus.textContent = "Reloading Jira workspace…";
  void loadWorkspace()
    .then(() => {
      settingsStatus.textContent = `Loaded ${workspace.projects.length} projects and ${workspace.boards.length} boards.`;
    })
    .catch(() => {
      settingsStatus.textContent = "Jira workspace could not be loaded.";
    });
});

settingsProject.addEventListener("change", () => {
  prefs = { ...prefs, project: settingsProject.value, boardId: null, boardName: "" };
  syncSelectors();
});

projectSelect.addEventListener("change", () => {
  prefs = { ...prefs, project: projectSelect.value, boardId: null, boardName: "" };
  persistPrefs(prefs);
  syncSelectors();
  void loadBoard();
});

boardSelect.addEventListener("change", () => {
  persistPrefs({
    ...prefs,
    boardId: boardSelect.value ? Number(boardSelect.value) : null,
    boardName: workspace.boards.find((board) => String(board.id) === boardSelect.value)?.name ?? "",
  });
  void loadBoard();
});

signOutButton.addEventListener("click", () => {
  void supabase?.auth.signOut({ scope: "local" });
});

refreshButton.addEventListener("click", () => void loadBoard());
searchInput.addEventListener("input", renderBoard);

function appendChat(role: "user" | "assistant", body: string): void {
  const hint = chatLog.querySelector(".chat-hint");
  if (hint) hint.remove();
  const row = document.createElement("article");
  row.className = `chat-row chat-${role}`;
  row.append(text("p", body));
  chatLog.append(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChat(): Promise<void> {
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
  appendChat("user", message);
  chatSend.disabled = true;
  try {
    const result = (await api("/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        selectedKey: selectedIssue?.key ?? undefined,
        tickets: compactTickets(issues),
      }),
    })) as { reply: string };
    appendChat("assistant", result.reply);
  } catch (error) {
    appendChat(
      "assistant",
      error instanceof ApiError && error.status === 401
        ? "Sign out and sign back in so chat can use your session."
        : "The assistant could not answer just now.",
    );
  } finally {
    chatSend.disabled = false;
    chatInput.focus();
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendChat();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendChat();
  }
});

ticketDialog.addEventListener("click", (event) => {
  if (event.target === ticketDialog) ticketDialog.close();
});

for (const button of viewButtons) {
  button.addEventListener("click", () => {
    const view = button.dataset.view ?? "board";
    showView(view);
    if (view === "approvals") void loadApprovals();
    if (view === "settings") void loadWorkspace().catch(() => {
      settingsStatus.textContent = "Jira workspace could not be loaded.";
    });
  });
}

applyShell(false, false);
if (!supabase) applyShell(false, true);

supabase?.auth.onAuthStateChange((event, session) => {
  signedInEmail = session?.user.email ?? "";
  if (session && rememberEmail.checked) persistPrefs({ ...prefs, email: signedInEmail || prefs.email });
  applyShell(Boolean(session), true);
  if (session && event !== "TOKEN_REFRESHED") {
    showView("board");
    void Promise.all([loadBoard(), loadApprovals()]);
  }
});
