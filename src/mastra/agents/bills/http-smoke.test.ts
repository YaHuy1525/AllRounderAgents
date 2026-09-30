import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import {
  BillModelOutputSchema,
  BillPostingSchema,
  BILLS_FLOW_STEPS,
  BillsRunStateSchema,
  type BillModelOutput,
  type BillsRunState,
} from "./contracts.js";
import type { BillModel } from "./flow.js";
import { HttpXeroLedger } from "./tools/xero.js";
import { MemoryVendorRegistry, type MemoryVendorEntry } from "./tools/vendors.js";

/**
 * The M4 HTTP smoke: one vendor email walks the full bills flow (intake ->
 * extract -> approve -> post) against the real HttpXeroLedger, which talks to
 * a locally bound Xero stand-in over real sockets. No model key and no Xero
 * credentials, but everything between the flow and the wire is production
 * code: URL joining, the token grant, the tenant header, the draft payload
 * and the idempotent replay.
 */

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-30T09:00:00.000Z");
const LEDGER_KEY = "bills-post:bill-acmepower-482913:BILL-482913";

const EMAIL = {
  messageId: "smoke-mail-1",
  from: "billing@acmepower.com.au",
  fromName: "Acme Power Billing",
  to: "bills@in.mspco.example",
  subject: "Invoice INV-2041 for August usage",
  text: "Attached is invoice INV-2041 for AUD 1,320.00 including GST. Payment to Acme Power Pty Ltd, BSB 012-345, account 12345678.",
  receivedAt: "2026-09-30T08:55:00.000Z",
} as const;

const HAPPY_BILL: BillModelOutput = {
  vendor: {
    name: "Acme Power Pty Ltd",
    accountName: "Acme Power Pty Ltd",
    bsb: "012-345",
    accountNumber: "12345678",
  },
  bill: {
    number: "INV-2041",
    issueDate: "2026-09-01",
    dueDate: "2026-09-15",
    currency: "AUD",
    totalCents: 132_000,
    taxCents: 12_000,
    lineItems: [{ description: "Electricity 1 Aug to 31 Aug", amountCents: 132_000 }],
  },
};

const REGISTERED_VENDOR: MemoryVendorEntry = {
  ref: "acmepower",
  name: "Acme Power Pty Ltd",
  accountName: "Acme Power Pty Ltd",
  bsb: "012345",
  accountNumber: "12345678",
  emails: ["billing@acmepower.com.au"],
};

class FixedModel implements BillModel {
  async extract(): Promise<BillModelOutput> {
    return BillModelOutputSchema.parse(HAPPY_BILL);
  }
}

interface RecordedCall {
  method: string;
  path: string;
  authorization: string;
  tenantId: string;
  body: string;
}

/** A locally bound Xero stand-in: real HTTP, recorded calls, canned drafts. */
class StubXero {
  readonly calls: RecordedCall[] = [];
  port = 0;
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
        this.calls.push({
          method: request.method ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization ?? "",
          tenantId: String(request.headers["xero-tenant-id"] ?? ""),
          body,
        });
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/connect/token") {
          response.end(JSON.stringify({ access_token: "stub-token", expires_in: 1_800 }));
          return;
        }
        response.end(
          JSON.stringify({
            Invoices: [{ InvoiceID: "draft-1", InvoiceNumber: "INV-2041", Status: "DRAFT" }],
          }),
        );
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.port = typeof address === "object" && address !== null ? address.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

interface Suspension {
  artifact: Record<string, unknown>;
  effects?: Record<string, Record<string, unknown>>;
}

function suspendAt(outcome: unknown, stepId: string): Suspension {
  const view = outcome as {
    status?: string;
    suspendPayload?: Record<string, Suspension | undefined>;
  };
  const payload = view.status === "suspended" ? view.suspendPayload?.[stepId] : undefined;
  if (payload?.artifact === undefined) {
    throw new Error(`no suspension at ${stepId} (status ${String(view.status)})`);
  }
  return payload;
}

interface Completion {
  status?: string;
  result?: {
    receipt?: Record<string, unknown>;
    effects?: Record<string, Record<string, unknown>>;
  };
}

