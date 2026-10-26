import type { LaneTicketRow } from "./runs";
import type { WorkflowDefinition, WorkflowStartField } from "./workflows";

/**
 * Everything the start card needs and nothing the old chat ladder needed. This
 * module has no prose generators, no intent parsers, and no board matchers:
 * deciding what a message means is the assistant's job now, on the host. What
 * survives here is the confirm seam — the field catalog, the values a record can
 * prove, and the `POST /runs` input built from them.
 */

export type ContextChip = { key: string; summary: string };

const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,19}-\d+$/;
const CHIP_LIMIT = 8;

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

export type ChatTicketRow = LaneTicketRow;

/**
 * One start field plus its value. ``source`` names the record a prefill came
 * from, and is absent for a value the message carried: a field the rail cannot
 * cite must not look cited.
 */
export type ChatStartField = WorkflowStartField & { value: string; source?: string };

/**
 * A workflow start the rail drafted from a listed ticket. The card renders
 * exactly the fields the catalog publishes, so what it collects is what
 * `POST /runs` validates — no hand-written form per workflow, and no run
 * started with a value the assistant guessed.
 */
export type ChatStartDraft = {
  workflow: string;
  workflowLabel: string;
  ticketKey: string;
  title: string;
  detail: string;
  fields: ChatStartField[];
};

const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const REPOSITORY_PATTERN = /\b[\w.-]+\/[\w.-]+\b/;
const URL_PATTERN = /\bhttps?:\/\/\S+/i;
const ID_TOKEN_PATTERN = /\b[A-Z]{2,6}-\d{2,}(?:-\d+)?\b/g;
const HASHED_NUMBER_PATTERN = /(?:#|\b(?:pr|pull request|number)\s*#?)\s*(\d+)\b/i;
const KEYED_PAIR_PATTERN =
  /([A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*){0,2})\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g;

export function normalizeStartKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

function allMatches(pattern: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[0].trim();
    if (value !== "") out.push(value);
  }
  return out;
}

/**
 * Read start-field values out of a message: explicit `fieldId: value` pairs
 * first (deterministic, and the form the help text teaches), then the shapes
 * each kind can be recognized by. Anything not read here stays empty for the
 * human to fill — the rail never invents an employee id, a tax id, or a date.
 */
export function extractStartValues(
  text: string,
  fields: WorkflowStartField[],
): Record<string, string> {
  const values: Record<string, string> = {};
  const byKey = new Map<string, WorkflowStartField>();
  for (const field of fields) {
    byKey.set(normalizeStartKey(field.id), field);
    byKey.set(normalizeStartKey(field.label), field);
  }

  // Keyed pairs are consumed, so their values are not re-read as free text.
  let rest = text;
  for (const match of text.matchAll(KEYED_PAIR_PATTERN)) {
    const field = byKey.get(normalizeStartKey(match[1] ?? ""));
    if (field === undefined) continue;
    const value = stripQuotes(match[2] ?? "");
    if (value === "") continue;
    values[field.id] = value;
    rest = rest.replace(match[0], " ");
  }

  const dates = allMatches(ISO_DATE_PATTERN, rest);
  const ids = allMatches(ID_TOKEN_PATTERN, rest);
  const repository = REPOSITORY_PATTERN.exec(rest)?.[0] ?? "";
  const url = URL_PATTERN.exec(rest)?.[0] ?? "";
  const number = HASHED_NUMBER_PATTERN.exec(rest)?.[1] ?? "";

  for (const field of fields) {
    if (values[field.id] !== undefined) continue;
    if (field.kind === "date") {
      const next = dates.shift();
      if (next !== undefined) values[field.id] = next;
      continue;
    }
    if (field.kind === "enum") {
      const hit = field.values.find((value) =>
        new RegExp(`\\b${escapeRegExp(value)}\\b`, "i").test(rest),
      );
      if (hit !== undefined) values[field.id] = hit;
      continue;
    }
    if (field.kind === "number") {
      if (number !== "") values[field.id] = number;
      continue;
    }
    if (field.id === "repository" && repository !== "") {
      values[field.id] = repository;
      continue;
    }
    if (field.id === "targetUrl" && url !== "") {
      values[field.id] = url;
      continue;
    }
    if (field.id === "question") {
      const question = rest
        .replace(/^[\s:,\u2013-]+/, "")
        .replace(/^(?:a|an|the)\b\s*/i, "")
        .trim();
      if (question !== "") values[field.id] = question;
      continue;
    }
    if (/Id$/i.test(field.id)) {
      const next = ids.shift();
      if (next !== undefined) values[field.id] = next;
    }
  }
  return values;
}

/**
 * The record a field's value came from, or "" once the shown value is no
 * longer the one that record proved. Editing a prefilled field makes the value
 * the operator's, so the citation has to go with it.
 */
export function fieldProvenance(field: ChatStartField, value: string): string {
  if (field.source === undefined || field.value !== value) return "";
  return field.source;
}

/** The required field labels still empty in ``values`` (confirm stays off). */
export function missingStartFields(
  draft: ChatStartDraft,
  values: Record<string, string>,
): string[] {
  return draft.fields
    .filter((field) => field.required && (values[field.id] ?? "").trim() === "")
    .map((field) => field.label);
}

