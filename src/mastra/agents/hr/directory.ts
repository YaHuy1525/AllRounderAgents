import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { fixtureFile } from "../../shared/fixtures.js";

/**
 * Employee directory for the HR lanes. Fixture-backed on purpose: the plan's
 * HRIS seam (`EmployeeDirectory`) is the interface, and the in-memory
 * implementation reads `fixtures/hr_directory.json` so the lanes make no
 * network calls. A later MCP-first integration only swaps this
 * implementation.
 */

export const ACCESS_TIERS = ["low", "medium", "high"] as const;

export const AccessTierSchema = z.enum(ACCESS_TIERS);

export type AccessTier = z.infer<typeof AccessTierSchema>;

export const EmployeeSchema = z
  .object({
    employeeId: z.string().min(2).max(40),
    fullName: z.string().min(2).max(200),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    managerId: z.string().min(2).max(40).nullable(),
    location: z.string().min(2).max(120),
    accessTier: AccessTierSchema,
    systems: z.array(z.string().min(1).max(60)).max(30),
    status: z.enum(["active", "onboarding", "offboarding"]),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    leaveBalanceDays: z.number().int().min(0).max(365),
  })
  .strict();

export type HrEmployee = z.infer<typeof EmployeeSchema>;

export const DepartmentSchema = z
  .object({
    headId: z.string().min(2).max(40),
  })
  .strict();

export const DirectoryFileSchema = z
  .object({
    employees: z.array(EmployeeSchema).min(1).max(200),
    departments: z.record(DepartmentSchema),
  })
  .strict();

export type DirectoryFile = z.infer<typeof DirectoryFileSchema>;

export const HolidaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    label: z.string().min(2).max(120),
  })
  .strict();

export const BlackoutPeriodSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string().min(2).max(200),
  })
  .strict();

export const CalendarFileSchema = z
  .object({
    holidays: z.array(HolidaySchema).max(100),
    blackoutPeriods: z.array(BlackoutPeriodSchema).max(50),
  })
  .strict();

export type HrCalendar = z.infer<typeof CalendarFileSchema>;

/** Fixture path lookup: repo-root `fixtures/` first, source-tree fallback. */
function resolveFixturePath(name: string): string {
  const direct = resolve(process.cwd(), "fixtures", name);
  if (existsSync(direct)) return direct;
  return fixtureFile(name);
}

export function loadDirectoryFile(): DirectoryFile {
  return DirectoryFileSchema.parse(
    JSON.parse(readFileSync(resolveFixturePath("hr_directory.json"), "utf8")),
  );
}

export function loadCalendarFile(): HrCalendar {
  return CalendarFileSchema.parse(
    JSON.parse(readFileSync(resolveFixturePath("hr_calendar.json"), "utf8")),
  );
}

/**
 * The HRIS seam every HR lane reads through. `get` returns null for unknown
 * employees so lanes can fail loudly instead of inventing people; onboarding
 * runs `findDuplicates` to score a new hire against the existing directory
 * and `departmentHead` to resolve fixture-backed approval chains.
 */
export interface EmployeeDirectory {
  list(): Promise<readonly HrEmployee[]>;
  get(employeeId: string): Promise<HrEmployee | null>;
  calendar(): Promise<HrCalendar>;
  findDuplicates(probe: DuplicateProbe): Promise<readonly DuplicateMatch[]>;
  departmentHead(department: string): Promise<string | null>;
}

/** The profile a duplicate check compares against the directory. */
export type DuplicateProbe = {
  fullName: string;
  department?: string;
};

/** One scored duplicate candidate (score sorted, highest first). */
export type DuplicateMatch = {
  employeeId: string;
  fullName: string;
  score: number;
  matchedOn: string[];
};

function normalizeNameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
}

export class MemoryEmployeeDirectory implements EmployeeDirectory {
  private readonly byId = new Map<string, HrEmployee>();
  private readonly departments: Record<string, { headId: string }>;
  private readonly calendarData: HrCalendar;

  constructor(input: { employees?: readonly HrEmployee[]; departments?: Record<string, { headId: string }>; calendar?: HrCalendar } = {}) {
    const file =
      input.employees === undefined || input.departments === undefined ? loadDirectoryFile() : null;
    const employees = input.employees ?? file?.employees ?? [];
    this.departments = input.departments ?? file?.departments ?? {};
    this.calendarData = input.calendar ?? loadCalendarFile();
    for (const employee of employees) {
      this.byId.set(employee.employeeId, employee);
    }
  }

  async list(): Promise<readonly HrEmployee[]> {
    return [...this.byId.values()];
  }

  async get(employeeId: string): Promise<HrEmployee | null> {
    return this.byId.get(employeeId) ?? null;
  }

  async calendar(): Promise<HrCalendar> {
    return this.calendarData;
  }

  /**
   * Deterministic duplicate scoring for onboarding: exact names score 1,
   * surname + given name 0.85, surname + given initial 0.7, surname alone
   * 0.55, shared name tokens 0.4, and a same-department match adds 0.05.
   */
  async findDuplicates(probe: DuplicateProbe): Promise<readonly DuplicateMatch[]> {
    const probeTokens = normalizeNameTokens(probe.fullName);
    if (probeTokens.length === 0) return [];
    const matches: DuplicateMatch[] = [];
    for (const employee of this.byId.values()) {
      const tokens = normalizeNameTokens(employee.fullName);
      if (tokens.length === 0) continue;
      const matchedOn: string[] = [];
      let score = 0;
      if (tokens.join(" ") === probeTokens.join(" ")) {
        score = 1;
        matchedOn.push("full name");
      } else if (tokens[tokens.length - 1] === probeTokens[probeTokens.length - 1]) {
        if (tokens[0] === probeTokens[0]) {
          score = 0.85;
          matchedOn.push("given name", "surname");
        } else if (tokens[0]?.[0] === probeTokens[0]?.[0]) {
          score = 0.7;
          matchedOn.push("surname", "given initial");
        } else {
          score = 0.55;
          matchedOn.push("surname");
        }
      } else if (probeTokens.some((token) => tokens.includes(token))) {
        score = 0.4;
        matchedOn.push("name token");
      }
      if (score === 0) continue;
      if (probe.department !== undefined && probe.department === employee.department) {
        score = Math.min(1, score + 0.05);
        matchedOn.push("department");
      }
      matches.push({
        employeeId: employee.employeeId,
        fullName: employee.fullName,
        score: Number(score.toFixed(2)),
        matchedOn,
      });
    }
    matches.sort(
      (left, right) => right.score - left.score || left.employeeId.localeCompare(right.employeeId),
    );
    return matches;
  }

  /** Department head from the fixture map (used for approval chains). */
  async departmentHead(department: string): Promise<string | null> {
    return this.departments[department]?.headId ?? null;
  }
}
