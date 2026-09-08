import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DeterministicSupportModel,
  FakeApprovalGate,
  FakeSupportRetriever,
  MemorySupportSender,
  SupportWorkflow,
  SupportWorkflowInputSchema,
  pilotMetrics,
} from "./workflow.js";
import { fixtureFile } from "../../shared/fixtures.js";

const input = SupportWorkflowInputSchema.parse({
  caseId: "case-1",
  tenantId: "tenant-a",
  ticketKey: "SUP-1",
  query: "How long do refunds take?",
});

describe("support workflow", () => {
  it("suspends a cited draft and sends only after approval", async () => {
    const sender = new MemorySupportSender();
    const gate = new FakeApprovalGate("approved");
    const workflow = new SupportWorkflow(
      new FakeSupportRetriever([
        {
          content: "Refunds take five days.",
          score: 0.9,
          stale: false,
          citation: { sourceId: "refunds", span: "0-24" },
        },
      ]),
      new DeterministicSupportModel(),
      gate,
      sender,
    );
    const result = await workflow.run(input);
    expect(result.status).toBe("sent");
    expect(result.citations).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
    expect(gate.suspended).toHaveLength(1);
  });

  it.each(["rejected", "expired"] as const)(
    "%s approval never sends",
    async (decision) => {
      const sender = new MemorySupportSender();
      const result = await new SupportWorkflow(
        new FakeSupportRetriever([
          {
            content: "Known answer.",
            score: 0.9,
            stale: false,
            citation: { sourceId: "doc", span: "0-13" },
          },
        ]),
        new DeterministicSupportModel(),
        new FakeApprovalGate(decision),
        sender,
      ).run(input);
      expect(result.status).toBe("escalated");
      expect(sender.sent).toHaveLength(0);
    },
  );

  it("empty retrieval and unsupported claims escalate", async () => {
    const empty = await new SupportWorkflow(
      new FakeSupportRetriever([]),
      new DeterministicSupportModel(),
      new FakeApprovalGate("approved"),
      new MemorySupportSender(),
    ).run(input);
    expect(empty.status).toBe("escalated");

    const unsupported = await new SupportWorkflow(
      new FakeSupportRetriever([
        {
          content: "Known answer.",
          score: 0.9,
          stale: false,
          citation: { sourceId: "doc", span: "0-13" },
        },
      ]),
      { draft: async () => ({ text: "Invented uncited claim", claimCitations: [] }) },
      new FakeApprovalGate("approved"),
      new MemorySupportSender(),
    ).run(input);
    expect(unsupported.status).toBe("escalated");
  });

  it("is bounded and duplicate sends are idempotent", async () => {
    const sender = new MemorySupportSender();
    const workflow = new SupportWorkflow(
      new FakeSupportRetriever([
        {
          content: "Known answer.",
          score: 0.9,
          stale: false,
          citation: { sourceId: "doc", span: "0-13" },
        },
      ]),
      new DeterministicSupportModel(),
      new FakeApprovalGate("approved"),
      sender,
    );
    await workflow.run(input);
    await workflow.run(input);
    expect(sender.sent).toHaveLength(1);
  });
});

describe("20-ticket pilot", () => {
  it("records containment and escalation precision", () => {
    const fixtures = JSON.parse(
      readFileSync(fixtureFile("phase1_support_pilot.json"), "utf8"),
    ) as Array<{
      id: string;
      expectedEscalation: boolean;
      status: "sent" | "escalated";
    }>;
    expect(pilotMetrics(fixtures)).toEqual({
      total: 20,
      contained: 15,
      escalated: 5,
      containmentRate: 0.75,
      escalationPrecision: 1,
    });
  });
});
