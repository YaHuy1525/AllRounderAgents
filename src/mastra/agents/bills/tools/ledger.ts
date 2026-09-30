import type { BillPosting } from "../contracts.js";

/**
 * The bills ledger seam: one interface every ledger implementation posts
 * draft bills through (the "same seam" the finance lane's SandboxLedger
 * declares, focused on vendor bills). The memory implementation is the M4
 * sandbox default; `HttpXeroLedger` (tools/xero.ts) posts ACCPAY bills in
 * DRAFT status to Xero behind the same interface, so the flow never talks to
 * a provider directly.
 */

export interface BillsPostRequest {
  /** Stable replay key (the flow hashes its exact action into this). */
  readonly idempotencyKey: string;
  /** The signed approval receipt; the ledger refuses an empty one. */
  readonly approvalReceipt: string;
  readonly posting: BillPosting;
}

export interface BillsPostResult {
  /** Where the bill was recorded ("xero:DRAFT:<id>", "memory:..."). */
  readonly artifact: string;
  readonly billId: string;
  readonly billNumber: string;
  /** false when the idempotency key replayed an earlier posting. */
  readonly created: boolean;
}

export interface BillsLedger {
  readonly provider: string;
  post(request: BillsPostRequest): Promise<BillsPostResult>;
}

export type BillsLedgerErrorCode = "invalid" | "unreachable" | "rejected";

export class BillsLedgerError extends Error {
  readonly code: BillsLedgerErrorCode;
  readonly retryable: boolean;

  constructor(
    code: BillsLedgerErrorCode,
    message: string,
    options: { retryable?: boolean } = {},
  ) {
    super(`ledger: ${message}`);
    this.name = "BillsLedgerError";
    this.code = code;
    this.retryable = options.retryable ?? code === "unreachable";
  }
}

/**
 * The in-memory sandbox ledger: records postings and replays by idempotency
 * key. A posting without an approval receipt throws, so the last inch of the
 * lane keeps the same discipline as the run service's receipt verification —
 * no receipt, no post, no exceptions.
 */
export class MemoryBillsLedger implements BillsLedger {
  readonly provider = "memory";
  readonly posted: BillPosting[] = [];
  private readonly receipts = new Map<string, BillsPostResult>();

  async post(request: BillsPostRequest): Promise<BillsPostResult> {
    if (request.approvalReceipt.length === 0) {
      throw new BillsLedgerError("invalid", "approval receipt required");
    }
    const prior = this.receipts.get(request.idempotencyKey);
    if (prior !== undefined) return prior;
    this.posted.push(request.posting);
    const result: BillsPostResult = {
      artifact: `memory:${request.idempotencyKey}`,
      billId: `memory-bill-${this.posted.length}`,
      billNumber: request.posting.billNumber,
      created: true,
    };
    this.receipts.set(request.idempotencyKey, result);
    return result;
  }
}
