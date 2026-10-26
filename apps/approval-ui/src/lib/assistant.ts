import { MastraClient } from "@mastra/client-js";

import { resolveAccessToken, sessionHeaders } from "./api";
import { readStoredSession } from "./auth";
import { AUTH_STORAGE_KEY, getSupabaseClient } from "./supabase";

/**
 * Everything the console does against the Mastra host lives here: no React, no
 * DOM, and every entry point takes an injected client, so the whole surface is
 * testable in the node vitest environment the app already uses.
 *
 * The host is authoritative about who is calling. This module never sends a
 * `requestContext`; the host middleware derives the tenant and the memory
 * resource from the verified token, and overrides anything a caller supplies.
 */

export const ASSISTANT_AGENT_ID = "console-assistant";

export type AssistantThread = { id: string; title: string; updatedAt: number | null };
export type AssistantMessage = { role: "user" | "assistant"; body: string };

type SessionUser = { id?: string | null; app_metadata?: Record<string, unknown> | null };

/**
 * The production reader hands back the user itself, while a Supabase-shaped
 * session (`{ user: {...} }`) is also accepted, so a test or an SSR caller can
 * pass either without reshaping it first.
 */
function userOf(session: unknown): SessionUser | null {
  if (session === null || typeof session !== "object") return null;
  const record = session as Record<string, unknown>;
  const nested = record.user;
  if (nested !== null && typeof nested === "object") return nested as SessionUser;
  return record as SessionUser;
}

/**
 * Swappable so tests and the SSR pass can drive the resource path without a live
 * Supabase client. Production code never calls it.
 */
let readSession: () => Promise<unknown> = async () => {
  const client = getSupabaseClient();
  if (!client) return null;
  const storage = typeof window === "undefined" ? null : window.localStorage;
  if (!client.auth || storage === undefined || storage === null) return null;
  const result = await client.auth.getSession();
  const user = result.data.session?.user;
  if (!user) return null;
  return { id: user.id, app_metadata: user.app_metadata as Record<string, unknown> };
};

export function setSessionReaderForTest(reader: () => Promise<unknown>): void {
  readSession = reader;
}

function resourceFrom(userId: string, tenantId: string): string {
  return `${tenantId}:${userId}`;
}

/**
 * The memory resource string. The host derives the identical value from the same
 * signed claims, so agreement is a precondition for any thread call. A missing
 * tenant means an unprovisioned account: return null and let the composer say so
 * rather than firing a request the host will refuse.
 */
export async function assistantResource(): Promise<string | null> {
  let userId: string | null = null;
  let tenantId: string | null = null;
  try {
    const session = await readSession();
    const user = userOf(session);
    if (user) {
      userId = typeof user.id === "string" && user.id !== "" ? user.id : null;
      const claim = user.app_metadata?.tenant_id;
      tenantId = typeof claim === "string" && claim.trim() !== "" ? claim.trim() : null;
    }
  } catch {
    // Fall through to the persisted snapshot, same bounded-read rule as api.ts.
  }
  if (userId === null || tenantId === null) {
    // Deliberately does not require a Supabase client: the snapshot is the
    // fallback for exactly the case where the client is missing or stalled.
    if (typeof window === "undefined") return null;
    const stored = readStoredSession(window.localStorage, AUTH_STORAGE_KEY);
    if (!stored) return null;
    if (userId === null) userId = stored.userId;
    if (tenantId === null) {
      const claim = stored.appMetadata?.tenant_id;
      tenantId = typeof claim === "string" && claim.trim() !== "" ? claim.trim() : null;
    }
  }
  if (userId === null || tenantId === null) return null;
  return resourceFrom(userId, tenantId);
}

/**
 * Builds a client for one call. `MastraClient` takes a static header map, so a
 * cached instance would keep a stale access token after a refresh; rebuilding
 * per call is how the token stays current.
 */
