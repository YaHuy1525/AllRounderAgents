import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { MastraEmbeddingModel, QueryResult } from "@mastra/core/vector";
import type { RelevanceScoreProvider } from "@mastra/core/relevance";
import { CohereRelevanceScorer, MDocument, rerankWithScorer } from "@mastra/rag";
import { PgVector } from "@mastra/pg";

import type {
  HrPolicyPassage,
  HrPolicyRetriever,
} from "../agents/hr-help/tools/hr-policy.js";
import { fixtureFile } from "./fixtures.js";

/**
 * Mastra-native knowledge plane. One PgVector store on the instance `vectors`
 * key, one ingest path, one embedder. Seeding follows the Mastra RAG
 * tutorial: `MDocument.fromMarkdown(...).chunk({ strategy: "recursive" })`
 * at natural boundaries (512 chars, 50 overlap), chunk text kept at
 * `metadata.text` so retrieval results can be reranked, deterministic ids,
 * and governance fields (`title`, `reviewed`, `staleAfter`, `stale`,
 * `tenantId`, `domain`, `canonical`) parsed at ingest into metadata.
 * Idempotency: each source's vectors are deleted by `sourceId` filter before
 * re-upsert, so re-seeding replaces rather than duplicates.
 *
 * Consequences of the MDocument-for-everything decision: passages are chunk
 * windows, not paragraphs, so citations carry a `chunk-N` span instead of a
 * character range, and the `Reviewed:` header no longer survives inside
 * passage text — it lives in metadata instead.
 *
 * Embeddings read the same OpenAI-compatible environment block the Python
 * service pins (`EMBEDDING_*` falling back to `MODEL_*`), so Mastra vectors
 * stay comparable with production ones. The HR pilot retriever degrades to
 * the injected baseline on any failure; the lane never goes dark because the
 * vector path did.
 */

