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
