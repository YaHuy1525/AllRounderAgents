import {
  DeskError,
  type DeskAdapter,
  type DeskAttachment,
  type DeskCapabilities,
  type DeskComment,
  type DeskCommentResult,
  type DeskTicketDraft,
  type DeskTicketRef,
  type DeskTicketState,
} from "./types.js";

/** Transport seam: global fetch in production, recorded fixtures in tests. */
export type DeskFetch = typeof fetch;

export interface JiraDeskOptions {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly projectKey: string;
  readonly issueType?: string;
  readonly fetch?: DeskFetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Jira Cloud adapter behind the desk seam (MSP plan wave 0). Talks REST v3
 * with an API token: create issue, comment, transition by name and attach
 * evidence. Jira has no native correlation dedupe, so the flow's effect map
 * is the replay guard and `readTicket` reconciles; HTTP failures map onto
 * DeskError codes so the trail shows why a write stopped.
 */
export class JiraDeskAdapter implements DeskAdapter {
  readonly provider = "jira";
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly projectKey: string;
  private readonly issueType: string;
  private readonly fetchImpl: DeskFetch;
  private readonly timeoutMs: number;

  constructor(options: JiraDeskOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (this.baseUrl === "") {
      throw new Error("JiraDeskAdapter: baseUrl is required");
    }
    this.auth = Buffer.from(`${options.email}:${options.apiToken}`).toString("base64");
    this.projectKey = options.projectKey;
    this.issueType = options.issueType ?? "Task";
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
    const labels = sanitizeLabels(draft.labels ?? []);
    const response = await this.send("POST", "/rest/api/3/issue", {
      body: {
        fields: {
          project: { key: this.projectKey },
          issuetype: { name: this.issueType },
          summary: truncate(draft.title, 250),
          description: adfDocument(draft.body),
          ...(labels.length === 0 ? {} : { labels }),
        },
      },
    });
    const payload = await this.json(response, "create issue");
    const key = asText(payload.key);
    if (key === "") {
      throw new DeskError(this.provider, "rejected", "create issue returned no key");
    }
    const id = asText(payload.id);
    return {
      key,
      ...(id === "" ? {} : { id }),
      url: `${this.baseUrl}/browse/${key}`,
    };
  }

  async addComment(ref: DeskTicketRef, comment: DeskComment): Promise<DeskCommentResult> {
    const lines = [comment.body];
    const evidence = comment.evidenceRefs ?? [];
    if (evidence.length > 0) {
      lines.push(`Evidence: ${evidence.join(", ")}`);
    }
    const response = await this.send("POST", `/rest/api/3/issue/${encodeURIComponent(ref.key)}/comment`, {
      body: { body: adfDocument(lines.join("\n")) },
    });
    const payload = await this.json(response, `comment on ${ref.key}`);
    const commentId = asText(payload.id);
    if (commentId === "") {
      throw new DeskError(this.provider, "rejected", `comment on ${ref.key} returned no id`);
    }
    return {
      commentId,
      created: true,
      url: `${this.baseUrl}/browse/${ref.key}?focusedCommentId=${commentId}`,
    };
  }

  async setStatus(ref: DeskTicketRef, status: string): Promise<DeskTicketRef> {
    const listResponse = await this.send(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(ref.key)}/transitions`,
    );
    const payload = await this.json(listResponse, `list transitions for ${ref.key}`);
    const transitions = Array.isArray(payload.transitions) ? payload.transitions : [];
    const match = transitions.find(
      (candidate) => isRecord(candidate) && matchesTransition(candidate, status),
    );
    if (!isRecord(match)) {
      const available = transitions
        .filter((candidate) => isRecord(candidate))
        .map((candidate) => asText((candidate as Record<string, unknown>).name))
        .filter((name) => name !== "")
        .join(", ");
      throw new DeskError(
        this.provider,
        "rejected",
        `no transition to "${status}" for ${ref.key}` +
          (available === "" ? "" : `; available: ${available}`),
      );
    }
    const response = await this.send(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(ref.key)}/transitions`,
      { body: { transition: { id: asText(match.id) } } },
    );
    await this.json(response, `transition ${ref.key}`);
    return { ...ref, url: ref.url ?? `${this.baseUrl}/browse/${ref.key}` };
  }

