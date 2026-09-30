import { VendorRecordSchema, type VendorRecord } from "../contracts.js";

/**
 * The vendor registry seam: the extract step asks which registered vendor a
 * sender address belongs to, so the bill's remittance details can be compared
 * against the registered ones. The memory implementation backs the M4 sandbox
 * and the tests; `HttpVendorRegistry` reads the platform registry over the
 * service-to-service route (`POST /msp/vendors/lookup`).
 */

export interface VendorLookup {
  /** The MSP tenant whose registry to search; null when the run carries none. */
  readonly tenantId: string | null;
  /** The sender address on the bill email. */
  readonly email: string;
}

export interface VendorRegistry {
  lookup(query: VendorLookup): Promise<VendorRecord | null>;
}

export interface MemoryVendorEntry extends VendorRecord {
  /** Every address the vendor bills from; matched case-insensitively. */
  readonly emails: readonly string[];
}

/** The in-memory registry: exact records, case-insensitive email match. */
export class MemoryVendorRegistry implements VendorRegistry {
  private readonly entries: MemoryVendorEntry[];

  constructor(entries: readonly MemoryVendorEntry[] = []) {
    this.entries = [...entries];
  }

  async lookup(query: VendorLookup): Promise<VendorRecord | null> {
    const email = query.email.trim().toLowerCase();
    const entry = this.entries.find((item) =>
      item.emails.some((candidate) => candidate.trim().toLowerCase() === email),
    );
    if (entry === undefined) return null;
    return {
      ref: entry.ref,
      name: entry.name,
      accountName: entry.accountName,
      bsb: entry.bsb,
      accountNumber: entry.accountNumber,
    };
  }
}

/** Transport seam: global fetch in production, recorded fixtures in tests. */
export type VendorFetch = typeof fetch;

export interface HttpVendorRegistryOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: VendorFetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Vendor registry over the platform API's service-to-service lookup route
 * (`POST /msp/vendors/lookup`, shared bearer token; the same bridge the
 * knowledge seam uses). The tenant scopes the lookup and the sender address
 * is the key inside it.
 *
 * Every failure degrades to `null` instead of an exception: an unreachable or
 * unconfigured registry must surface as the lane's `vendor_unverified`
 * escalation, where a human sees it, rather than fail the extract step. A
 * response the VendorRecord contract cannot parse is treated as no match at
 * all, because partial trust is worse than a human review.
 */
export class HttpVendorRegistry implements VendorRegistry {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: VendorFetch;
  private readonly timeoutMs: number;

  constructor(options: HttpVendorRegistryOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (this.baseUrl === "") {
      throw new Error("HttpVendorRegistry: baseUrl is required");
    }
    this.serviceToken = options.serviceToken;
    if (this.serviceToken === "") {
      throw new Error("HttpVendorRegistry: serviceToken is required");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async lookup(query: VendorLookup): Promise<VendorRecord | null> {
    const tenantId = query.tenantId?.trim();
    if (tenantId === undefined || tenantId === "") {
      console.warn(
        "[mastra] vendor lookup skipped: the run carries no tenantId, so the"
          + " registry cannot be scoped; the bill escalates as vendor_unverified.",
      );
      return null;
    }
    let payload: unknown;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/msp/vendors/lookup`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.serviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tenantId, email: query.email }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        console.warn(
          `[mastra] vendor lookup failed (HTTP ${response.status}); the bill escalates as vendor_unverified.`,
        );
        return null;
      }
      payload = await response.json();
    } catch (error) {
      console.warn(
        "[mastra] vendor lookup failed"
          + ` (${error instanceof Error ? error.message : String(error)});`
          + " the bill escalates as vendor_unverified.",
      );
      return null;
    }
    const vendor = isRecord(payload) ? payload.vendor : undefined;
    if (vendor === undefined || vendor === null) return null;
    const parsed = VendorRecordSchema.safeParse(vendor);
    if (!parsed.success) {
      console.warn(
        "[mastra] vendor lookup returned a record outside the VendorRecord"
          + " contract; the bill escalates as vendor_unverified.",
      );
      return null;
    }
    return parsed.data;
  }
}