export async function assistantClient(): Promise<MastraClient> {
  const baseUrl = process.env.NEXT_PUBLIC_MASTRA_URL;
  if (!baseUrl || !baseUrl.trim()) {
    throw new Error("NEXT_PUBLIC_MASTRA_URL is not configured");
  }
  const headers = await sessionHeaders();
  return new MastraClient({ baseUrl: baseUrl.trim(), headers, retries: 1 });
}

/** Resolves the resource or throws, for callers that must have one. */
function requireResource(): Promise<string> {
  return assistantResource().then((value) => {
    if (value === null) throw new Error("this account has no tenant");
    return value;
  });
}

export function threadTitleFor(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "New conversation";
  return collapsed.slice(0, 60);
}

/** `updatedAt` arrives as a Date from the host and as an epoch from the test fake. */
function updatedAtOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function titleOf(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "New conversation";
}

/**
 * The host answers `GET /memory/threads` with a paginated envelope
 * (`{ threads: [...] }`), not a bare array. Accept both so a caller holding
 * either shape — and the test fake — behaves the same.
 */
function threadListOf(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const threads = (payload as { threads?: unknown } | null | undefined)?.threads;
  return Array.isArray(threads) ? (threads as Array<Record<string, unknown>>) : [];
}

export async function listThreads(client?: MastraClient): Promise<AssistantThread[]> {
  try {
    const resourceId = await requireResource();
    const target = client ?? (await assistantClient());
    const payload: unknown = await target.listMemoryThreads({
      resourceId,
      agentId: ASSISTANT_AGENT_ID,
    });
    return threadListOf(payload)
      .map((thread) => ({
        id: String(thread.id),
        title: titleOf(thread.title),
        updatedAt: updatedAtOf(thread.updatedAt),
      }))
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  } catch {
    // An empty sidebar with a working composer beats a blocked panel.
    return [];
  }
}

export async function createThread(
  title: string,
  client?: MastraClient,
): Promise<AssistantThread | null> {
  const opened = await openThread(title, client);
  return "thread" in opened ? opened.thread : null;
}

/** The configured host, for the sentence a person reads when a call fails. */
export function assistantHost(): string {
  const base = process.env.NEXT_PUBLIC_MASTRA_URL;
  return base === undefined || base.trim() === ""
    ? "no host configured (NEXT_PUBLIC_MASTRA_URL is unset)"
    : base.trim();
}

/**
 * Turns a host failure into something a person can act on. The reason is kept
 * on purpose: a swallowed error is what made the first failure unreadable.
 */
function hostFailure(error: unknown): string {
  const host = assistantHost();
  const detail = error instanceof Error ? error.message : String(error);
  if (/no tenant/i.test(detail)) {
    return "This account has no tenant, so a conversation cannot be stored.";
  }
  if (/not configured/i.test(detail)) {
    return "The assistant has no host to talk to. Set NEXT_PUBLIC_MASTRA_URL to this project's Mastra host.";
  }
  if (/ECONNREFUSED|fetch failed|Failed to fetch|NetworkError|ECONNRESET/i.test(detail)) {
    return `Nothing answered at ${host}. Start the assistant host with npm run dev:backend, then try again.`;
  }
  if (/404|not found/i.test(detail)) {
    return `The host at ${host} answered, but it has no "${ASSISTANT_AGENT_ID}" agent. Point NEXT_PUBLIC_MASTRA_URL at this project's Mastra host.`;
  }
  return `The host at ${host} refused the conversation: ${detail.slice(0, 200)}`;
}

export type ThreadOpen = { thread: AssistantThread } | { reason: string };

/** Like `createThread`, but it says why it failed instead of returning null. */
export async function openThread(title: string, client?: MastraClient): Promise<ThreadOpen> {
  try {
    const resourceId = await requireResource();
    const target = client ?? (await assistantClient());
    const thread = await target.createMemoryThread({
      title: title.trim() === "" ? "New conversation" : title.trim().slice(0, 60),
      metadata: {},
      resourceId,
      agentId: ASSISTANT_AGENT_ID,
    });
    return { thread: { id: String(thread.id), title: titleOf(thread.title), updatedAt: null } };
  } catch (error) {
    return { reason: hostFailure(error) };
  }
}

