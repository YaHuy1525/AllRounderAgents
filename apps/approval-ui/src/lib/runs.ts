import { ApiError, api, apiUrl, sessionHeaders } from "./api";

/**
 * Browser-side model for the parallel-safe runs API. The API owns the run
 * state; this module mirrors its shapes, applies per-run SSE events onto the
 * last known run (snappy UI), and exposes the start/decide/cancel/subscribe
 * calls the run panel drives.
 */

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_human"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "awaiting_human",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

export type RunStepState =
  | "pending"
  | "running"
  | "awaiting_human"
  | "blocked"
  | "done"
  | "failed";

/** Stepper-facing state: done / current / awaiting you / blocked / future. */
export type RunVisualState = "done" | "current" | "awaiting" | "blocked" | "future";

export type RunDecisionAction =
  | "proceed"
  | "edit"
  | "regenerate"
  | "back"
  | "abort"
  | "retry_lock";

export type RunStep = {
  stepId: string;
  index: number;
  title: string;
  state: RunStepState;
  artifact: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
  receipt: string | null;
  actionHash: string | null;
  regenerations: number;
  updatedAt: string;
};

export type RunSummary = {
  runId: string;
  workflow: string;
  ticketKey: string;
  status: RunStatus;
  queuePosition: number | null;
  currentStepId: string | null;
  stepCount: number;
  stepsDone: number;
  startedAt: string;
  finishedAt: string | null;
};

export type RunDetail = RunSummary & {
  caseId: string;
  attempt: number;
  heartbeatAt: string;
  lockTarget: string | null;
  lockedBy: string | null;
  outcome: string | null;
  cancelReason: string | null;
  sideEffects: Record<string, Record<string, unknown>>;
  steps: RunStep[];
};

export type RunEvent = {
  runId: string;
  sequence: number;
  type: string;
  [key: string]: unknown;
};

export type RunDecision = {
  action: RunDecisionAction;
  edits?: Record<string, unknown>;
  guidance?: string;
  comment?: string;
};

export type RunDecisionResult = {
  run: RunDetail;
  receipt: string | null;
  replayed: boolean;
};

/** Workflows the console can start today (later PRs extend this list). */
export const RUNNABLE_WORKFLOWS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
}> = [
  {
    id: "review",
    label: "PR Review",
    description: "Review an open pull request, inspect the diff, and post the verdict comment.",
  },
  {
    id: "issues",
    label: "Issue Resolution",
    description: "Analyse a bug, approve the patch, and open the Draft PR.",
  },
  {
    id: "features",
    label: "Feature Implementation",
    description: "Plan the scope, review the planned changes, and open the Draft PR.",
  },
  {
    id: "dependencies",
    label: "Dependency Update",
    description: "Scan the manifest, review grouped bumps, validate, and merge the update PRs.",
  },
  {
    id: "accessibility",
    label: "Accessibility Audit",
    description: "Crawl the routes, fix the violations, re-scan, and open the fix PR.",
  },
  {
    id: "vendors",
    label: "Vendor Onboarding",
    description: "Collect documents, verify the checks, score risk, approve, and create the record.",
  },
  {
    id: "leave",
    label: "Leave Request",
    description: "Intake the request, run the working-day policy check, approve, and book the leave entry.",
  },
  {
    id: "onboarding",
    label: "New-Hire Onboarding",
    description: "Collect the paperwork, verify the checks, score the access risk, approve the signers, and provision the employee.",
  },
  {
    id: "offboarding",
    label: "Employee Offboarding",
    description: "Audit the per-system access, approve the high-blast revocations, revoke each system, and attest the case close.",
  },
  {
    id: "screening",
    label: "Candidate Screening",
    description: "Frame the requisition rubric, screen candidates with citations and guardrail flags, shortlist, and schedule the interviews.",
  },
  {
    id: "hr-help",
    label: "HR Help",
    description: "Intake the employee question, retrieve the policy passages, draft a cited answer, approve it, and record the answer.",
  },
];

