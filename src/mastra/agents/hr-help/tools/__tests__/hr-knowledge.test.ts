import { describe, expect, it } from "vitest";

import {
  HttpHrPolicyRetriever,
  type HrKnowledgeFetch,
} from "../hr-knowledge.js";
import type { HrPolicyPassage, HrPolicyRetriever } from "../hr-policy.js";

const BASE_URL = "https://api.example/";
const TOKEN = "knowledge-service-token";
const TENANT = "acme-hr";

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: unknown;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function passage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceId: "hr_policy/leave-and-time-off.md",
    span: "0-180",
    title: "Leave and Time Off",
    text: "Annual leave accrues at 25 days per calendar year.",
    score: 0.0164,
    stale: false,
    ...overrides,
  };
}

/** Recorded-fixture knowledge API: pins the wire contract without a network. */
class FakeKnowledgeApi {
  readonly requests: RecordedRequest[] = [];
  private scripted: Response | Error | null = null;

  respondWith(response: Response): void {
    this.scripted = response;
  }

  failWith(error: Error): void {
    this.scripted = error;
  }

  readonly fetch: HrKnowledgeFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    this.requests.push({
      method: init?.method ?? "GET",
      url,
      authorization: headers.get("Authorization") ?? "",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const scripted = this.scripted;
    if (scripted instanceof Error) {
      throw scripted;
    }
    if (scripted === null) {
      throw new Error("FakeKnowledgeApi: no scripted response");
    }
    return scripted;
  };
}

/** The on-disk corpus double, recording that an outage fell back to it. */
class RecordingFallback implements HrPolicyRetriever {
  readonly calls: { query: string; k: number }[] = [];

  async retrieve(query: string, k: number): Promise<readonly HrPolicyPassage[]> {
    this.calls.push({ query, k });
    return [
      {
        sourceId: "hr_policy/benefits-and-pay.md",
        span: "0-64",
        title: "Benefits and Pay",
        text: "The stipend is paid monthly.",
        score: 1,
        stale: false,
      },
    ];
  }
}

function retriever(
  api: FakeKnowledgeApi,
  options: { fallback?: HrPolicyRetriever; tenantId?: string; domain?: string } = {},
) {
  return new HttpHrPolicyRetriever({
    baseUrl: BASE_URL,
    serviceToken: TOKEN,
    tenantId: options.tenantId ?? TENANT,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    fetch: api.fetch,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
  });
}

describe("HR knowledge retriever", () => {
  it("searches the tenant's hr:policy partition and keeps the citations", async () => {
    const api = new FakeKnowledgeApi();
    api.respondWith(
      jsonResponse(200, { passages: [passage()], embeddingModel: "embed-v4.0", rerankModel: null }),
    );
    const found = await retriever(api).retrieve("how much annual leave", 5);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sourceId: "hr_policy/leave-and-time-off.md",
      span: "0-180",
      title: "Leave and Time Off",
      score: 0.0164,
      stale: false,
    });
    expect(api.requests).toEqual([
      {
        method: "POST",
        url: "https://api.example/knowledge/search",
        authorization: `Bearer ${TOKEN}`,
        body: { tenantId: TENANT, domain: "hr:policy", query: "how much annual leave", k: 5 },
      },
    ]);
  });

  it("never asks the store for more passages than the lane can hold", async () => {
    const api = new FakeKnowledgeApi();
    api.respondWith(jsonResponse(200, { passages: [] }));
    await retriever(api).retrieve("parental leave", 50);
    expect((api.requests[0]?.body as { k: number }).k).toBe(8);
  });

  it("honours an empty corpus as an empty retrieval instead of falling back", async () => {
    const api = new FakeKnowledgeApi();
    api.respondWith(jsonResponse(200, { passages: [] }));
    const fallback = new RecordingFallback();
    const found = await retriever(api, { fallback }).retrieve("garden leave", 5);
    expect(found).toEqual([]);
    expect(fallback.calls).toEqual([]);
  });

  it("falls back to the on-disk corpus when the service is down", async () => {
    const api = new FakeKnowledgeApi();
    api.failWith(new Error("connect ECONNREFUSED"));
    const fallback = new RecordingFallback();
    const found = await retriever(api, { fallback }).retrieve("home office stipend", 5);
    expect(found[0]?.sourceId).toBe("hr_policy/benefits-and-pay.md");
    expect(fallback.calls).toEqual([{ query: "home office stipend", k: 5 }]);
  });

  it("falls back when the service answers with a rejected status", async () => {
    const api = new FakeKnowledgeApi();
    api.respondWith(jsonResponse(503, { detail: "embeddings unavailable" }));
    const fallback = new RecordingFallback();
    const found = await retriever(api, { fallback }).retrieve("sick note", 4);
    expect(found).toHaveLength(1);
    expect(fallback.calls).toEqual([{ query: "sick note", k: 4 }]);
  });

  it("treats a passage outside the contract as no grounding", async () => {
    const api = new FakeKnowledgeApi();
    api.respondWith(jsonResponse(200, { passages: [passage({ span: "not-a-span" })] }));
    const fallback = new RecordingFallback();
    const found = await retriever(api, { fallback }).retrieve("annual leave", 5);
    expect(found[0]?.sourceId).toBe("hr_policy/benefits-and-pay.md");
  });

  it("reports an empty retrieval when an outage has no fallback to offer", async () => {
    const api = new FakeKnowledgeApi();
    api.failWith(new Error("socket hang up"));
    const found = await retriever(api).retrieve("annual leave", 5);
    expect(found).toEqual([]);
  });

  it("refuses to guess a tenant or a service credential", () => {
    const api = new FakeKnowledgeApi();
    expect(
      () => new HttpHrPolicyRetriever({ baseUrl: BASE_URL, serviceToken: TOKEN, tenantId: " " }),
    ).toThrow(/tenantId/);
    expect(
      () => new HttpHrPolicyRetriever({ baseUrl: "", serviceToken: TOKEN, tenantId: TENANT }),
    ).toThrow(/baseUrl/);
    expect(
      () => new HttpHrPolicyRetriever({ baseUrl: BASE_URL, serviceToken: "", tenantId: TENANT }),
    ).toThrow(/serviceToken/);
    expect(api.requests).toEqual([]);
  });
});
