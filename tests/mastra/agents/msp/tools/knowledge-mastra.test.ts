import { describe, expect, it } from "vitest";
import type { RelevanceScoreProvider } from "@mastra/core/relevance";
import type { PgVector } from "@mastra/pg";

import type { EmbeddingSettings } from "../../../../../src/mastra/shared/rag.js";
import { MastraFirstMspKnowledge } from "../../../../../src/mastra/agents/msp/tools/knowledge-mastra.js";
import type { MspPassage } from "../../../../../src/mastra/agents/msp/contracts.js";
import type { MspKnowledge, MspKnowledgeScope } from "../../../../../src/mastra/agents/msp/flow.js";

/**
 * The Mastra-first msp seam runs without a database or provider: a fake
 * store stands in for pgvector, an injected fetch stubs embeddings, and a
 * recording fake plays the platform hybrid fallback. The reranker is always
 * injected here, so COHERE_API_KEY never needs to be set for these tests.
 */

const embedding: EmbeddingSettings = {
  baseUrl: "https://embed.test/v1",
  apiKey: "test-key",
  model: "test-embed-v4",
  dimensions: 3,
};

function stubEmbedFetch() {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    const data = body.input.map((text) => {
      const seed = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      return { embedding: [seed % 97, seed % 89, seed % 83] };
    });
    return { ok: true, json: async () => ({ data }) } as Response;
  }) satisfies typeof fetch;
  return { fetch: fetchImpl };
}

function passageRow(sourceId: string, text: string, score: number, stale = false) {
  return {
    score,
    metadata: {
      text,
      sourceId,
      span: "chunk-0",
      title: `Runbook ${sourceId}`,
      stale,
    },
  };
}

interface QueryCall {
  indexName: string;
  queryVector: number[];
  topK: number;
  filter?: Record<string, unknown>;
}

function fakeStore(rows: unknown[], existingIndexes: string[] = ["msp_runbooks"]) {
  const queries: QueryCall[] = [];
  let listCalls = 0;
  const store = {
    listIndexes: async () => {
      listCalls += 1;
      return existingIndexes;
    },
    query: async (params: QueryCall) => {
      queries.push(params);
      return rows;
    },
  } as unknown as PgVector;
  return { store, queries, listIndexes: () => listCalls };
}

class RecordingFallback implements MspKnowledge {
  readonly calls: { scope: MspKnowledgeScope; query: string; limit: number }[] = [];
  readonly passages: readonly MspPassage[];
  constructor(passages: readonly MspPassage[] = []) {
    this.passages = passages;
  }
  async search(scope: MspKnowledgeScope, query: string, limit: number) {
    this.calls.push({ scope, query, limit });
    return this.passages;
  }
}

const fallbackPassage: MspPassage = {
  sourceId: "kb/vpn.md",
  span: "120-360",
  title: "VPN troubleshooting",
  text: "Hybrid fallback passage.",
  score: 0.9,
  stale: false,
};

const scope: MspKnowledgeScope = { tenantId: "acme-tenant", clientRef: "globex" };