/** Keyword signals that pull in their workflow even when the Jira type is generic. */
const KEYWORD_WORKFLOW_RULES: ReadonlyArray<{ id: string; tokens: readonly string[] }> = [
  { id: "onboarding", tokens: ["new hire", "new-hire", "onboarding", "new starter", "new employee"] },
  { id: "offboarding", tokens: ["offboard", "off-board", "termination", "resignation", "departure", "last day"] },
  { id: "screening", tokens: ["screen", "candidate", "recruit", "interview", "requisition"] },
  { id: "hr-help", tokens: ["hr help", "hr-help", "handbook", "policy question", "policy lookup"] },
  { id: "vendors", tokens: ["vendor", "onboard"] },
  { id: "accessibility", tokens: ["accessib", "a11y"] },
  { id: "dependencies", tokens: ["dependen", "upgrade", "bump"] },
  { id: "leave", tokens: ["leave", "time-off", "time off", "pto", "vacation"] },
];

const CODE_TICKET_TYPES = new Set(["bug", "story", "task", "epic", "feature", "improvement", "chore"]);

/**
 * Workflows supported for a ticket, most relevant first: keyword-matched
 * workflows lead, the Jira type adds its primary workflow (bugs resolve,
 * stories and tasks implement, every code-ish type can be reviewed), and
 * unknown tickets fall back to the full catalog.
 */
export function workflowsForTicket(ticket: {
  issueType: string;
  summary: string;
  labels: string[];
}): string[] {
  const type = ticket.issueType.trim().toLowerCase();
  const text = `${ticket.summary} ${ticket.labels.join(" ")}`.toLowerCase();
  const supported: string[] = [];
  const add = (id: string): void => {
    if (!supported.includes(id)) supported.push(id);
  };

  for (const rule of KEYWORD_WORKFLOW_RULES) {
    if (rule.tokens.some((token) => text.includes(token))) add(rule.id);
  }
  if (type === "bug") add("issues");
  if (CODE_TICKET_TYPES.has(type) && type !== "bug") add("features");
  if (CODE_TICKET_TYPES.has(type)) add("review");

  return supported.length > 0 ? supported : RUNNABLE_WORKFLOWS.map((item) => item.id);
}

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function isValidRepository(value: string): boolean {
  return REPOSITORY_PATTERN.test(value.trim());
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

export function isRunTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function runVisualState(step: RunStep): RunVisualState {
  switch (step.state) {
    case "done":
      return "done";
    case "awaiting_human":
      return "awaiting";
    case "blocked":
    case "failed":
      return "blocked";
    case "running":
      return "current";
    default:
      return "future";
  }
}

/** Newest run first (ISO timestamps compare lexicographically). */
export function sortRunsNewestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
}

export function latestRunId(runs: RunSummary[]): string | null {
  const sorted = sortRunsNewestFirst(runs);
  return sorted[0]?.runId ?? null;
}

export function stepArtifact(run: RunDetail, stepId: string): Record<string, unknown> | null {
  const step = run.steps.find((item) => item.stepId === stepId);
  return step?.artifact ?? null;
}

