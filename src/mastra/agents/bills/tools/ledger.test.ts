import { describe, expect, it } from "vitest";

import { BillPostingSchema, type BillPosting } from "../contracts.js";
import {
  BillsLedgerError,
  MemoryBillsLedger,
  type BillsPostRequest,
} from "./ledger.js";

const POSTING: BillPosting = BillPostingSchema.parse({
  vendorName: "Acme Power Pty Ltd",
  vendorEmail: "billing@acmepower.com.au",
  billNumber: "INV-2041",
  issueDate: "2026-09-01",
  dueDate: "2026-09-15",
  currency: "AUD",
  totalCents: 132_000,
  taxCents: 12_000,
  lineItems: [{ description: "Electricity 1 Aug to 31 Aug", amountCents: 132_000 }],
  reference: "case case-1 · ticket BILL-7",
});

function request(overrides: Partial<BillsPostRequest> = {}): BillsPostRequest {
  return {
    idempotencyKey: "bills-post:case-1:BILL-7",
    approvalReceipt: "rcpt-1",
    posting: POSTING,
    ...overrides,
  };
}

describe("MemoryBillsLedger", () => {
  it("posts a draft bill and replays it by idempotency key", async () => {
    const ledger = new MemoryBillsLedger();

    const first = await ledger.post(request());
    expect(first).toEqual({
      artifact: "memory:bills-post:case-1:BILL-7",
      billId: "memory-bill-1",
      billNumber: "INV-2041",
      created: true,
    });
    expect(ledger.posted).toEqual([POSTING]);

    const replay = await ledger.post(request());
    expect(replay).toEqual(first);
    expect(ledger.posted).toHaveLength(1);
  });

  it("numbers distinct bills in posting order", async () => {
    const ledger = new MemoryBillsLedger();

    await ledger.post(request());
    const second = await ledger.post(
      request({ idempotencyKey: "bills-post:case-2:BILL-8" }),
    );

    expect(second.billId).toBe("memory-bill-2");
    expect(ledger.posted).toHaveLength(2);
  });

  it("refuses a posting without a signed approval receipt", async () => {
    const ledger = new MemoryBillsLedger();

    const failure = await ledger.post(request({ approvalReceipt: "" })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BillsLedgerError);
    const error = failure as BillsLedgerError;
    expect(error.message).toBe("ledger: approval receipt required");
    expect(error.code).toBe("invalid");
    expect(error.retryable).toBe(false);
    expect(ledger.posted).toHaveLength(0);
  });

  it("has the memory provider name", () => {
    expect(new MemoryBillsLedger().provider).toBe("memory");
  });
});
