import { api } from "./api";

/**
 * Browser-side model for the command-bar search (upgrade U1). The API owns
 * intent resolution and matching; this module mirrors its response shape,
 * validates it defensively (mirroring `parseRunSnapshot`), and turns hits
 * into deep-link targets. It never executes anything: the only outcomes are
 * "open this ticket/step" or "open this run".
 */

export type SearchIntent = "find" | "list" | "why" | "do";

export type SearchHitKind = "run" | "approval" | "receipt" | "ticket";

export type SearchHit = {
  kind: SearchHitKind;
  id: string;
  title: string;
  subtitle: string;
  snippet: string;
  runId: string | null;
  workflow: string | null;
  ticketKey: string | null;
  stepId: string | null;
  stepTitle: string | null;
  status: string | null;
  reason: string | null;
  logLine: string | null;
  receipt: string | null;
};

export type SearchPassage = {
  sourceId: string;
  span: string;
  title: string;
  text: string;
  score: number;
  stale: boolean;
  domain: string;
};

export type SearchResponse = {
  query: string;
  intent: SearchIntent;
  scope: string | null;
  results: SearchHit[];
  kb: SearchPassage[];
  kbDegraded: boolean;
  counts: { runs: number; approvals: number; kb: number };
};

/** What clicking a hit does: navigate only, never execute. */
export type CommandTarget =
  | { kind: "ticket"; ticketKey: string; stepId: string | null }
  | { kind: "run"; runId: string; ticketKey: string | null; stepId: string | null }
  | { kind: "approvals" };

const HIT_KINDS: readonly string[] = ["run", "approval", "receipt", "ticket"];
const INTENTS: readonly string[] = ["find", "list", "why", "do"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseHit(value: unknown): SearchHit | null {
  const record = asRecord(value);
  if (record === null) return null;
  const kind = asString(record.kind);
  const id = asString(record.id);
  if (kind === null || !HIT_KINDS.includes(kind) || id === null || id === "") return null;
  return {
    kind: kind as SearchHitKind,
    id,
    title: asString(record.title) ?? id,
    subtitle: asString(record.subtitle) ?? "",
    snippet: asString(record.snippet) ?? "",
    runId: asString(record.runId),
    workflow: asString(record.workflow),
    ticketKey: asString(record.ticketKey),
    stepId: asString(record.stepId),
    stepTitle: asString(record.stepTitle),
    status: asString(record.status),
    reason: asString(record.reason),
    logLine: asString(record.logLine),
    receipt: asString(record.receipt),
  };
}

function parsePassage(value: unknown): SearchPassage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const sourceId = asString(record.sourceId);
  const text = asString(record.text);
  if (sourceId === null || text === null) return null;
  return {
    sourceId,
    span: asString(record.span) ?? "",
    title: asString(record.title) ?? sourceId,
    text,
    score: asNumber(record.score) ?? 0,
    stale: record.stale === true,
    domain: asString(record.domain) ?? "",
  };
}

/** Validate one `GET /search` payload; malformed rows are dropped, not fatal. */
export function parseSearchResponse(value: unknown): SearchResponse {
  const record = asRecord(value);
  if (record === null) return emptySearchResponse("");
  const intent = asString(record.intent);
  const results: SearchHit[] = [];
  for (const item of Array.isArray(record.results) ? record.results : []) {
    const hit = parseHit(item);
    if (hit !== null) results.push(hit);
  }
  const kb: SearchPassage[] = [];
  for (const item of Array.isArray(record.kb) ? record.kb : []) {
    const passage = parsePassage(item);
    if (passage !== null) kb.push(passage);
  }
  const counts = asRecord(record.counts);
  return {
    query: asString(record.query) ?? "",
    intent: intent !== null && INTENTS.includes(intent) ? (intent as SearchIntent) : "find",
    scope: asString(record.scope),
    results,
    kb,
    kbDegraded: record.kbDegraded === true,
    counts: {
      runs: asNumber(counts?.runs) ?? results.length,
      approvals: asNumber(counts?.approvals) ?? 0,
      kb: asNumber(counts?.kb) ?? kb.length,
    },
  };
}

export function emptySearchResponse(query: string): SearchResponse {
  return {
    query,
    intent: "find",
    scope: null,
    results: [],
    kb: [],
    kbDegraded: false,
    counts: { runs: 0, approvals: 0, kb: 0 },
  };
}

/** `q=` with proper encoding for punctuation-heavy commands. */
export function searchQueryString(query: string): string {
  return new URLSearchParams({ q: query }).toString();
}

/** One read-only query against the console search route. */
export async function searchConsole(query: string): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (trimmed === "") return emptySearchResponse("");
  const payload = await api<unknown>(`/search?${searchQueryString(trimmed)}`);
  return parseSearchResponse(payload);
}

// ------------------------------------------------------------ local tickets

export type TicketMatchSource = { key: string; summary: string };

/**
 * Ticket matches come from the board list the console already holds; the
 * search route covers runs, approvals, and knowledge. Matching every token
 * against `key + summary` keeps the local half deterministic too.
 */
export function ticketHits(
  query: string,
  tickets: readonly TicketMatchSource[],
  limit = 5,
): SearchHit[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter((token) => token !== "");
  if (tokens.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const ticket of tickets) {
    const haystack = `${ticket.key} ${ticket.summary}`.toLowerCase();
    if (!tokens.every((token) => haystack.includes(token))) continue;
    hits.push({
      kind: "ticket",
      id: ticket.key,
      title: `${ticket.key} - ${ticket.summary}`,
      subtitle: "Ticket · board",
      snippet: ticket.summary,
      runId: null,
      workflow: null,
      ticketKey: ticket.key,
      stepId: null,
      stepTitle: null,
      status: null,
      reason: null,
      logLine: null,
      receipt: null,
    });
    if (hits.length === limit) break;
  }
  return hits;
}

/** Server hits first (they carry run:step links), then local ticket matches. */
export function mergeSearchHits(
  serverHits: readonly SearchHit[],
  localHits: readonly SearchHit[],
  limit = 10,
): SearchHit[] {
  const merged: SearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...serverHits, ...localHits]) {
    const key = `${hit.kind}:${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length === limit) break;
  }
  return merged;
}

/**
 * Resolve what a hit opens. A ticket key + step id always wins (the guide's
 * "jump to that ticket's awaiting step"); a bare run id opens the inspector
 * (its step survives so the run view can focus it); a bare ticket opens its
 * tab; bare approvals fall back to the approvals panel. Nothing executes.
 */
export function commandTarget(hit: SearchHit): CommandTarget | null {
  if (hit.ticketKey !== null && hit.ticketKey !== "" && hit.stepId !== null) {
    return { kind: "ticket", ticketKey: hit.ticketKey, stepId: hit.stepId };
  }
  if (hit.runId !== null && hit.runId !== "") {
    return { kind: "run", runId: hit.runId, ticketKey: hit.ticketKey, stepId: hit.stepId };
  }
  if (hit.ticketKey !== null && hit.ticketKey !== "") {
    return { kind: "ticket", ticketKey: hit.ticketKey, stepId: null };
  }
  if (hit.kind === "approval") return { kind: "approvals" };
  return null;
}
