import type { AccessTier } from "../../hr/directory.js";

/**
 * HRIS provisioning surface for the onboarding lane. `provision` is idempotent
 * by employee id: provisioning an employee whose record already exists returns
 * the stored record with `created: false` instead of doubling the accounts,
 * equipment ticket, or payroll enrollment. The default in-memory
 * implementation is the sandbox the tests and the local host run against — the
 * lane makes no network calls.
 */
export interface ProvisionedEmployee {
  readonly employeeId: string;
  /** Redacted initials only — the directory stores the raw name, not this. */
  readonly label: string;
  readonly roleTitle: string;
  readonly department: string;
  readonly location: string;
  readonly managerId: string | null;
  readonly accessTier: AccessTier;
  readonly effectiveDate: string;
  readonly accounts: readonly string[];
  readonly equipmentTicketId: string;
  readonly payrollEnrollmentId: string;
  readonly status: "onboarding";
  readonly createdAt: string;
}

export interface OnboardingCreateResult {
  readonly employee: ProvisionedEmployee;
  /** false when an existing record with the same employee id was reused. */
  readonly created: boolean;
  readonly registryRef: string;
}

export interface OnboardingRegistry {
  get(employeeId: string): Promise<ProvisionedEmployee | null>;
  /** Idempotent by employee id; `created` is false on a replay. */
  provision(record: ProvisionedEmployee): Promise<OnboardingCreateResult>;
}

export class MemoryOnboardingRegistry implements OnboardingRegistry {
  private readonly byEmployeeId = new Map<string, ProvisionedEmployee>();

  constructor(seed: readonly ProvisionedEmployee[] = []) {
    for (const record of seed) {
      this.byEmployeeId.set(record.employeeId, record);
    }
  }

  async get(employeeId: string): Promise<ProvisionedEmployee | null> {
    return this.byEmployeeId.get(employeeId) ?? null;
  }

  async provision(record: ProvisionedEmployee): Promise<OnboardingCreateResult> {
    const existing = this.byEmployeeId.get(record.employeeId);
    if (existing !== undefined) {
      return {
        employee: existing,
        created: false,
        registryRef: `hris:${existing.employeeId}`,
      };
    }
    this.byEmployeeId.set(record.employeeId, record);
    return {
      employee: record,
      created: true,
      registryRef: `hris:${record.employeeId}`,
    };
  }
}