export async function renameThread(
  threadId: string,
  title: string,
  client?: MastraClient,
): Promise<void> {
  const resourceId = await requireResource();
  const target = client ?? (await assistantClient());
  await target.getMemoryThread({ threadId, agentId: ASSISTANT_AGENT_ID }).update({
    title: title.trim().slice(0, 60),
    resourceId,
  });
}

export async function deleteThread(threadId: string, client?: MastraClient): Promise<void> {
  const target = client ?? (await assistantClient());
  await target.getMemoryThread({ threadId, agentId: ASSISTANT_AGENT_ID }).delete();
}

export async function loadMessages(
  threadId: string,
  client?: MastraClient,
): Promise<AssistantMessage[]> {
  try {
    await requireResource();
    const target = client ?? (await assistantClient());
    const result = await target
      .getMemoryThread({ threadId, agentId: ASSISTANT_AGENT_ID })
      .listMessages({ page: 0, perPage: 200, orderBy: { field: "createdAt", direction: "ASC" } });
    const messages = (result.messages ?? []) as Array<{
      role?: unknown;
      content?: unknown;
    }>;
    return messages
      .map(
        (message): AssistantMessage => ({
          role: message.role === "user" ? "user" : "assistant",
          body: messageText(message),
        }),
      )
      .filter((message) => message.body !== "");
  } catch {
    return [];
  }
}

