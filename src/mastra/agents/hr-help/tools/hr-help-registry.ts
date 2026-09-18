import type { Citation } from "../contracts.js";

/**
 * Answer store for the HR help lane. `send` is idempotent by `(caseId,
 * ticketKey)`: recording a ticket whose answer already exists returns the
 * stored record with `created: false` instead of posting the answer twice.
 * The default in-memory implementation is the sandbox the tests and the
 * local host run against — the lane makes no network calls.
 */
export interface HrHelpAnswer {
  readonly answerId: string;
  readonly caseId: string;
  readonly ticketKey: string;
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly status: "sent";
  readonly createdAt: string;
}

export interface HrHelpSendResult {
  readonly answer: HrHelpAnswer;
  /** false when an existing answer for the same case and ticket was reused. */
  readonly created: boolean;
  readonly registryRef: string;
}

export interface HrHelpRegistry {
  get(caseId: string, ticketKey: string): Promise<HrHelpAnswer | null>;
  /** Idempotent by `(caseId, ticketKey)`; `created` is false on a replay. */
  send(answer: HrHelpAnswer): Promise<HrHelpSendResult>;
}

function keyFor(caseId: string, ticketKey: string): string {
  return `${caseId}#${ticketKey}`;
}

export class MemoryHrHelpRegistry implements HrHelpRegistry {
  private readonly byKey = new Map<string, HrHelpAnswer>();

  async get(caseId: string, ticketKey: string): Promise<HrHelpAnswer | null> {
    return this.byKey.get(keyFor(caseId, ticketKey)) ?? null;
  }

  async send(answer: HrHelpAnswer): Promise<HrHelpSendResult> {
    const key = keyFor(answer.caseId, answer.ticketKey);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return {
        answer: existing,
        created: false,
        registryRef: `hr-help:${key}`,
      };
    }
    this.byKey.set(key, answer);
    return {
      answer,
      created: true,
      registryRef: `hr-help:${key}`,
    };
  }
}