describe("MastraFirstMspKnowledge", () => {
  it("answers from the Mastra index with the client's partition pinned", async () => {
    const { store, queries } = fakeStore([passageRow("msp_runbooks/globex/vpn.md", "Restart the VPN gateway.", 0.71)]);
    const fallback = new RecordingFallback([fallbackPassage]);
    const lane = new MastraFirstMspKnowledge({
      store,
      embedding,
      fallback,
      fetch: stubEmbedFetch().fetch,
    });
    const passages = await lane.search(scope, "vpn keeps dropping", 5);
    expect(queries.length).toBe(1);
    expect(queries[0]?.indexName).toBe("msp_runbooks");
    expect(queries[0]?.topK).toBe(5);
    expect(queries[0]?.filter).toEqual({ tenantId: "acme-tenant", domain: "msp:globex" });
    expect(passages).toEqual([
      {
        sourceId: "msp_runbooks/globex/vpn.md",
        span: "chunk-0",
        title: "Runbook msp_runbooks/globex/vpn.md",
        text: "Restart the VPN gateway.",
        score: 0.71,
        stale: false,
      },
    ]);
    expect(fallback.calls).toEqual([]);
  });

  it("delegates forever without probing again once the index is missing", async () => {
    const { store, queries, listIndexes } = fakeStore([], ["hr_policy"]);
    const fallback = new RecordingFallback([fallbackPassage]);
    const lane = new MastraFirstMspKnowledge({
      store,
      embedding,
      fallback,
      fetch: stubEmbedFetch().fetch,
    });
    await expect(lane.search(scope, "vpn", 5)).resolves.toEqual([fallbackPassage]);
    await expect(lane.search(scope, "vpn again", 5)).resolves.toEqual([fallbackPassage]);
    expect(listIndexes()).toBe(1); // existence answer is memoized
    expect(queries).toEqual([]);
    expect(fallback.calls.length).toBe(2);
  });

  it("delegates when the client partition holds no chunks", async () => {
    const { store } = fakeStore([]);
    const fallback = new RecordingFallback([fallbackPassage]);
    const lane = new MastraFirstMspKnowledge({
      store,
      embedding,
      fallback,
      fetch: stubEmbedFetch().fetch,
    });
    await expect(lane.search(scope, "unknown client", 5)).resolves.toEqual([fallbackPassage]);
    expect(fallback.calls.length).toBe(1);
  });

  it("drops off-contract rows instead of trusting them", async () => {
    const { store } = fakeStore([
      { score: 0.5, metadata: { text: "", sourceId: "msp_runbooks/a.md", span: "chunk-0" } },
      passageRow("msp_runbooks/b.md", "Good row.", 0.6),
    ]);
    const lane = new MastraFirstMspKnowledge({
      store,
      embedding,
      fetch: stubEmbedFetch().fetch,
    });
    const passages = await lane.search(scope, "anything", 5);
    expect(passages.map((passage) => passage.sourceId)).toEqual(["msp_runbooks/b.md"]);
  });

  it("skips the vector arm entirely when the run carries no tenant", async () => {
    const { store, queries } = fakeStore([passageRow("msp_runbooks/x.md", "text", 0.5)]);
    const fallback = new RecordingFallback([fallbackPassage]);
    const lane = new MastraFirstMspKnowledge({
      store,
      embedding,
      fallback,
      fetch: stubEmbedFetch().fetch,
    });
    await expect(lane.search({ tenantId: null, clientRef: "globex" }, "vpn", 5))
      .resolves.toEqual([fallbackPassage]);
    expect(queries).toEqual([]);
  });

  it("delegates when the query path throws and keeps working next time", async () => {
    const failing = {
      listIndexes: async () => ["msp_runbooks"],
      query: async () => {
        throw new Error("database unreachable");
      },
    } as unknown as PgVector;
    const fallback = new RecordingFallback([fallbackPassage]);
    const lane = new MastraFirstMspKnowledge({
      store: failing,
      embedding,
      fallback,
      fetch: stubEmbedFetch().fetch,
    });
    await expect(lane.search(scope, "vpn", 5)).resolves.toEqual([fallbackPassage]);
    await expect(lane.search(scope, "vpn", 5)).resolves.toEqual([fallbackPassage]);
    expect(fallback.calls.length).toBe(2);
  });

  it("answers empty when there is no fallback to delegate to", async () => {
    const { store } = fakeStore([], ["hr_policy"]);
    const lane = new MastraFirstMspKnowledge({
      store,
      embedding,
      fetch: stubEmbedFetch().fetch,
    });
    await expect(lane.search(scope, "vpn", 5)).resolves.toEqual([]);
  });

  it("over-fetches and reranks the retrieved results down to the limit", async () => {
    const { store, queries } = fakeStore([
      passageRow("msp_runbooks/vpn.md", "gateway session limit note", 0.62),
      passageRow("msp_runbooks/dns.md", "renew the DNS lease and flush", 0.60),
      passageRow("msp_runbooks/battery.md", "battery saver settings", 0.55),
      passageRow("msp_runbooks/wifi.md", "wifi adapter power saving", 0.51),
    ]);
    // Strongly prefers the vpn row's text; the weighted blend (0.4 semantic)
    // with close vector scores makes it win despite lower position.
    const scorer: RelevanceScoreProvider = {
      getRelevanceScore: async (_query, text) => (text.includes("session limit") ? 1 : 0),
    };
    const lane = new MastraFirstMspKnowledge({
      store,
      embedding,
      reranker: scorer,
      fetch: stubEmbedFetch().fetch,
    });
    const passages = await lane.search(scope, "vpn drops after sleep", 2);
    expect(queries[0]?.topK).toBe(4); // limit * 2 candidates
    expect(passages.length).toBe(2);
    expect(passages[0]?.sourceId).toBe("msp_runbooks/vpn.md");
  });

  it("keeps the vector order when the reranker fails", async () => {
    const { store } = fakeStore([
      passageRow("msp_runbooks/vpn.md", "first row", 0.7),
      passageRow("msp_runbooks/dns.md", "second row", 0.6),
    ]);
    const scorer: RelevanceScoreProvider = {
      getRelevanceScore: async () => {
        throw new Error("cohere down");
      },
    };
    const lane = new MastraFirstMspKnowledge({
      store,
      embedding,
      reranker: scorer,
      fetch: stubEmbedFetch().fetch,
    });
    const passages = await lane.search(scope, "vpn", 5);
    expect(passages.map((passage) => passage.sourceId)).toEqual([
      "msp_runbooks/vpn.md",
      "msp_runbooks/dns.md",
    ]);
  });
});
