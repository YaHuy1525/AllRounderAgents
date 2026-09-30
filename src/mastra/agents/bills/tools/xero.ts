import type { BillPosting } from "../contracts.js";
import {
  BillsLedgerError,
  type BillsLedger,
  type BillsPostRequest,
  type BillsPostResult,
} from "./ledger.js";

/**
 * The M4 ledger: vendor bills land in Xero as ACCPAY bills in DRAFT status.
 * A draft is the bounded blast radius — Xero assigns the real bill number on
 * approval there, and a draft can always be deleted, while the flow still
 * holds the human receipt that authorized the posting.
 *
 * Posting is idempotent by the flow's ledger key (the xero.post policy's
 * `ledgerKey`): a repeated key replays the recorded result instead of
 * creating a second draft. Xero has no native dedupe for draft bills, so the
 * effect map on the run plus this map are the replay guards. The invoice is
 * stamped with the vendor's bill number as its reference so a human can match
 * the draft against the email that produced it.
 */

export type XeroFetch = typeof fetch;

export interface HttpXeroLedgerOptions {
  /** Xero custom connection credentials (client_credentials grant). */
  readonly clientId: string;
  readonly clientSecret: string;
  /** The Xero organisation the bills land in (xero-tenant-id header). */
  readonly tenantId: string;
  /** Overrides for tests: the token and API origins. */
  readonly identityUrl?: string;
  readonly apiUrl?: string;
  readonly fetch?: XeroFetch;
  readonly timeoutMs?: number;
  /** Optional account code stamped on every line (e.g. "300"). */
  readonly accountCode?: string;
}