const DEFAULT_INDEX_NAME = "hr_policy";
const EMBED_BATCH = 32;
/** Mastra tutorial settings: natural-boundary recursive chunks. */
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 50;
/** Same freshness rule the lexical fallback applies to `Reviewed:` dates. */
const STALE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1_000;

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
  // Same rule as the primary store (mastra.ts postgresSsl): managed hosts get
  // TLS without CA pinning — Supabase's pooler chain fails Node's strict
  // verification — and localhost stays plaintext unless overridden.
  let ssl: boolean | { rejectUnauthorized: boolean } = { rejectUnauthorized: false };
  if (sslOverride === "false") ssl = false;
  else if (sslOverride !== "true") {
    const host = new URL(connectionString).hostname;
    if (host === "localhost" || host === "127.0.0.1") ssl = false;
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

/** Batched OpenAI-compatible `/embeddings` call, shared by every vector path. */
async function embedTexts(
  embedding: EmbeddingSettings,
  texts: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH) {
    const batch = texts.slice(offset, offset + EMBED_BATCH);
    const response = await fetchImpl(`${embedding.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${embedding.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: embedding.model,
        input: batch,
        dimensions: embedding.dimensions,
      }),
    });
    if (!response.ok) {
      throw new Error(`embedding provider returned ${response.status}`);
    }
    const payload = (await response.json()) as { data?: { embedding?: unknown }[] };
    const batchVectors = (payload.data ?? []).map((row) => row.embedding);
    if (
      batchVectors.length !== batch.length ||
      batchVectors.some((vector) => !Array.isArray(vector))
    ) {
      throw new Error("embedding provider response malformed");
    }
    vectors.push(...(batchVectors as number[][]));
  }
  return vectors;
}

/**
 * Optional hosted cross-encoder for the Mastra plane (upgrade plan P4),
 * mirroring the Python hybrid stage: the same `COHERE_API_KEY` plus
 * `RETRIEVAL_RERANK_MODEL` (default `rerank-v3.5`). `undefined` without a
 * key keeps every vector path on pure cosine order, so reranking is always
 * an enrichment, never a requirement. The scorer is cheap to construct and
 * reads the key per call, so no memoization is needed.
 */
export function knowledgeReranker(): CohereRelevanceScorer | undefined {
  const apiKey = (process.env.COHERE_API_KEY ?? "").trim();
  if (apiKey === "") return undefined;
  const model = (process.env.RETRIEVAL_RERANK_MODEL ?? "").trim() || "rerank-v3.5";
  return new CohereRelevanceScorer(model, apiKey);
}

/**
 * Rerank retrieved chunks on their `metadata.text`, degrading to the passed
 * (vector) order when the scorer fails — a configured reranker that is down
 * changes result quality, never availability. Reranked order is cut to `k`.
 */
export async function rerankQueryResults(
  results: readonly QueryResult[],
  query: string,
  scorer: RelevanceScoreProvider,
  k: number,
): Promise<QueryResult[]> {
  if (results.length <= 1) return results.slice(0, k);
  try {
    const reranked = await rerankWithScorer({
      results: [...results],
      query,
      scorer,
      options: { topK: k },
    });
    return reranked.map((entry) => entry.result);
  } catch (error) {
    console.warn(
      "[mastra] knowledge rerank failed, keeping the vector order: "
        + `${error instanceof Error ? error.message : String(error)}`,
    );
    return results.slice(0, k);
  }
}

/**
 * The pinned fetch embedder exposed as an AI SDK V2 embedding model, so
 * `createVectorQueryTool({ model })` and manual seeding share one client and
 * no provider SDK is added to the dependency tree.
 */
export function openAiCompatibleEmbedder(
  embedding: EmbeddingSettings,
  fetchImpl: typeof fetch = fetch,
): MastraEmbeddingModel<string> {
  return {
    specificationVersion: "v2",
    provider: "openai-compatible",
    modelId: embedding.model,
    maxEmbeddingsPerCall: EMBED_BATCH,
    supportsParallelCalls: false,
    doEmbed: async ({ values }: { values: string[] }) => ({
      embeddings: await embedTexts(embedding, values, fetchImpl),
    }),
  };
}

/**
 * Strip the document-level header lines the corpus convention puts at the
 * top (`# Title`, `Reviewed: YYYY-MM-DD`); they become metadata, not passage
 * text. Section headings (`##` and deeper) stay — they are retrieval context.
 */
function stripDocHeaders(raw: string): string {
  return raw
    .split("\n")
    .filter(
      (line) =>
        !/^#\s/.test(line) && !/^Reviewed:\s*\d{4}-\d{2}-\d{2}\s*$/.test(line),
    )
    .join("\n")
    .trim();
}

interface CorpusGovernance {
  readonly title: string;
  readonly reviewed: string | undefined;
  readonly stale: boolean;
}

/** Title + freshness from the corpus header convention, same rule as the fallback loader. */
function readGovernance(raw: string, fileName: string, now: Date): CorpusGovernance {
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(fileName, ".md");
  const reviewed = raw.match(/^Reviewed:\s*(\d{4}-\d{2}-\d{2})$/m)?.[1];
  const reviewedAt = reviewed === undefined ? NaN : Date.parse(`${reviewed}T00:00:00Z`);
  const stale = !Number.isFinite(reviewedAt) || now.getTime() - reviewedAt > STALE_DAYS * DAY_MS;
  return { title, reviewed, stale };
}

export interface MarkdownCorpusIngestDeps {
  store: PgVector;
  embedding: EmbeddingSettings;
  indexName: string;
  /** Directory of `.md` files to ingest, chunked per the tutorial strategy. */
  directory: string;
  /** Citation prefix for the source id, e.g. `hr_policy` → `hr_policy/<file>.md`. */
  sourcePrefix: string;
  tenantId: string;
  domain: string;
  /** Governance default: this repo's seeded corpora are canonical documents. */
  canonical?: boolean | undefined;
  now?: (() => Date) | undefined;
  fetch?: typeof fetch | undefined;
}

export interface IngestSummary {
  readonly sources: number;
  readonly chunks: number;
}

/**
 * Mastra-owned corpus ingest: MDocument recursive chunking → cosine index →
 * deterministic ids (`<sourceId>:chunk-<n>`) → upsert with `metadata.text`.
 * Idempotent per source: `deleteVectors` by `sourceId` filter before re-
 * upsert, so re-running replaces a document's vectors instead of duplicating
 * them. Creates the index on first run; a re-seed picks up edited files.
 */
export async function ingestMarkdownCorpus(
  deps: MarkdownCorpusIngestDeps,
): Promise<IngestSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const canonical = deps.canonical ?? true;
  if (!(await deps.store.listIndexes()).includes(deps.indexName)) {
    await deps.store.createIndex({
      indexName: deps.indexName,
      dimension: deps.embedding.dimensions,
      metric: "cosine",
    });
  }
  const files = readdirSync(deps.directory)
    .filter((name) => name.endsWith(".md"))
    .sort();
  let sources = 0;
  let chunkCount = 0;
  for (const fileName of files) {
    // Normalize Windows checkouts so the chunker sees stable line breaks.
    const raw = readFileSync(resolve(deps.directory, fileName), "utf8").replace(/\r\n/g, "\n");
    const body = stripDocHeaders(raw);
    if (body === "") continue;
    const sourceId = `${deps.sourcePrefix}/${fileName}`;
    const governance = readGovernance(raw, fileName, now);
    const document = MDocument.fromMarkdown(body, { sourceId });
    const chunkTexts = (
      await document.chunk({
        strategy: "recursive",
        maxSize: CHUNK_SIZE,
        overlap: CHUNK_OVERLAP,
      })
    )
      .map((chunk) => chunk.text.trim())
      .filter((text) => text !== "");
    if (chunkTexts.length === 0) continue;
    await deps.store.deleteVectors({ indexName: deps.indexName, filter: { sourceId } });
    const vectors = await embedTexts(deps.embedding, chunkTexts, deps.fetch);
    await deps.store.upsert({
      indexName: deps.indexName,
      ids: chunkTexts.map((_, index) => `${sourceId}:chunk-${index}`),
      vectors,
      metadata: chunkTexts.map((text, index) => ({
        // metadata.text is what rerankers and the vector-query tool read.
        text,
        sourceId,
        span: `chunk-${index}`,
        title: governance.title,
        tenantId: deps.tenantId,
        domain: deps.domain,
        canonical,
        reviewed: governance.reviewed,
        stale: governance.stale,
      })),
    });
    sources += 1;
    chunkCount += chunkTexts.length;
  }
  return { sources, chunks: chunkCount };
}

/**
 * HR-help `HrPolicyRetriever` over the Mastra-owned `hr_policy` index. First
 * use seeds the index from the company handbook corpus through the shared
 * MDocument ingest; later retrievals go straight to cosine top-k. When a
 * reranker is attached (P4), cosine over-fetches `2k` candidates and the
 * cross-encoder reorders them down to `k` — rerank happens on the retrieved
 * results, never as a second database pass. Any vector failure degrades to
 * the injected baseline retriever (the Python hybrid or the on-disk lexical
 * one); a reranker failure keeps the cosine order.
 */
export class MastraRagHrPolicyRetriever implements HrPolicyRetriever {
  private readonly indexName: string;
  private ready: Promise<void> | undefined;
  private warned = false;

  constructor(
    private readonly deps: {
      store: PgVector;
      embedding: EmbeddingSettings;
      fallback: HrPolicyRetriever;
      indexName?: string | undefined;
      directory?: string | undefined;
      tenantId?: string | undefined;
      domain?: string | undefined;
      reranker?: RelevanceScoreProvider | undefined;
      now?: (() => Date) | undefined;
      fetch?: typeof fetch | undefined;
    },
  ) {
    this.indexName = deps.indexName ?? DEFAULT_INDEX_NAME;
  }

  private async embed(texts: readonly string[]): Promise<number[][]> {
    return embedTexts(this.deps.embedding, texts, this.deps.fetch);
  }

  private async build(): Promise<void> {
    await ingestMarkdownCorpus({
      store: this.deps.store,
      embedding: this.deps.embedding,
      indexName: this.indexName,
      // The seeded company handbook — the same files the KB seeder ingests,
      // never the golden fixture corpus with its different numbers.
      directory: this.deps.directory ?? fixtureFile("company/hr_policy"),
      sourcePrefix: "hr_policy",
      tenantId: this.deps.tenantId ?? "omnidewalt",
      domain: this.deps.domain ?? "hr:policy",
      now: this.deps.now,
      fetch: this.deps.fetch,
    });
  }

  async retrieve(query: string, k: number): Promise<readonly HrPolicyPassage[]> {
    try {
      this.ready ??= this.build();
      await this.ready;
      const [queryVector] = await this.embed([query]);
      if (queryVector === undefined) throw new Error("no query embedding returned");
      const reranker = this.deps.reranker;
      const results = await this.deps.store.query({
        indexName: this.indexName,
        queryVector,
        // Over-fetch for the reranker only; without one the request stays exact.
        topK: reranker === undefined ? k : k * 2,
      });
      const ordered = reranker === undefined
        ? results
        : await rerankQueryResults(results, query, reranker, k);
      return ordered.map((result) => {
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
