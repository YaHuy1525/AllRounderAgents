import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import type { Memory } from "@mastra/memory";

import {
  CaseHistoryRecordSchema,
  caseRecallScore,
  type CaseHistory,
  type CaseHistoryRecord,
  type CaseRecallQuery,
} from "./seams.js";

/**
 * Memory-backed `CaseHistory` for hosts with persistent Mastra storage
 * (plan §5.1): case records live as structured messages in one tenant-scoped
 * thread. Exact lookup reads the thread; similar-case recall asks Memory
 * (vector search when an embedder is configured, message history otherwise)
 * and rescores locally with the same weights as the fixture implementation.
 *
 * Never used in tests or CI — `createSecurityFlow` defaults to the fixture
 * `MemoryCaseHistory`; only the host injects this implementation.
 */

const DEFAULT_RESOURCE_ID = "security-cases";
const CASE_THREAD_ID = "case-index";
const THREAD_PAGE_SIZE = 200;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first text part of a stored record message, if any. */
function messageText(message: MastraDBMessage): string {
  const parts: readonly unknown[] = message.content.parts;
  return parts
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .join("\n")
    .trim();
}

function parseRecord(message: MastraDBMessage): CaseHistoryRecord | null {
  const text = messageText(message);
  if (text === "") return null;
  try {
    const parsed = CaseHistoryRecordSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class MastraMemoryCaseHistory implements CaseHistory {
  private readonly memory: Memory;
  private readonly resourceId: string;

  constructor(memory: Memory, resourceId: string = DEFAULT_RESOURCE_ID) {
    this.memory = memory;
    this.resourceId = resourceId;
  }

  async lookup(alertId: string): Promise<CaseHistoryRecord | null> {
    const records = await this.threadRecords();
    let match: CaseHistoryRecord | null = null;
    for (const record of records) {
      if (record.alertId === alertId) match = record;
    }
    return match;
  }

  async recall(query: CaseRecallQuery): Promise<readonly CaseHistoryRecord[]> {
    const messages = await this.recallMessages(query.text.trim() === "" ? undefined : query.text);
    if (messages === null) return [];
    const scored: Array<{ record: CaseHistoryRecord; score: number }> = [];
    for (const message of messages) {
      const record = parseRecord(message);
      if (record === null) continue;
      const score = caseRecallScore(record, query);
      if (score === 0) continue;
      scored.push({ record, score });
    }
    scored.sort(
      (left, right) =>
        right.score - left.score ||
        right.record.closedAt.localeCompare(left.record.closedAt) ||
        left.record.caseId.localeCompare(right.record.caseId),
    );
    return scored.slice(0, query.limit ?? 3).map((entry) => entry.record);
  }

  async remember(record: CaseHistoryRecord): Promise<void> {
    await this.ensureThread();
    await this.memory.saveMessages({
      messages: [
        {
          id: `case-${record.caseId}`,
          threadId: CASE_THREAD_ID,
          resourceId: this.resourceId,
          role: "assistant",
          createdAt: new Date(record.closedAt),
          type: "text",
          content: { format: 2, parts: [{ type: "text", text: JSON.stringify(record) }] },
        },
      ],
    });
  }

  /**
   * Thread messages for a recall, retrying without vector search when the
   * vector path fails (no embedder or vector store configured): recall must
   * degrade to plain message history, never to a silently empty result.
   * Returns null only when both paths fail.
   */
  private async recallMessages(
    vectorSearchString: string | undefined,
  ): Promise<readonly MastraDBMessage[] | null> {
    try {
      const result = await this.memory.recall({
        threadId: CASE_THREAD_ID,
        resourceId: this.resourceId,
        perPage: THREAD_PAGE_SIZE,
        ...(vectorSearchString === undefined ? {} : { vectorSearchString }),
      });
      return result.messages;
    } catch (error) {
      if (vectorSearchString === undefined) {
        console.warn(`MastraMemoryCaseHistory: recall failed: ${describeError(error)}`);
        return null;
      }
      console.warn(
        `MastraMemoryCaseHistory: vector recall failed, retrying history: ${describeError(error)}`,
      );
      return this.recallMessages(undefined);
    }
  }

  private async threadRecords(): Promise<readonly CaseHistoryRecord[]> {
    try {
      const result = await this.memory.recall({
        threadId: CASE_THREAD_ID,
        resourceId: this.resourceId,
        perPage: THREAD_PAGE_SIZE,
      });
      const records: CaseHistoryRecord[] = [];
      for (const message of result.messages) {
        const record = parseRecord(message);
        if (record !== null) records.push(record);
      }
      return records;
    } catch (error) {
      console.warn(`MastraMemoryCaseHistory: lookup failed: ${describeError(error)}`);
      return [];
    }
  }

  private async ensureThread(): Promise<void> {
    const existing = await this.memory.getThreadById({
      threadId: CASE_THREAD_ID,
      resourceId: this.resourceId,
    });
    if (existing !== null) return;
    try {
      await this.memory.createThread({
        threadId: CASE_THREAD_ID,
        resourceId: this.resourceId,
        title: "Security case index",
        metadata: { lane: "security" },
        saveThread: true,
      });
    } catch (error) {
      // Two concurrent runs may race the create; only a still-missing thread
      // is a real failure.
      const thread = await this.memory.getThreadById({
        threadId: CASE_THREAD_ID,
        resourceId: this.resourceId,
      });
      if (thread === null) throw error;
    }
  }
}
