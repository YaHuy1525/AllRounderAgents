import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { RelevanceScoreProvider } from "@mastra/core/relevance";
import type { PgVector } from "@mastra/pg";

import {
  ingestMarkdownCorpus,
  knowledgeReranker,
  openAiCompatibleEmbedder,
  MastraRagHrPolicyRetriever,
  type EmbeddingSettings,
} from "../rag.js";
import { fixtureFile } from "../fixtures.js";

/**
 * The Mastra-native ingest tests run without a database or an embedding
 * provider: a recording fake store and an injected fetch stand in for both,
 * while the corpus itself is the real company handbook.
 */

const embedding: EmbeddingSettings = {
  baseUrl: "https://embed.test/v1",
  apiKey: "test-key",
  model: "test-embed-v4",
  dimensions: 3,
};

const NOW = () => new Date("2026-10-14T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

/** OpenAI-shaped `/embeddings` stub: deterministic 3-d vectors, no network. */
function stubEmbedFetch() {
  const inputs: string[][] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    inputs.push(body.input);
    const data = body.input.map((text) => {
      const seed = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      return { embedding: [seed % 97, seed % 89, seed % 83] };
    });
    return { ok: true, json: async () => ({ data }) } as Response;
  }) satisfies typeof fetch;
  return { fetch: fetchImpl, inputs };
}

interface UpsertCall {
  indexName: string;
  ids: string[];
  vectors: number[][];
  metadata: Record<string, unknown>[];
}

function fakeStore(existingIndexes: string[] = []) {
  const indexes = new Set(existingIndexes);
  const created: { indexName: string; dimension: number; metric: string }[] = [];
  const deleted: { indexName: string; filter: Record<string, unknown> }[] = [];
  const upserted: UpsertCall[] = [];
  const store = {
    listIndexes: async () => [...indexes],
    createIndex: async (params: { indexName: string; dimension: number; metric: string }) => {
      created.push(params);
      indexes.add(params.indexName);
    },
    deleteVectors: async (params: { indexName: string; filter: Record<string, unknown> }) => {
      deleted.push(params);
    },
    upsert: async (params: UpsertCall) => {
      upserted.push(params);
      return params.ids;
    },
  } as unknown as PgVector;
  return { store, created, deleted, upserted };
}

const corpusDirectory = fixtureFile("company/hr_policy");

