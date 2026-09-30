import { describe, expect, it } from "vitest";

import { BillPostingSchema, type BillPosting } from "../contracts.js";
import { BillsLedgerError, type BillsPostRequest } from "./ledger.js";
import { HttpXeroLedger, type XeroFetch } from "./xero.js";

const IDENTITY_URL = "https://identity.example/";
const API_URL = "https://api.example/";
const CLIENT_ID = "client-id";
const CLIENT_SECRET = "client-secret";
const XERO_TENANT = "xero-tenant-1";

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

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  tenantId: string;
  body: unknown;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenResponse(token = "tok-1", expiresIn = 1_800): Response {
  return jsonResponse(200, { access_token: token, expires_in: expiresIn });
}

/**
 * Recorded-fixture Xero: answers the token and API calls by URL, recording
 * every request so the wire contract (basic auth, scope, tenant header, bill
 * payload) is pinned without a network.
 */
class FakeXeroApi {
  readonly requests: RecordedRequest[] = [];
  private tokenScript: Response | Error = tokenResponse();
  private apiScripts: Array<Response | Error> = [];

  tokenResponds(response: Response | Error): void {
    this.tokenScript = response;
  }

  respondWith(response: Response | Error): void {
    this.apiScripts.push(response);
  }

  readonly fetch: XeroFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const record = {
      method: init?.method ?? "GET",
      url,
      authorization: headers.get("Authorization") ?? "",
      tenantId: headers.get("xero-tenant-id") ?? "",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    if (url.includes("/connect/token")) {
      this.requests.push({ ...record, body: Object.fromEntries(new URLSearchParams(record.body)) });
      if (this.tokenScript instanceof Error) throw this.tokenScript;
      return this.tokenScript;
    }
    this.requests.push({
      ...record,
      body: record.body === undefined ? undefined : JSON.parse(record.body),
    });
    const scripted = this.apiScripts.shift();
    if (scripted === undefined) throw new Error("FakeXeroApi: no scripted response");
    if (scripted instanceof Error) throw scripted;
    return scripted;
  };
}

function ledger(api: FakeXeroApi, accountCode?: string): HttpXeroLedger {
  return new HttpXeroLedger({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tenantId: XERO_TENANT,
    identityUrl: IDENTITY_URL,
    apiUrl: API_URL,
    fetch: api.fetch,
    ...(accountCode === undefined ? {} : { accountCode }),
  });
}

const TOKEN_CALL = {
  method: "POST",
  url: "https://identity.example/connect/token",
  authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
  tenantId: "",
  body: { grant_type: "client_credentials", scope: "accounting.transactions" },
};

