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
  /**
   * Which ceiling a ``queued`` run waits on ("run" | "apply" | "model"),
   * sourced server-side from the run's recorded pass; null when the run
   * carries no pass record. Names the actual queue so the console can say
   * more than "waiting for a run slot".
   */
  waitingOn: string | null;
  /** Ceiling slots the recorded pass has already been granted. */
  heldSlots: string[];
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
  {
    id: "security",
    label: "SOC Alert Triage",
    description: "Ingest the alert, triage it with ATT&CK mapping, investigate with cited evidence, decide and approve the disposition, then contain — containment is idempotent.",
  },
];

/** Keyword signals that pull in their workflow even when the Jira type is generic. */
const KEYWORD_WORKFLOW_RULES: ReadonlyArray<{ id: string; tokens: readonly string[] }> = [
  // The SCRUM project has no Bug issue type, so the type fallback below can
  // never reach the issues lane from the board — summary/label keywords must.
  { id: "issues", tokens: ["fix:", "bug"] },
  { id: "onboarding", tokens: ["new hire", "new-hire", "onboarding", "new starter", "new employee"] },
  { id: "offboarding", tokens: ["offboard", "off-board", "termination", "resignation", "departure", "last day"] },
  { id: "screening", tokens: ["screen", "candidate", "recruit", "interview", "requisition"] },
  { id: "hr-help", tokens: ["hr help", "hr-help", "handbook", "policy question", "policy lookup"] },
  {
    id: "security",
    tokens: [
      "security",
      "soc ",
      "alert",
      "ioc",
      "malware",
      "phishing",
      "ransomware",
      "siem",
      "edr",
      "intrusion",
      "mitre",
      "cve",
      "exploit",
    ],
  },
  { id: "vendors", tokens: ["vendor", "onboard"] },
  { id: "accessibility", tokens: ["accessib", "a11y"] },
  { id: "dependencies", tokens: ["dependen", "upgrade", "bump"] },
  { id: "leave", tokens: ["leave", "time-off", "time off", "pto", "vacation"] },
];

const CODE_TICKET_TYPES = new Set(["bug", "story", "task", "epic", "feature", "improvement", "chore"]);

/** Keyword-routed lane ids; a bare "list tickets" query reads across these. */
export const KEYWORD_WORKFLOW_IDS: readonly string[] = KEYWORD_WORKFLOW_RULES.map(
  (rule) => rule.id,
);

/**
 * Coarse domains the chat expands when a listing names one ("HR") into the
 * lane ids the server keyword rules actually route. Only keyword-addressable
 * lanes appear: a domain never claims a lane no ticket text can match.
 */
export const WORKFLOW_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  hr: ["leave", "onboarding", "offboarding", "screening", "hr-help"],
  coding: ["issues", "dependencies", "accessibility"],
  security: ["security"],
  vendors: ["vendors"],
};

/**
 * One row of `GET /jira/tickets`: a board ticket as the search returns it,
 * plus every lane its summary and labels matched, in rule order.
 */
export type LaneTicketRow = {
  key: string;
  project: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string;
  assignee: string | null;
  labels: string[];
  matchedWorkflows: string[];
};

/**
 * Ask the server for the tenant's lane-matched tickets. The same keyword
 * vocabulary this module's board matcher uses decides membership server-side
 * (pinned by test_ticket_search.py), so the answer is not capped at the
 * tickets currently on screen.
 */
export async function searchLaneTickets(input: {
  workflows: readonly string[];
  text?: string;
  maxResults?: number;
}): Promise<LaneTicketRow[]> {
  const params = new URLSearchParams();
  params.set("workflows", input.workflows.join(","));
  if (input.text !== undefined && input.text !== "") params.set("text", input.text);
  if (input.maxResults !== undefined) params.set("max_results", String(input.maxResults));
  const result = await api<{ total: number; tickets: LaneTicketRow[] }>(
    `/jira/tickets?${params.toString()}`,
  );
  return Array.isArray(result.tickets) ? result.tickets : [];
}

/**
 * Workflows whose keyword rule fires on this text, in rule order. Shared by
 * the board's ticket matcher and the assistant's start-run intent, so both
 * read one vocabulary.
 */