describe("bills lane HTTP smoke: vendor email to Xero draft receipt", () => {
  it("posts a DRAFT ACCPAY through the real ledger over sockets, replay safe", async () => {
    const xero = new StubXero();
    await xero.start();
    try {
      const base = `http://127.0.0.1:${xero.port}`;
      const ledger = new HttpXeroLedger({
        clientId: "smoke-client",
        clientSecret: "smoke-secret",
        tenantId: "smoke-org",
        identityUrl: base,
        apiUrl: base,
        accountCode: "300",
      });
      const mastra = createAllRounderMastra({
        bills: {
          ledger,
          registry: new MemoryVendorRegistry([REGISTERED_VENDOR]),
          model: new FixedModel(),
          now: () => FIXED_NOW,
        },
      });
      const flow = mastra.getWorkflow("billsFlow");
      if (flow === undefined) throw new Error("billsFlow is not registered");
      const run = await flow.createRun();

      const decisions: Record<string, Record<string, unknown>> = {};
      const artifacts: Record<string, Record<string, unknown>> = {};
      let effects: Record<string, Record<string, unknown>> = {};
      const envelope = (): BillsRunState =>
        BillsRunStateSchema.parse({
          runId: "smoke-run-1",
          workflow: "bills",
          ticketKey: "BILL-482913",
          caseId: "bill-acmepower-482913",
          attempt: 1,
          input: EMAIL,
          decisions,
          artifacts,
          effects,
        });

      let outcome: unknown = await run.start({ inputData: envelope() });
      let payload = suspendAt(outcome, BILLS_FLOW_STEPS[0]);
      for (let index = 0; index < BILLS_FLOW_STEPS.length; index += 1) {
        const stepId = BILLS_FLOW_STEPS[index]!;
        artifacts[stepId] = payload.artifact;
        if (payload.effects !== undefined) effects = { ...effects, ...payload.effects };
        const decision = { action: "proceed", actionHash: PROCEED_HASH, receiptId: "rcpt-smoke" };
        decisions[stepId] = decision;
        outcome = await run.resume({
          resumeData: BillsRunStateSchema.parse({ ...envelope(), decision }),
        });
        if (index < BILLS_FLOW_STEPS.length - 1) {
          payload = suspendAt(outcome, BILLS_FLOW_STEPS[index + 1]!);
        }
      }

      const done = outcome as Completion;
      expect(done.status).toBe("success");
      expect(done.result?.receipt).toMatchObject({
        caseId: "bill-acmepower-482913",
        ticketKey: "BILL-482913",
        vendorRef: "acmepower",
        vendorEmail: "billing@acmepower.com.au",
        provider: "xero",
        ledgerKey: LEDGER_KEY,
        billId: "draft-1",
        billNumber: "INV-2041",
        currency: "AUD",
        totalCents: 132_000,
        billCreated: true,
        escalations: [],
        postedAt: FIXED_NOW.toISOString(),
      });
      expect(done.result?.effects?.post?.receipt).toEqual(done.result?.receipt);

      // The wire: the client_credentials grant, then the draft over the socket.
      const token = xero.calls.find((call) => call.path === "/connect/token");
      expect(token?.authorization).toBe(
        `Basic ${Buffer.from("smoke-client:smoke-secret").toString("base64")}`,
      );
      expect(token?.body).toContain("grant_type=client_credentials");
      expect(token?.body).toContain("scope=accounting.transactions");

      const posted = xero.calls.filter(
        (call) => call.method === "POST" && call.path === "/api.xro/2.0/Invoices",
      );
      expect(posted).toHaveLength(1);
      expect(posted[0]?.authorization).toBe("Bearer stub-token");
      expect(posted[0]?.tenantId).toBe("smoke-org");
      const body = JSON.parse(posted[0]?.body ?? "{}") as Record<string, unknown>;
      expect(body).toMatchObject({
        Type: "ACCPAY",
        Status: "DRAFT",
        Reference: "INV-2041",
        DueDate: "2026-09-15",
        LineAmountTypes: "Inclusive",
      });
      expect(body.LineItems).toEqual([
        {
          Description: "Electricity 1 Aug to 31 Aug",
          Quantity: 1,
          UnitAmount: 1_320,
          AccountCode: "300",
        },
      ]);

      // Replay safety: the same ledger key never creates a second draft.
      const posting = BillPostingSchema.parse({
        vendorName: "Acme Power Pty Ltd",
        vendorEmail: "billing@acmepower.com.au",
        billNumber: "INV-2041",
        issueDate: "2026-09-01",
        dueDate: "2026-09-15",
        currency: "AUD",
        totalCents: 132_000,
        taxCents: 12_000,
        lineItems: [{ description: "Electricity 1 Aug to 31 Aug", amountCents: 132_000 }],
        reference: "case bill-acmepower-482913 · ticket BILL-482913",
      });
      const replay = await ledger.post({
        idempotencyKey: LEDGER_KEY,
        approvalReceipt: "rcpt-smoke",
        posting,
      });
      expect(replay.billId).toBe("draft-1");
      expect(
        xero.calls.filter(
          (call) => call.method === "POST" && call.path === "/api.xro/2.0/Invoices",
        ),
      ).toHaveLength(1);
    } finally {
      await xero.stop();
    }
  });
});
