import { PolicyPassageSchema, type PolicyPassage } from "../contracts.js";
import type { HrPolicyPassage, HrPolicyRetriever } from "./hr-policy.js";

/** Transport seam: global fetch in production, recorded fixtures in tests. */
export type HrKnowledgeFetch = typeof fetch;

export interface HttpHrPolicyRetrieverOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  /** Tenant whose policy partition the lane reads. */
  readonly tenantId: string;
  readonly domain?: string;
  readonly fetch?: HrKnowledgeFetch;
  readonly timeoutMs?: number;
  /** Corpus consulted when the knowledge service cannot be reached at all. */
  readonly fallback?: HrPolicyRetriever;
}

/** The graduated HR policy corpus lives in this partition (hr:<lane> family). */
export const HR_POLICY_DOMAIN = "hr:policy";

const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * HR policy retriever served by the platform API's hybrid retrieval, keeping the
 * fixture corpus's citation discipline. Tenant plus the `hr:policy` partition
 * scope the store, so one tenant's handbook never grounds another's answer.
 * No passages is the truth about the corpus and is reported as such; an outage
 * or an unparseable passage falls back to the on-disk corpus, because partial
 * trust is worse than a human review.
 */
export class HttpHrPolicyRetriever implements HrPolicyRetriever {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly tenantId: string;
  private readonly domain: string;
  private readonly fetchImpl: HrKnowledgeFetch;
  private readonly timeoutMs: number;
  private readonly fallback: HrPolicyRetriever | undefined;

  constructor(options: HttpHrPolicyRetrieverOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (this.baseUrl === "") {
      throw new Error("HttpHrPolicyRetriever: baseUrl is required");
    }
    this.serviceToken = options.serviceToken;
    if (this.serviceToken === "") {
      throw new Error("HttpHrPolicyRetriever: serviceToken is required");
    }
    this.tenantId = options.tenantId.trim();
    if (this.tenantId === "") {
      throw new Error("HttpHrPolicyRetriever: tenantId is required");
    }
    this.domain = options.domain?.trim() || HR_POLICY_DOMAIN;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fallback = options.fallback;
  }

  async retrieve(query: string, k: number): Promise<readonly HrPolicyPassage[]> {
    const limit = Math.max(1, Math.min(k, 8));
    let payload: unknown;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/knowledge/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.serviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId: this.tenantId,
          domain: this.domain,
          query,
          k: limit,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return this.degrade(
          query,
          limit,
          `knowledge search failed (HTTP ${response.status})`,
        );
      }
      payload = await response.json();
    } catch (error) {
      return this.degrade(
        query,
        limit,
        `knowledge search failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const rows = isRecord(payload) && Array.isArray(payload.passages) ? payload.passages : [];
    const passages: PolicyPassage[] = [];
    for (const row of rows) {
      const parsed = PolicyPassageSchema.safeParse(row);
      if (!parsed.success) {
        return this.degrade(
          query,
          limit,
          "knowledge search returned a passage outside the PolicyPassage contract",
        );
      }
      passages.push(parsed.data);
    }
    return passages;
  }

  /** An unreachable or unparseable service is an outage, not an empty corpus. */
  private async degrade(
    query: string,
    limit: number,
    reason: string,
  ): Promise<readonly HrPolicyPassage[]> {
    if (this.fallback === undefined) {
      console.warn(`[mastra] ${reason}; the HR help lane reports an empty retrieval.`);
      return [];
    }
    console.warn(`[mastra] ${reason}; the HR help lane falls back to the on-disk policy corpus.`);
    return this.fallback.retrieve(query, limit);
  }
}