export function matchWorkflowsFromText(text: string): string[] {
  const haystack = text.toLowerCase();
  const matched: string[] = [];
  for (const rule of KEYWORD_WORKFLOW_RULES) {
    if (rule.tokens.some((token) => haystack.includes(token)) && !matched.includes(rule.id)) {
      matched.push(rule.id);
    }
  }
  return matched;
}

/**
 * Workflows supported for a ticket, most relevant first. An explicit keyword
 * match wins outright: an HR question filed as a Task must not inherit the
 * code lanes, so keyword-matched tickets get exactly their matched workflows.
 * Only keyword-free tickets fall through to the Jira type rules (bugs
 * resolve, stories and tasks implement, every code-ish type can be reviewed),
 * and unknown tickets fall back to the full catalog.
 */
export function workflowsForTicket(ticket: {
  issueType: string;
  summary: string;
  labels: string[];
}): string[] {
  const type = ticket.issueType.trim().toLowerCase();
  const supported: string[] = [];
  const add = (id: string): void => {
    if (!supported.includes(id)) supported.push(id);
  };

  for (const id of matchWorkflowsFromText(`${ticket.summary} ${ticket.labels.join(" ")}`)) {
    add(id);
  }
  if (supported.length === 0) {
    if (type === "bug") add("issues");
    if (CODE_TICKET_TYPES.has(type) && type !== "bug") add("features");
    if (CODE_TICKET_TYPES.has(type)) add("review");
  }

  return supported.length > 0 ? supported : RUNNABLE_WORKFLOWS.map((item) => item.id);
}

/** Console label for a workflow id (falls back to the raw id). */
export function workflowLabel(id: string): string {
  return RUNNABLE_WORKFLOWS.find((item) => item.id === id)?.label ?? id;
}

/**
 * Synthetic key for describe-started runs. The server accepts any key
 * matching the ticket pattern when opening a case (no Jira lookup), and
 * TASK- keys are local-only: they never appear on the board.
 */
export function syntheticTaskKey(): string {
  const lead = 1 + Math.floor(Math.random() * 9);
  const rest = String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0");
  return `TASK-${lead}${rest}`;
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

/**
 * Whole seconds between start and finish (or `now` while the run is open);
 * null when either timestamp is missing or malformed.
 */
export function runDurationSeconds(
  run: Pick<RunSummary, "startedAt" | "finishedAt">,
  now: number = Date.now(),
): number | null {
  const start = Date.parse(run.startedAt);
  if (Number.isNaN(start)) return null;
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Compact duration copy for list rows: 42s, 3m 05s, 2h 07m. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
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

/** Ceiling kind names: keep the strings, drop anything not a string. */
function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function withStep(run: RunDetail, stepId: string, update: (step: RunStep) => RunStep): RunStep[] {
  return run.steps.map((step) => (step.stepId === stepId ? update(step) : step));
}

/** Transition events whose payloads embed a full run snapshot (``event.run``). */
const SNAPSHOT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.suspended",
  "run.status",
  "run.decision",
  "run.locked",
  "run.unlocked",
]);

const RUN_STEP_STATES: readonly RunStepState[] = [
  "pending",
  "running",
  "awaiting_human",
  "blocked",
  "done",
  "failed",
];

function isRunStepState(value: unknown): value is RunStepState {
  return typeof value === "string" && (RUN_STEP_STATES as readonly string[]).includes(value);
}

function asEffectMap(value: unknown): Record<string, Record<string, unknown>> {
  const record = asRecord(value);
  if (record === null) return {};
  const effects: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(record)) {
    const effect = asRecord(item);
    if (effect !== null) effects[key] = effect;
  }
  return effects;
}

function parseRunStep(value: unknown): RunStep | null {
  const record = asRecord(value);
  if (record === null) return null;
  const stepId = asString(record.stepId);
  const title = asString(record.title);
  const index = asNumber(record.index);
  if (stepId === null || title === null || index === null || !isRunStepState(record.state)) {
    return null;
  }
  return {
    stepId,
    index,
    title,
    state: record.state,
    artifact: asRecord(record.artifact),
    decision: asRecord(record.decision),
    receipt: asString(record.receipt),
    actionHash: asString(record.actionHash),
    regenerations: asNumber(record.regenerations) ?? 0,
    updatedAt: asString(record.updatedAt) ?? "",
  };
}

