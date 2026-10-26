import {
  QaDefectReceiptSchema,
  type QaCaseResult,
  type QaDefect,
  type QaDefectReceipt,
} from "./contracts.js";

/**
 * The filing seam. Jira writes stay in the Python plane: the existing transport
 * there owns receipts, the MCP-to-REST degradation and the replay rule, and a
 * second transport in TypeScript would mean two idempotency records for one
 * defect (decision D2 in the plan).
 *
 * What this module owns is the request and the honest report of what happened:
 *
 *   * An approved failure posts `status: "failed"`, which the route answers by
 *     creating the ticket, commenting on the existing one, or reporting a
 *     replay. The route keys on `{storyKey}:{caseId}`, so a nightly suite
 *     cannot produce a ticket avalanche.
 *   * A passing case posts `status: "passed"`, which the route only acts on
 *     when that correlation already has a defect. With no defect it answers
 *     `skipped`, and nothing is written.
 *   * A write that cannot happen is a `failed` receipt, not a thrown run: the
 *     findings stay visible in the close output instead of disappearing.
 */

const BASE_URL_ENV = "KNOWLEDGE_API_URL";
const SERVICE_TOKEN_ENV = "KNOWLEDGE_SERVICE_TOKEN";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface QaFileBrief {
  readonly runId: string;
  readonly storyKey: string;
  readonly targetKey: string;
  readonly caseSetHash: string;
  /** The approved findings, in approval order. */
  readonly defects: readonly QaDefect[];
  /** Every result of the run, so a case that now passes can be commented. */
  readonly results: readonly QaCaseResult[];
}

export interface QaDefectFiler {
  file(brief: QaFileBrief): Promise<QaDefectReceipt[]>;
}

export interface QaDefectFilerOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function failedReceipt(
  caseId: string,
  correlationId: string,
  reason: string,
): QaDefectReceipt {
  return QaDefectReceiptSchema.parse({
    caseId,
    correlationId,
    action: "failed",
    ticketKey: "",
    status: reason.slice(0, 40),
  });
}

function resolutionBody(input: {
  readonly storyKey: string;
  readonly runId: string;
  readonly result: QaCaseResult;
}): string {
  const observed = input.result.observed.trim();
  return [
    `Case ${input.result.caseId} now passes against story ${input.storyKey}.`,
    `Run: ${input.runId}`,
    "",
    `Observed: ${observed === "" ? "(no observation recorded)" : observed}`,
  ]
    .join("\n")
    .slice(0, 4_000);
}

/**
 * The live filer: one governed POST per finding, then one per passing case so a
 * regression that was fixed can be closed by comment rather than by silence.
 */
export function createQaDefectFiler(options: QaDefectFilerOptions): QaDefectFiler {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (baseUrl === "") {
    throw new Error("createQaDefectFiler: baseUrl is required");
  }
  if (options.serviceToken === "") {
    throw new Error("createQaDefectFiler: serviceToken is required");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(
    body: Record<string, unknown>,
    caseId: string,
    correlationId: string,
  ): Promise<QaDefectReceipt> {
    try {
      const response = await fetchImpl(`${baseUrl}/agent-tools/qa/file-defect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.serviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return failedReceipt(caseId, correlationId, `http_${response.status}`);
      }
      const answer = (await response.json()) as unknown;
      if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
        return failedReceipt(caseId, correlationId, "unreadable_body");
      }
      const record = answer as Record<string, unknown>;
      const parsed = QaDefectReceiptSchema.safeParse({
        caseId,
        correlationId,
        action: record.action,
        ticketKey: typeof record.ticketKey === "string" ? record.ticketKey : "",
        status: typeof record.status === "string" ? record.status : "unknown",
      });
      return parsed.success
        ? parsed.data
        : failedReceipt(caseId, correlationId, "invalid_receipt");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[mastra] qa defect filing failed for ${caseId} (${reason}); the receipt reports it.`,
      );
      return failedReceipt(caseId, correlationId, reason);
    }
  }

  return {
    async file(brief: QaFileBrief): Promise<QaDefectReceipt[]> {
      const receipts: QaDefectReceipt[] = [];
      const failing = new Set(brief.defects.map((defect) => defect.caseId));
      for (const defect of brief.defects) {
        receipts.push(
          await post(
            {
              storyKey: brief.storyKey,
              caseId: defect.caseId,
              targetKey: brief.targetKey,
              runId: brief.runId,
              status: "failed",
              title: defect.title,
              body: defect.body,
              severity: defect.severity,
              evidenceRefs: [...defect.evidenceRefs],
              correlationId: defect.correlationId,
            },
            defect.caseId,
            defect.correlationId,
          ),
        );
      }
      for (const result of brief.results) {
        if (result.status !== "passed" || failing.has(result.caseId)) continue;
        const correlationId = `${brief.storyKey}:${result.caseId}`;
        receipts.push(
          await post(
            {
              storyKey: brief.storyKey,
              caseId: result.caseId,
              targetKey: brief.targetKey,
              runId: brief.runId,
              status: "passed",
              title: `[QA] ${result.caseId} now passes`,
              body: resolutionBody({
                storyKey: brief.storyKey,
                runId: brief.runId,
                result,
              }),
              severity: "low",
              evidenceRefs: [],
              correlationId,
            },
            result.caseId,
            correlationId,
          ),
        );
      }
      return receipts;
    },
  };
}

/**
 * A filer that writes nothing. Used when the console bridge is not configured:
 * every approved finding comes back as a `failed` receipt naming the missing
 * environment, so the run still closes with the findings visible and nobody
 * reads "filed" when nothing was.
 */
export function unconfiguredQaDefectFiler(reason: string): QaDefectFiler {
  return {
    async file(brief: QaFileBrief): Promise<QaDefectReceipt[]> {
      return brief.defects.map((defect) =>
        failedReceipt(defect.caseId, defect.correlationId, reason),
      );
    },
  };
}

/** The live filer, or one that reports the missing bridge for every finding. */
export function qaDefectFilerFromEnv(): QaDefectFiler {
  const baseUrl = process.env[BASE_URL_ENV]?.trim();
  const serviceToken = process.env[SERVICE_TOKEN_ENV]?.trim();
  if (baseUrl === undefined || baseUrl === "" || serviceToken === undefined || serviceToken === "") {
    return unconfiguredQaDefectFiler(`bridge_unconfigured:${BASE_URL_ENV}`);
  }
  return createQaDefectFiler({ baseUrl, serviceToken });
}
