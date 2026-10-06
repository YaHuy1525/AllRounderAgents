import {
  DeskError,
  type DeskAdapter,
  type DeskAttachment,
  type DeskCapabilities,
  type DeskComment,
  type DeskCommentResult,
  type DeskErrorCode,
  type DeskTicketDraft,
  type DeskTicketRef,
  type DeskTicketState,
} from "./types.js";

/** Transport seam: global fetch in production, recorded fixtures in tests. */
export type DeskFetch = typeof fetch;

export interface HaloDeskOptions {
  /** Instance root, e.g. https://acme.halopsa.com (no /api suffix). */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Hosted-instance tenant, appended to the token request as ?tenant=... */
  readonly tenant?: string;
  /** OAuth scope granted to the API application; Halo's default is "all". */
  readonly scope?: string;
  /** Ticket type for created tickets; instance-configurable, optional. */
  readonly ticketTypeId?: number;
  /** Fallback Halo company id for client refs without an explicit mapping. */
  readonly defaultClientId?: number;
  /** clientRef -> Halo company id, e.g. { acme: 42 }. */
  readonly clientIds?: Readonly<Record<string, number>>;
  readonly fetch?: DeskFetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh the bearer token early so an in-flight call never races expiry. */
const TOKEN_SKEW_MS = 30_000;
/** Statuses are instance configuration; cache them between transitions. */
const STATUS_TTL_MS = 5 * 60_000;
/** Halo truncates overview summaries at 255 characters. */
const SUMMARY_MAX = 255;

/**
 * HaloPSA adapter behind the desk seam (MSP plan wave 1). OAuth2 client
 * credentials with a cached bearer token (one forced refresh and retry when
 * a live call comes back 401), array-wrapped writes per Halo's API
 * conventions, and the numeric ticket id as the ref key. Status names are
 * instance-configurable, so transitions resolve through /api/Status; Halo
 * has no native correlation dedupe, so the flow's effect map is the replay
 * guard and `readTicket` reconciles.
 */
export class HaloDeskAdapter implements DeskAdapter {
  readonly provider = "halopsa";
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tenant: string;
  private readonly scope: string;
  private readonly ticketTypeId: number | null;
  private readonly defaultClientId: number | null;
  private readonly clientIds: ReadonlyMap<string, number>;
  private readonly fetchImpl: DeskFetch;
  private readonly timeoutMs: number;
  private tokenCache: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private statusCache: HaloStatusIndex | null = null;