/**
 * Validate one embedded run snapshot — the API enriches transition events
 * with the same shape ``GET /runs/{runId}`` returns. Anything malformed
 * returns null so the caller falls back to the incremental patch.
 */
export function parseRunSnapshot(value: unknown): RunDetail | null {
  const record = asRecord(value);
  if (record === null) return null;
  const runId = asString(record.runId);
  const workflow = asString(record.workflow);
  const ticketKey = asString(record.ticketKey);
  const caseId = asString(record.caseId);
  const startedAt = asString(record.startedAt);
  const heartbeatAt = asString(record.heartbeatAt);
  const stepCount = asNumber(record.stepCount);
  const stepsDone = asNumber(record.stepsDone);
  const attempt = asNumber(record.attempt);
  if (
    runId === null ||
    workflow === null ||
    ticketKey === null ||
    caseId === null ||
    startedAt === null ||
    heartbeatAt === null ||
    stepCount === null ||
    stepsDone === null ||
    attempt === null ||
    !isRunStatus(record.status) ||
    !Array.isArray(record.steps)
  ) {
    return null;
  }
  const steps: RunStep[] = [];
  for (const item of record.steps) {
    const step = parseRunStep(item);
    if (step === null) return null;
    steps.push(step);
  }
  return {
    runId,
    workflow,
    ticketKey,
    status: record.status,
    queuePosition: asNumber(record.queuePosition),
    waitingOn: asString(record.waitingOn),
    heldSlots: asStringList(record.heldSlots),
    currentStepId: asString(record.currentStepId),
    stepCount,
    stepsDone,
    startedAt,
    finishedAt: asString(record.finishedAt),
    caseId,
    attempt,
    heartbeatAt,
    lockTarget: asString(record.lockTarget),
    lockedBy: asString(record.lockedBy),
    outcome: asString(record.outcome),
    cancelReason: asString(record.cancelReason),
    sideEffects: asEffectMap(record.sideEffects),
    steps,
  };
}

/**
 * One lane-declared custom input on a topology step (U7): the lane owner
 * configures these in ``definitions.py`` and the step surface renders them.
 * ``snapKey`` names the canonical doc-snap extraction key (``abn``,
 * ``expiry``, ``invoiceNumber``, ``total``) that auto-fills the field when
 * a snapped document carries it.
 */
export type RunTopologyField = {
  id: string;
  label: string;
  kind: "text" | "date" | "number";
  required: boolean;
  maxLength: number;
  placeholder: string;
  help: string;
  snapKey: string;
};

/**
 * One step row of the N1 topology payload (`GET /runs/{id}/topology`): the
 * live state from `run_snapshot()` enriched with the static satellites and
 * lineage flags the five lenses render.
 */
export type RunTopologyStep = {
  stepId: string;
  index: number;
  title: string;
  state: RunStepState;
  sideEffecting: boolean;
  integrations: string[];
  fields: RunTopologyField[];
  receipt: string | null;
  actionHash: string | null;
  hasArtifact: boolean;
  hasDecision: boolean;
  regenerations: number;
  updatedAt: string;
};

/** One signed-receipt row of the topology's receipt trail. */
export type RunTopologyReceipt = {
  stepId: string;
  receipt: string | null;
  actionHash: string | null;
  effectRecorded: boolean;
};

export type RunTopologyLock = {
  target: string | null;
  lockedBy: string | null;
};

/**
 * Read model behind the view switcher: one payload so the graph, header,
 * data, and timeline lenses never disagree on step state.
 */
export type RunTopology = {
  runId: string;
  workflow: string;
  status: RunStatus;
  attempt: number;
  currentStepId: string | null;
  stepCount: number;
  stepsDone: number;
  startedAt: string;
  finishedAt: string | null;
  lock: RunTopologyLock | null;
  receipts: { signed: number; items: RunTopologyReceipt[] };
  steps: RunTopologyStep[];
};

