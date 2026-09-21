import { describe, expect, it } from "vitest";

import { requestIdFor } from "../leave/flow.js";
import { MemoryLeaveRegistry } from "../leave/tools/leave-registry.js";
import { MemoryScreeningAts } from "../screening/tools/screening-ats.js";
import { loadDirectoryFile } from "./directory.js";
import {
  CompanyEmployeeDirectory,
  CompanyPolicyRetriever,
  createCompanyMastra,
  directoryIntegrityViolations,
  ledgerIntegrityViolations,
  loadCompanyCalendar,
  loadCompanyCandidates,
  loadCompanyDirectory,
  loadCompanyLeaveLedger,
} from "./company.js";

/**
 * The simulated company lives additively next to the golden cast: these tests
 * pin the generated dataset's shape, its edge cases (overlapping leave,
 * blackout bookings, zero balances, duplicate-surname probes, guardrail trap
 * notes), and the fact that the golden fixtures are untouched.
 */

const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");

describe("simulated company fixtures", () => {
  it("loads 171 employees across 6 departments plus the CEO", async () => {
    const directory = new CompanyEmployeeDirectory();
    const staff = await directory.list();
    expect(staff).toHaveLength(171);
    expect(staff.every((employee) => /^E-\d{4}$/.test(employee.employeeId))).toBe(true);
    const ceo = await directory.get("E-2001");
    expect(ceo?.fullName).toBe("Helena Voss");
    expect(ceo?.managerId).toBeNull();
    expect(await directory.departmentHead("Engineering")).toBe("E-2002");
    const calendar = await directory.calendar();
    expect(calendar.blackoutPeriods).toHaveLength(3);
    expect(calendar.blackoutPeriods.some((period) => period.reason === "Year-end close")).toBe(true);
  });

  it("passes structural integrity checks for directory, ledger, and candidates", () => {
    const file = loadCompanyDirectory();
    expect(directoryIntegrityViolations(file)).toEqual([]);
    expect(ledgerIntegrityViolations(file, loadCompanyLeaveLedger())).toEqual([]);
    const candidates = loadCompanyCandidates();
    expect(candidates.requisitions).toHaveLength(6);
    expect(candidates.candidates).toHaveLength(26);
    const staff = new Set(file.employees.map((employee) => employee.employeeId));
    for (const requisition of candidates.requisitions) {
      expect(requisition.interviewers.every((id) => staff.has(id))).toBe(true);
    }
  });

  it("leaves the golden cast untouched (additive-only company)", () => {
    const golden = loadDirectoryFile();
    expect(golden.employees).toHaveLength(8);
    const goldenIds = new Set(golden.employees.map((employee) => employee.employeeId));
    const company = loadCompanyDirectory();
    expect(company.employees.some((employee) => goldenIds.has(employee.employeeId))).toBe(false);
  });

  it("plants the edge cases the lanes are supposed to catch", () => {
    const staff = loadCompanyDirectory().employees;
    const zeroBalance = staff.filter(
      (employee) => employee.status === "active" && employee.leaveBalanceDays === 0,
    );
    expect(zeroBalance.length).toBeGreaterThanOrEqual(2);
    const offboardingTiers = new Set(
      staff.filter((employee) => employee.status === "offboarding").map((employee) => employee.accessTier),
    );
    expect([...offboardingTiers].sort()).toEqual(["high", "low", "medium"]);
    expect(staff.filter((employee) => employee.status === "onboarding").length).toBeGreaterThanOrEqual(2);
  });

  it("scores duplicate probes across the planted Novak family", async () => {
    const directory = new CompanyEmployeeDirectory();
    const self = await directory.findDuplicates({ fullName: "Pia Novak", department: "Finance" });
    expect(self[0]?.score).toBe(1);
    expect(self[0]?.matchedOn).toContain("full name");
    const surname = await directory.findDuplicates({ fullName: "Petra Novak" });
    expect(surname.length).toBeGreaterThanOrEqual(3);
    // The probe first matches Petra's own directory entry, then Pavel/Pia.
    expect(surname[0]?.score).toBe(1);
    expect(surname[0]?.matchedOn).toContain("full name");
    // Pavel and Pia share Petra's initial, so they score 0.7 (surname + given initial).
    expect(surname.filter((match) => match.score >= 0.7).length).toBeGreaterThanOrEqual(3);
  });
});

