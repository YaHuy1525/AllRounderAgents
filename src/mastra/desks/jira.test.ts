import { describe, expect, it } from "vitest";

import { deskConformance } from "./conformance.js";
import { JiraDeskAdapter, type DeskFetch } from "./jira.js";
import { DeskError, type DeskTicketDraft } from "./types.js";

const BASE_URL = "https://demo.atlassian.net";
const EMAIL = "automation@example.com";
const TOKEN = "test-token";

interface FakeIssue {
  id: string;
  key: string;
  status: string;
  summary: string;
  comments: Array<{ id: string; body: unknown }>;
  attachments: string[];
}

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: unknown;
  form: FormData | null;
}

/**
 * Recorded-fixture Jira site: an in-memory stand-in that answers the exact
 * REST v3 shapes the adapter speaks and records every request, so the replay
 * tests pin the wire contract (paths, ADF bodies, auth header) without a
 * network. Failure injection covers the rate-limit and auth paths.
 */
class FakeJiraSite {
  readonly requests: RecordedRequest[] = [];
  private readonly issues = new Map<string, FakeIssue>();
  private readonly failures: Array<{ status: number; body: unknown }> = [];
  private sequence = 0;

  readonly transitions = [
    { id: "21", name: "In Progress", to: { name: "In Progress" } },
    { id: "31", name: "Done", to: { name: "Done" } },
  ];

  failNext(status: number, body: unknown = { errorMessages: ["Injected failure"] }): void {
    this.failures.push({ status, body });
  }

  readonly fetch: DeskFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const form = init?.body instanceof FormData ? init.body : null;
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    this.requests.push({
      method,
      url,
      authorization: headers.get("Authorization") ?? "",
      body,
      form,
    });
    const failure = this.failures.shift();
    if (failure !== undefined) {
      return jsonResponse(failure.status, failure.body);
    }
    return this.route(method, new URL(url), body);
  };

  private route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    const create = path.match(/^\/rest\/api\/3\/issue$/);
    if (create !== null && method === "POST") {
      this.sequence += 1;
      const key = `SUP-${this.sequence}`;
      const fields = isRecord(body) && isRecord(body.fields) ? body.fields : {};
      const issue: FakeIssue = {
        id: `10${this.sequence}`,
        key,
        status: "Open",
        summary: typeof fields.summary === "string" ? fields.summary : "",
        comments: [],
        attachments: [],
      };
      this.issues.set(key, issue);
      return jsonResponse(201, { id: issue.id, key, self: `${BASE_URL}/rest/api/3/issue/${issue.id}` });
    }
    const read = path.match(/^\/rest\/api\/3\/issue\/([^/]+)$/);
    if (read !== null && method === "GET") {
      const issue = this.issues.get(decodeURIComponent(read[1]!));
      if (issue === undefined) return jiraNotFound();
      return jsonResponse(200, {
        id: issue.id,
        key: issue.key,
        fields: { summary: issue.summary, status: { name: issue.status } },
      });
    }
    const comment = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/comment$/);
    if (comment !== null && method === "POST") {
      const issue = this.issues.get(decodeURIComponent(comment[1]!));
      if (issue === undefined) return jiraNotFound();
      const id = `10${this.sequence}${issue.comments.length + 1}`;
      issue.comments.push({ id, body });
      return jsonResponse(201, { id });
    }
    const transitions = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/);
    if (transitions !== null) {
      const issue = this.issues.get(decodeURIComponent(transitions[1]!));
      if (issue === undefined) return jiraNotFound();
      if (method === "GET") {
        return jsonResponse(200, { transitions: this.transitions });
      }
      if (method === "POST") {
        const wanted =
          isRecord(body) && isRecord(body.transition) ? String(body.transition.id) : "";
        const match = this.transitions.find((item) => item.id === wanted);
        if (match === undefined) {
          return jsonResponse(400, { errorMessages: ["Invalid transition"] });
        }
        issue.status = match.to.name;
        return new Response(null, { status: 204 });
      }
    }
    const attachments = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/attachments$/);
    if (attachments !== null && method === "POST") {
      const issue = this.issues.get(decodeURIComponent(attachments[1]!));
      if (issue === undefined) return jiraNotFound();
      issue.attachments.push("uploaded");
      return jsonResponse(200, [{ id: "20001", filename: "receipt.json" }]);
    }
    return jsonResponse(404, { errorMessages: ["Route not found"] });
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

function jiraNotFound(): Response {
  return jsonResponse(404, {
    errorMessages: ["Issue does not exist or you do not have permission to see it."],
  });
}

function adapter(site: FakeJiraSite): JiraDeskAdapter {
  return new JiraDeskAdapter({
    baseUrl: BASE_URL,
    email: EMAIL,
    apiToken: TOKEN,
    projectKey: "SUP",
    fetch: site.fetch,
  });
}

