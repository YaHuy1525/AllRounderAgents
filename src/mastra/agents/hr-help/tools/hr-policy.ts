import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { fixtureFile } from "../../../shared/fixtures.js";

/**
 * Fixture policy retriever for the HR help lane. It implements the support
 * lane's citation discipline — every passage carries a `sourceId` (the
 * markdown file), a character `span`, a deterministic term-overlap `score`,
 * and a `stale` flag from the document's review date — so the lane makes no
 * network calls and a later MCP-first (then pgvector) swap changes only this
 * implementation. Documents are the `fixtures/hr_policy/*.md` corpus; each
 * blank-line-separated paragraph is one passage.
 */

/** Documents reviewed longer ago than this many days are flagged stale. */
const STALE_DAYS = 365;

/** Default number of passages the retriever returns. */
const DEFAULT_K = 5;

export interface HrPolicyPassage {
  readonly sourceId: string;
  readonly span: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
  readonly stale: boolean;
}

export interface HrPolicyRetriever {
  /** Ranked passages for the query; empty when nothing matches. */
  retrieve(query: string, k: number): Promise<readonly HrPolicyPassage[]>;
}

interface PolicyChunk {
  readonly sourceId: string;
  readonly span: string;
  readonly title: string;
  readonly text: string;
  readonly stale: boolean;
}

/** Fixture path lookup: repo-root `fixtures/` first, source-tree fallback. */
function resolvePolicyDir(): string {
  const direct = resolve(process.cwd(), "fixtures", "hr_policy");
  if (existsSync(direct)) return direct;
  return fixtureFile("hr_policy");
}

/** Lowercased word tokens (3+ chars) in first-seen order, deduplicated. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.toLowerCase().matchAll(/[a-z][a-z0-9-]{2,}/g)) {
    if (!terms.includes(match[0])) terms.push(match[0]);
  }
  return terms;
}

/**
 * Word-boundary term test so a short term never matches inside a longer word
 * ("get" must not match "budget").
 */
export function matchesTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text.toLowerCase());
}

/**
 * Split a document into blank-line-separated paragraphs with their character
 * offsets; the `# Title` and `Reviewed:` header lines are skipped.
 */
function paragraphs(raw: string): { text: string; start: number }[] {
  const blocks: { text: string; start: number }[] = [];
  let cursor = 0;
  for (const block of raw.split(/\n{2,}/)) {
    const start = raw.indexOf(block, cursor);
    cursor = start + block.length;
    const trimmed = block.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("Reviewed:")) continue;
    blocks.push({ text: trimmed, start });
  }
  return blocks;
}

function loadChunks(dir: string, now: Date): PolicyChunk[] {
  const chunks: PolicyChunk[] = [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  for (const fileName of files) {
    // Normalize Windows checkouts so the blank-line paragraph split holds.
    const raw = readFileSync(resolve(dir, fileName), "utf8").replace(/\r\n/g, "\n");
    const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(fileName, ".md");
    const reviewed = raw.match(/^Reviewed:\s*(\d{4}-\d{2}-\d{2})$/m)?.[1];
    const reviewedAt = reviewed === undefined ? NaN : Date.parse(`${reviewed}T00:00:00Z`);
    const stale =
      !Number.isFinite(reviewedAt) || now.getTime() - reviewedAt > STALE_DAYS * 24 * 60 * 60 * 1_000;
    for (const paragraph of paragraphs(raw)) {
      chunks.push({
        sourceId: `hr_policy/${fileName}`,
        span: `${paragraph.start}-${paragraph.start + paragraph.text.length}`,
        title,
        text: paragraph.text,
        stale,
      });
    }
  }
  return chunks;
}

export class MemoryHrPolicyRetriever implements HrPolicyRetriever {
  private readonly chunks: PolicyChunk[];
  private readonly now: () => Date;

  constructor(options: { directory?: string; now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    this.chunks = loadChunks(options.directory ?? resolvePolicyDir(), this.now());
  }

  async retrieve(query: string, k: number = DEFAULT_K): Promise<readonly HrPolicyPassage[]> {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    return this.chunks
      .map((chunk) => {
        const matches = terms.filter((term) => matchesTerm(chunk.text, term)).length;
        return {
          sourceId: chunk.sourceId,
          span: chunk.span,
          title: chunk.title,
          text: chunk.text,
          score: Math.round((matches / terms.length) * 100) / 100,
          stale: chunk.stale,
        };
      })
      .filter((passage) => passage.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.sourceId.localeCompare(right.sourceId) || left.span.localeCompare(right.span),
      )
      .slice(0, Math.max(1, Math.min(k, 8)));
  }
}
