/**
 * Deprovisioning surface for the offboarding lane. `revoke` is idempotent by
 * `(employeeId, system)`: revoking a system that is already revoked returns
 * the stored entry with `created: false` instead of writing twice, and
 * `attest` is idempotent by employee id. Seeded `failures` make a system fail
 * deterministically so the lane's "failures are listed, never swallowed"
 * path can be exercised. The default in-memory implementation is the sandbox
 * the tests and the local host run against — the lane makes no network calls.
 */

export interface RevocationEntry {
  readonly employeeId: string;
  readonly system: string;
  readonly status: "revoked";
  readonly detail: string;
  readonly revokedAt: string;
}

export interface RevokeResult {
  readonly entry: RevocationEntry;
  /** false when the system was already revoked (idempotent replay). */
  readonly created: boolean;
}

export interface AttestationRecord {
  readonly employeeId: string;
  readonly offboardingId: string;
  readonly lastDay: string;
  readonly revokedSystems: readonly string[];
  readonly failedSystems: readonly string[];
  readonly equipmentOutstanding: readonly string[];
  readonly finalPayReady: boolean;
  readonly closedAt: string;
}

export interface AttestResult {
  readonly record: AttestationRecord;
  /** false when the case was already attested (idempotent replay). */
  readonly created: boolean;
}

export interface OffboardingRegistry {
  /** Systems already revoked for the employee, sorted. */
  revokedSystems(employeeId: string): Promise<readonly string[]>;
  /**
   * Idempotent by `(employeeId, system)`. A seeded failure throws the
   * configured reason before anything is written.
   */
  revoke(request: {
    employeeId: string;
    system: string;
    detail: string;
    revokedAt: string;
  }): Promise<RevokeResult>;
  attestation(employeeId: string): Promise<AttestationRecord | null>;
  /** Idempotent by employee id; `created` is false on a replay. */
  attest(record: AttestationRecord): Promise<AttestResult>;
}

export class MemoryOffboardingRegistry implements OffboardingRegistry {
  private readonly revocations = new Map<string, Map<string, RevocationEntry>>();
  private readonly attestations = new Map<string, AttestationRecord>();
  private readonly failures: ReadonlyMap<string, string>;

  constructor(
    input: { failures?: ReadonlyMap<string, string> | Record<string, string> } = {},
  ) {
    const failures = input.failures ?? {};
    this.failures = failures instanceof Map ? failures : new Map(Object.entries(failures));
  }

  async revokedSystems(employeeId: string): Promise<readonly string[]> {
    return [...(this.revocations.get(employeeId)?.keys() ?? [])].sort();
  }

  async revoke(request: {
    employeeId: string;
    system: string;
    detail: string;
    revokedAt: string;
  }): Promise<RevokeResult> {
    const reason = this.failures.get(request.system);
    if (reason !== undefined) {
      throw new Error(reason);
    }
    const bySystem =
      this.revocations.get(request.employeeId) ?? new Map<string, RevocationEntry>();
    const existing = bySystem.get(request.system);
    if (existing !== undefined) {
      return { entry: existing, created: false };
    }
    const entry: RevocationEntry = {
      employeeId: request.employeeId,
      system: request.system,
      status: "revoked",
      detail: request.detail,
      revokedAt: request.revokedAt,
    };
    bySystem.set(request.system, entry);
    this.revocations.set(request.employeeId, bySystem);
    return { entry, created: true };
  }

  async attestation(employeeId: string): Promise<AttestationRecord | null> {
    return this.attestations.get(employeeId) ?? null;
  }

  async attest(record: AttestationRecord): Promise<AttestResult> {
    const existing = this.attestations.get(record.employeeId);
    if (existing !== undefined) {
      return { record: existing, created: false };
    }
    this.attestations.set(record.employeeId, record);
    return { record, created: true };
  }
}