deskConformance("JiraDeskAdapter (recorded fixtures)", {
  createDesk: () => adapter(new FakeJiraSite()),
  dedupes: false,
});

const DRAFT: DeskTicketDraft = {
  clientRef: "acme",
  title: "VPN outage for three users",
  body: "Hi team, since 9am our Sydney office cannot reach the VPN.",
  correlationId: "corr-1",
  labels: ["email intake", "vpn"],
};

describe("JiraDeskAdapter transport", () => {
  it("records the create request shape (path, auth, ADF body, sanitized labels)", async () => {
    const site = new FakeJiraSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);

    expect(ref.key).toBe("SUP-1");
    expect(ref.url).toBe(`${BASE_URL}/browse/SUP-1`);
    const request = site.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${BASE_URL}/rest/api/3/issue`);
    expect(request.authorization).toBe(
      `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`,
    );
    const fields = (request.body as { fields: Record<string, unknown> }).fields;
    expect(fields.project).toEqual({ key: "SUP" });
    expect(fields.issuetype).toEqual({ name: "Task" });
    expect(fields.summary).toBe(DRAFT.title);
    expect(fields.labels).toEqual(["email-intake", "vpn"]);
    expect(fields.description).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: DRAFT.body }],
        },
      ],
    });
  });

  it("comments with its evidence refs and transitions by name", async () => {
    const site = new FakeJiraSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    const comment = await desk.addComment(ref, {
      body: "Approved reply sent to acme.",
      evidenceRefs: ["receipt:abc123"],
    });
    expect(comment.commentId).not.toBe("");
    expect(comment.url).toContain("focusedCommentId=");

    await desk.setStatus(ref, "In Progress");
    const state = await desk.readTicket(ref);
    expect(state.status).toBe("In Progress");

    const transitionRequests = site.requests.filter((request) =>
      request.url.endsWith(`/issue/${ref.key}/transitions`),
    );
    expect(transitionRequests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(transitionRequests[1]!.body).toEqual({ transition: { id: "21" } });
  });

  it("uploads evidence as a multipart attachment", async () => {
    const site = new FakeJiraSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    await desk.attachEvidence(ref, {
      fileName: "receipt.json",
      mediaType: "application/json",
      content: '{"receipt":"abc"}',
      evidenceRef: "receipt:abc",
    });
    const upload = site.requests.find((request) =>
      request.url.endsWith(`/issue/${ref.key}/attachments`),
    );
    expect(upload?.form).toBeInstanceOf(FormData);
  });

  it("rejects an unknown transition and names the available ones", async () => {
    const site = new FakeJiraSite();
    const desk = adapter(site);
    const ref = await desk.createTicket(DRAFT);
    await expect(desk.setStatus(ref, "Frozen")).rejects.toMatchObject({
      name: "DeskError",
      code: "rejected",
    });
    await expect(desk.setStatus(ref, "Frozen")).rejects.toThrow(/In Progress/);
  });

  it("maps rate limiting to a retryable DeskError", async () => {
    const site = new FakeJiraSite();
    site.failNext(429, { errorMessages: ["Rate limit exceeded"] });
    const desk = adapter(site);
    await expect(desk.createTicket(DRAFT)).rejects.toMatchObject({
      name: "DeskError",
      code: "rate-limited",
      status: 429,
      retryable: true,
    });
  });

  it("maps auth failures and server errors onto their codes", async () => {
    const site = new FakeJiraSite();
    const desk = adapter(site);
    site.failNext(401, { errorMessages: ["Unauthorized"] });
    await expect(desk.createTicket(DRAFT)).rejects.toMatchObject({ code: "auth", retryable: false });
    site.failNext(503, { errorMessages: ["Service unavailable"] });
    await expect(desk.createTicket(DRAFT)).rejects.toMatchObject({
      code: "unreachable",
      retryable: true,
    });
  });

  it("maps a dead transport onto unreachable", async () => {
    const dead = new JiraDeskAdapter({
      baseUrl: BASE_URL,
      email: EMAIL,
      apiToken: TOKEN,
      projectKey: "SUP",
      fetch: () => Promise.reject(new Error("socket hang up")),
    });
    await expect(dead.createTicket(DRAFT)).rejects.toMatchObject({
      code: "unreachable",
      retryable: true,
    });
  });

  it("reconciles a deleted ticket as exists false", async () => {
    const site = new FakeJiraSite();
    const desk = adapter(site);
    const state = await desk.readTicket({ key: "SUP-404" });
    expect(state.exists).toBe(false);
    expect(state.ref.key).toBe("SUP-404");
  });

  it("wraps every failure as a DeskError with the jira provider", async () => {
    const site = new FakeJiraSite();
    const desk = adapter(site);
    const error = await desk.addComment({ key: "SUP-404" }, { body: "hi" }).catch((item) => item);
    expect(error).toBeInstanceOf(DeskError);
    expect((error as DeskError).provider).toBe("jira");
  });
});