export function currentStep(run: RunDetail): RunStep | null {
  return run.steps.find((step) => step.stepId === run.currentStepId) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The posted-review receipt recorded by the side-effecting complete step. */
export function completeReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = asRecord(run.sideEffects["complete"]);
  return effect === null ? null : asRecord(effect["receipt"]);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function withStep(run: RunDetail, stepId: string, update: (step: RunStep) => RunStep): RunStep[] {
  return run.steps.map((step) => (step.stepId === stepId ? update(step) : step));
}

/**
 * Apply one per-run SSE event onto the last known detail. Pure (new objects
 * only) so the panel can render instantly while a full refresh reconciles.
 */
export function applyRunEvent(run: RunDetail, event: RunEvent): RunDetail {
  const next: RunDetail = { ...run };
  switch (event.type) {
    case "run.created": {
      // The follow-up `run.queued`/`run.suspended` events carry the detail.
      break;
    }
    case "run.queued": {
      const position = asNumber(event.queuePosition);
      next.status = "queued";
      next.queuePosition = position;
      break;
    }
    case "run.status": {
      const status = event.status;
      if (isRunStatus(status)) next.status = status;
      const reason = asString(event.reason);
      if (reason !== null) next.cancelReason = reason;
      const error = asString(event.error);
      if (error !== null) next.outcome = error;
      if (isRunTerminal(next.status)) next.queuePosition = null;
      break;
    }
    case "run.locked": {
      const target = asString(event.target);
      const lockedBy = asString(event.lockedBy);
      next.status = "blocked";
      next.lockTarget = target;
      next.lockedBy = lockedBy;
      if (next.currentStepId !== null) {
        next.steps = withStep(next, next.currentStepId, (step) => ({ ...step, state: "blocked" }));
      }
      break;
    }
    case "run.unlocked": {
      const target = asString(event.target);
      next.status = "awaiting_human";
      next.lockTarget = target ?? next.lockTarget;
      next.lockedBy = run.runId;
      next.steps = next.steps.map((step) =>
        step.state === "blocked" ? { ...step, state: "awaiting_human" } : step,
      );
      break;
    }
    case "run.suspended": {
      const stepId = asString(event.stepId);
      if (stepId === null) break;
      const blocked = event.stepState === "blocked";
      const artifact = asRecord(event.artifact);
      const suspendedIndex = run.steps.find((item) => item.stepId === stepId)?.index ?? -1;
      next.status = blocked ? "blocked" : "awaiting_human";
      next.queuePosition = null;
      next.currentStepId = stepId;
      const target = asString(event.target);
      if (target !== null) {
        next.lockTarget = target;
        next.lockedBy = blocked ? asString(event.lockedBy) : run.runId;
      } else {
        next.lockTarget = null;
        next.lockedBy = null;
      }
      next.steps = run.steps.map((step) => {
        if (step.stepId === stepId) {
          return {
            ...step,
            state: blocked ? "blocked" : "awaiting_human",
            artifact: artifact ?? step.artifact,
          };
        }
        if (step.index < suspendedIndex && step.state !== "done") {
          return { ...step, state: "done" };
        }
        return step;
      });
      break;
    }
    case "run.decision": {
      const stepId = asString(event.stepId);
      const action = asString(event.action);
      if (stepId === null || action === null) break;
      next.steps = withStep(next, stepId, (step) => {
        if (action === "proceed" || action === "edit") return { ...step, state: "done" };
        if (action === "regenerate") return { ...step, regenerations: step.regenerations + 1 };
        return step;
      });
      break;
    }
    default:
      break;
  }
  return next;
}

/**
 * Incremental SSE parser: returns the complete `data:` frames found in the
 * buffer plus the unterminated remainder to carry into the next read. Loose
 * by design — malformed frames are dropped, never thrown.
 */
export function parseSseChunk(buffer: string): { events: RunEvent[]; rest: string } {
  const events: RunEvent[] = [];
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = parseSseFrame(rest.slice(0, boundary));
    if (frame !== null) events.push(frame);
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
  }
  return { events, rest };
}

function parseSseFrame(frame: string): RunEvent | null {
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  try {
    const value = JSON.parse(data.join("\n")) as unknown;
    const record = asRecord(value);
    if (record !== null && typeof record.type === "string") return record as RunEvent;
  } catch {
    // A malformed frame is skipped; the next frame still parses.
  }
  return null;
}

export async function startRun(input: {
  workflow: string;
  ticketKey: string;
  caseId: string;
  input: Record<string, unknown>;
}): Promise<RunDetail> {
  return api<RunDetail>("/runs", { method: "POST", body: JSON.stringify(input) });
}

export type CaseOpenResult = {
  caseId: string;
  ticketKey: string;
  status: string;
  created: boolean;
};

/**
 * Ensure the ticket has a case record (idempotent server-side) so a run can
 * start. The console calls this lazily from the start card when the ticket
 * status endpoint has not found one yet.
 */
export async function openCase(ticketKey: string): Promise<CaseOpenResult> {
  return api<CaseOpenResult>("/cases", {
    method: "POST",
    body: JSON.stringify({ ticketKey }),
  });
}

