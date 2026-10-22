import { PgVector } from "@mastra/pg";

import {
  loadPolicyChunks,
  type HrPolicyPassage,
  type HrPolicyRetriever,
} from "../agents/hr-help/tools/hr-policy.js";

/**
 * Mastra-native RAG pilot (plan Phase 4). Registers a `PgVector` store on the
 * instance `vectors` key and offers an HR-help retriever that answers from a
 * Mastra-owned pgvector index in a DEDICATED table namespace
 * (`hr_policy_pilot_*`), never the Python-owned `kb_chunks`. Chunking and
 * staleness come from the same fixture loader the lexical retriever uses, so
 * the pilot cannot drift from the corpus semantics. Embeddings read the same
 * OpenAI-compatible environment block the Python service pins
 * (`EMBEDDING_*` falling back to `MODEL_*`), so pilot vectors are comparable
 * with production ones. Every failure falls back to the baseline retriever;
 * the lane never goes dark because the pilot did.
 */

const DEFAULT_INDEX_NAME = "hr_policy_pilot";
const EMBED_BATCH = 32;

let vectorStore: PgVector | undefined;
let vectorStoreUrl = "";

/**
 * Memoized by connection string, so the instance `vectors` key and the
 * pilot retriever share one PgVector (one pool) per database. `undefined`
 * without `DATABASE_URL` keeps credential-free runs off the vector path.
 */
export function knowledgeVectorStore(): PgVector | undefined {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") return undefined;
  if (vectorStore !== undefined && vectorStoreUrl === connectionString) return vectorStore;
  const sslOverride = process.env.MASTRA_PG_SSL;
  let ssl: boolean | { rejectUnauthorized: boolean } = true;
  if (sslOverride === "false") ssl = false;
  else if (sslOverride !== "true") {
    const host = new URL(connectionString).hostname;
    ssl = host !== "localhost" && host !== "127.0.0.1";
  }
  vectorStore = new PgVector({ id: "knowledge-vectors", connectionString, ssl });
  vectorStoreUrl = connectionString;
  return vectorStore;
}

export interface EmbeddingSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
}

/**
 * Reads the pinned embedding block (mirrors apps/api settings.py): the
 * `EMBEDDING_*` override wins, `MODEL_*` is the standing fallback. Returns
 * `undefined` when no API key exists, which keeps the pilot off.
 */
export function readEmbeddingSettings(): EmbeddingSettings | undefined {
  const apiKey = (process.env.EMBEDDING_API_KEY ?? process.env.MODEL_API_KEY ?? "").trim();
  const model = (process.env.EMBEDDING_MODEL ?? process.env.MODEL_NAME ?? "").trim();
  if (apiKey === "" || model === "") return undefined;
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? "1536");
  return {
    baseUrl: (
      process.env.EMBEDDING_BASE_URL ??
      process.env.MODEL_BASE_URL ??
      "https://api.openai.com/v1"
    ).replace(/\/$/, ""),
    apiKey,
    model,
    dimensions: Number.isInteger(dimensions) && dimensions > 0 ? dimensions : 1536,
  };
}

/**
 * HR-help `HrPolicyRetriever` over the Mastra-owned pilot index. First use
 * creates the index and seeds it from the fixture corpus; later uses go
 * straight to cosine top-k. Any pilot failure degrades to the injected
 * baseline retriever (the Python hybrid or the on-disk lexical one).
 */
export class MastraRagHrPolicyRetriever implements HrPolicyRetriever {
  private readonly indexName: string;
  private readonly directory: string | undefined;
  private ready: Promise<void> | undefined;
  private warned = false;

  constructor(
    private readonly deps: {
      store: PgVector;
      embedding: EmbeddingSettings;
      fallback: HrPolicyRetriever;
      indexName?: string;
      directory?: string;
    },
  ) {
    this.indexName = deps.indexName ?? DEFAULT_INDEX_NAME;
    this.directory = deps.directory;
  }

  private async embed(texts: readonly string[]): Promise<number[][]> {
    const response = await fetch(`${this.deps.embedding.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.deps.embedding.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.deps.embedding.model,
        input: texts,
        dimensions: this.deps.embedding.dimensions,
      }),
    });
    if (!response.ok) {
      throw new Error(`embedding provider returned ${response.status}`);
    }
    const payload = (await response.json()) as { data?: { embedding?: unknown }[] };
    const vectors = (payload.data ?? []).map((row) => row.embedding);
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector))) {
      throw new Error("embedding provider response malformed");
    }
    return vectors as number[][];
  }

  private async build(): Promise<void> {
    const { store, embedding } = this.deps;
    if ((await store.listIndexes()).includes(this.indexName)) return;
    await store.createIndex({ indexName: this.indexName, dimension: embedding.dimensions, metric: "cosine" });
    const chunks = loadPolicyChunks(this.directory);
    for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
      const batch = chunks.slice(offset, offset + EMBED_BATCH);
      const vectors = await this.embed(batch.map((chunk) => chunk.text));
      await store.upsert({
        indexName: this.indexName,
        ids: batch.map((chunk, index) => `${chunk.sourceId}:${chunk.span}:${index}`),
        vectors,
        metadata: batch.map((chunk) => ({ ...chunk })),
      });
    }
  }

  async retrieve(query: string, k: number): Promise<readonly HrPolicyPassage[]> {
    try {
      this.ready ??= this.build();
      await this.ready;
      const [queryVector] = await this.embed([query]);
      if (queryVector === undefined) throw new Error("no query embedding returned");
      const results = await this.deps.store.query({
        indexName: this.indexName,
        queryVector,
        topK: k,
      });
      return results.map((result) => {
        const meta = (result.metadata ?? {}) as Record<string, unknown>;
        return {
          sourceId: String(meta.sourceId ?? this.indexName),
          span: String(meta.span ?? ""),
          title: String(meta.title ?? ""),
          text: String(meta.text ?? ""),
          score: result.score,
          stale: meta.stale === true,
        };
      });
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `[mastra] RAG pilot retrieval failed, falling back to the baseline retriever: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return this.deps.fallback.retrieve(query, k);
    }
  }
}
