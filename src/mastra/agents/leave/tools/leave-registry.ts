/**
 * Leave calendar surface for the leave lane. `apply` is idempotent by request
 * id: applying a request whose entry already exists returns the stored entry
 * with `created: false` instead of double-booking the calendar. The default
 * in-memory implementation is the sandbox the tests and the local host run
 * against — the lane makes no network calls.
 */
export interface LeaveEntry {
  readonly requestId: string;
  readonly employeeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly workingDays: number;
  readonly status: "booked";
  readonly createdAt: string;
}

export interface LeaveApplyResult {
  readonly entry: LeaveEntry;
  /** false when an existing booking with the same request id was reused. */
  readonly created: boolean;
  readonly registryRef: string;
}

export interface LeaveRegistry {
  /** Booked entries for one employee, used by the overlap check. */
  list(employeeId: string): Promise<readonly LeaveEntry[]>;
  get(requestId: string): Promise<LeaveEntry | null>;
  /** Idempotent by request id; `created` is false on a replay. */
  apply(entry: LeaveEntry): Promise<LeaveApplyResult>;
}

export class MemoryLeaveRegistry implements LeaveRegistry {
  private readonly byRequestId = new Map<string, LeaveEntry>();

  constructor(seed: readonly LeaveEntry[] = []) {
    for (const entry of seed) {
      this.byRequestId.set(entry.requestId, entry);
    }
  }

  async list(employeeId: string): Promise<readonly LeaveEntry[]> {
    return [...this.byRequestId.values()].filter((entry) => entry.employeeId === employeeId);
  }

  async get(requestId: string): Promise<LeaveEntry | null> {
    return this.byRequestId.get(requestId) ?? null;
  }

  async apply(entry: LeaveEntry): Promise<LeaveApplyResult> {
    const existing = this.byRequestId.get(entry.requestId);
    if (existing !== undefined) {
      return {
        entry: existing,
        created: false,
        registryRef: `leave-calendar:${existing.requestId}`,
      };
    }
    this.byRequestId.set(entry.requestId, entry);
    return {
      entry,
      created: true,
      registryRef: `leave-calendar:${entry.requestId}`,
    };
  }
}