function parseRunTopologyField(value: unknown): RunTopologyField | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asString(record.id);
  const label = asString(record.label);
  if (id === null || id === "" || label === null || label === "") return null;
  const maxLength = asNumber(record.maxLength);
  return {
    id,
    label,
    kind: record.kind === "date" || record.kind === "number" ? record.kind : "text",
    required: record.required === true,
    // Clamp to the same 4000-char cap every surface input enforces.
    maxLength: Math.min(Math.max(maxLength ?? 4_000, 1), 4_000),
    placeholder: asString(record.placeholder) ?? "",
    help: asString(record.help) ?? "",
    snapKey: asString(record.snapKey) ?? "",
  };
}

function parseRunTopologyStep(value: unknown): RunTopologyStep | null {
  const record = asRecord(value);
  if (record === null) return null;
  const stepId = asString(record.stepId);
  const index = asNumber(record.index);
  const title = asString(record.title);
  if (stepId === null || index === null || title === null || !isRunStepState(record.state)) {
    return null;
  }
  const rawIntegrations = record.integrations;
  const integrations = Array.isArray(rawIntegrations)
    ? rawIntegrations.filter((item): item is string => typeof item === "string")
    : [];
  // Declared fields are strict when present and default to none when absent
  // (payloads predating U7 keep parsing).
  const rawFields = record.fields;
  const fields: RunTopologyField[] = [];
  if (rawFields !== undefined) {
    if (!Array.isArray(rawFields)) return null;
    for (const item of rawFields) {
      const field = parseRunTopologyField(item);
      if (field === null) return null;
      fields.push(field);
    }
  }
  return {
    stepId,
    index,
    title,
    state: record.state,
    sideEffecting: record.sideEffecting === true,
    integrations,
    fields,
    receipt: asString(record.receipt),
    actionHash: asString(record.actionHash),
    hasArtifact: record.hasArtifact === true,
    hasDecision: record.hasDecision === true,
    regenerations: asNumber(record.regenerations) ?? 0,
    updatedAt: asString(record.updatedAt) ?? "",
  };
}

/**
 * Validate one N1 topology payload with the same discipline as
 * ``parseRunSnapshot``: anything malformed returns null so the caller keeps
 * its catalog-derived frame instead of rendering half a graph.
 */
export function parseRunTopology(value: unknown): RunTopology | null {
  const record = asRecord(value);
  if (record === null) return null;
  const runId = asString(record.runId);
  const workflow = asString(record.workflow);
  const startedAt = asString(record.startedAt);
  const attempt = asNumber(record.attempt);
  const stepCount = asNumber(record.stepCount);
  const stepsDone = asNumber(record.stepsDone);
  if (
    runId === null ||
    workflow === null ||
    startedAt === null ||
    attempt === null ||
    stepCount === null ||
    stepsDone === null ||
    !isRunStatus(record.status) ||
    !Array.isArray(record.steps)
  ) {
    return null;
  }
  const steps: RunTopologyStep[] = [];
  for (const item of record.steps) {
    const step = parseRunTopologyStep(item);
    if (step === null) return null;
    steps.push(step);
  }
  const receiptsRecord = asRecord(record.receipts);
  const rawItems =
    receiptsRecord !== null && Array.isArray(receiptsRecord.items) ? receiptsRecord.items : null;
  if (rawItems === null) return null;
  const items: RunTopologyReceipt[] = [];
  for (const item of rawItems) {
    const entry = asRecord(item);
    const stepId = entry === null ? null : asString(entry.stepId);
    if (entry === null || stepId === null) return null;
    items.push({
      stepId,
      receipt: asString(entry.receipt),
      actionHash: asString(entry.actionHash),
      effectRecorded: entry.effectRecorded === true,
    });
  }
  const lockRecord = asRecord(record.lock);
  return {
    runId,
    workflow,
    status: record.status,
    attempt,
    currentStepId: asString(record.currentStepId),
    stepCount,
    stepsDone,
    startedAt,
    finishedAt: asString(record.finishedAt),
    lock:
      lockRecord === null
        ? null
        : { target: asString(lockRecord.target), lockedBy: asString(lockRecord.lockedBy) },
    receipts: { signed: asNumber(receiptsRecord?.signed) ?? 0, items },
    steps,
  };
}

