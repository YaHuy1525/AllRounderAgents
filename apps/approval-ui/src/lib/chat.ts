import { caseHeaderModel, laneForWorkflow, type CaseHeaderRun, type LaneId } from "./cases";
import { workflowLabel, workflowsForTicket, type RunDetail, type RunSummary } from "./runs";
import { INBOX_STATUS_COPY, sortInboxTasks, waitLabel, type InboxTask } from "./taskInbox";

export type ContextChip = { key: string; summary: string };

export const CHAT_AGENTS = [
  { id: "triage", label: "Triage assistant" },
  { id: "support", label: "Support assistant" },
  { id: "coding", label: "Coding assistant" },
] as const;

const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,19}-\d+$/;
const CHIP_LIMIT = 8;
const TICKET_PAYLOAD_LIMIT = 40;

export function normalizeChip(value: { key: string; summary: string }): ContextChip | null {
  const key = value.key.trim().toUpperCase();
  if (!TICKET_KEY_PATTERN.test(key)) return null;
  return { key, summary: value.summary.trim().slice(0, 240) };
}

export function addContextChip(
  chips: ContextChip[],
  chip: { key: string; summary: string },
  limit = CHIP_LIMIT,
): ContextChip[] {
  const normalized = normalizeChip(chip);
  if (!normalized) return chips;
  const without = chips.filter((item) => item.key !== normalized.key);
  return [normalized, ...without].slice(0, Math.max(1, limit));
}

export function removeContextChip(chips: ContextChip[], key: string): ContextChip[] {
  return chips.filter((item) => item.key !== key);
}

/**
 * Build the /chat payload: context chips ride in front of the board snapshot
 * (deduplicated by key, capped at the server's 40-ticket limit), and the
 * first chip becomes the selected ticket the assistant focuses on.
 */
export function buildChatRequest(input: {
  message: string;
  agent: string;
  chips: ContextChip[];
  tickets: Array<Record<string, unknown>>;
  selectedKey?: string;
}): {
  message: string;
  agent: string;
  selectedKey: string | undefined;
  tickets: Array<Record<string, unknown>>;
} {
  const tickets: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const chip of input.chips) {
    if (seen.has(chip.key)) continue;
    seen.add(chip.key);
    tickets.push({ key: chip.key, summary: chip.summary });
  }
  for (const ticket of input.tickets) {
    if (tickets.length >= TICKET_PAYLOAD_LIMIT) break;
    const key = typeof ticket.key === "string" ? ticket.key : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tickets.push(ticket);
  }
  return {
    message: input.message.trim(),
    agent: input.agent,
    selectedKey: input.chips[0]?.key ?? input.selectedKey,
    tickets: tickets.slice(0, TICKET_PAYLOAD_LIMIT),
  };
}

// ----------------------------------------------------- run:step context (U8)

/** Short run id used in chat copy and link labels. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/** "run 3f8a2c1d at verify" — the run:step context chips carry. */
export function runContextSuffix(run: { runId: string; currentStepId: string | null }): string {
  const step = run.currentStepId === null || run.currentStepId === "" ? null : run.currentStepId;
  return step === null ? `run ${shortRunId(run.runId)}` : `run ${shortRunId(run.runId)} at ${step}`;
}

/**
 * Keep the selected ticket's chip carrying its run:step context. An existing
 * chip updates in place (its position is kept); a missing chip lands on top
 * like a drag. ``summary`` must be the bare ticket summary — the suffix is
 * appended here so repeated calls stay idempotent. Returns the same array
 * when nothing changes, so callers can setState unconditionally.
 */
export function ensureRunContextChip(
  chips: ContextChip[],
  input: {
    key: string;
    summary: string;
    run: { runId: string; currentStepId: string | null } | null;
  },
): ContextChip[] {
  if (input.run === null) return chips;
  const normalized = normalizeChip({ key: input.key, summary: input.summary });
  if (normalized === null) return chips;
  const summary = `${normalized.summary} · ${runContextSuffix(input.run)}`.slice(0, 240);
  const existing = chips.find((chip) => chip.key === normalized.key);
  if (existing !== undefined) {
    if (existing.summary === summary) return chips;
    return chips.map((chip) => (chip.key === normalized.key ? { ...chip, summary } : chip));
  }
  return addContextChip(chips, { key: normalized.key, summary });
}

// ---------------------------------------------------- lane quick actions (U8)

export type ChatActionKind = "summarize-run" | "list-blockers" | "create-task" | "draft";

