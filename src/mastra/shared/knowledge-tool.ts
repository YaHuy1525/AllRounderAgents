import type { RerankConfig } from "@mastra/rag";
import { createVectorQueryTool } from "@mastra/rag";

import { knowledgeVectorStore, openAiCompatibleEmbedder, readEmbeddingSettings } from "./rag.js";

/**
 * Shared factory for Mastra-native knowledge tools (upgrade plan P2). One
 * thin wrapper over `createVectorQueryTool` so every conversational lane
 * gets the same grounded-retrieval behavior: the pinned OpenAI-compatible
 * embedder, the PgVector store registered on the instance, a score floor
 * that keeps irrelevant chunks out of the prompt, and metadata filtering
 * enabled so the agent can narrow by `domain`, `tenantId` or `canonical`
 * (chunk text lives at `metadata.text`, governance at ingest).
 *
 * Returns `undefined` when `DATABASE_URL` or the `EMBEDDING_*`/`MODEL_*`
 * block is missing, which lets callers omit the tool with a conditional
 * spread instead of shipping a tool that fails at call time.
 *
 * Usage notes for agents (tutorial practice, enforced via description):
 * ask for 3-4 results, not dozens; rerank happens on the retrieved results
 * through the optional `reranker` config, never by re-querying the database.
 */
export interface KnowledgeToolOptions {
  /** Stable tool id, surfaced to the model and to Studio. */
  id: string;
  /** What the lane may find in this index; the model reads this to decide when to call. */
  description: string;
  /** Mastra-owned index, e.g. `hr_policy` (seeded by ingestMarkdownCorpus). */
  indexName: string;
  /** Cosine similarity floor. Defaults to 0.25, high enough to drop noise. */
  minScore?: number | undefined;
  /** Optional reranker applied to the retrieved results only. */
  reranker?: RerankConfig | undefined;
}

export function createKnowledgeTool(
  options: KnowledgeToolOptions,
): ReturnType<typeof createVectorQueryTool> | undefined {
  const store = knowledgeVectorStore();
  const embedding = readEmbeddingSettings();
  if (store === undefined || embedding === undefined) return undefined;
  const base = {
    id: options.id,
    description:
      `${options.description} Ask for 3-4 results. Results carry metadata `
      + `(sourceId, domain, tenantId, canonical, stale); cite sourceId:span.`,
    indexName: options.indexName,
    model: openAiCompatibleEmbedder(embedding),
    vectorStore: store,
    enableFilter: true,
    databaseConfig: { pgvector: { minScore: options.minScore ?? 0.25 } },
  };
  // Two call shapes instead of a `reranker: undefined` property, because
  // the package types forbid passing explicit undefined under strict mode.
  return options.reranker === undefined
    ? createVectorQueryTool(base)
    : createVectorQueryTool({ ...base, reranker: options.reranker });
}
