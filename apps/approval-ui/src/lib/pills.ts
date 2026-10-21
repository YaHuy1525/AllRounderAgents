import { api } from "./api";
import type { RunDecision } from "./runs";

/**
 * Data pills (N3): the console-side half of the `{{ref}}` token protocol.
 *
 * The API serves the picker catalog (earlier outputs of the run, path
 * addressed) from `GET /runs/{id}/pills`; this module parses it, turns plain
 * text fields into token-aware fields (insert, remove, re-map) and answers
 * the one question that must never fail silently: does every ref a draft
 * carries still exist in the catalog? Resolution itself happens at the API
 * boundary when the decision is recorded, so a receipt is always bound to
 * concrete values, never to tokens.
 */

export type RunPillKind = "text" | "number" | "boolean" | "citation";

/** One referenceable output: a leaf value, or a composite `{sourceId, span}` citation. */
export type RunPill = {
  /** Token path, e.g. `steps.select-pr.prNumber` or `trigger.repository`. */
  ref: string;
  /** Step id (`trigger` for the run input) the pill belongs to. */
  group: string;
  /** Human group label: `Trigger`, `Select PR`, ... */
  groupTitle: string;
  /** Path within the group, e.g. `review.citations[0]`. */
  label: string;
  kind: RunPillKind;
  /** Short value preview the picker and chips show. */
  preview: string;
  /** Step order; -1 for the trigger input. */
  stepIndex: number;
};

export type RunPills = {
  runId: string;
  workflow: string;
  currentStepId: string | null;
  pills: RunPill[];
};