describe("simulated company lanes", () => {
  it("seeds the leave registry with lane-derived request ids, overlaps, and a blackout booking", async () => {
    const ledger = loadCompanyLeaveLedger();
    const directory = new CompanyEmployeeDirectory();
    const registry = new MemoryLeaveRegistry(ledger);
    for (const entry of ledger) {
      expect(requestIdFor({
        employeeId: entry.employeeId,
        leaveType: "annual",
        startDate: entry.startDate,
        endDate: entry.endDate,
      })).toBe(entry.requestId);
    }
    const overlapper = ledger.filter((entry) => entry.employeeId === "E-2009");
    expect(overlapper.length).toBeGreaterThanOrEqual(2);
    const overlapPair = overlapper.filter(
      (entry) => entry.startDate <= "2026-11-06" && entry.endDate >= "2026-11-02",
    );
    expect(overlapPair).toHaveLength(2);
    const [first, second] = overlapPair;
    expect(first!.startDate <= second!.endDate && second!.startDate <= first!.endDate).toBe(true);
    expect((await registry.list("E-2009")).length).toBeGreaterThanOrEqual(2);

    const blackout = (await directory.calendar()).blackoutPeriods.find(
      (period) => period.reason === "Year-end close",
    );
    expect(blackout).toBeDefined();
    const blackoutBooking = ledger.find(
      (entry) =>
        entry.startDate >= blackout!.from &&
        entry.endDate <= blackout!.to,
    );
    expect(blackoutBooking).toBeDefined();
  });

  it("loads the company ATS with the planted screening traps", async () => {
    const ats = new MemoryScreeningAts({ file: loadCompanyCandidates() });
    const requisition = await ats.requisition("REQ-5002");
    expect(requisition?.criteria.map((criterion) => criterion.id)).toEqual([
      "pipeline",
      "negotiation",
      "crm",
      "forecasting",
      "discovery",
    ]);
    expect(await ats.candidates("REQ-5002")).toHaveLength(4);
    const candidates = loadCompanyCandidates().candidates;
    const missingMust = candidates.find((candidate) => candidate.candidateId === "C-5007");
    expect(missingMust).toBeDefined();
    const mustHaveIds = new Set(
      requisition!.criteria.filter((criterion) => criterion.mustHave).map((criterion) => criterion.id),
    );
    expect(
      missingMust!.evidence.some((item) => mustHaveIds.has(item.criterionId)),
    ).toBe(false);
    const trap = candidates.find((candidate) => candidate.candidateId === "C-5003");
    expect(trap?.notes.some((note) => note.includes("Culture fit"))).toBe(true);
  });

  it("retrieves from the company policy corpus with stale documents flagged", async () => {
    const retriever = new CompanyPolicyRetriever({ now: () => FIXED_NOW });
    const stipend = await retriever.retrieve("home office stipend amount", 8);
    const stipendSources = new Set(stipend.map((passage) => passage.sourceId));
    expect(stipendSources.has("hr_policy/remote-work.md")).toBe(true);
    expect(stipendSources.has("hr_policy/remote-work-legacy.md")).toBe(true);
    expect(stipend.some((passage) => passage.sourceId === "hr_policy/remote-work-legacy.md" && passage.stale)).toBe(true);
    const parental = await retriever.retrieve("parental leave primary caregiver", 5);
    expect(parental[0]?.sourceId).toBe("hr_policy/leave-and-time-off.md");
    expect(parental[0]?.stale).toBe(false);
    expect((await retriever.retrieve("stipend", 100)).length).toBeLessThanOrEqual(8);
  });

  it("wires every HR lane through createCompanyMastra", () => {
    const mastra = createCompanyMastra();
    const workflows = [
      "leaveFlow",
      "onboardingFlow",
      "offboardingFlow",
      "screeningFlow",
      "hrHelpFlow",
    ] as const;
    for (const workflow of workflows) {
      expect(mastra.getWorkflow(workflow)).toBeDefined();
    }
  });
});
