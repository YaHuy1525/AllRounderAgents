import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FinanceWorkflowInputSchema } from "./contracts.js";
import { createFinanceFlow } from "./flow.js";
import { FINANCE_FLOW_STEPS, MemorySandboxLedger } from "./workflow.js";
import { createAllRounderMastra } from "../../mastra.js";
import { fixtureFile } from "../../shared/fixtures.js";

interface FinanceFixture {
  period: string;
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
  expectedExceptions: Array<{ type: string; externalRef: string }>;
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

function financeWorkflow(ledger: MemorySandboxLedger) {
  return createAllRounderMastra({ ledger }).getWorkflow("financeFlow");
}

describe("Mastra financeFlow", () => {
  it("registers named recon-to-post steps", () => {
    const workflow = createFinanceFlow({ ledger: new MemorySandboxLedger() });
    expect(workflow.id).toBe("financeFlow");
    expect(Object.keys(workflow.steps)).toEqual([...FINANCE_FLOW_STEPS]);
  });

  it("is registered on the AllRounder Mastra instance", () => {
    const mastra = createAllRounderMastra({ ledger: new MemorySandboxLedger() });
    expect(mastra.getWorkflow("financeFlow").id).toBe("financeFlow");
  });

  it("suspends at approval and does not post until resumed with a receipt", async () => {
    const ledger = new MemorySandboxLedger();
    const workflow = financeWorkflow(ledger);
    const run = await workflow.createRun();
    const started = await run.start({ inputData: input() });
    expect(started.status).toBe("suspended");
    expect(ledger.posted).toHaveLength(0);
    if (started.status !== "suspended") throw new Error("expected suspend");
    expect(started.suspendPayload).toMatchObject({
      approval: {
        ticketKey: "SCRUM-5",
        posting: { ledger: "sandbox" },
      },
    });
    const exceptions = started.steps["detect-exceptions"];
    expect(exceptions?.status).toBe("success");
    if (exceptions?.status === "success") {
      expect(
        (exceptions.output as { exceptions: Array<{ externalRef: string }> }).exceptions
          .map((item) => item.externalRef)
          .sort(),
      ).toEqual(fixture.expectedExceptions.map((item) => item.externalRef).sort());
    }
  });

  it("posts a sandbox journal after an approved resume and replays idempotently", async () => {
    const ledger = new MemorySandboxLedger();
    const workflow = financeWorkflow(ledger);
    const firstRun = await workflow.createRun();
    const started = await firstRun.start({ inputData: input() });
    expect(started.status).toBe("suspended");
    const actionHash =
      started.status === "suspended"
        ? String((started.suspendPayload as { approval: { actionHash: string } }).approval.actionHash)
        : "";
    const first = await firstRun.resume({
      resumeData: { decision: "approved", receipt: `ok:${actionHash}` },
    });
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("expected success");
    expect(first.result.status).toBe("posted");
    expect(first.result.auditPack.findings.length).toBeGreaterThanOrEqual(3);
    expect(ledger.posted).toHaveLength(1);

    const secondRun = await workflow.createRun();
    const secondStart = await secondRun.start({ inputData: input() });
    expect(secondStart.status).toBe("suspended");
    const secondHash =
      secondStart.status === "suspended"
        ? String((secondStart.suspendPayload as { approval: { actionHash: string } }).approval.actionHash)
        : "";
    const second = await secondRun.resume({
      resumeData: { decision: "approved", receipt: `ok:${secondHash}` },
    });
    expect(second.status).toBe("success");
    expect(ledger.posted).toHaveLength(1);
    expect(actionHash).toBe(secondHash);
  });

  it("never posts when the approval resume is rejected", async () => {
    const ledger = new MemorySandboxLedger();
    const workflow = financeWorkflow(ledger);
    const run = await workflow.createRun();
    await run.start({ inputData: input() });
    const result = await run.resume({ resumeData: { decision: "rejected" } });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.result.status).toBe("escalated");
    expect(result.result.reason).toBe("approval_rejected");
    expect(ledger.posted).toHaveLength(0);
  });

  it("rejects non-integer money before any posting", async () => {
    expect(() =>
      FinanceWorkflowInputSchema.parse({
        ...input(),
        ledger: [{ ...fixture.ledger[0]!, amountCents: 10.5 }],
      }),
    ).toThrow();
    const ledger = new MemorySandboxLedger();
    const workflow = financeWorkflow(ledger);
    const run = await workflow.createRun();
    await expect(
      run.start({
        inputData: {
          ...input(),
          ledger: [{ ...fixture.ledger[0]!, amountCents: 10.5 }],
        },
      }),
    ).rejects.toThrow(/integer/i);
    expect(ledger.posted).toHaveLength(0);
  });

  it("closes a balanced recon for review without suspending a posting gate", async () => {
    const ledger = new MemorySandboxLedger();
    const workflow = financeWorkflow(ledger);
    const run = await workflow.createRun();
    const started = await run.start({
      inputData: {
        ...input(),
        bank: fixture.ledger,
      },
    });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.status).toBe("awaiting_approval");
    expect(started.result.reason).toBe("balanced_close_requires_review");
    expect(ledger.posted).toHaveLength(0);
  });
});