  constructor(options: HaloDeskOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (this.baseUrl === "") {
      throw new Error("HaloDeskAdapter: baseUrl is required");
    }
    if (options.clientId === "" || options.clientSecret === "") {
      throw new Error("HaloDeskAdapter: clientId and clientSecret are required");
    }
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tenant = options.tenant?.trim() ?? "";
    this.scope =
      options.scope === undefined || options.scope === "" ? "all" : options.scope;
    this.ticketTypeId = options.ticketTypeId ?? null;
    this.defaultClientId = options.defaultClientId ?? null;
    this.clientIds = new Map(Object.entries(options.clientIds ?? {}));
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  capabilities(): DeskCapabilities {
    return {
      create: true,
      comment: true,
      transition: true,
      attach: true,
      webhook: false,
      polling: false,
    };
  }

  async createTicket(draft: DeskTicketDraft): Promise<DeskTicketRef> {
    const clientId = this.requireClientId(draft.clientRef);
    const response = await this.send("POST", "/api/Tickets", [
      {
        summary: truncate(draft.title, SUMMARY_MAX),
        details: draft.body,
        client_id: clientId,
        ...(this.ticketTypeId === null
          ? {}
          : { tickettype_id: this.ticketTypeId }),
      },
    ]);
    const body = await this.json(response, "create ticket");
    const id = ticketIdFrom(body);
    if (id === null) {
      throw new DeskError(this.provider, "rejected", "create ticket returned no id");
    }
    return { key: id, id, url: this.ticketUrl(id) };
  }

  async addComment(ref: DeskTicketRef, comment: DeskComment): Promise<DeskCommentResult> {
    const ticketId = this.requireTicketId(ref);
    const response = await this.send("POST", "/api/Actions", [
      { ticket_id: ticketId, note: commentNote(comment) },
    ]);
    const body = await this.json(response, `comment on ${ref.key}`);
    const actionId = actionIdFrom(body);
    if (actionId === null) {
      throw new DeskError(
        this.provider,
        "rejected",
        `comment on ${ref.key} returned no id`,
      );
    }
    return { commentId: actionId, created: true, url: this.ticketUrl(ticketId) };
  }

  async setStatus(ref: DeskTicketRef, status: string): Promise<DeskTicketRef> {
    const ticketId = this.requireTicketId(ref);
    const index = await this.statusIndex();
    const statusId = index.byName.get(status.trim().toLowerCase());
    if (statusId === undefined) {
      throw new DeskError(
        this.provider,
        "rejected",
        `no status named "${status}" in Halo; available: ${index.available.join(", ")}`,
      );
    }
    const response = await this.send("POST", "/api/Tickets", [
      { id: ticketId, status_id: statusId },
    ]);
    await this.json(response, `transition ${ref.key}`);
    return { ...ref, url: ref.url ?? this.ticketUrl(ticketId) };
  }

  async attachEvidence(
    ref: DeskTicketRef,
    attachment: DeskAttachment,
  ): Promise<DeskTicketRef> {
    const ticketId = this.requireTicketId(ref);
    const response = await this.send("POST", "/api/Attachment", {
      ticket_id: ticketId,
      filename: attachment.fileName,
      data: Buffer.from(attachment.content, "utf8").toString("base64"),
    });
    if (!response.ok) {
      throw await this.errorFor(response, `attach evidence to ${ref.key}`);
    }
    // Halo answers 201 with an empty body; drain it to release the socket.
    await response.text().catch(() => "");
    return { ...ref, url: ref.url ?? this.ticketUrl(ticketId) };
  }

  async readTicket(ref: DeskTicketRef): Promise<DeskTicketState> {
    const ticketId = this.ticketId(ref);
    if (ticketId === null) {
      return { ref: { ...ref }, exists: false };
    }
    const response = await this.send("GET", `/api/Tickets/${ticketId}`);
    if (response.status === 404) {
      return { ref: { ...ref }, exists: false };
    }
    const body = await this.json(response, `read ${ref.key}`);
    const ticket = ticketFrom(body);
    if (ticket === null) {
      throw new DeskError(
        this.provider,
        "unreachable",
        `read ${ref.key}: desk returned no ticket`,
      );
    }
    const id = stringId(ticket.id) ?? String(ticketId);
    const statusId = toIdNumber(ticket.status_id);
    let status = "";
    if (statusId !== null) {
      const index = await this.statusIndex();
      status = index.byId.get(statusId) ?? "";
    }
    const summary = asText(ticket.summary);
    return {
      ref: {
        key: ref.key,
        id: ref.id ?? id,
        url: ref.url ?? this.ticketUrl(id),
      },
      exists: true,
      ...(status === "" ? {} : { status }),
      ...(summary === "" ? {} : { summary }),
    };
  }

  private requireClientId(clientRef: string): number {
    const mapped = this.clientIds.get(clientRef);
    if (mapped !== undefined) {
      return mapped;
    }
    if (this.defaultClientId !== null) {
      return this.defaultClientId;
    }
    throw new DeskError(
      this.provider,
      "rejected",
      `no Halo client id for "${clientRef}"; map it in clientIds or set defaultClientId`,
    );
  }

  private ticketId(ref: DeskTicketRef): number | null {
    return toIdNumber(ref.id ?? ref.key);
  }

  private requireTicketId(ref: DeskTicketRef): number {
    const id = this.ticketId(ref);
    if (id === null) {
      throw new DeskError(
        this.provider,
        "not-found",
        `ticket ${ref.key} is not a Halo ticket id`,
      );
    }
    return id;
  }

  private ticketUrl(id: string | number): string {
    return `${this.baseUrl}/tickets?id=${id}`;
  }

  /** Instance statuses, cached briefly; names resolve both ways. */
  private async statusIndex(): Promise<HaloStatusIndex> {
    const cached = this.statusCache;
    if (cached !== null && Date.now() < cached.expiresAt) {
      return cached;
    }
    const response = await this.send("GET", "/api/Status");
    const body = await this.json(response, "list statuses");
    const index = buildStatusIndex(body);
    this.statusCache = { ...index, expiresAt: Date.now() + STATUS_TTL_MS };
    return this.statusCache;
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    retryAuth = true,
  ): Promise<Response> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (error) {
      throw new DeskError(
        this.provider,
        "unreachable",
        `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401 && retryAuth) {
      // A cached token the desk no longer accepts: drain, refresh once, retry.
      await response.text().catch(() => "");
      await this.accessToken(true);
      return this.send(method, path, body, false);
    }
    return response;
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    const cached = this.tokenCache;
    if (!forceRefresh && cached !== null && Date.now() < cached.expiresAt - TOKEN_SKEW_MS) {
      return cached.value;
    }
    const pending = this.tokenInFlight;
    if (pending !== null) {
      return pending;
    }
    const request = this.requestToken().finally(() => {
      this.tokenInFlight = null;
    });
    this.tokenInFlight = request;
    return request;
  }

  private async requestToken(): Promise<string> {
    const tenant =
      this.tenant === "" ? "" : `?tenant=${encodeURIComponent(this.tenant)}`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scope,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/auth/token${tenant}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DeskError(
        this.provider,
        "unreachable",
        `auth token request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const detail = await errorDetail(response);
      const code: DeskErrorCode =
        response.status === 429
          ? "rate-limited"
          : response.status >= 500
            ? "unreachable"
            : "auth";
      throw new DeskError(this.provider, code, `auth token: ${detail}`, {
        status: response.status,
      });
    }
    const body = asRecord(await this.readBody(response, "auth token"));
    const value = body === null ? "" : asText(body.access_token);
    if (value === "") {
      throw new DeskError(
        this.provider,
        "auth",
        "auth token response carried no access_token",
      );
    }
    const expiresIn =
      body !== null &&
      typeof body.expires_in === "number" &&
      Number.isFinite(body.expires_in)
        ? body.expires_in
        : 3600;
    this.tokenCache = { value, expiresAt: Date.now() + expiresIn * 1000 };
    return value;
  }

  /** Parse a JSON response, mapping every non-OK status onto a DeskError. */
  private async json(response: Response, context: string): Promise<unknown> {
    if (!response.ok) {
      throw await this.errorFor(response, context);
    }
    return this.readBody(response, context);
  }

  private async readBody(response: Response, context: string): Promise<unknown> {
    const text = await response.text();
    if (text.trim() === "") {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DeskError(
        this.provider,
        "unreachable",
        `${context}: desk returned invalid JSON`,
      );
    }
  }

  private async errorFor(response: Response, context: string): Promise<DeskError> {
    const detail = await errorDetail(response);
    const status = response.status;
    if (status === 401 || status === 403) {
      return new DeskError(this.provider, "auth", `${context}: ${detail}`, { status });
    }
    if (status === 404) {
      return new DeskError(this.provider, "not-found", `${context}: ${detail}`, { status });
    }
    if (status === 429) {
      return new DeskError(this.provider, "rate-limited", `${context}: ${detail}`, { status });
    }
    if (status >= 500) {
      return new DeskError(this.provider, "unreachable", `${context}: ${detail}`, { status });
    }
    return new DeskError(this.provider, "rejected", `${context}: ${detail}`, { status });
  }
}

interface HaloStatusIndex {
  readonly byId: ReadonlyMap<number, string>;
  readonly byName: ReadonlyMap<string, number>;
  readonly available: readonly string[];
  readonly expiresAt: number;
}

function buildStatusIndex(body: unknown): Omit<HaloStatusIndex, "expiresAt"> {
  const record = asRecord(body);
  const list =
    asArray(body) ?? (record === null ? null : asArray(record.statuses)) ?? [];
  const byId = new Map<number, string>();
  const byName = new Map<string, number>();
  const available: string[] = [];
  for (const item of list) {
    const status = asRecord(item);
    if (status === null) {
      continue;
    }
    const id = toIdNumber(status.id);
    const name = asText(status.name);
    if (id === null || name === "") {
      continue;
    }
    byId.set(id, name);
    available.push(name);
    // First name seen wins: instance names are unique, shortnames alias names.
    const key = name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, id);
    }
    const shortname = asText(status.shortname).toLowerCase();
    if (shortname !== "" && !byName.has(shortname)) {
      byName.set(shortname, id);
    }
  }
  return { byId, byName, available };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toIdNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function stringId(value: unknown): string | null {
  const id = toIdNumber(value);
  return id === null ? null : String(id);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function commentNote(comment: DeskComment): string {
  const evidence = comment.evidenceRefs ?? [];
  return [
    comment.body,
    ...(evidence.length === 0 ? [] : [`Evidence: ${evidence.join(", ")}`]),
  ].join("\n");
}

/** Halo wraps create responses differently across versions; accept them all. */
function ticketIdFrom(body: unknown): string | null {
  const record = asRecord(body);
  if (record !== null) {
    const direct = stringId(record.id);
    if (direct !== null) {
      return direct;
    }
    const list = asArray(record.tickets);
    if (list !== null) {
      return firstId(list);
    }
    return stringId(asRecord(record.ticket)?.id);
  }
  const list = asArray(body);
  return list === null ? null : firstId(list);
}

function actionIdFrom(body: unknown): string | null {
  const record = asRecord(body);
  if (record !== null) {
    const direct = stringId(record.id);
    if (direct !== null) {
      return direct;
    }
    const single = stringId(asRecord(record.action)?.id);
    if (single !== null) {
      return single;
    }
    const list = asArray(record.actions);
    return list === null ? null : firstId(list);
  }
  const list = asArray(body);
  return list === null ? null : firstId(list);
}

/** GET /api/Tickets/{id} returns the ticket; tolerate wrapped variants. */
function ticketFrom(body: unknown): Record<string, unknown> | null {
  const record = asRecord(body);
  if (record !== null) {
    if (record.id !== undefined) {
      return record;
    }
    const list = asArray(record.tickets);
    if (list !== null) {
      return firstRecord(list);
    }
    return asRecord(record.ticket);
  }
  const list = asArray(body);
  return list === null ? null : firstRecord(list);
}

function firstId(list: readonly unknown[]): string | null {
  for (const item of list) {
    const id = stringId(asRecord(item)?.id);
    if (id !== null) {
      return id;
    }
  }
  return null;
}

function firstRecord(list: readonly unknown[]): Record<string, unknown> | null {
  for (const item of list) {
    const record = asRecord(item);
    if (record !== null) {
      return record;
    }
  }
  return null;
}

async function errorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }
  const trimmed = text.trim();
  if (trimmed === "") {
    return `HTTP ${response.status}`;
  }
  try {
    const parsed = asRecord(JSON.parse(trimmed) as unknown);
    if (parsed !== null) {
      for (const key of ["message", "Message", "error", "Error", "error_description"]) {
        const value = parsed[key];
        if (typeof value === "string" && value !== "") {
          return value.slice(0, 500);
        }
      }
    }
  } catch {
    // Fall through to the raw body.
  }
  return trimmed.slice(0, 500);
}
