import type { RelevanceScoreProvider } from "@mastra/core/relevance";
import type { PgVector } from "@mastra/pg";

import {
  knowledgeReranker,
  openAiCompatibleEmbedder,
  rerankQueryResults,
  type EmbeddingSettings,
} from "../../../shared/rag.js";
import { MspPassageSchema, type MspPassage } from "../contracts.js";
import type { MspKnowledge, MspKnowledgeScope } from "../flow.js";

/** Same name the knowledge plane declares for the MSP runbook index. */
const DEFAULT_INDEX_NAME = "msp_runbooks";

export interface MastraFirstMspKnowledgeOptions {
  /** The instance vector store backing the Mastra knowledge plane. */
  readonly store: PgVector;
  /** The pinned OpenAI-compatible embedding block. */
  readonly embedding: EmbeddingSettings;
  readonly indexName?: string;
  /** The platform hybrid path; without it a cold Mastra arm answers empty. */
  readonly fallback?: MspKnowledge;
  /** Defaults to the env-driven `knowledgeReranker()`; injectable for tests. */
  readonly reranker?: RelevanceScoreProvider | undefined;
  readonly fetch?: typeof fetch;
}

/**
 * Mastra-first knowledge seam for the msp draft step, falling back to the
 * platform API hybrid arm. Partitioning by `{ tenantId, domain: "msp:<clientRef>" }`
 * keeps one client's runbooks out of another's reply; the `listIndexes` probe is
 * memoized, empty or failed searches delegate, and unparseable rows are dropped.
 */
export class MastraFirstMspKnowledge implements MspKnowledge {
  private readonly indexName: string;
  private readonly reranker: RelevanceScoreProvider | undefined;
  private indexReady: Promise<boolean> | undefined;
  private warned = false;

  constructor(private readonly deps: MastraFirstMspKnowledgeOptions) {
    this.indexName = deps.indexName ?? DEFAULT_INDEX_NAME;
    this.reranker = deps.reranker ?? knowledgeReranker();
  }

  /** Memoized existence check: a cold plane delegates without probing again. */
  private hasIndex(): Promise<boolean> {
    this.indexReady ??= this.deps.store
      .listIndexes()
      .then((names) => names.includes(this.indexName), () => false);
    return this.indexReady;
  }

  private delegate(scope: MspKnowledgeScope, query: string, limit: number) {
    const fallback = this.deps.fallback;
    if (fallback === undefined) return Promise.resolve<readonly MspPassage[]>([]);
    return fallback.search(scope, query, limit);
  }

  async search(
    scope: MspKnowledgeScope,
    query: string,
    limit: number,
  ): Promise<readonly MspPassage[]> {
    const tenantId = scope.tenantId?.trim();
    // No tenant means no partition, the same rule the HTTP arm enforces.
    if (tenantId === undefined || tenantId === "") {
      return this.delegate(scope, query, limit);
    }
    if (!(await this.hasIndex())) return this.delegate(scope, query, limit);
    try {
      const { embeddings } = await openAiCompatibleEmbedder(
        this.deps.embedding,
        this.deps.fetch,
      ).doEmbed({ values: [query] });
      const queryVector = embeddings[0];
      if (queryVector === undefined) throw new Error("no query embedding returned");
      let results = await this.deps.store.query({
        indexName: this.indexName,
        queryVector,
        topK: this.reranker === undefined ? limit : limit * 2,
        filter: { tenantId, domain: `msp:${scope.clientRef}` },
      });
      if (this.reranker !== undefined) {
        results = await rerankQueryResults(results, query, this.reranker, limit);
      }
      const passages: MspPassage[] = [];
      for (const row of results) {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const sourceId = String(meta.sourceId ?? "");
        const parsed = MspPassageSchema.safeParse({
          sourceId,
          span: String(meta.span ?? ""),
          title: String(meta.title ?? "") || sourceId,
          text: String(meta.text ?? "").slice(0, 2_000),
          score: Math.min(Math.max(row.score, 0), 1),
          stale: meta.stale === true,
        });
        if (parsed.success) passages.push(parsed.data);
      }
      if (passages.length === 0) return this.delegate(scope, query, limit);
      return passages.slice(0, limit);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          "[mastra] msp Mastra-plane knowledge search failed"
            + ` (${error instanceof Error ? error.message : String(error)});`
            + " falling back to the platform knowledge path.",
        );
      }
      return this.delegate(scope, query, limit);
    }
  }
}