describe("ingestMarkdownCorpus", () => {
  it("seeds every handbook file with deterministic ids and governance metadata", async () => {
    const { store, created, deleted, upserted } = fakeStore();
    const stub = stubEmbedFetch();
    const summary = await ingestMarkdownCorpus({
      store,
      embedding,
      indexName: "hr_policy",
      directory: corpusDirectory,
      sourcePrefix: "hr_policy",
      tenantId: "omnidewalt",
      domain: "hr:policy",
      now: NOW,
      fetch: stub.fetch,
    });

    const expectedSources = readdirSync(corpusDirectory)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => `hr_policy/${name}`);
    expect(summary.sources).toBe(expectedSources.length);
    expect(summary.chunks).toBeGreaterThan(summary.sources);

    // Cosine index on the pinned dimensions, created once.
    expect(created).toEqual([
      { indexName: "hr_policy", dimension: 3, metric: "cosine" },
    ]);

    const metadata = upserted.flatMap((call) => call.metadata);
    const ids = upserted.flatMap((call) => call.ids);
    expect(metadata.length).toBe(summary.chunks);
    expect(new Set(metadata.map((row) => row.sourceId))).toEqual(new Set(expectedSources));

    for (const row of metadata) {
      // metadata.text is the rerank/query-tool contract; it must be real text.
      expect(String(row.text).length).toBeGreaterThan(0);
      expect(String(row.span)).toMatch(/^chunk-\d+$/);
      expect(String(row.title).length).toBeGreaterThan(0);
      expect(row.tenantId).toBe("omnidewalt");
      expect(row.domain).toBe("hr:policy");
      expect(row.canonical).toBe(true);
      // Ids are derived, so re-seeding the same corpus cannot duplicate rows.
      expect(ids).toContain(`${row.sourceId}:${row.span}`);
      // Headers became metadata, not passage text.
      expect(String(row.text)).not.toMatch(/^Reviewed:/m);
      expect(String(row.text)).not.toMatch(/^# /m);
      // Staleness follows the Reviewed: header, computed at seed time.
      const reviewed = row.reviewed as string | undefined;
      const expectedStale =
        reviewed === undefined || NOW().getTime() - Date.parse(`${reviewed}T00:00:00Z`) > 365 * DAY_MS;
      expect(row.stale).toBe(expectedStale);
    }
    expect(metadata.some((row) => row.stale === true)).toBe(true);
    expect(metadata.some((row) => row.stale === false)).toBe(true);

    // Every source is cleared before re-upsert (idempotent replacement).
    expect(new Set(deleted.map((call) => String(call.filter.sourceId)))).toEqual(
      new Set(expectedSources),
    );
  });

  it("re-running replaces vectors instead of duplicating them", async () => {
    const stub = stubEmbedFetch();
    const first = fakeStore();
    await ingestMarkdownCorpus({
      store: first.store,
      embedding,
      indexName: "hr_policy",
      directory: corpusDirectory,
      sourcePrefix: "hr_policy",
      tenantId: "omnidewalt",
      domain: "hr:policy",
      now: NOW,
      fetch: stub.fetch,
    });
    const second = fakeStore(["hr_policy"]);
    await ingestMarkdownCorpus({
      store: second.store,
      embedding,
      indexName: "hr_policy",
      directory: corpusDirectory,
      sourcePrefix: "hr_policy",
      tenantId: "omnidewalt",
      domain: "hr:policy",
      now: NOW,
      fetch: stub.fetch,
    });
    expect(second.created).toEqual([]); // index already exists
    const firstIds = first.upserted.flatMap((call) => call.ids).sort();
    const secondIds = second.upserted.flatMap((call) => call.ids).sort();
    expect(secondIds).toEqual(firstIds);
    expect(second.deleted.length).toBe(first.deleted.length);
  });
});

describe("openAiCompatibleEmbedder", () => {
  it("wraps the pinned fetch embedder as an AI SDK V2 model", async () => {
    const stub = stubEmbedFetch();
    const model = openAiCompatibleEmbedder(embedding, stub.fetch);
    const result = await model.doEmbed({ values: ["alpha", "beta"] });
    expect(result.embeddings.length).toBe(2);
    expect(stub.inputs).toEqual([["alpha", "beta"]]);
  });
});