/** One open pull request, shaped for the start card's picker. */
export type PullRequestOption = {
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  author: string;
  draft: boolean;
  url: string;
};

/**
 * Repositories a run may target — every repository the selected GitHub
 * account can see (plus the server allowlist) — the start card offers these
 * as a picker instead of free text.
 */
export async function listRepositories(accountId?: string): Promise<string[]> {
  const query =
    accountId === undefined || accountId === ""
      ? ""
      : `?accountId=${encodeURIComponent(accountId)}`;
  const payload = await api<{ repositories: string[] }>(`/github/repositories${query}`);
  return payload.repositories;
}

/** A GitHub identity registered in Settings; the token itself never returns. */
export type GithubAccount = {
  id: string;
  label: string;
  username: string;
  isDefault: boolean;
  tokenHint: string;
};

/** Accounts set up in Settings, default first. */
export async function listGithubAccounts(): Promise<GithubAccount[]> {
  const payload = await api<{ accounts: GithubAccount[] }>("/github/accounts");
  return payload.accounts;
}

export async function createGithubAccount(input: {
  label: string;
  username?: string;
  token: string;
}): Promise<GithubAccount> {
  return api<GithubAccount>("/github/accounts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** DELETE answers 204 without a body, so the JSON helper cannot be used. */
async function apiVoid(path: string, init: RequestInit = {}): Promise<void> {
  if (!apiUrl) throw new Error("NEXT_PUBLIC_API_URL is not configured");
  const auth = await sessionHeaders();
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...auth,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new ApiError(response.status);
}

export async function deleteGithubAccount(accountId: string): Promise<void> {
  await apiVoid(`/github/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
  });
}

export async function setDefaultGithubAccount(accountId: string): Promise<GithubAccount> {
  return api<GithubAccount>(
    `/github/accounts/${encodeURIComponent(accountId)}/default`,
    { method: "POST" },
  );
}

export async function listPullRequests(
  repository: string,
  accountId?: string,
): Promise<PullRequestOption[]> {
  const [owner, name] = repository.split("/");
  const query =
    accountId === undefined || accountId === ""
      ? ""
      : `?accountId=${encodeURIComponent(accountId)}`;
  const payload = await api<{ pullRequests: PullRequestOption[] }>(
    `/github/repositories/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/pull-requests${query}`,
  );
  return payload.pullRequests;
}

export async function listRuns(ticketKey: string): Promise<RunSummary[]> {
  const payload = await api<{ runs: RunSummary[] }>(
    `/runs?ticket=${encodeURIComponent(ticketKey)}`,
  );
  return payload.runs;
}

export async function getRun(runId: string): Promise<RunDetail> {
  return api<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
}

export async function decideRunStep(
  runId: string,
  stepId: string,
  decision: RunDecision,
): Promise<RunDecisionResult> {
  return api<RunDecisionResult>(
    `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/decision`,
    { method: "POST", body: JSON.stringify(decision) },
  );
}

export async function cancelRun(runId: string, reason?: string): Promise<RunDetail> {
  return api<RunDetail>(`/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: JSON.stringify(reason === undefined ? {} : { reason }),
  });
}

/**
 * Subscribe to a run's SSE stream with the browser session token. Returns a
 * close function; the stream is finite for finished runs and closes itself on
 * a terminal `run.status`.
 */
export async function subscribeToRunEvents(
  runId: string,
  handlers: {
    onEvent: (event: RunEvent) => void;
    onError?: (error: unknown) => void;
    onDone?: () => void;
  },
): Promise<() => void> {
  const controller = new AbortController();
  void (async () => {
    try {
      if (!apiUrl) throw new Error("NEXT_PUBLIC_API_URL is not configured");
      const headers = await sessionHeaders();
      const response = await fetch(`${apiUrl}/runs/${encodeURIComponent(runId)}/events`, {
        headers: { ...headers, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) throw new ApiError(response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) handlers.onEvent(event);
      }
      handlers.onDone?.();
    } catch (error) {
      if (controller.signal.aborted) return;
      handlers.onError?.(error);
    }
  })();
  return () => controller.abort();
}
