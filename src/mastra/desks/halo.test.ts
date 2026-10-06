import { describe, expect, it } from "vitest";

import { deskConformance } from "./conformance.js";
import { HaloDeskAdapter, type DeskFetch } from "./halo.js";
import { DeskError, type DeskTicketDraft } from "./types.js";

const BASE_URL = "https://demo.halopsa.com";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const TENANT = "demo";

interface FakeTicket {
  id: number;
  summary: string;
  details: string;
  client_id: number;
  status_id: number;
  tickettype_id: number | null;
}

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: unknown;
  form: string | null;
}

/**
 * Recorded-fixture Halo site: an in-memory stand-in that answers the exact
 * shapes the adapter speaks (token form, array-wrapped ticket and action
 * writes, /api/Status, base64 attachments) and records every request, so the
 * transport tests pin the wire contract without a network. `failNext` applies
 * to the next API call; the token endpoint stays reachable so failure tests
 * exercise the response mapping rather than the auth handshake.
 */
class FakeHaloSite {
  readonly requests: RecordedRequest[] = [];
  readonly statuses = [
    { id: 1, name: "New", shortname: "New" },
    { id: 2, name: "In Progress", shortname: "InProg" },
    { id: 8, name: "Resolved", shortname: "Resolved" },
  ];

  private readonly tickets = new Map<number, FakeTicket>();
  private readonly actions: Array<{ id: number; ticket_id: number; note: string }> = [];
  private readonly attachments: Array<Record<string, unknown>> = [];
  private readonly failures: Array<{ status: number; body: unknown }> = [];
  private readonly tokens: string[] = [];
  private ticketSequence = 0;
  private actionSequence = 0;
  private rejectApiOnce = false;

  /** Reject the next API call with a 401 the way an expired token would. */
  expireTokenOnce(): void {
    this.rejectApiOnce = true;
  }

  tokenRequestCount(): number {
    return this.tokens.length;
  }

  failNext(status: number, body: unknown = { error: "Injected failure" }): void {
    this.failures.push({ status, body });
  }