describe("HttpXeroLedger", () => {
  it("posts an ACCPAY draft with the bill number as its reference", async () => {
    const api = new FakeXeroApi();
    api.respondWith(
      jsonResponse(200, { Invoices: [{ InvoiceID: "inv-1", InvoiceNumber: "INV-42" }] }),
    );

    const result = await ledger(api).post(request());

    expect(result).toEqual({
      artifact: "xero:DRAFT:inv-1",
      billId: "inv-1",
      billNumber: "INV-42",
      created: true,
    });
    expect(api.requests).toEqual([
      TOKEN_CALL,
      {
        method: "POST",
        url: "https://api.example/api.xro/2.0/Invoices",
        authorization: "Bearer tok-1",
        tenantId: XERO_TENANT,
        body: {
          Type: "ACCPAY",
          Status: "DRAFT",
          Contact: { Name: "Acme Power Pty Ltd" },
          Date: "2026-09-01",
          DueDate: "2026-09-15",
          Reference: "INV-2041",
          LineAmountTypes: "Inclusive",
          LineItems: [
            { Description: "Electricity 1 Aug to 31 Aug", Quantity: 1, UnitAmount: 1320 },
          ],
        },
      },
    ]);
  });

  it("falls back to one total line when the lines do not sum to the total", async () => {
    const api = new FakeXeroApi();
    api.respondWith(jsonResponse(200, { Invoices: [{ InvoiceID: "inv-1" }] }));

    const result = await ledger(api).post(
      request({
        posting: {
          ...POSTING,
          lineItems: [{ description: "Electricity", amountCents: 100_000 }],
        },
      }),
    );

    // Xero assigned no number: the flow's bill number carries through.
    expect(result.billNumber).toBe("INV-2041");
    const [, invoice] = api.requests;
    expect(invoice?.body).toMatchObject({
      LineItems: [
        { Description: "Bill INV-2041 from Acme Power Pty Ltd", Quantity: 1, UnitAmount: 1320 },
      ],
    });
  });

  it("stamps the configured account code on every line", async () => {
    const api = new FakeXeroApi();
    api.respondWith(jsonResponse(200, { Invoices: [{ InvoiceID: "inv-1" }] }));

    await ledger(api, "300").post(request());

    const [, invoice] = api.requests;
    expect(invoice?.body).toMatchObject({
      LineItems: [
        { Description: "Electricity 1 Aug to 31 Aug", AccountCode: "300" },
      ],
    });
  });

  it("reuses the cached token and replays a recorded posting without HTTP", async () => {
    const api = new FakeXeroApi();
    api.respondWith(jsonResponse(200, { Invoices: [{ InvoiceID: "inv-1" }] }));
    api.respondWith(
      jsonResponse(200, {
        Invoices: [{ InvoiceID: "inv-1", InvoiceNumber: "INV-42", Status: "DRAFT" }],
      }),
    );
    const xero = ledger(api);

    const first = await xero.post(request());
    const state = await xero.readBill("inv-1");
    const replay = await xero.post(request());

    expect(state).toEqual({ billId: "inv-1", billNumber: "INV-42", status: "DRAFT" });
    expect(replay).toEqual(first);
    // One token call for both posts and the read; the replay made no call.
    expect(api.requests.filter((call) => call.url.includes("/connect/token"))).toHaveLength(1);
    expect(api.requests.filter((call) => call.method === "POST")).toHaveLength(2);
  });

  it("reads a bill and treats a 404 as absent", async () => {
    const api = new FakeXeroApi();
    api.respondWith(new Response("", { status: 404 }));

    const missing = await ledger(api).readBill("inv-404");
    expect(missing).toBeNull();

    const echoed = api.requests[1]!;
    expect(echoed.method).toBe("GET");
    expect(echoed.url).toBe("https://api.example/api.xro/2.0/Invoices/inv-404");
  });

  it("refuses a posting without a signed approval receipt before any call", async () => {
    const api = new FakeXeroApi();

    const failure = await ledger(api).post(request({ approvalReceipt: "" })).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BillsLedgerError);
    expect((failure as BillsLedgerError).message).toBe("ledger: approval receipt required");
    expect(api.requests).toEqual([]);
  });

  it("surfaces token and API failures as ledger errors", async () => {
    const tokenApi = new FakeXeroApi();
    tokenApi.tokenResponds(jsonResponse(401, { error: "invalid_client" }));
    const tokenFailure = await ledger(tokenApi).post(request()).catch((error: unknown) => error);
    expect(tokenFailure).toBeInstanceOf(BillsLedgerError);
    expect((tokenFailure as BillsLedgerError).message).toContain("token request failed (HTTP 401)");

    const rejectedApi = new FakeXeroApi();
    rejectedApi.respondWith(new Response('{"Message":"Validation failed"}', { status: 400 }));
    const rejected = await ledger(rejectedApi).post(request()).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(BillsLedgerError);
    expect((rejected as BillsLedgerError).message).toContain("HTTP 400");

    const emptyApi = new FakeXeroApi();
    emptyApi.respondWith(jsonResponse(200, { Invoices: [] }));
    const empty = await ledger(emptyApi).post(request()).catch((error: unknown) => error);
    expect(empty).toBeInstanceOf(BillsLedgerError);
    expect((empty as BillsLedgerError).message).toContain("no invoice");

    const downApi = new FakeXeroApi();
    downApi.respondWith(new Error("socket hang up"));
    const down = await ledger(downApi).post(request()).catch((error: unknown) => error);
    expect(down).toBeInstanceOf(BillsLedgerError);
    expect((down as BillsLedgerError).message).toContain("unreachable");
  });

  it("requires credentials before it is constructed", () => {
    const base = {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      tenantId: XERO_TENANT,
    };
    expect(() => new HttpXeroLedger({ ...base, clientId: " " })).toThrow(/clientId/);
    expect(() => new HttpXeroLedger({ ...base, clientSecret: "" })).toThrow(/clientSecret/);
    expect(() => new HttpXeroLedger({ ...base, tenantId: "" })).toThrow(/tenantId/);
    expect(new HttpXeroLedger(base).provider).toBe("xero");
  });
});