export type ChatAction = {
  id: string;
  label: string;
  /** The user-facing message the chip posts into the log. */
  prompt: string;
  kind: ChatActionKind;
  /** Hidden until a run context is loaded for the selected ticket. */
  requiresRun?: boolean;
};

/** One draft action per lane; lanes without a voice keep the neutral set. */
const LANE_DRAFT_ACTIONS: Record<LaneId, { id: string; label: string } | null> = {
  generic: null,
  support: { id: "draft-customer-reply", label: "Draft customer reply" },
  coding: { id: "draft-status-update", label: "Draft status update" },
  finance: { id: "draft-chase", label: "Draft chase" },
  review: { id: "draft-review-note", label: "Draft review note" },
  issues: { id: "draft-status-update", label: "Draft status update" },
  features: { id: "draft-status-update", label: "Draft status update" },
  dependencies: { id: "draft-upgrade-note", label: "Draft upgrade note" },
  accessibility: { id: "draft-fix-summary", label: "Draft fix summary" },
  vendors: { id: "draft-chase", label: "Draft chase" },
  leave: { id: "draft-approval-note", label: "Draft approval note" },
  onboarding: { id: "draft-welcome-note", label: "Draft welcome note" },
  offboarding: { id: "draft-exit-checklist", label: "Draft exit checklist" },
  screening: { id: "draft-shortlist-note", label: "Draft shortlist note" },
  "hr-help": { id: "draft-hr-reply", label: "Draft HR reply" },
};

/**
 * Lane-aware quick actions: the neutral trio (summarize / blockers / create
 * task) is gated on the context the selected ticket actually has, and each
 * lane adds one draft action. Pure so the rail's menu stays testable.
 */
export function quickActionsFor(
  lane: LaneId,
  context: { hasTicket: boolean; hasRun: boolean },
): ChatAction[] {
  if (!context.hasTicket) return [];
  const actions: ChatAction[] = [];
  if (context.hasRun) {
    actions.push({
      id: "summarize-run",
      label: "Summarize this run",
      prompt: "Summarize this run: risks, the next step, and receipts.",
      kind: "summarize-run",
      requiresRun: true,
    });
  }
  actions.push({
    id: "list-blockers",
    label: "List blockers",
    prompt: "List the runs blocked or waiting on a human right now.",
    kind: "list-blockers",
  });
  const draft = LANE_DRAFT_ACTIONS[lane];
  if (draft !== null) {
    actions.push({
      id: draft.id,
      label: draft.label,
      prompt: `${draft.label} for the selected ticket.`,
      kind: "draft",
    });
  }
  actions.push({
    id: "create-task",
    label: "Create task",
    prompt: "Create a task from this ticket.",
    kind: "create-task",
  });
  return actions;
}

/** Recognize "create task[: …]" intent in free text (U8), case-insensitive. */
export function parseCreateTaskIntent(message: string): { text: string } | null {
  const match = /^\s*create\s+task\b\s*[:\u2013-]?\s*(.*)$/is.exec(message);
  if (match === null) return null;
  return { text: (match[1] ?? "").trim() };
}

// ---------------------------------------------------- answers with links (U8)

export type ChatLinkKind = "run" | "step" | "receipt" | "ticket" | "inbox";

/** A deep link attached to an answer; run/step/receipt open the run panel. */
export type ChatLink = {
  kind: ChatLinkKind;
  label: string;
  runId?: string;
  workflow?: string;
  ticketKey?: string;
  stepId?: string;
};

/** The task-bearing ticket fields the assistant reads (CompactTicket shape). */
export type ChatTicket = {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string;
  assignee: string | null;
  labels: string[];
};

/** One task the rail drafted; confirming starts the run that carries it. */
export type ChatTaskDraft = {
  ticketKey: string;
  workflow: string;
  workflowLabel: string;
  input: Record<string, unknown>;
  title: string;
  detail: string;
};

export type ChatReply = {
  body: string;
  source: string;
  links: ChatLink[];
  task?: ChatTaskDraft;
};

const RISK_LINK_LIMIT = 5;
const RECEIPT_LINK_LIMIT = 4;
const BLOCKER_LIMIT = 8;

/**
 * List rows carry no steps; widen a summary to the header's run shape the
 * same way the ticket tab does — absent detail stays absent, never guessed.
 */
function widenedSummary(summary: RunSummary): CaseHeaderRun {
  return {
    ...summary,
    attempt: 1,
    lockTarget: null,
    lockedBy: null,
    outcome: null,
    cancelReason: null,
    steps: [],
  };
}