/**
 * Merge one replayed or live event into the ordered history: entries dedupe
 * by sequence and stay sorted, so a re-subscribed stream can replay from
 * zero without duplicating the tail it already showed.
 */
export function mergeRunEvents(events: readonly RunEvent[], event: RunEvent): RunEvent[] {
  const sequence = asNumber(event.sequence);
  if (sequence === null) return [...events, event];
  const merged = events.filter((item) => item.sequence !== sequence);
  merged.push(event);
  return merged.sort(
    (left, right) =>
      (asNumber(left.sequence) ?? Number.MAX_SAFE_INTEGER) -
      (asNumber(right.sequence) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Apply one per-run SSE event onto the last known detail. Pure (new objects
 * only) so the panel can render instantly while a full refresh reconciles.
 * Transition events prefer their embedded snapshot; the incremental patch
 * stays as the fallback when the snapshot is absent or malformed.
 */
export function applyRunEvent(run: RunDetail, event: RunEvent): RunDetail {
  if (SNAPSHOT_EVENT_TYPES.has(event.type)) {
    const snapshot = parseRunSnapshot(event.run);
    if (snapshot !== null && snapshot.runId === run.runId) return snapshot;
  }
  const next: RunDetail = { ...run };
  switch (event.type) {
    case "run.created": {
      // The follow-up `run.queued`/`run.suspended` events carry the detail.
      break;
    }
    case "run.queued": {
      const position = asNumber(event.queuePosition);
      const waiting = asString(event.waitingOn);
      next.status = "queued";
      next.queuePosition = position;
      // The server names the ceiling this run waits on; a missing key
      // (pre-fix producer) keeps the previous value rather than guessing.
      if (waiting !== null) next.waitingOn = waiting;
      break;
    }
    case "run.status": {
      const status = event.status;
      if (isRunStatus(status)) next.status = status;
      const reason = asString(event.reason);
      if (reason !== null) next.cancelReason = reason;
      const error = asString(event.error);
      if (error !== null) next.outcome = error;
      if (isRunTerminal(next.status)) {
        next.queuePosition = null;
        next.waitingOn = null;
        next.heldSlots = [];
      }
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
      // The suspended pass has released its ceiling grants (and their queue
      // entry), so the run waits on nothing until a decision launches a pass.
      next.waitingOn = null;
      next.heldSlots = [];
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
      // The decision event carries the freshly signed receipt; handing it to
      // the step keeps the graph dots and the lineage chips live under SSE
      // without waiting for a refetch.
      const receipt = asString(event.receipt);
      next.steps = withStep(next, stepId, (step) => {
        if (action === "proceed" || action === "edit") {
          return { ...step, state: "done", receipt: receipt ?? step.receipt };
        }
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

/** One value a record could prove, plus the record it came from. */
export type WorkflowPrefillField = {
  id: string;
  label: string;
  value: string;
  source: string;
};

/** The prefill answer: what the API could fill, and what it still needs. */
export type WorkflowPrefill = {
  workflow: string;
  fields: WorkflowPrefillField[];
  missing: { id: string; label: string }[];
};

/**
 * Ask what records can prove for a drafted start. Read-only: the answer fills
 * the card, and the run still starts only when the human confirms it. A field
 * the caller already has in ``values`` comes back unchanged.
 */
export async function prefillStartFields(input: {
  workflow: string;
  ticketKey: string;
  ticketSummary: string;
  text: string;
  values: Record<string, string>;
}): Promise<WorkflowPrefill> {
  return api<WorkflowPrefill>("/runs/prefill", {
    method: "POST",
    body: JSON.stringify(input),
  });
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

/** The workspace's MSP connection; null until the desk is wired in Settings. */
export type MspConnection = {
  inboundDomain: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

/** One mailbox client ref registered for the MSP lane. */
export type MspClient = {
  clientRef: string;
  displayName: string;
  contactEmail: string;
  deskProject: string;
  createdAt: string;
  updatedAt: string;
};

export type MspConnections = {
  connection: MspConnection | null;
  clients: MspClient[];
};

/** Connection plus clients, as the Settings island reads them. */
export async function getMspConnections(): Promise<MspConnections> {
  return api<MspConnections>("/msp/connections");
}

export async function saveMspConnection(input: {
  inboundDomain: string;
  displayName?: string;
}): Promise<MspConnection> {
  return api<MspConnection>("/msp/connections", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function upsertMspClient(input: {
  clientRef: string;
  displayName?: string;
  contactEmail?: string;
  deskProject?: string;
}): Promise<MspClient> {
  return api<MspClient>("/msp/clients", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteMspClient(clientRef: string): Promise<void> {
  await apiVoid(`/msp/clients/${encodeURIComponent(clientRef)}`, { method: "DELETE" });
}

/** Client refs are mailbox slugs; the server check allows dots and dashes. */
const MSP_CLIENT_REF = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export function normalizeClientRef(value: string): string {
  return value.trim().toLowerCase();
}

/** Returns a caller-safe reason when the ref would fail the server check. */
export function clientRefProblem(value: string): string | null {
  const ref = normalizeClientRef(value);
  if (ref.length === 0) return "Enter the mailbox local part, for example acme.";
  if (!MSP_CLIENT_REF.test(ref)) {
    return "Use lowercase letters, digits, dots and dashes only (max 64 characters).";
  }
  return null;
}

/** The YYYY-MM pack month for a clock; the console defaults to the current one. */
export function packMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function auditPackFilename(clientRef: string, month: string): string {
  return `audit-pack-${clientRef}-${month}.pdf`;
}

/**
 * Downloads the monthly audit pack as a PDF. Binary responses cannot ride
 * through the JSON helper, so the body becomes a blob and the browser saves it
 * under the server's filename.
 */
export async function downloadAuditPack(clientRef: string, month: string): Promise<void> {
  if (!apiUrl) throw new Error("NEXT_PUBLIC_API_URL is not configured");
  const auth = await sessionHeaders();
  const query = new URLSearchParams({ clientRef, month, format: "pdf" });
  const response = await fetch(`${apiUrl}/msp/audit-pack?${query.toString()}`, {
    headers: auth,
  });
  if (!response.ok) throw new ApiError(response.status);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = auditPackFilename(clientRef, month);
  anchor.click();
  URL.revokeObjectURL(url);
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

export type RunListScope = "active" | "history";

/** Filters for the runs explorer (`GET /runs`); absent fields are omitted. */
export type RunListFilters = {
  ticket?: string;
  scope?: RunListScope;
  workflow?: string;
  status?: RunStatus;
  limit?: number;
  cursor?: string;
};

/**
 * Deterministic query string for `GET /runs` (fixed param order so cursors and
 * tests stay predictable). The default scope (`active`) is omitted — the empty
 * filter set serializes to "".
 */
export function runListQuery(filters: RunListFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.ticket !== undefined && filters.ticket !== "") params.set("ticket", filters.ticket);
  if (filters.scope !== undefined && filters.scope !== "active") params.set("scope", filters.scope);
  if (filters.workflow !== undefined && filters.workflow !== "") {
    params.set("workflow", filters.workflow);
  }
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.cursor !== undefined && filters.cursor !== "") params.set("cursor", filters.cursor);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export type RunListPage = {
  runs: RunSummary[];
  nextCursor: string | null;
};

/** One page of runs; `scope: "history"` merges the durable archive with Redis. */
export async function listRunsPage(filters: RunListFilters = {}): Promise<RunListPage> {
  const payload = await api<{ runs: RunSummary[]; nextCursor?: string | null }>(
    `/runs${runListQuery(filters)}`,
  );
  return { runs: payload.runs, nextCursor: payload.nextCursor ?? null };
}

export async function listRuns(ticketKey: string): Promise<RunSummary[]> {
  const page = await listRunsPage({ ticket: ticketKey });
  return page.runs;
}

export async function getRun(runId: string): Promise<RunDetail> {
  return api<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
}

/**
 * N1 topology for one run. Returns null instead of throwing on a malformed
 * payload — the graph lens keeps its catalog frame when the overlay cannot
 * be trusted.
 */
export async function getRunTopology(runId: string): Promise<RunTopology | null> {
  const payload = await api<unknown>(`/runs/${encodeURIComponent(runId)}/topology`);
  return parseRunTopology(payload);
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
