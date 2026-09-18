import { describe, expect, it } from "vitest";

import type { HrCalendar, HrEmployee } from "./directory.js";
import { MemoryEmployeeDirectory } from "./directory.js";
import { assertNoRawPii, redactName } from "./pii.js";

describe("employee directory", () => {
  it("loads the fixture directory, departments and calendar", async () => {
    const directory = new MemoryEmployeeDirectory();
    const employees = await directory.list();
    expect(employees).toHaveLength(8);
    expect(employees.map((employee) => employee.employeeId)).toContain("E-1001");

    const jordan = await directory.get("E-1001");
    expect(jordan?.fullName).toBe("Jordan Avery");
    expect(jordan?.systems).toContain("aws");
    expect(jordan?.leaveBalanceDays).toBe(14);

    const calendar = await directory.calendar();
    expect(calendar.holidays.map((holiday) => holiday.date)).toContain("2026-12-25");
    expect(calendar.blackoutPeriods.some((period) => period.reason === "Year-end close")).toBe(true);
  });

  it("returns null for unknown employees instead of inventing people", async () => {
    const directory = new MemoryEmployeeDirectory();
    expect(await directory.get("E-9999")).toBeNull();
    expect(await directory.get("")).toBeNull();
  });

  it("resolves department heads from the fixture map", async () => {
    const directory = new MemoryEmployeeDirectory();
    expect(await directory.departmentHead("Engineering")).toBe("E-1002");
    expect(await directory.departmentHead("People")).toBe("E-1008");
    expect(await directory.departmentHead("Missing")).toBeNull();
  });

  it("accepts injected data without touching the fixtures", async () => {
    const employee: HrEmployee = {
      employeeId: "X-1",
      fullName: "Test Person",
      roleTitle: "Tester",
      department: "QA",
      managerId: null,
      location: "Remote",
      accessTier: "low",
      systems: ["okta"],
      status: "active",
      startDate: "2026-01-01",
      leaveBalanceDays: 5,
    };
    const calendar: HrCalendar = { holidays: [], blackoutPeriods: [] };
    const directory = new MemoryEmployeeDirectory({
      employees: [employee],
      departments: { QA: { headId: "X-1" } },
      calendar,
    });
    expect(await directory.get("X-1")).toEqual(employee);
    expect(await directory.list()).toHaveLength(1);
    expect(await directory.calendar()).toEqual(calendar);
  });
});

describe("duplicate scoring", () => {
  it("scores an exact name match at 1", async () => {
    const directory = new MemoryEmployeeDirectory();
    const matches = await directory.findDuplicates({ fullName: "Jordan Avery" });
    expect(matches[0]).toMatchObject({
      employeeId: "E-1001",
      score: 1,
      matchedOn: ["full name"],
    });
  });

  it("adds a department bonus without exceeding 1", async () => {
    const directory = new MemoryEmployeeDirectory();
    const matches = await directory.findDuplicates({
      fullName: "Jordan Avery",
      department: "Engineering",
    });
    expect(matches[0]?.score).toBe(1);
    expect(matches[0]?.matchedOn).toContain("department");
  });

  it("scores surname plus given initial at 0.7", async () => {
    const directory = new MemoryEmployeeDirectory();
    const matches = await directory.findDuplicates({ fullName: "J. Avery" });
    expect(matches[0]).toMatchObject({
      employeeId: "E-1001",
      score: 0.7,
      matchedOn: ["surname", "given initial"],
    });
  });

  it("scores a bare surname at 0.55 and a shared token at 0.4, sorted", async () => {
    const directory = new MemoryEmployeeDirectory();
    const matches = await directory.findDuplicates({ fullName: "Ada Berg" });
    expect(matches.map((match) => match.employeeId)).toEqual(["E-1007", "E-1008"]);
    expect(matches[0]).toMatchObject({ score: 0.55, matchedOn: ["surname"] });
    expect(matches[1]).toMatchObject({ score: 0.4, matchedOn: ["name token"] });
  });

  it("returns no matches for unrelated or empty probes", async () => {
    const directory = new MemoryEmployeeDirectory();
    expect(await directory.findDuplicates({ fullName: "Zoe Quinn" })).toEqual([]);
    expect(await directory.findDuplicates({ fullName: "   " })).toEqual([]);
  });
});

describe("pii discipline", () => {
  it("redacts names to initials", () => {
    expect(redactName("Jordan Avery")).toBe("J. A.");
    expect(redactName("Ada")).toBe("A.");
    expect(redactName("  ")).toBe("—");
  });

  it("passes when only redacted labels appear", () => {
    expect(() =>
      assertNoRawPii({ employeeLabel: "J. A.", summary: "Annual leave request." }, [
        "Jordan Avery",
      ]),
    ).not.toThrow();
  });

  it("throws when a raw fixture name leaks into an artifact", () => {
    expect(() =>
      assertNoRawPii({ note: "cc Jordan Avery on the approval" }, ["Jordan Avery"]),
    ).toThrow(/Raw PII leaked/);
  });

  it("skips short names so common words never false-positive", () => {
    expect(() => assertNoRawPii({ note: "cc Bo about the laptop" }, ["Bo"])).not.toThrow();
  });
});