/** ``run:<runId>:<stepId>:receipt`` → stepId; anything else → null. */
function receiptStepId(source: string): string | null {
  const parts = source.split(":");
  const stepId = parts[2];
  if (
    parts.length === 4 &&
    parts[0] === "run" &&
    parts[3] === "receipt" &&
    stepId !== undefined &&
    stepId !== ""
  ) {
    return stepId;
  }
  return null;
}

/**
 * "Summarize this run" answered deterministically from the U2 header model:
 * the risks and the next entry always trace to the step whose panel proves
 * them, and every signed receipt becomes a link into the run timeline.
 */
export function summarizeRunReply(input: {
  ticket: ChatTicket;
  run: RunSummary;
  detail: RunDetail | null;
}): ChatReply {
  const model = caseHeaderModel({
    ticket: {
      key: input.ticket.key,
      summary: input.ticket.summary,
      status: input.ticket.status,
      issueType: input.ticket.issueType,
      priority: input.ticket.priority,
      assignee: input.ticket.assignee,
      labels: input.ticket.labels,
      project: "",
    },
    record: null,
    lane: laneForWorkflow(input.run.workflow) ?? "generic",
    steps: [],
    states: [],
    runs: [widenedSummary(input.run)],
    run: input.detail,
    approvals: [],
  });

  const short = shortRunId(input.run.runId);
  const lines: string[] = [
    `**Run ${short} · ${input.run.workflow} · ${model.status.label}**`,
    "",
    model.summary,
  ];
  if (model.risks.length === 0) {
    lines.push("", "No risks flagged on this run.");
  } else {
    lines.push("", "**Risks**", "");
    for (const risk of model.risks) lines.push(`- **${risk.label}** — ${risk.detail}`);
  }
  lines.push("", `**Next:** ${model.next.label} — ${model.next.detail}`);
  lines.push(
    "",
    `**Receipts:** ${model.receipts.signed} signed · ${model.receipts.pending} pending`,
  );

  const context = { runId: input.run.runId, workflow: input.run.workflow, ticketKey: input.ticket.key };
  const links: ChatLink[] = [{ kind: "run", label: `Open run ${short}`, ...context }];
  for (const risk of model.risks.slice(0, RISK_LINK_LIMIT)) {
    if (risk.stepId === null) continue;
    links.push({ kind: "step", label: risk.label, ...context, stepId: risk.stepId });
  }
  if (model.next.stepId !== null) {
    links.push({ kind: "step", label: `${model.next.label} (next)`, ...context, stepId: model.next.stepId });
  }
  for (const item of model.receipts.items.slice(0, RECEIPT_LINK_LIMIT)) {
    if (item.state !== "signed") continue;
    const stepId = receiptStepId(item.source);
    links.push({
      kind: "receipt",
      label: `Receipt · ${item.label}`,
      ...context,
      ...(stepId === null ? {} : { stepId }),
    });
  }
  return { body: lines.join("\n"), source: "local · run summary", links };
}

function receiptCountLabel(count: number): string {
  return count === 1 ? "1 receipt" : `${count} receipts`;
}

/** "List blockers": the U4 inbox cards, sorted awaiting-first/oldest-wait. */
export function blockersReply(tasks: readonly InboxTask[]): ChatReply {
  const sorted = sortInboxTasks(tasks);
  const inboxLink: ChatLink = { kind: "inbox", label: "Open the Task Inbox" };
  if (sorted.length === 0) {
    return {
      body: "No runs are waiting on a human right now — nothing is blocked or awaiting a decision.",
      source: "local · inbox",
      links: [inboxLink],
    };
  }
  const now = Date.now();
  const lines: string[] = [`**${sorted.length} run(s) need a human**`, ""];
  const links: ChatLink[] = [inboxLink];
  for (const task of sorted.slice(0, BLOCKER_LIMIT)) {
    const where = task.stepTitle ?? task.stepId ?? "the next step";
    const held =
      task.status === "blocked" && task.lockTarget !== null
        ? ` — held on ${task.lockTarget}${task.lockedBy === null ? "" : ` by run ${shortRunId(task.lockedBy)}`}`
        : "";
    lines.push(
      `- **${task.ticketKey} · ${INBOX_STATUS_COPY[task.status]}** at ${where} — ` +
        `${waitLabel(task, now)} · ${receiptCountLabel(task.receipts)}${held}`,
    );
    links.push({
      kind: "step",
      label: `${task.ticketKey} · ${where}`,
      runId: task.runId,
      workflow: task.workflow,
      ticketKey: task.ticketKey,
      ...(task.stepId === null ? {} : { stepId: task.stepId }),
    });
  }
  return { body: lines.join("\n"), source: "local · inbox", links };
}

