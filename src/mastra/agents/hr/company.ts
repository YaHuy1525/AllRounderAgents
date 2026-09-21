import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { fixtureFile } from "../../shared/fixtures.js";
import { createAllRounderMastra } from "../../mastra.js";
import { MemoryHrHelpRegistry } from "../hr-help/tools/hr-help-registry.js";
import { MemoryHrPolicyRetriever } from "../hr-help/tools/hr-policy.js";
import {
  CalendarFileSchema,
  DirectoryFileSchema,
  MemoryEmployeeDirectory,
  type DirectoryFile,
  type HrCalendar,
} from "./directory.js";
import { MemoryLeaveRegistry } from "../leave/tools/leave-registry.js";
import { MemoryOffboardingRegistry } from "../offboarding/tools/offboarding-registry.js";
import { MemoryOnboardingRegistry } from "../onboarding/tools/onboarding-registry.js";
import { MemoryScreeningAts, type CandidatesFile, CandidatesFileSchema } from "../screening/tools/screening-ats.js";

/**
 * The simulated company: a second, much larger fixture-backed HRIS living
 * under `fixtures/company/` next to the golden cast. The golden fixtures are
 * pinned by tests, so everything here is additive: the loader, the ledger
 * schema, and the integrity checks accept generated data while the lanes
 * keep running against the same seams they already ship.
 */

const COMPANY_DIR = "company";

/** Repo-root `fixtures/company/<name>` with a cwd fallback, mirroring the other loaders. */
function companyFixturePath(name: string): string {
  const direct = resolve(process.cwd(), "fixtures", COMPANY_DIR, name);
  if (existsSync(direct)) return direct;
  return fixtureFile(`${COMPANY_DIR}/${name}`);
}

/** Mirrors `LeaveEntry` from the leave registry so generated bookings seed it directly. */
export const CompanyLedgerEntrySchema = z
  .object({
    requestId: z.string().regex(/^LR-[0-9A-F]{8}$/),
    employeeId: z.string().min(2).max(40),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    workingDays: z.number().int().min(1).max(260),
    status: z.literal("booked"),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CompanyLedgerEntry = z.infer<typeof CompanyLedgerEntrySchema>;

export const CompanyLeaveLedgerSchema = z.array(CompanyLedgerEntrySchema).min(1).max(500);

export function loadCompanyDirectory(): DirectoryFile {
  return DirectoryFileSchema.parse(
    JSON.parse(readFileSync(companyFixturePath("hr_directory.json"), "utf8")),
  );
}

export function loadCompanyCalendar(): HrCalendar {
  return CalendarFileSchema.parse(
    JSON.parse(readFileSync(companyFixturePath("hr_calendar.json"), "utf8")),
  );
}

export function loadCompanyCandidates(): CandidatesFile {
  return CandidatesFileSchema.parse(
    JSON.parse(readFileSync(companyFixturePath("hr_candidates.json"), "utf8")),
  );
}

export function loadCompanyLeaveLedger(): CompanyLedgerEntry[] {
  return CompanyLeaveLedgerSchema.parse(
    JSON.parse(readFileSync(companyFixturePath("hr_leave_ledger.json"), "utf8")),
  );
}

/**
 * Structural checks the Zod schemas cannot express: every manager and
 * department head must reference an existing employee, and a department head
 * must belong to the department they head. `Executive` has no department-map
 * entry by design (it is the CEO's own group).
 */
export function directoryIntegrityViolations(file: DirectoryFile): string[] {
  const violations: string[] = [];
  const byId = new Map(file.employees.map((employee) => [employee.employeeId, employee]));
  for (const employee of file.employees) {
    if (employee.managerId !== null && !byId.has(employee.managerId)) {
      violations.push(`${employee.employeeId}: unknown manager ${employee.managerId}`);
    }
    if (employee.department !== "Executive" && !(employee.department in file.departments)) {
      violations.push(`${employee.employeeId}: unknown department ${employee.department}`);
    }
  }
  for (const [department, entry] of Object.entries(file.departments)) {
    const head = byId.get(entry.headId);
    if (head === undefined) {
      violations.push(`${department}: unknown head ${entry.headId}`);
    } else if (head.department !== department) {
      violations.push(`${department}: head ${entry.headId} belongs to ${head.department}`);
    }
  }
  return violations;
}

/** Ledger checks against the directory: bookings must reference real staff. */
export function ledgerIntegrityViolations(
  file: DirectoryFile,
  ledger: readonly CompanyLedgerEntry[],
): string[] {
  const violations: string[] = [];
  const byId = new Set(file.employees.map((employee) => employee.employeeId));
  const requestIds = new Set<string>();
  for (const entry of ledger) {
    if (!byId.has(entry.employeeId)) {
      violations.push(`${entry.requestId}: unknown employee ${entry.employeeId}`);
    }
    if (requestIds.has(entry.requestId)) {
      violations.push(`duplicate request id ${entry.requestId}`);
    }
    requestIds.add(entry.requestId);
  }
  return violations;
}

/**
 * The company's employee directory: same class as the golden lanes use,
 * constructed from the generated files instead of the golden fixtures.
 */
export class CompanyEmployeeDirectory extends MemoryEmployeeDirectory {
  constructor() {
    const file = loadCompanyDirectory();
    super({
      employees: file.employees,
      departments: file.departments,
      calendar: loadCompanyCalendar(),
    });
  }
}

/** The company's policy corpus (`fixtures/company/hr_policy/*.md`). */
export class CompanyPolicyRetriever extends MemoryHrPolicyRetriever {
  constructor(options: { now?: () => Date } = {}) {
    super({
      directory: companyFixturePath("hr_policy"),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
}

/**
 * One-call wiring so demos and tests run every HR lane against the simulated
 * company: leave reads the pre-booked ledger, onboarding/offboarding share the
 * company directory, screening reads the generated ATS file, and hr-help
 * answers from the company policy corpus.
 */
export function createCompanyMastra() {
  return createAllRounderMastra({
    leave: {
      directory: new CompanyEmployeeDirectory(),
      registry: new MemoryLeaveRegistry(loadCompanyLeaveLedger()),
    },
    onboarding: {
      directory: new CompanyEmployeeDirectory(),
      registry: new MemoryOnboardingRegistry(),
    },
    offboarding: {
      directory: new CompanyEmployeeDirectory(),
      registry: new MemoryOffboardingRegistry(),
    },
    screening: {
      ats: new MemoryScreeningAts({ file: loadCompanyCandidates() }),
    },
    hrHelp: {
      retriever: new CompanyPolicyRetriever(),
      registry: new MemoryHrHelpRegistry(),
    },
  });
}
