import { existsSync } from "node:fs";

import { fixtureFile } from "./fixtures.js";
import { createKnowledgeTool } from "./knowledge-tool.js";
import {
  ingestMarkdownCorpus,
  knowledgeReranker,
  knowledgeVectorStore,
  readEmbeddingSettings,
  type IngestSummary,
} from "./rag.js";

/**
 * The one place that decides which vector indexes exist, which tool searches
 * each, and which corpus seeds it, so adding a source is one entry. Opt-in
 * through `MASTRA_RAG_PILOT` while the Python hybrid retriever stays the
 * production path. An index with no seeded corpus contributes neither a tool nor
 * a seed run, so an empty index never errors on first query.
 */

/** The tool shape the factory returns when the plane is wired. */
type KnowledgeTool = NonNullable<ReturnType<typeof createKnowledgeTool>>;

/** Markdown corpus that seeds one index, per the shared MDocument ingest. */
export interface CorpusSeed {
  readonly directory: string;
  readonly sourcePrefix: string;
  readonly tenantId: string;
  readonly domain: string;
}

export interface KnowledgeIndex {
  /** PgVector index name, seeded and queried by the plane. */
  readonly indexName: string;
  /** Tool id the model sees. */
  readonly toolId: string;
  /** Model-facing scope statement: what this index can answer. */
  readonly description: string;
  /** Corpus to seed the index from; `undefined` means nothing seeds it here. */
  readonly corpus: CorpusSeed | undefined;
}

/** Same default the HR-help pilot seeds with, so both paths write one partition. */
const DEFAULT_KB_TENANT = "omnidewalt";

/**
 * The plane's index registry. `hr_policy` is the company handbook and is live.
 * `msp_runbooks` is declared for the msp leg of the plan but stays inert until
 * a repo-owned runbook corpus exists: client runbooks partition as
 * `msp:<clientRef>` per tenant, so its seed must be written when the corpus
 * and its scoping rule land, not guessed here.
 */
export function knowledgeIndexes(): readonly KnowledgeIndex[] {
  const tenantId = process.env.HR_KB_TENANT?.trim() || DEFAULT_KB_TENANT;
  return [
    {
      indexName: "hr_policy",
      toolId: "search_hr_policy",
      description:
        "Search the company HR handbook: leave and time off, benefits and pay, "
        + "remote work, and conduct and grievance procedure.",
      corpus: {
        directory: fixtureFile("company/hr_policy"),
        sourcePrefix: "hr_policy",
        tenantId,
        domain: "hr:policy",
      },
    },
    {
      indexName: "msp_runbooks",
      toolId: "search_msp_runbooks",
      description:
        "Search MSP client runbooks and service-desk procedures for the run's client.",
      corpus: undefined,
    },
  ];
}

/** True while the Mastra-native knowledge plane is the opted-in experiment. */
export function knowledgePlaneEnabled(): boolean {
  if (process.env.MASTRA_RAG_PILOT !== "true") return false;
  return knowledgeVectorStore() !== undefined && readEmbeddingSettings() !== undefined;
}

/** Indexes a corpus actually backs: the searchable surface of the plane. */
export function seededKnowledgeIndexes(): readonly KnowledgeIndex[] {
  return knowledgeIndexes().filter(
    (index) => index.corpus !== undefined && existsSync(index.corpus.directory),
  );
}

/**
 * One retrieval tool per seeded index, keyed by tool id, so a conversational
 * agent attaches the whole plane with `tools: knowledgeTools()` and picks the
 * index itself. Empty when the plane is off, which keeps a credential-free or
 * pilot-off build free of tools that could only fail. When `COHERE_API_KEY`
 * is configured the tool reranks its own retrieved results (P4: rerank on
 * the results, never a second database pass); without the key the tool keeps
 * the plain cosine order.
 */
export function knowledgeTools(): Record<string, KnowledgeTool> {
  const tools: Record<string, KnowledgeTool> = {};
  if (!knowledgePlaneEnabled()) return tools;
  const reranker = knowledgeReranker();
  for (const index of seededKnowledgeIndexes()) {
    const tool = createKnowledgeTool({
      id: index.toolId,
      description: index.description,
      indexName: index.indexName,
      ...(reranker === undefined ? {} : { reranker: { model: reranker } }),
    });
    if (tool !== undefined) tools[index.toolId] = tool;
  }
  return tools;
}

let seedRun: Promise<IngestSummary[]> | undefined;

/**
 * Seed every backed index through the shared MDocument ingest. Memoized per
 * process and never rejecting: a corpus or provider that fails at boot is
 * logged and leaves the index cold, because the dev host must still start and
 * the lanes degrade to their baseline retrievers. Idempotent per source, so a
 * second pass only refreshes edited files.
 */
export function seedKnowledgePlane(): Promise<IngestSummary[]> {
  seedRun ??= runSeed();
  return seedRun;
}

async function runSeed(): Promise<IngestSummary[]> {
  if (!knowledgePlaneEnabled()) return [];
  const store = knowledgeVectorStore();
  const embedding = readEmbeddingSettings();
  if (store === undefined || embedding === undefined) return [];
  const summaries: IngestSummary[] = [];
  for (const index of seededKnowledgeIndexes()) {
    const corpus = index.corpus;
    if (corpus === undefined) continue;
    try {
      const summary = await ingestMarkdownCorpus({
        store,
        embedding,
        indexName: index.indexName,
        directory: corpus.directory,
        sourcePrefix: corpus.sourcePrefix,
        tenantId: corpus.tenantId,
        domain: corpus.domain,
      });
      summaries.push(summary);
      console.info(
        `[mastra] knowledge plane seeded ${summary.chunks} chunks from`
          + ` ${summary.sources} sources into the ${index.indexName} index.`,
      );
    } catch (error) {
      console.warn(
        `[mastra] knowledge plane could not seed the ${index.indexName} index`
          + ` (${error instanceof Error ? error.message : String(error)});`
          + " retrieval falls back to the baseline path.",
      );
    }
  }
  return summaries;
}