  readonly fetch: DeskFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const raw = typeof init?.body === "string" ? init.body : null;
    const request: RecordedRequest = {
      method,
      url,
      authorization: headers.get("Authorization") ?? "",
      body: undefined,
      form: null,
    };
    this.requests.push(request);
    const parsed = new URL(url);
    if (parsed.pathname === "/auth/token") {
      request.form = raw;
      return this.token(raw ?? "");
    }
    if (raw !== null) {
      request.body = JSON.parse(raw);
    }
    if (request.authorization !== `Bearer ${this.tokens.at(-1) ?? ""}`) {
      return jsonResponse(401, { error: "invalid_token" });
    }
    const failure = this.failures.shift();
    if (failure !== undefined) {
      return jsonResponse(failure.status, failure.body);
    }
    if (this.rejectApiOnce) {
      this.rejectApiOnce = false;
      return jsonResponse(401, { error: "invalid_token", error_description: "Token expired" });
    }
    return this.route(method, parsed, request.body);
  };

  private token(form: string): Response {
    const params = new URLSearchParams(form);
    const valid =
      params.get("grant_type") === "client_credentials" &&
      params.get("client_id") === CLIENT_ID &&
      params.get("client_secret") === CLIENT_SECRET;
    if (!valid) {
      return jsonResponse(400, {
        error: "invalid_client",
        error_description: "The client identifier or secret is incorrect",
      });
    }
    const value = `halo-token-${this.tokens.length + 1}`;
    this.tokens.push(value);
    return jsonResponse(200, { access_token: value, token_type: "Bearer", expires_in: 3600 });
  }

  private route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    if (path === "/api/Status" && method === "GET") {
      return jsonResponse(200, this.statuses);
    }
    if (path === "/api/Tickets" && method === "POST") {
      const items = Array.isArray(body) ? body : [body];
      const item = isRecord(items[0]) ? items[0] : {};
      const id = typeof item.id === "number" ? item.id : null;
      if (id !== null) {
        const ticket = this.tickets.get(id);
        if (ticket === undefined) {
          return jsonResponse(404, { error: "Ticket not found" });
        }
        if (typeof item.status_id === "number") {
          ticket.status_id = item.status_id;
        }
        return jsonResponse(200, ticket);
      }
      this.ticketSequence += 1;
      const ticket: FakeTicket = {
        id: 4000 + this.ticketSequence,
        summary: typeof item.summary === "string" ? item.summary : "",
        details: typeof item.details === "string" ? item.details : "",
        client_id: typeof item.client_id === "number" ? item.client_id : 0,
        status_id: 1,
        tickettype_id: typeof item.tickettype_id === "number" ? item.tickettype_id : null,
      };
      this.tickets.set(ticket.id, ticket);
      return jsonResponse(201, ticket);
    }
    const read = path.match(/^\/api\/Tickets\/(\d+)$/);
    if (read !== null && method === "GET") {
      const ticket = this.tickets.get(Number(read[1]));
      if (ticket === undefined) {
        return jsonResponse(404, { error: "Ticket not found" });
      }
      return jsonResponse(200, ticket);
    }
    if (path === "/api/Actions" && method === "POST") {
      const items = Array.isArray(body) ? body : [body];
      const item = isRecord(items[0]) ? items[0] : {};
      const ticketId = typeof item.ticket_id === "number" ? item.ticket_id : 0;
      if (!this.tickets.has(ticketId)) {
        return jsonResponse(404, { error: "Ticket not found" });
      }
      this.actionSequence += 1;
      const action = {
        id: 5000 + this.actionSequence,
        ticket_id: ticketId,
        note: typeof item.note === "string" ? item.note : "",
      };
      this.actions.push(action);
      return jsonResponse(201, action);
    }
    if (path === "/api/Attachment" && method === "POST") {
      const item = isRecord(body) ? body : {};
      const ticketId = typeof item.ticket_id === "number" ? item.ticket_id : 0;
      if (!this.tickets.has(ticketId)) {
        return jsonResponse(404, { error: "Ticket not found" });
      }
      this.attachments.push(item);
      return jsonResponse(201, {});
    }
    return jsonResponse(404, { error: "Route not found" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function adapter(site: FakeHaloSite): HaloDeskAdapter {
  return new HaloDeskAdapter({
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tenant: TENANT,
    ticketTypeId: 7,
    clientIds: { acme: 42 },
    fetch: site.fetch,
  });
}

/** Stub transport: the token handshake succeeds, API calls delegate. */
function stubFetch(api: (url: URL) => Response): DeskFetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/token")) {
      return jsonResponse(200, {
        access_token: "stub-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return api(new URL(url));
  };
}

deskConformance("HaloDeskAdapter (recorded fixtures)", {
  createDesk: () => adapter(new FakeHaloSite()),
  dedupes: false,
});

const DRAFT: DeskTicketDraft = {
  clientRef: "acme",
  title: "VPN outage for three users",
  body: "Hi team, since 9am our Sydney office cannot reach the VPN.",
  correlationId: "corr-1",
  labels: ["email-intake"],
};

describe("HaloDeskAdapter transport", () => {
  it("authenticates then records the create request shape", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);

    expect(ref.key).toBe("4001");
    expect(ref.id).toBe("4001");
    expect(ref.url).toBe(`${BASE_URL}/tickets?id=4001`);

    const [token, create] = site.requests;
    expect(token!.method).toBe("POST");
    expect(token!.url).toBe(`${BASE_URL}/auth/token?tenant=${TENANT}`);
    const form = new URLSearchParams(token!.form ?? "");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("scope")).toBe("all");

    expect(create!.method).toBe("POST");
    expect(create!.url).toBe(`${BASE_URL}/api/Tickets`);
    expect(create!.authorization).toBe("Bearer halo-token-1");
    expect(create!.body).toEqual([
      {
        summary: DRAFT.title,
        details: DRAFT.body,
        client_id: 42,
        tickettype_id: 7,
      },
    ]);
  });

  it("caches the bearer token across calls", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    await desk.addComment(ref, { body: "Approved reply sent." });
    expect(site.tokenRequestCount()).toBe(1);
  });

  it("refreshes the token once when a live call comes back 401", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    site.expireTokenOnce();
    const state = await desk.readTicket(ref);
    expect(state.exists).toBe(true);
    expect(site.tokenRequestCount()).toBe(2);
    const retries = site.requests.filter(
      (request) => request.method === "GET" && request.url === `${BASE_URL}/api/Tickets/4001`,
    );
    expect(retries.map((request) => request.authorization)).toEqual([
      "Bearer halo-token-1",
      "Bearer halo-token-2",
    ]);
  });

  it("truncates an over-long summary to Halo's limit", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    await desk.createTicket({ ...DRAFT, title: "x".repeat(300) });
    const create = site.requests.find((request) => request.url === `${BASE_URL}/api/Tickets`);
    const item = (create!.body as Array<{ summary: string }>)[0]!;
    expect(item.summary).toHaveLength(255);
    expect(item.summary.endsWith("…")).toBe(true);
  });

  it("comments with its evidence refs and returns the action id", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    const comment = await desk.addComment(ref, {
      body: "Approved reply sent to acme.",
      evidenceRefs: ["receipt:abc123"],
    });
    expect(comment.commentId).toBe("5001");
    expect(comment.created).toBe(true);
    expect(comment.url).toBe(`${BASE_URL}/tickets?id=4001`);

    const post = site.requests.find((request) => request.url === `${BASE_URL}/api/Actions`);
    expect(post!.body).toEqual([
      {
        ticket_id: 4001,
        note: "Approved reply sent to acme.\nEvidence: receipt:abc123",
      },
    ]);
  });

  it("resolves status names once, then updates the ticket", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    await desk.setStatus(ref, "in progress");
    await desk.setStatus(ref, "InProg");
    const state = await desk.readTicket(ref);
    expect(state.status).toBe("In Progress");

    const statusRequests = site.requests.filter(
      (request) => request.url === `${BASE_URL}/api/Status`,
    );
    expect(statusRequests).toHaveLength(1);
    const updates = site.requests.filter(
      (request) => request.method === "POST" && request.url === `${BASE_URL}/api/Tickets`,
    );
    expect(updates[1]!.body).toEqual([{ id: 4001, status_id: 2 }]);
    expect(updates[2]!.body).toEqual([{ id: 4001, status_id: 2 }]);
  });

  it("uploads evidence as base64 JSON on the ticket", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    await desk.attachEvidence(ref, {
      fileName: "receipt.json",
      mediaType: "application/json",
      content: '{"receipt":"abc"}',
      evidenceRef: "receipt:abc",
    });
    const upload = site.requests.find((request) => request.url === `${BASE_URL}/api/Attachment`);
    expect(upload!.body).toEqual({
      ticket_id: 4001,
      filename: "receipt.json",
      data: Buffer.from('{"receipt":"abc"}', "utf8").toString("base64"),
    });
  });

  it("rejects an unknown status and names the available ones", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    await expect(desk.setStatus(ref, "Frozen")).rejects.toMatchObject({
      name: "DeskError",
      code: "rejected",
    });
    await expect(desk.setStatus(ref, "Frozen")).rejects.toThrow(/In Progress/);
  });

  it("rejects a create when the client ref has no Halo company id", async () => {
    const site = new FakeHaloSite();
    const desk = new HaloDeskAdapter({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: site.fetch,
    });
    const error = await desk.createTicket(DRAFT).catch((item) => item);
    expect(error).toBeInstanceOf(DeskError);
    expect((error as DeskError).code).toBe("rejected");
    expect((error as DeskError).message).toContain('no Halo client id for "acme"');
  });

  it("omits the tenant query when no tenant is configured", async () => {
    const site = new FakeHaloSite();
    const desk = new HaloDeskAdapter({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clientIds: { acme: 42 },
      fetch: site.fetch,
    });
    await desk.createTicket(DRAFT);
    expect(site.requests[0]!.url).toBe(`${BASE_URL}/auth/token`);
  });

  it("maps rate limiting to a retryable DeskError", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    await desk.createTicket(DRAFT);
    site.failNext(429, { error: "Too many requests" });
    await expect(desk.createTicket(DRAFT)).rejects.toMatchObject({
      name: "DeskError",
      code: "rate-limited",
      status: 429,
      retryable: true,
    });
  });

  it("maps auth failures, rejections and server errors onto their codes", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    await desk.createTicket(DRAFT);
    site.failNext(403, { error: "Forbidden" });
    await expect(desk.createTicket(DRAFT)).rejects.toMatchObject({
      code: "auth",
      retryable: false,
    });
    site.failNext(400, { error: "Could not create ticket" });
    await expect(desk.createTicket(DRAFT)).rejects.toThrow(/Could not create ticket/);
    site.failNext(503, { error: "Service unavailable" });
    await expect(desk.createTicket(DRAFT)).rejects.toMatchObject({
      code: "unreachable",
      retryable: true,
    });
  });

  it("maps bad credentials to an auth DeskError", async () => {
    const site = new FakeHaloSite();
    const desk = new HaloDeskAdapter({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: "wrong-secret",
      clientIds: { acme: 42 },
      fetch: site.fetch,
    });
    await expect(desk.createTicket(DRAFT)).rejects.toMatchObject({
      name: "DeskError",
      code: "auth",
      retryable: false,
    });
  });

  it("maps token-endpoint rate limits and outages onto their codes", async () => {
    await expect(
      new HaloDeskAdapter({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        clientIds: { acme: 42 },
        fetch: () => Promise.resolve(jsonResponse(429, { error: "Too many requests" })),
      }).createTicket(DRAFT),
    ).rejects.toMatchObject({ code: "rate-limited", retryable: true });
    await expect(
      new HaloDeskAdapter({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        clientIds: { acme: 42 },
        fetch: () => Promise.resolve(jsonResponse(503, { error: "Down" })),
      }).createTicket(DRAFT),
    ).rejects.toMatchObject({ code: "unreachable", retryable: true });
  });

  it("maps a dead transport onto unreachable", async () => {
    const dead = new HaloDeskAdapter({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clientIds: { acme: 42 },
      fetch: () => Promise.reject(new Error("socket hang up")),
    });
    await expect(dead.createTicket(DRAFT)).rejects.toMatchObject({
      code: "unreachable",
      retryable: true,
    });
  });

  it("wraps an HTML body from a misrouted desk as unreachable", async () => {
    const desk = new HaloDeskAdapter({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clientIds: { acme: 42 },
      fetch: stubFetch(() => new Response("<html>sign in</html>", { status: 200 })),
    });
    await expect(desk.createTicket(DRAFT)).rejects.toMatchObject({
      code: "unreachable",
      retryable: true,
    });
  });

  it("accepts wrapped create responses across Halo versions", async () => {
    const variants: Array<{ body: unknown; key: string }> = [
      { body: [{ id: 77 }], key: "77" },
      { body: { tickets: [{ id: 78 }] }, key: "78" },
      { body: { ticket: { id: 79 } }, key: "79" },
    ];
    for (const variant of variants) {
      const desk = new HaloDeskAdapter({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        clientIds: { acme: 42 },
        fetch: stubFetch(() => jsonResponse(201, variant.body)),
      });
      const ref = await desk.createTicket(DRAFT);
      expect(ref.key).toBe(variant.key);
    }
  });

  it("accepts wrapped comment responses across Halo versions", async () => {
    const variants: unknown[] = [
      [{ id: 61 }],
      { action: { id: 62 } },
      { actions: [{ id: 63 }] },
    ];
    for (const body of variants) {
      const desk = new HaloDeskAdapter({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        clientIds: { acme: 42 },
        fetch: stubFetch(() => jsonResponse(201, body)),
      });
      const result = await desk.addComment({ key: "4001" }, { body: "hi" });
      expect(result.commentId).not.toBe("");
    }
  });

  it("reads wrapped ticket payloads across Halo versions", async () => {
    const ticket = { id: 4001, summary: "VPN outage", status_id: 2 };
    const variants: unknown[] = [
      { tickets: [ticket] },
      { ticket },
      [ticket],
    ];
    for (const body of variants) {
      const desk = new HaloDeskAdapter({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        clientIds: { acme: 42 },
        fetch: stubFetch((url) =>
          url.pathname === "/api/Status" ? jsonResponse(200, siteStatuses()) : jsonResponse(200, body),
        ),
      });
      const state = await desk.readTicket({ key: "4001" });
      expect(state.exists).toBe(true);
      expect(state.status).toBe("In Progress");
      expect(state.summary).toBe("VPN outage");
    }
  });

  it("shouts when a comment lands no action id", async () => {
    const desk = new HaloDeskAdapter({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clientIds: { acme: 42 },
      fetch: stubFetch(() => jsonResponse(201, { success: true })),
    });
    await expect(desk.addComment({ key: "4001" }, { body: "hi" })).rejects.toMatchObject({
      code: "rejected",
    });
  });

  it("reconciles a deleted ticket as exists false", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const state = await desk.readTicket({ key: "4001" });
    expect(state.exists).toBe(false);
    expect(state.ref.key).toBe("4001");
  });

  it("wraps every failure as a DeskError with the halopsa provider", async () => {
    const site = new FakeHaloSite();
    const desk = adapter(site);
    const error = await desk.addComment({ key: "GHOST-999" }, { body: "hi" }).catch((item) => item);
    expect(error).toBeInstanceOf(DeskError);
    expect((error as DeskError).provider).toBe("halopsa");
    expect((error as DeskError).code).toBe("not-found");
  });
});

function siteStatuses(): Array<{ id: number; name: string; shortname: string }> {
  return [
    { id: 1, name: "New", shortname: "New" },
    { id: 2, name: "In Progress", shortname: "InProg" },
  ];
}