// ------------------------------------------------------------------ drafts

function firstText(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 160);
  }
  return null;
}

const DONE_STATE_PATTERN = /received|complete|done|signed|waived|pass/i;

/**
 * First ≤4 actionable highlight lines from an artifact's list-shaped fields
 * (documents, checks, flags …). Entries already resolved are skipped so a
 * chase draft only asks for what is still outstanding.
 */
export function artifactHighlights(artifact: Record<string, unknown> | null): string[] {
  if (artifact === null) return [];
  const out: string[] = [];
  for (const key of ["documents", "outstanding", "items", "checks", "flags", "risks"]) {
    const value = artifact[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim() !== "") {
        out.push(item.trim().slice(0, 160));
      } else if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const label = firstText(record, ["label", "title", "name", "document", "kind", "check"]);
        if (label === null) continue;
        const state = firstText(record, ["status", "state"]);
        if (state !== null && DONE_STATE_PATTERN.test(state)) continue;
        out.push(state === null ? label : `${label} (${state})`);
      }
      if (out.length >= 4) return out;
    }
  }
  return out;
}

const DRAFT_COPY: Record<
  string,
  { subject: string; intro: string; request: string }
> = {
  "draft-chase": {
    subject: "Outstanding items",
    intro: "Following up on the outstanding items",
    request: "Could you send these through so we can keep the ticket moving?",
  },
  "draft-customer-reply": {
    subject: "Update on your request",
    intro: "A quick update on your request",
    request: "Here is where things stand — we will confirm the moment the next checkpoint clears.",
  },
  "draft-review-note": {
    subject: "Review status",
    intro: "Review update",
    request: "Comments land on the pull request once the checkpoint below is confirmed.",
  },
  "draft-upgrade-note": {
    subject: "Upgrade plan",
    intro: "Planned upgrade",
    request: "The checklist below is what remains before we can proceed.",
  },
  "draft-fix-summary": {
    subject: "Accessibility fixes",
    intro: "Fix summary",
    request: "Each finding below links back to its evidence in the run.",
  },
  "draft-approval-note": {
    subject: "Approval request",
    intro: "Requesting your approval",
    request: "Everything below is checked; a decision keeps the case moving.",
  },
  "draft-welcome-note": {
    subject: "Welcome aboard",
    intro: "Welcome",
    request: "Your first-day details are below — provisioning runs behind the signed approvals.",
  },
  "draft-exit-checklist": {
    subject: "Offboarding checklist",
    intro: "Offboarding checklist",
    request: "Access below is revoked after the final approvals; flag anything that looks off.",
  },
  "draft-shortlist-note": {
    subject: "Candidate shortlist",
    intro: "Shortlist update",
    request: "The candidates below are ready for the next stage; screening notes ride with each entry.",
  },
  "draft-hr-reply": {
    subject: "Your HR question",
    intro: "Thanks for reaching out",
    request: "Here is the answer from the current policy; the citation is recorded with the run.",
  },
  "draft-status-update": {
    subject: "Status update",
    intro: "Where this stands",
    request: "The next checkpoint needs a decision before anything else moves.",
  },
};

const DRAFT_FALLBACK = {
  subject: "Follow-up",
  intro: "Following up",
  request: "Here is where things stand; let me know what you need next.",
};

function stepTitle(run: RunSummary, detail: RunDetail | null): string | null {
  const stepId = run.currentStepId;
  if (stepId === null || stepId === "") return null;
  return detail?.steps.find((step) => step.stepId === stepId)?.title ?? stepId;
}

/**
 * A lane draft composed from the waiting step's artifact — deterministic,
 * clearly marked as a draft, and carrying the step plus the latest signed
 * receipt as deep links. The assistant never sends; a human reviews first.
 */
