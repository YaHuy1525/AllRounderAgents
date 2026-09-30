import { MspPassageSchema, type MspPassage } from "../contracts.js";
import type { MspKnowledge, MspKnowledgeScope } from "../flow.js";

/** Transport seam: global fetch in production, recorded fixtures in tests. */
export type KnowledgeFetch = typeof fetch;

export interface HttpMspKnowledgeOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: KnowledgeFetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Knowledge seam over the platform API's service-to-service retrieval route
 * (`POST /knowledge/search`, shared bearer token). The run's tenant plus the
 * client ref map onto the store partition `msp:<clientRef>`, so one client's
 * runbooks never ground another client's reply.
 *
 * Every failure degrades to an empty result instead of an exception: an
 * unreachable or unconfigured service must surface as the lane's
 * `empty_retrieval` escalation, where a human sees it, rather than fail the
 * draft step. A response the MspPassage contract cannot parse is treated as
 * no grounding at all, because partial trust is worse than a human review.
 */
export class HttpMspKnowledge implements MspKnowledge {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: KnowledgeFetch;
  private readonly timeoutMs: number;

  constructor(options: HttpMspKnowledgeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (this.baseUrl === "") {
      throw new Error("HttpMspKnowledge: baseUrl is required");
    }
    this.serviceToken = options.serviceToken;
    if (this.serviceToken === "") {
      throw new Error("HttpMspKnowledge: serviceToken is required");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(
    scope: MspKnowledgeScope,
    query: string,
    limit: number,
  ): Promise<readonly MspPassage[]> {
    const tenantId = scope.tenantId?.trim();
    if (tenantId === undefined || tenantId === "") {
      console.warn(
        "[mastra] knowledge search skipped: the run carries no tenantId, so the"
          + " client scope cannot be derived; the draft escalates.",
      );
      return [];
    }
    let payload: unknown;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/knowledge/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.serviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId,
          domain: `msp:${scope.clientRef}`,
          query,
          k: limit,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        console.warn(
          `[mastra] knowledge search failed (HTTP ${response.status}); the draft escalates.`,
        );
        return [];
      }
      payload = await response.json();
    } catch (error) {
      console.warn(
        "[mastra] knowledge search failed"
          + ` (${error instanceof Error ? error.message : String(error)});`
          + " the draft escalates.",
      );
      return [];
    }
    const rows = isRecord(payload) && Array.isArray(payload.passages) ? payload.passages : [];
    const passages: MspPassage[] = [];
    for (const row of rows) {
      const parsed = MspPassageSchema.safeParse(row);
      if (!parsed.success) {
        console.warn(
          "[mastra] knowledge search returned a passage outside the MspPassage"
            + " contract; the draft escalates.",
        );
        return [];
      }
      passages.push(parsed.data);
    }
    return passages;
  }
}