  async attachEvidence(
    ref: DeskTicketRef,
    attachment: DeskAttachment,
  ): Promise<DeskTicketRef> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([attachment.content], { type: attachment.mediaType }),
      attachment.fileName,
    );
    const response = await this.send(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(ref.key)}/attachments`,
      { form },
    );
    const payload = await this.json(response, `attach evidence to ${ref.key}`, true);
    const attachments = Array.isArray(payload.items) ? payload.items : [];
    if (attachments.length === 0) {
      throw new DeskError(
        this.provider,
        "rejected",
        `attach evidence to ${ref.key} returned no attachment`,
      );
    }
    return { ...ref, url: ref.url ?? `${this.baseUrl}/browse/${ref.key}` };
  }

  async readTicket(ref: DeskTicketRef): Promise<DeskTicketState> {
    const response = await this.send(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(ref.key)}?fields=status,summary`,
    );
    if (response.status === 404) {
      return { ref: { ...ref }, exists: false };
    }
    const payload = await this.json(response, `read ${ref.key}`);
    const fields = isRecord(payload.fields) ? payload.fields : {};
    const status = isRecord(fields.status) ? asText(fields.status.name) : "";
    const summary = asText(fields.summary);
    const id = asText(payload.id);
    return {
      ref: {
        key: ref.key,
        ...(id === "" ? (ref.id === undefined ? {} : { id: ref.id }) : { id }),
        url: ref.url ?? `${this.baseUrl}/browse/${ref.key}`,
      },
      exists: true,
      ...(status === "" ? {} : { status }),
      ...(summary === "" ? {} : { summary }),
    };
  }

  private async send(
    method: string,
    path: string,
    init: { body?: unknown; form?: FormData } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${this.auth}`,
      Accept: "application/json",
    };
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    if (init.form !== undefined) {
      headers["X-Atlassian-Token"] = "no-check";
      body = init.form;
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      throw new DeskError(
        this.provider,
        "unreachable",
        `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Parse a JSON response, mapping every non-OK status onto a DeskError. */
  private async json(
    response: Response,
    context: string,
    expectArray = false,
  ): Promise<Record<string, unknown>> {
    if (!response.ok) {
      throw await this.errorFor(response, context);
    }
    if (response.status === 204) {
      return expectArray ? { items: [] } : {};
    }
    const text = await response.text();
    if (text.trim() === "") {
      return expectArray ? { items: [] } : {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DeskError(
        this.provider,
        "unreachable",
        `${context}: desk returned invalid JSON`,
      );
    }
    if (expectArray) {
      return { items: Array.isArray(parsed) ? parsed : [] };
    }
    return isRecord(parsed) ? parsed : {};
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function matchesTransition(candidate: Record<string, unknown>, status: string): boolean {
  const wanted = status.toLowerCase();
  if (asText(candidate.name).toLowerCase() === wanted) return true;
  return isRecord(candidate.to) && asText(candidate.to.name).toLowerCase() === wanted;
}

/** Jira labels allow no spaces or punctuation beyond dashes and underscores. */
function sanitizeLabels(labels: readonly string[]): string[] {
  const cleaned = labels
    .map((label) =>
      label
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 255),
    )
    .filter((label) => label !== "");
  return [...new Set(cleaned)].slice(0, 20);
}

/** Minimal Atlassian Document Format document: one paragraph per line. */
function adfDocument(text: string): Record<string, unknown> {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    })),
  };
}

async function errorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const messages = parsed.errorMessages;
      if (Array.isArray(messages) && messages.length > 0) {
        return messages.map((item) => String(item)).join("; ").slice(0, 500);
      }
      if (isRecord(parsed.errors)) {
        const entries = Object.entries(parsed.errors);
        if (entries.length > 0) {
          return entries.map(([field, item]) => `${field}: ${String(item)}`).join("; ").slice(0, 500);
        }
      }
    }
  } catch {
    // Fall through to the raw body.
  }
  const trimmed = text.trim();
  return trimmed === "" ? `HTTP ${response.status}` : trimmed.slice(0, 500);
}