export function draftReply(input: {
  actionId: string;
  ticket: ChatTicket;
  run: RunSummary | null;
  detail: RunDetail | null;
}): ChatReply {
  const copy = DRAFT_COPY[input.actionId] ?? DRAFT_FALLBACK;
  const links: ChatLink[] = [{ kind: "ticket", label: `Open ${input.ticket.key}`, ticketKey: input.ticket.key }];
  const run = input.run;
  const stepId = run === null ? null : run.currentStepId;
  const step = run === null || stepId === null ? null : input.detail?.steps.find((item) => item.stepId === stepId) ?? null;
  const highlights = artifactHighlights(step?.artifact ?? null);

  const lines: string[] = ["*Draft — review before sending.*", ""];
  lines.push(`Subject: ${copy.subject} — ${input.ticket.key}`);
  lines.push("", "Hi,", "");
  lines.push(`${copy.intro} for ${input.ticket.key} (“${input.ticket.summary}”).`);
  if (highlights.length > 0) {
    lines.push("");
    for (const item of highlights) lines.push(`- ${item}`);
  }
  lines.push("", copy.request, "", "Thanks,", "[Your name]");

  if (run !== null) {
    const context = { runId: run.runId, workflow: run.workflow, ticketKey: input.ticket.key };
    const title = stepTitle(run, input.detail);
    links.push({
      kind: "run",
      label: `Open run ${shortRunId(run.runId)}`,
      ...context,
    });
    if (title !== null) {
      links.push({ kind: "step", label: `${title} (waiting step)`, ...context, ...(stepId === null ? {} : { stepId }) });
    }
    const signed = input.detail?.steps.filter((item) => item.receipt !== null).at(-1) ?? null;
    if (signed !== null) {
      links.push({
        kind: "receipt",
        label: `Receipt · ${signed.title}`,
        ...context,
        stepId: signed.stepId,
      });
    }
  }
  return { body: lines.join("\n"), source: "draft · review before sending", links };
}

// --------------------------------------------------------------- task create

const TASK_TITLE_LIMIT = 120;

function taskTitle(text: string, ticket: ChatTicket): string {
  const base = text.trim() === "" ? ticket.summary : text.trim();
  return (base.split("\n")[0] ?? "").trim().slice(0, TASK_TITLE_LIMIT);
}

/**
 * Draft the task for the selected ticket. Only workflows whose start input is
 * fully derivable start a run — the assistant never invents vendor
 * identities, leave dates, or pull request numbers. The started run parks at
 * its first human checkpoint, which is exactly where the U4 inbox picks it
 * up; the reply carries the run and inbox links, and every decision from
 * there lands in the run's receipt trail.
 */
export function createTaskDraft(input: { ticket: ChatTicket; taskText: string }): ChatTaskDraft | null {
  const text = input.taskText.trim();
  const workflows = workflowsForTicket({
    issueType: input.ticket.issueType,
    summary: input.ticket.summary,
    labels: input.ticket.labels,
  });
  const base = {
    ticketKey: input.ticket.key,
    title: taskTitle(text, input.ticket),
    detail: text === "" ? input.ticket.summary : text,
  };
  for (const workflow of workflows) {
    if (workflow === "issues" || workflow === "features") {
      return {
        ...base,
        workflow,
        workflowLabel: workflowLabel(workflow),
        input: {
          ticketKey: input.ticket.key,
          ticketSummary: input.ticket.summary,
          candidates: [
            { key: input.ticket.key, summary: input.ticket.summary, status: input.ticket.status },
          ],
        },
      };
    }
    if (workflow === "dependencies") {
      return { ...base, workflow, workflowLabel: workflowLabel(workflow), input: {} };
    }
    if (workflow === "hr-help" && text.length >= 5) {
      return {
        ...base,
        workflow,
        workflowLabel: workflowLabel(workflow),
        input: { question: text },
      };
    }
  }
  return null;
}

/** The reply for a create-task request: a confirmable draft or the honest refusal. */
export function createTaskReply(input: { ticket: ChatTicket; taskText: string }): ChatReply {
  const draft = createTaskDraft(input);
  const ticketLink: ChatLink = { kind: "ticket", label: `Open ${input.ticket.key}`, ticketKey: input.ticket.key };
  if (draft === null) {
    return {
      body:
        `I can only start runs whose inputs come straight from the ticket — issue resolution, ` +
        `feature delivery, dependency upgrades, and HR questions. ${input.ticket.key} needs start ` +
        `details I must not invent, so open the ticket and use its start card instead.`,
      source: "local · task draft",
      links: [ticketLink],
    };
  }
  return {
    body:
      `Task drafted for ${input.ticket.key} as a **${draft.workflowLabel}** run. Confirm below and it ` +
      `starts immediately, parking at its first checkpoint — that is where the Task Inbox picks it ` +
      `up, and every decision from there signs a receipt.`,
    source: "local · task draft",
    links: [ticketLink, { kind: "inbox", label: "Open the Task Inbox" }],
    task: draft,
  };
}