const DEFAULT_IDENTITY_URL = "https://identity.xero.com";
const DEFAULT_API_URL = "https://api.xero.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_SCOPE = "accounting.transactions";
/** Refresh the token this many milliseconds before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dollars(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export interface XeroBillState {
  readonly billId: string;
  readonly billNumber: string;
  readonly status: string;
}

export class HttpXeroLedger implements BillsLedger {
  readonly provider = "xero";
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tenantId: string;
  private readonly identityUrl: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: XeroFetch;
  private readonly timeoutMs: number;
  private readonly accountCode: string | undefined;
  private readonly receipts = new Map<string, BillsPostResult>();
  private token: { value: string; expiresAt: number } | null = null;

  constructor(options: HttpXeroLedgerOptions) {
    for (const [label, value] of [
      ["clientId", options.clientId],
      ["clientSecret", options.clientSecret],
      ["tenantId", options.tenantId],
    ] as const) {
      if (value.trim() === "") {
        throw new Error(`HttpXeroLedger: ${label} is required`);
      }
    }
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tenantId = options.tenantId;
    this.identityUrl = (options.identityUrl ?? DEFAULT_IDENTITY_URL).replace(/\/+$/, "");
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.accountCode = options.accountCode?.trim() || undefined;
  }

  async post(request: BillsPostRequest): Promise<BillsPostResult> {
    if (request.approvalReceipt.length === 0) {
      throw new BillsLedgerError("invalid", "approval receipt required");
    }
    const prior = this.receipts.get(request.idempotencyKey);
    if (prior !== undefined) return prior;
    const posting = request.posting;
    const payload = {
      Type: "ACCPAY",
      Status: "DRAFT",
      Contact: { Name: posting.vendorName },
      Date: posting.issueDate ?? isoDate(new Date()),
      DueDate: posting.dueDate,
      Reference: posting.billNumber,
      LineAmountTypes: "Inclusive",
      LineItems: this.lineItems(posting),
    };
    const body = await this.send("POST", "/api.xro/2.0/Invoices", payload);
    const invoices = isRecord(body) && Array.isArray(body.Invoices) ? body.Invoices : [];
    const invoice = invoices[0];
    if (!isRecord(invoice) || typeof invoice.InvoiceID !== "string") {
      throw new BillsLedgerError("rejected", "Xero returned no invoice for the posting");
    }
    const invoiceNumber =
      typeof invoice.InvoiceNumber === "string" && invoice.InvoiceNumber !== ""
        ? invoice.InvoiceNumber
        : posting.billNumber;
    const result: BillsPostResult = {
      artifact: `xero:DRAFT:${invoice.InvoiceID}`,
      billId: invoice.InvoiceID,
      billNumber: invoiceNumber,
      created: true,
    };
    this.receipts.set(request.idempotencyKey, result);
    return result;
  }

  /**
   * The read side of the seam (`xero.read` in policy/tools.yaml): one bill's
   * current state, or null when Xero knows no such bill. Read-only and
   * unauthenticated failures surface loudly because a caller acting on the
   * answer must never mistake "unreadable" for "absent".
   */
  async readBill(billId: string): Promise<XeroBillState | null> {
    if (billId.trim() === "") {
      throw new BillsLedgerError("invalid", "billId is required");
    }
    const body = await this.send("GET", `/api.xro/2.0/Invoices/${encodeURIComponent(billId)}`);
    const invoices = isRecord(body) && Array.isArray(body.Invoices) ? body.Invoices : [];
    const invoice = invoices[0];
    if (invoice === undefined) return null;
    if (!isRecord(invoice) || typeof invoice.InvoiceID !== "string") {
      throw new BillsLedgerError("rejected", "Xero returned an unreadable invoice");
    }
    return {
      billId: invoice.InvoiceID,
      billNumber: typeof invoice.InvoiceNumber === "string" ? invoice.InvoiceNumber : "",
      status: typeof invoice.Status === "string" ? invoice.Status : "",
    };
  }

  /**
   * Itemized lines when the extraction's lines sum to the stated total (a
   * human reviewing the draft sees the real breakdown); otherwise one line
   * carrying the total, so the posted amount always equals the approved one.
   */
  private lineItems(posting: BillPosting): Record<string, unknown>[] {
    const sum = posting.lineItems.reduce((total, line) => total + line.amountCents, 0);
    const lines =
      posting.lineItems.length > 0 && sum === posting.totalCents
        ? posting.lineItems.map((line) => ({
            description: line.description,
            amountCents: line.amountCents,
          }))
        : [
            {
              description: `Bill ${posting.billNumber} from ${posting.vendorName}`,
              amountCents: posting.totalCents,
            },
          ];
    return lines.map((line) => ({
      Description: line.description,
      Quantity: 1,
      UnitAmount: dollars(line.amountCents),
      ...(this.accountCode === undefined ? {} : { AccountCode: this.accountCode }),
    }));
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token !== null && this.token.expiresAt > now) return this.token.value;
    let payload: unknown;
    try {
      const response = await this.fetchImpl(`${this.identityUrl}/connect/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: TOKEN_SCOPE,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        throw new BillsLedgerError(
          "rejected",
          `Xero token request failed (HTTP ${response.status})`,
        );
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof BillsLedgerError) throw error;
      throw new BillsLedgerError(
        "unreachable",
        `Xero identity unreachable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const token = isRecord(payload) ? payload.access_token : undefined;
    const expiresIn = isRecord(payload) ? payload.expires_in : undefined;
    if (typeof token !== "string" || token === "") {
      throw new BillsLedgerError("rejected", "Xero token response carried no access_token");
    }
    const seconds = typeof expiresIn === "number" ? expiresIn : 1_800;
    this.token = { value: token, expiresAt: now + seconds * 1_000 - TOKEN_SKEW_MS };
    return token;
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "xero-tenant-id": this.tenantId,
          Accept: "application/json",
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BillsLedgerError(
        "unreachable",
        `Xero API unreachable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (response.status === 404) {
      return { Invoices: [] };
    }
    if (!response.ok) {
      // The body carries Xero's own validation detail; keep it short and
      // caller-safe (it lands in the run's failure message).
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        detail = "";
      }
      throw new BillsLedgerError(
        "rejected",
        `Xero ${method} ${path} failed (HTTP ${response.status}${detail === "" ? "" : `: ${detail}`})`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new BillsLedgerError(
        "rejected",
        `Xero ${method} ${path} returned a non-JSON body (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}