describe("MastraRagHrPolicyRetriever", () => {
  it("maps query results to passages through the MDocument chunk metadata", async () => {
    const stub = stubEmbedFetch();
    const { store, created } = fakeStore();
    const queryResults = [
      {
        score: 0.82,
        metadata: {
          text: "Remote work is approved by the team lead.",
          sourceId: "hr_policy/remote-work.md",
          span: "chunk-1",
          title: "Remote Work Policy",
          stale: false,
        },
      },
    ];
    (store as unknown as { query: (p: unknown) => Promise<unknown> }).query = async () =>
      queryResults;
    const retriever = new MastraRagHrPolicyRetriever({
      store,
      embedding,
      fallback: { retrieve: async () => [] },
      now: NOW,
      fetch: stub.fetch,
    });
    const passages = await retriever.retrieve("can I work remotely", 3);
    expect(created.length).toBe(1); // the index was seeded on first use
    expect(passages).toEqual([
      {
        sourceId: "hr_policy/remote-work.md",
        span: "chunk-1",
        title: "Remote Work Policy",
        text: "Remote work is approved by the team lead.",
        score: 0.82,
        stale: false,
      },
    ]);
  });

  it("over-fetches for the reranker and reorders the retrieved results (P4)", async () => {
    const stub = stubEmbedFetch();
    const { store } = fakeStore();
    const queryCalls: { topK: number }[] = [];
    const rows = [
      {
        score: 0.9,
        metadata: {
          text: "Sick leave needs a manager note after three days.",
          sourceId: "hr_policy/leave-and-time-off.md",
          span: "chunk-0",
          title: "Leave Policy",
          stale: false,
        },
      },
      {
        score: 0.85,
        metadata: {
          text: "Parental leave is sixteen weeks at full pay.",
          sourceId: "hr_policy/benefits-and-pay.md",
          span: "chunk-2",
          title: "Benefits",
          stale: false,
        },
      },
    ];
    (store as unknown as { query: (p: unknown) => Promise<unknown> }).query = async (params) => {
      queryCalls.push(params as { topK: number });
      return rows;
    };
    // Strongly prefers the parental-leave text; the weighted blend makes it
    // overtake the higher-cosine row, proving rerank happens on the results.
    const scorer: RelevanceScoreProvider = {
      getRelevanceScore: async (_query, text) => (text.includes("Parental") ? 1 : 0),
    };
    const retriever = new MastraRagHrPolicyRetriever({
      store,
      embedding,
      fallback: { retrieve: async () => [] },
      reranker: scorer,
      now: NOW,
      fetch: stub.fetch,
    });
    const passages = await retriever.retrieve("parental leave pay", 1);
    expect(queryCalls[0]?.topK).toBe(2); // k * 2 candidates for the reranker
    expect(passages.length).toBe(1);
    expect(passages[0]?.sourceId).toBe("hr_policy/benefits-and-pay.md");
    expect(passages[0]?.span).toBe("chunk-2");
  });

  it("keeps the cosine order when the reranker fails", async () => {
    const stub = stubEmbedFetch();
    const { store } = fakeStore();
    const rows = [
      { score: 0.9, metadata: { text: "first", sourceId: "a.md", span: "chunk-0" } },
      { score: 0.8, metadata: { text: "second", sourceId: "b.md", span: "chunk-0" } },
    ];
    (store as unknown as { query: (p: unknown) => Promise<unknown> }).query = async () => rows;
    const scorer: RelevanceScoreProvider = {
      getRelevanceScore: async () => {
        throw new Error("reranker down");
      },
    };
    const retriever = new MastraRagHrPolicyRetriever({
      store,
      embedding,
      fallback: { retrieve: async () => [] },
      reranker: scorer,
      now: NOW,
      fetch: stub.fetch,
    });
    const passages = await retriever.retrieve("anything", 2);
    expect(passages.map((passage) => passage.sourceId)).toEqual(["a.md", "b.md"]);
  });

  it("degrades to the baseline retriever when the vector path fails", async () => {
    const baseline = [
      {
        sourceId: "hr_policy/leave-and-time-off.md",
        span: "12-88",
        title: "Leave Policy",
        text: "Sixteen weeks of parental leave.",
        score: 1,
        stale: false,
      },
    ];
    const failing = {
      listIndexes: async () => {
        throw new Error("database unreachable");
      },
    } as unknown as PgVector;
    const retriever = new MastraRagHrPolicyRetriever({
      store: failing,
      embedding,
      fallback: { retrieve: async () => baseline },
      directory: corpusDirectory,
      now: NOW,
      fetch: stubEmbedFetch().fetch,
    });
    await expect(retriever.retrieve("parental leave", 3)).resolves.toEqual(baseline);
  });
});

describe("knowledgeReranker", () => {
  it("stays off without COHERE_API_KEY and reads the pinned model with it", () => {
    const savedKey = process.env.COHERE_API_KEY;
    const savedModel = process.env.RETRIEVAL_RERANK_MODEL;
    try {
      delete process.env.COHERE_API_KEY;
      expect(knowledgeReranker()).toBeUndefined();
      process.env.COHERE_API_KEY = "test-cohere-key";
      delete process.env.RETRIEVAL_RERANK_MODEL;
      // `model` is private on the scorer, so read it through a structural view.
      const pinned = knowledgeReranker() as unknown as { model: string } | undefined;
      expect(pinned?.model).toBe("rerank-v3.5");
      process.env.RETRIEVAL_RERANK_MODEL = "rerank-custom";
      const custom = knowledgeReranker() as unknown as { model: string } | undefined;
      expect(custom?.model).toBe("rerank-custom");
    } finally {
      if (savedKey === undefined) delete process.env.COHERE_API_KEY;
      else process.env.COHERE_API_KEY = savedKey;
      if (savedModel === undefined) delete process.env.RETRIEVAL_RERANK_MODEL;
      else process.env.RETRIEVAL_RERANK_MODEL = savedModel;
    }
  });
});
