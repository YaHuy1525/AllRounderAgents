import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FinanceWorkflowInputSchema } from "./contracts.js";
import {
  FakeFinanceApprovalGate,
  FinanceWorkflow,
  MemorySandboxLedger,
  reconcile,
} from "./workflow.js";
import { fixtureFile } from "../../shared/fixtures.js";

interface FinanceFixture {
  period: string;
  currency: string;
  ledger: Array<{
    account: string;
    amountCents: number;
    currency: string;
    externalRef: string;
  }>;
  bank: Array<{
    account: string;
    amountCents: number;
    currency: string;
    externalRef: string;
  }>;
  expectedExceptions: Array<{ type: string; externalRef: string; specialist: string }>;
}

const fixture = JSON.parse(
  readFileSync(fixtureFile("phase3_finance.json"), "utf8"),
) as FinanceFixture;

function input() {
  return {
    caseId: "case-fin-1",
    tenantId: "tenant-a",
    ticketKey: "SCRUM-5",
    period: fixture.period,
    ledger: fixture.ledger,
    bank: fixture.bank,
  };
}

describe("finance workflow", () => {
  it("exposes named recon-to-post steps", () => {
    const workflow = new FinanceWorkflow(
      new FakeFinanceApprovalGate("approved"),
      new MemorySandboxLedger(),
    );
    expect(workflow.steps.map((step) => step.id)).toEqual([
      "load-context",
      "reconcile",
      "detect-exceptions",
      "rca",
      "specialist-fanout",
      "merge",
      "audit",
      "approval",
      "sandbox-post",
    ]);
  });

  it("reconciles the month-end sample into three exceptions", () => {
    const exceptions = reconcile(fixture.ledger, fixture.bank);
    expect(exceptions.map((item) => `${item.type}:${item.externalRef}`).sort()).toEqual(
      fixture.expectedExceptions.map((item) => `${item.type}:${item.externalRef}`).sort(),
    );
    expect(exceptions.every((item) => Number.isInteger(item.deltaCents))).toBe(true);
  });

  it("rejects non-integer money before any posting", () => {
    expect(() =>
      FinanceWorkflowInputSchema.parse({
        ...input(),
        ledger: [{ ...fixture.ledger[0]!, amountCents: 10.5 }],
      }),
    ).toThrow();
  });

  it("never posts without an approved receipt", async () => {
    const ledger = new MemorySandboxLedger();
    const workflow = new FinanceWorkflow(new FakeFinanceApprovalGate("rejected"), ledger);
    const result = await workflow.run(input());
    expect(result.status).toBe("escalated");
    expect(result.reason).toBe("approval_rejected");
    expect(ledger.posted).toHaveLength(0);
    await expect(
      ledger.post({
        idempotencyKey: "x".repeat(64),
        approvalReceipt: "",
        posting: result.posting!,
      }),
    ).rejects.toThrow(/approval receipt/i);
  });

  it("posts a sandbox journal after approval and replays idempotently", async () => {
    const approvals = new FakeFinanceApprovalGate("approved");
    const ledger = new MemorySandboxLedger();
    const workflow = new FinanceWorkflow(approvals, ledger);
    const first = await workflow.run(input());
    const second = await workflow.run(input());
    expect(first.status).toBe("posted");
    expect(second.status).toBe("posted");
    expect(first.posting?.ledger).toBe("sandbox");
    expect(ledger.posted).toHaveLength(1);
    expect(first.auditPack.checks.every((check) => check.passed)).toBe(true);
    expect(first.auditPack.findings.length).toBeGreaterThanOrEqual(3);
    expect(approvals.suspended).toHaveLength(2);
    expect(approvals.suspended[0]?.actionHash).toBe(approvals.suspended[1]?.actionHash);
  });
});