/** Memory stores AI-sdk message parts; pull the text out of both shapes. */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  const record = content as { parts?: unknown } | null | undefined;
  if (!Array.isArray(record?.parts)) return "";
  return (record.parts as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/** Proves the token reader is shared with api.ts rather than re-implemented. */
export async function assistantAuthProbe(): Promise<Record<string, string>> {
  const client = getSupabaseClient();
  if (client && typeof window !== "undefined") {
    await resolveAccessToken(client, window.localStorage);
  }
  return sessionHeaders();
}

/** The row shape the console already renders: `LaneTicketRow` in `lib/runs.ts`.
 *  Re-declared here so this module does not import the start-card layer. */
export type AssistantTicketRow = {
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

/** One turn of the transcript. Rows and tool notes belong to the turn that produced them. */
export type ChatTurn = {
  role: "user" | "assistant";
  body: string;
  toolNotes: string[];
  rows: AssistantTicketRow[];
  /** A single ticket the `execute_ticket` tool resolved, rendered as an Execute action. */
  execute: AssistantTicketRow | null;
  error: string | null;
  stopped: boolean;
};

export type ChatState = {
  turns: ChatTurn[];
  streaming: boolean;
  /** Set when the signed-in account carries no tenant, so the composer can say why it is disabled. */
  unusable: boolean;
};

export const TICKET_LIST_LIMIT = 10;

export function initialChatState(unusable = false): ChatState {
  return { turns: [], streaming: false, unusable };
}

function blankTurn(role: "user" | "assistant"): ChatTurn {
  return { role, body: "", toolNotes: [], rows: [], execute: null, error: null, stopped: false };
}

export function appendUserTurn(state: ChatState, text: string): ChatState {
  return { ...state, turns: [...state.turns, { ...blankTurn("user"), body: text }] };
}

/**
 * Guarantees the transcript ends on an assistant turn. The reducer calls this so
 * a chunk that arrives before the shell opened a turn still lands somewhere
 * renderable, and `startAssistantTurn` calls it so the two never double-open.
 */
function ensureAssistantTurn(state: ChatState): ChatState {
  if (state.turns.at(-1)?.role === "assistant") return state;
  return { ...state, turns: [...state.turns, blankTurn("assistant")] };
}

/** Opens the assistant turn the deltas stream into, and marks the stream live. */
export function startAssistantTurn(state: ChatState): ChatState {
  return { ...ensureAssistantTurn(state), streaming: true };
}

function withLastTurn(state: ChatState, patch: (turn: ChatTurn) => ChatTurn): ChatState {
  const turns = state.turns.slice();
  const last = turns[turns.length - 1];
  if (last === undefined) return state;
  turns[turns.length - 1] = patch(last);
  return { ...state, turns };
}

/** `payload.text` on a `text-delta`, whatever envelope the chunk arrived in. */
export function streamText(chunk: unknown): string {
  const payload = (chunk as { payload?: { text?: unknown; delta?: unknown } } | null)?.payload;
  const value = payload?.text ?? payload?.delta;
  return typeof value === "string" ? value : "";
}

function chunkType(chunk: unknown): string {
  const record = chunk as { type?: unknown; payload?: { type?: unknown } } | null;
  if (typeof record?.type === "string") return record.type;
  return typeof record?.payload?.type === "string" ? record.payload.type : "";
}

function chunkPayload(chunk: unknown): Record<string, unknown> {
  const record = chunk as { payload?: Record<string, unknown> } | null;
  return record?.payload ?? {};
}

function ticketRow(value: unknown): AssistantTicketRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<AssistantTicketRow>;
  if (typeof row.key !== "string" || row.key.trim() === "") return null;
  if (typeof row.summary !== "string") return null;
  return {
    key: row.key.trim(),
    project: typeof row.project === "string" ? row.project : "",
    summary: row.summary,
    status: typeof row.status === "string" ? row.status : "",
    issueType: typeof row.issueType === "string" ? row.issueType : "",
    priority: typeof row.priority === "string" ? row.priority : "",
    assignee: typeof row.assignee === "string" ? row.assignee : null,
    labels: Array.isArray(row.labels)
      ? row.labels.filter((item): item is string => typeof item === "string")
      : [],
    matchedWorkflows: Array.isArray(row.matchedWorkflows)
      ? row.matchedWorkflows.filter((item): item is string => typeof item === "string")
      : [],
  };
}

/**
 * Pulls pickable rows out of a `list_tickets` tool result. The stream path
 * arrives both enveloped (`{ type, from, payload }`) and flat (`payload` only),
 * so both are read, and an `ok: false` result yields nothing rather than a
 * picker that claims the console answered.
 */
export function extractTicketRows(chunk: unknown): AssistantTicketRow[] {
  const payload = chunkPayload(chunk);
  const toolName = payload.toolName ?? (chunk as { toolName?: unknown } | null)?.toolName;
  if (toolName !== "list_tickets") return [];
  const result = payload.result;
  if (typeof result !== "object" || result === null) return [];
  const record = result as { ok?: unknown; tickets?: unknown };
  if (record.ok === false) return [];
  if (!Array.isArray(record.tickets)) return [];
  const rows: AssistantTicketRow[] = [];
  for (const entry of record.tickets) {
    if (rows.length === TICKET_LIST_LIMIT) break;
    const row = ticketRow(entry);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * Read the single ticket an `execute_ticket` result resolved, or null. The
 * result carries `ticket`, not a `tickets` array, and an `ok: false` or a
 * missing ticket yields nothing so no Execute button is offered for a record
 * the console never read.
 */
export function extractExecuteTicket(chunk: unknown): AssistantTicketRow | null {
  const payload = chunkPayload(chunk);
  const toolName = payload.toolName ?? (chunk as { toolName?: unknown } | null)?.toolName;
  if (toolName !== "execute_ticket") return null;
  const result = payload.result;
  if (typeof result !== "object" || result === null) return null;
  const record = result as { ok?: unknown; ticket?: unknown };
  if (record.ok === false) return null;
  return ticketRow(record.ticket);
}

/**
 * The single transcript reducer. `ChatShell` only calls it and renders its
 * output, which is how every streaming behaviour stays a node test rather than
 * a browser click. It returns the same object when a chunk carries nothing, so
 * React does not re-render on noise.
 */
export function reduceChatState(state: ChatState, chunk: unknown): ChatState {
  const type = chunkType(chunk);
  const payload = chunkPayload(chunk);

  if (type === "text-delta") {
    const text = streamText(chunk);
    if (text === "") return state;
    return withLastTurn(ensureAssistantTurn(state), (turn) => ({
      ...turn,
      body: `${turn.body}${text}`,
    }));
  }

  if (type === "tool-call") {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    if (toolName === "") return state;
    const opened = ensureAssistantTurn(state);
    if (opened.turns.at(-1)?.toolNotes.includes(toolName) === true) return state;
    return withLastTurn(opened, (turn) => ({ ...turn, toolNotes: [...turn.toolNotes, toolName] }));
  }

  if (type === "tool-result" || payload.result !== undefined) {
    const execute = extractExecuteTicket(chunk);
    if (execute !== null) {
      return withLastTurn(ensureAssistantTurn(state), (turn) => ({ ...turn, execute }));
    }
    const rows = extractTicketRows(chunk);
    if (rows.length === 0) return state;
    return withLastTurn(ensureAssistantTurn(state), (turn) => {
      const seen = new Set(turn.rows.map((row) => row.key));
      const merged = [...turn.rows];
      for (const row of rows) {
        if (merged.length === TICKET_LIST_LIMIT) break;
        if (seen.has(row.key)) continue;
        seen.add(row.key);
        merged.push(row);
      }
      return { ...turn, rows: merged };
    });
  }

  if (type === "error") {
    const error = payload.error;
    const message =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : JSON.stringify(error ?? "The assistant could not answer");
    return withLastTurn(ensureAssistantTurn(state), (turn) => ({
      ...turn,
      error: message.slice(0, 400),
    }));
  }

  return state;
}

export function endChatTurn(
  state: ChatState,
  outcome: "done" | "stopped" | "error" = "done",
): ChatState {
  const closed = { ...state, streaming: false };
  if (outcome === "stopped") return withLastTurn(closed, (turn) => ({ ...turn, stopped: true }));
  return closed;
}

export type SendChatInput = {
  threadId: string;
  message: string;
  resource: string;
  onState: (state: ChatState) => void;
  /** The shell's prepared state. Omitted, the turn is opened here from `message`. */
  state?: ChatState;
  signal?: AbortSignal;
  client?: MastraClient;
};

/**
 * Streams one assistant turn into the reducer and always ends with
 * `streaming: false`. It never throws: a failed turn is an error on the turn,
 * which is what the spec's error table demands. The host is never given a
 * `requestContext`; tenancy arrives on the verified token.
 */
export async function sendChat(input: SendChatInput): Promise<ChatState> {
  let state = input.state ?? startAssistantTurn(appendUserTurn(initialChatState(), input.message));
  let target: MastraClient;
  try {
    target = input.client ?? (await assistantClient());
  } catch (error) {
    state = reduceChatState(state, {
      type: "error",
      payload: { error: error instanceof Error ? error.message : "the host could not be reached" },
    });
    const final = endChatTurn(state, "error");
    input.onState(final);
    return final;
  }

  try {
    const agent = target.getAgent(ASSISTANT_AGENT_ID);
    const response = await agent.stream(input.message, {
      memory: { thread: input.threadId, resource: input.resource },
      ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
    });
    await response.processDataStream({
      onChunk: async (chunk: unknown) => {
        state = reduceChatState(state, chunk);
        input.onState(state);
      },
    });
    const stopped = input.signal?.aborted === true;
    const final = endChatTurn(state, stopped ? "stopped" : "done");
    input.onState(final);
    return final;
  } catch (error) {
    // Aborts are a user action, not a fault: keep the partial text, mark stopped.
    const stopped = input.signal?.aborted === true;
    if (!stopped) {
      state = reduceChatState(state, {
        type: "error",
        payload: {
          error: error instanceof Error ? error.message : "the assistant could not answer",
        },
      });
    }
    const final = endChatTurn(state, stopped ? "stopped" : "error");
    input.onState(final);
    return final;
  }
}

/** A new conversation is titled from the first question the user actually asked. */
export async function ensureThread(
  title: string,
  client?: MastraClient,
): Promise<AssistantThread | null> {
  return createThread(title, client);
}
