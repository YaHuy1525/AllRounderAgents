import type { RerankConfig } from "@mastra/rag";
import { createVectorQueryTool } from "@mastra/rag";

import { knowledgeVectorStore, openAiCompatibleEmbedder, readEmbeddingSettings } from "./rag.js";

/**
 * One shared wrapper over `createVectorQueryTool` so every conversational lane
 * retrieves the same way: pinned embedder, instance PgVector store, a score
 * floor, and metadata filtering on `domain`, `tenantId` and `canonical`.
 * Returns `undefined` when the store or the embedding env is missing, so
 * callers omit the tool instead of shipping one that fails at call time.
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