const PILL_KINDS: readonly RunPillKind[] = ["text", "number", "boolean", "citation"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseRunPill(value: unknown): RunPill | null {
  const record = asRecord(value);
  if (record === null) return null;
  const ref = asString(record.ref);
  const group = asString(record.group);
  const groupTitle = asString(record.groupTitle);
  const label = asString(record.label);
  if (ref === null || ref === "" || group === null || groupTitle === null || label === null) {
    return null;
  }
  return {
    ref,
    group,
    groupTitle,
    label,
    kind: PILL_KINDS.includes(record.kind as RunPillKind)
      ? (record.kind as RunPillKind)
      : "text",
    preview: asString(record.preview) ?? "",
    stepIndex: typeof record.stepIndex === "number" ? record.stepIndex : -1,
  };
}

/** Tolerant parser: malformed rows drop out, a malformed payload yields null. */
export function parseRunPills(value: unknown): RunPills | null {
  const record = asRecord(value);
  if (record === null) return null;
  const runId = asString(record.runId);
  const workflow = asString(record.workflow);
  if (runId === null || workflow === null || !Array.isArray(record.pills)) return null;
  const pills: RunPill[] = [];
  for (const item of record.pills) {
    const pill = parseRunPill(item);
    if (pill !== null) pills.push(pill);
  }
  return {
    runId,
    workflow,
    currentStepId: asString(record.currentStepId),
    pills,
  };
}

/** The picker catalog for one run; a miss is not fatal for the panel. */
export async function getRunPills(runId: string): Promise<RunPills | null> {
  const payload = await api<unknown>(`/runs/${encodeURIComponent(runId)}/pills`);
  return parseRunPills(payload);
}

// ------------------------------------------------------------- token math

/** One `{{ref}}` occurrence: the ref plus its half-open span in the text. */
export type PillToken = { ref: string; start: number; end: number };

// The same grammar the API resolver enforces.
const PILL_TOKEN = /\{\{([A-Za-z0-9_.\[\]-]{1,200})\}\}/g;

export function pillTokens(text: string): PillToken[] {
  const tokens: PillToken[] = [];
  PILL_TOKEN.lastIndex = 0;
  for (let match = PILL_TOKEN.exec(text); match !== null; match = PILL_TOKEN.exec(text)) {
    const ref = match[1] ?? "";
    if (ref === "") continue;
    tokens.push({ ref, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Refs used in the text that the catalog no longer offers, deduped in order. */
export function brokenPillRefs(text: string, pills: readonly RunPill[]): string[] {
  const known = new Set(pills.map((pill) => pill.ref));
  const broken: string[] = [];
  for (const token of pillTokens(text)) {
    if (!known.has(token.ref) && !broken.includes(token.ref)) broken.push(token.ref);
  }
  return broken;
}

/**
 * Every broken ref a built decision carries (edits and guidance alike) —
 * the pre-submit gate. A non-empty list means the field must be re-mapped
 * before the decision is sent, mirroring the API resolver's own rejection.
 */
export function decisionPillIssues(
  decision: Pick<RunDecision, "edits" | "guidance">,
  pills: readonly RunPill[],
): string[] {
  const known = new Set(pills.map((pill) => pill.ref));
  const broken = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const token of pillTokens(value)) {
        if (!known.has(token.ref)) broken.add(token.ref);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = asRecord(value);
    if (record !== null) {
      for (const item of Object.values(record)) visit(item);
    }
  };
  visit(decision.edits);
  visit(decision.guidance);
  return [...broken];
}

/** Submit-blocking copy for broken chips; mirrors the API's rejection wording. */
export function pillBrokenCopy(refs: readonly string[]): string {
  const listed = refs
    .slice(0, 3)
    .map((ref) => `{{${ref}}}`)
    .join(", ");
  const more = refs.length > 3 ? ` and ${refs.length - 3} more` : "";
  return `Field no longer exists — re-map ${listed}${more} before proceeding.`;
}

/** Insert `{{ref}}` at the caret; returns the next text and caret position. */
export function insertPillToken(
  text: string,
  ref: string,
  caret: number,
): { text: string; caret: number } {
  const token = `{{${ref}}}`;
  const at = Math.min(Math.max(caret, 0), text.length);
  return {
    text: `${text.slice(0, at)}${token}${text.slice(at)}`,
    caret: at + token.length,
  };
}

/**
 * Drop the `@` that opened the picker (when the user typed one), so the
 * chosen token replaces it instead of following it.
 */
export function stripPillTrigger(
  text: string,
  atIndex: number,
): { text: string; caret: number } {
  if (atIndex < 0 || atIndex >= text.length || text[atIndex] !== "@") {
    return { text, caret: Math.min(Math.max(atIndex, 0), text.length) };
  }
  return { text: `${text.slice(0, atIndex)}${text.slice(atIndex + 1)}`, caret: atIndex };
}

/** Replace one token's span (a broken chip's re-map) with a fresh token. */
export function replacePillToken(
  text: string,
  span: { start: number; end: number },
  ref: string,
): { text: string; caret: number } {
  const token = `{{${ref}}}`;
  const start = Math.min(Math.max(span.start, 0), text.length);
  const end = Math.min(Math.max(span.end, start), text.length);
  return {
    text: `${text.slice(0, start)}${token}${text.slice(end)}`,
    caret: start + token.length,
  };
}

// ------------------------------------------------------------ autofill

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The leaf name of a path label: `review.citations[0]` -> `citations`. */
function leafName(label: string): string {
  return label.slice(label.lastIndexOf(".") + 1).replace(/\[\d+\]$/, "");
}

/**
 * Autofill ranking: pills whose leaf name matches the field's label, most
 * specific first (exact, then prefix, then containment), catalog order
 * within a tier. The picker lists these under "Suggested" for the field.
 */
export function suggestPills(fieldLabel: string, pills: readonly RunPill[]): RunPill[] {
  const target = normalizeLabel(fieldLabel);
  if (target === "") return [];
  const scored: Array<{ pill: RunPill; score: number }> = [];
  for (const pill of pills) {
    const leaf = normalizeLabel(leafName(pill.label));
    if (leaf === "") continue;
    let score: number | null = null;
    if (leaf === target) score = 0;
    else if (leaf.startsWith(target) || target.endsWith(leaf)) score = 1;
    else if (leaf.length >= 4 && (leaf.includes(target) || target.includes(leaf))) score = 2;
    if (score !== null) scored.push({ pill, score });
  }
  scored.sort((left, right) => left.score - right.score);
  return scored.slice(0, 5).map((entry) => entry.pill);
}

/** `Group › label` chip caption. */
export function pillChipLabel(pill: RunPill): string {
  return `${pill.groupTitle} › ${pill.label}`;
}
