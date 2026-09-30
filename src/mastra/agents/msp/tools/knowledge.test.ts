import { describe, expect, it } from "vitest";

import { HttpMspKnowledge, type KnowledgeFetch } from "./knowledge.js";

const BASE_URL = "https://api.example/";
const TOKEN = "knowledge-service-token";

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
    sourceId: "runbook-vpn",
    span: "0-44",
    title: "VPN runbook",
    text: "Reset the VPN client before the next shift.",
    score: 0.91,
    stale: false,
    ...overrides,
  };
}

/**
 * Recorded-fixture knowledge API: answers the exact response shape the route
 * speaks and records every request, so the wire contract (path, bearer, body)
 * is pinned without a network. Failures script the degradation paths.
 */
class FakeKnowledgeApi {
  readonly requests: RecordedRequest[] = [];
  private scripted: Response | Error | null = null;

  respondWith(response: Response): void {
    this.scripted = response;
  }

  failWith(error: Error): void {
    this.scripted = error;
  }

  readonly fetch: KnowledgeFetch = async (input, init) => {
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

function adapter(api: FakeKnowledgeApi): HttpMspKnowledge {
  return new HttpMspKnowledge({ baseUrl: BASE_URL, serviceToken: TOKEN, fetch: api.fetch });
}

describe("HttpMspKnowledge", () => {
  it("forwards the tenant partition, the query and the limit with the service bearer", async () => {
    const api = new FakeKnowledgeApi();
    api.respondWith(
      jsonResponse(200, {
        passages: [passage()],
        embeddingModel: "text-embedding-test",
        rerankModel: null,
        rerankDegraded: false,
      }),
    );

    const found = await adapter(api).search({ tenantId: "mspco", clientRef: "acme" }, "vpn drops", 5);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sourceId: "runbook-vpn", span: "0-44", title: "VPN runbook" });
    expect(api.requests).toEqual([
      {
        method: "POST",
        url: "https://api.example/knowledge/search",
        authorization: `Bearer ${TOKEN}`,
        body: { tenantId: "mspco", domain: "msp:acme", query: "vpn drops", k: 5 },
      },
    ]);
  });

  it("returns no passages without calling the API when the run carries no tenant", async () => {
    const api = new FakeKnowledgeApi();

    const found = await adapter(api).search({ tenantId: null, clientRef: "acme" }, "vpn drops", 5);

    expect(found).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it("degrades to no passages on transport and HTTP failures", async () => {
    const failures: Array<Response | Error> = [
      jsonResponse(401, { detail: "Invalid credentials" }),
      jsonResponse(500, { detail: "boom" }),
      new Error("socket hang up"),
    ];
    for (const failure of failures) {
      const api = new FakeKnowledgeApi();
      if (failure instanceof Error) {
        api.failWith(failure);
      } else {
        api.respondWith(failure);
      }
      const found = await adapter(api).search({ tenantId: "mspco", clientRef: "acme" }, "q", 5);
      expect(found, `failure: ${String(failure)}`).toEqual([]);
    }
  });

  it("degrades to no passages on an unparsable body", async () => {
    const api = new FakeKnowledgeApi();
    api.respondWith(new Response("not json", { status: 200 }));

    const found = await adapter(api).search({ tenantId: "mspco", clientRef: "acme" }, "q", 5);

    expect(found).toEqual([]);
  });

  it("treats one out-of-contract passage as no grounding at all", async () => {
    const api = new FakeKnowledgeApi();
    api.respondWith(
      jsonResponse(200, {
        passages: [passage(), passage({ score: 1.5 })],
        embeddingModel: "text-embedding-test",
        rerankModel: null,
        rerankDegraded: false,
      }),
    );

    const found = await adapter(api).search({ tenantId: "mspco", clientRef: "acme" }, "q", 5);

    expect(found).toEqual([]);
  });

  it("requires a base URL and a service token", () => {
    expect(() => new HttpMspKnowledge({ baseUrl: "/", serviceToken: TOKEN })).toThrow(/baseUrl/);
    expect(() => new HttpMspKnowledge({ baseUrl: BASE_URL, serviceToken: "" })).toThrow(
      /serviceToken/,
    );
  });
});