function coerceStartValue(field: WorkflowStartField, raw: string): unknown {
  if (field.kind === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (field.kind === "list") {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  if (field.kind === "enum") {
    return field.values.find((value) => value.toLowerCase() === raw.toLowerCase()) ?? raw;
  }
  return raw;
}

/** The `POST /runs` input for a confirmed card (blank optionals are omitted). */
export function buildStartInput(
  draft: ChatStartDraft,
  values: Record<string, string>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of draft.fields) {
    const raw = (values[field.id] ?? "").trim();
    if (raw === "") continue;
    input[field.id] = coerceStartValue(field, raw);
  }
  return input;
}

/**
 * The start card for a listed ticket and the workflow the human chose to launch
 * it with. Fields start blank because no message is being parsed any more — the
 * record lookup (prefill) fills what it can prove, and the confirm button is the
 * only writer. This replaces `ticketStartReply`, which also emitted the reply
 * text; prose is the assistant's job now.
 */
export function startDraftFromRow(
  row: ChatTicketRow,
  workflow: WorkflowDefinition,
): ChatStartDraft {
  return {
    workflow: workflow.id,
    workflowLabel: workflow.title,
    ticketKey: row.key,
    title: `${workflow.title} for ${row.key}`,
    detail: row.summary,
    fields: workflow.startFields.map((field) => ({ ...field, value: "" })),
  };
}

/** The card's own caption, so the shell renders a draft without a reply generator. */
export function startDraftCaption(draft: ChatStartDraft): string {
  const missing = missingStartFields(
    draft,
    Object.fromEntries(draft.fields.map((field) => [field.id, field.value])),
  );
  return missing.length > 0
    ? `${draft.workflowLabel} for ${draft.ticketKey} still needs: ${missing.join(", ")}. Fill the card — nothing starts until you confirm.`
    : `${draft.workflowLabel} for ${draft.ticketKey} is ready. Confirming starts the run, parked at its first checkpoint.`;
}

/** One value a record proved, as `POST /runs/prefill` answers it. */
export type ChatPrefillField = { id: string; label: string; value: string; source: string };

export type ChatPrefill = {
  workflow: string;
  fields: ChatPrefillField[];
  missing: string[];
};

/**
 * Read a ``POST /runs/prefill`` answer, or null when it is not one. Every row
 * is checked, because a malformed body must leave the card empty rather than
 * put an unverified string into a field the user is about to start a run with.
 */
export function parsePrefillReply(body: unknown): ChatPrefill | null {
  if (typeof body !== "object" || body === null) return null;
  const payload = body as { workflow?: unknown; fields?: unknown; missing?: unknown };
  if (typeof payload.workflow !== "string" || payload.workflow === "") return null;
  if (!Array.isArray(payload.fields)) return null;
  const fields: ChatPrefillField[] = [];
  for (const row of payload.fields) {
    if (typeof row !== "object" || row === null) continue;
    const item = row as { id?: unknown; label?: unknown; value?: unknown; source?: unknown };
    if (typeof item.id !== "string" || item.id === "") continue;
    if (typeof item.value !== "string" || item.value === "") continue;
    fields.push({
      id: item.id,
      label: typeof item.label === "string" ? item.label : item.id,
      value: item.value,
      source: typeof item.source === "string" ? item.source : "",
    });
  }
  const missing = Array.isArray(payload.missing)
    ? payload.missing.flatMap((row) => {
        const item = row as { id?: unknown; label?: unknown } | null;
        if (typeof item !== "object" || item === null) return [];
        if (typeof item.label === "string" && item.label !== "") return [item.label];
        return typeof item.id === "string" ? [item.id] : [];
      })
    : [];
  return { workflow: payload.workflow, fields, missing };
}

/**
 * Merge what records proved into a draft. Only a field the message left blank
 * is filled, and only for an id the catalog publishes: a value the user typed
 * is never replaced, and an unknown id is dropped instead of widening the
 * card. Returns the same draft when nothing changed.
 */
export function applyPrefill(
  draft: ChatStartDraft,
  suggestions: ChatPrefillField[],
): ChatStartDraft {
  let changed = false;
  const fields = draft.fields.map((field) => {
    if (field.value.trim() !== "") return field;
    const hit = suggestions.find((item) => item.id === field.id);
    if (hit === undefined) return field;
    changed = true;
    const filled: ChatStartField = { ...field, value: hit.value };
    return hit.source === "" ? filled : { ...filled, source: hit.source };
  });
  return changed ? { ...draft, fields } : draft;
}

/** Field problems a 422 ``POST /runs`` body names, one line per field. */
export function startProblemLines(body: unknown): string[] {
  const detail = (body as { detail?: unknown } | null | undefined)?.detail;
  const fields = (detail as { fields?: unknown } | null | undefined)?.fields;
  if (!Array.isArray(fields)) return [];
  const lines: string[] = [];
  for (const item of fields) {
    const record = item as { field?: unknown; problem?: unknown } | null;
    if (typeof record?.field !== "string" || typeof record.problem !== "string") continue;
    lines.push(`${record.field}: ${record.problem}`);
  }
  return lines;
}
