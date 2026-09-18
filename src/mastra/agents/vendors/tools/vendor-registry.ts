/**
 * Vendor master-record surface for the vendors lane. `create` is idempotent
 * by tax-ID key: creating a record whose tax ID already exists returns the
 * stored record with `created: false` instead of doubling the master data.
 * The default in-memory implementation is the sandbox the tests and the
 * local host run against — the lane makes no network calls.
 */
export interface VendorMasterRecord {
  readonly vendorId: string;
  readonly legalName: string;
  readonly taxId: string;
  readonly country: string;
  readonly requestor: string;
  readonly status: "active";
  readonly effectiveDate: string;
  readonly createdAt: string;
}

export interface VendorCreateResult {
  readonly record: VendorMasterRecord;
  /** false when an existing record with the same tax ID was reused. */
  readonly created: boolean;
  readonly registryRef: string;
}

export interface VendorRegistry {
  /** Existing master records, used by the duplicate screening. */
  list(): Promise<readonly VendorMasterRecord[]>;
  get(taxId: string): Promise<VendorMasterRecord | null>;
  /** Idempotent by tax-ID key; `created` is false on a replay. */
  create(record: VendorMasterRecord): Promise<VendorCreateResult>;
}

export class MemoryVendorRegistry implements VendorRegistry {
  private readonly byTaxId = new Map<string, VendorMasterRecord>();

  constructor(seed: readonly VendorMasterRecord[] = []) {
    for (const record of seed) {
      this.byTaxId.set(record.taxId, record);
    }
  }

  async list(): Promise<readonly VendorMasterRecord[]> {
    return [...this.byTaxId.values()];
  }

  async get(taxId: string): Promise<VendorMasterRecord | null> {
    return this.byTaxId.get(taxId) ?? null;
  }

  async create(record: VendorMasterRecord): Promise<VendorCreateResult> {
    const existing = this.byTaxId.get(record.taxId);
    if (existing !== undefined) {
      return {
        record: existing,
        created: false,
        registryRef: `vendor-registry:${existing.vendorId}`,
      };
    }
    this.byTaxId.set(record.taxId, record);
    return {
      record,
      created: true,
      registryRef: `vendor-registry:${record.vendorId}`,
    };
  }
}
