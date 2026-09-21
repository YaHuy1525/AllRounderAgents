#!/usr/bin/env node
/**
 * Deterministic simulated-company generator for the HR lanes.
 *
 * Writes a self-contained second company under `fixtures/company/`:
 *   - hr_directory.json      171 employees, org chart, 6 departments
 *   - hr_calendar.json       holidays + 3 blackout windows
 *   - hr_leave_ledger.json   pre-booked leave (overlaps + a blackout case)
 *   - hr_candidates.json     6 requisitions, 26 candidates, guardrail traps
 *   - hr_policy/*.md         8 policy docs (2 deliberately stale)
 *
 * The golden fixtures (fixtures/hr_*.json) are never touched. Re-running
 * with the same `--seed` regenerates byte-identical output.
 *
 * Usage: node scripts/generate-hr-company.mjs [--seed 20260919]
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SEED = (() => {
  const index = process.argv.indexOf("--seed");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value === undefined || value === "" ? "20260919" : value;
})();

const OUT_DIR = resolve(process.cwd(), "fixtures", "company");
const POLICY_DIR = resolve(OUT_DIR, "hr_policy");

/* ------------------------------------------------------------ rng helpers */

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

let rngState = fnv1a(SEED) || 1;

function rng() {
  rngState ^= rngState << 13;
  rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 0x100000000;
}

function intBetween(min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(list) {
  return list[Math.floor(rng() * list.length)];
}

/* ------------------------------------------------------------ name pool */

const FIRST_NAMES = [
  "Aiden", "Bruno", "Clara", "Diego", "Elena", "Farid", "Greta", "Hugo",
  "Ines", "Jonas", "Karin", "Leo", "Maya", "Nils", "Olga", "Pierre",
  "Quentin", "Rosa", "Stefan", "Talia", "Umar", "Vera", "Wesley", "Xenia",
  "Yara", "Zane", "Amara", "Boris", "Celine", "Dario", "Edith", "Felix",
  "Gina", "Henrik", "Iris", "Jasper", "Katya", "Liam", "Mona", "Nadia",
];

const LAST_NAMES = [
  "Alvarez", "Bianchi", "Cohen", "Dubois", "Eriksen", "Fontaine",
  "Gallagher", "Hansen", "Iversen", "Jensen", "Kowalski", "Lindqvist",
  "Marchetti", "Novak", "Petrov", "Quintana", "Rossi", "Santos", "Tanaka",
  "Uhler", "Vasquez", "Weber", "Xu", "Yilmaz", "Zhang", "Aalto", "Brennan",
  "Delgado", "Everly", "Falk",
];

/** Golden-cast and planted names that generated people must never collide with. */
const usedNames = new Set([
  "Helena Voss", "Ravi Menon", "Camille Duret", "Omar Haddad",
  "Yuki Tanaka", "Sofia Almeida", "Grace Odum",
  "Jordan Avery", "Priya Raman", "Sam Okafor", "Lena Fischer",
  "Marco Silveira", "Dara Whitfield", "Tomas Berg", "Ada Nakamura",
  "Ada Berg", "Quinn Alvarez",
]);

function uniqueName() {
  for (;;) {
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
}

/* ------------------------------------------------- provisioning rulebook */

/** Mirrors onboarding TIER_SYSTEMS / DEPARTMENT_SYSTEMS so generated staff
 * always hold at least the systems the lane would provision for them. */
const TIER_SYSTEMS = {
  low: ["okta", "slack", "zendesk"],
  medium: ["okta", "slack", "jira", "workday"],
  high: ["okta", "github", "aws", "jira", "slack", "workday"],
};

const DEPARTMENT_SYSTEMS = {
  Engineering: ["github", "aws"],
  Finance: ["payroll"],
  Operations: ["zendesk"],
  People: ["workday", "hr-console"],
};

const EXTRA_SYSTEMS = {
  Engineering: ["linear", "looker", "confluence", "figma", "zoom", "notion"],
  Sales: ["salesforce", "hubspot", "zoom", "gong"],
  Finance: ["erp", "banking", "looker", "zoom"],
  Operations: ["freshdesk", "notion", "zoom"],
  People: ["greenhouse", "zoom", "notion"],
  Marketing: ["figma", "hubspot", "notion"],
};

function systemsFor(tier, department) {
  const base = new Set([
    ...(TIER_SYSTEMS[tier] ?? []),
    ...(DEPARTMENT_SYSTEMS[department] ?? []),
  ]);
  const extras = EXTRA_SYSTEMS[department] ?? [];
  const extraCount = Math.min(intBetween(0, 3), extras.length);
  const start = intBetween(0, Math.max(0, extras.length - extraCount));
  for (const extra of extras.slice(start, start + extraCount)) base.add(extra);
  return [...base].sort();
}

/* ------------------------------------------------------------ org build */

const TIER_CYCLE = {
  Engineering: ["high", "medium", "low", "high", "medium"],
  Sales: ["medium", "low", "medium", "high", "low"],
  Finance: ["high", "medium", "medium", "low"],
  Operations: ["low", "medium", "low", "medium"],
  People: ["medium", "medium", "low", "high"],
  Marketing: ["medium", "low"],
};

const DEPARTMENT_CONFIG = [
  { name: "Engineering", size: 52, teams: 6, head: "Ravi Menon", headTitle: "VP of Engineering", leadTitle: "Engineering Manager", roles: ["Platform Engineer", "Backend Engineer", "Frontend Engineer", "Site Reliability Engineer", "QA Engineer", "Data Engineer"] },
  { name: "Sales", size: 40, teams: 5, head: "Camille Duret", headTitle: "VP of Sales", leadTitle: "Sales Manager", roles: ["Account Executive", "Sales Development Rep", "Sales Engineer"] },
  { name: "Finance", size: 26, teams: 3, head: "Omar Haddad", headTitle: "VP of Finance", leadTitle: "Finance Manager", roles: ["Accountant", "Payroll Specialist", "Financial Analyst"] },
  { name: "Operations", size: 22, teams: 3, head: "Yuki Tanaka", headTitle: "VP of Operations", leadTitle: "Operations Manager", roles: ["Ops Coordinator", "IT Support Specialist", "Facilities Coordinator"] },
  { name: "People", size: 18, teams: 2, head: "Sofia Almeida", headTitle: "VP of People", leadTitle: "People Operations Manager", roles: ["People Partner", "Recruiter", "HR Generalist"] },
  { name: "Marketing", size: 12, teams: 2, head: "Grace Odum", headTitle: "VP of Marketing", leadTitle: "Marketing Manager", roles: ["Content Strategist", "Growth Marketer", "Brand Designer"] },
];

const LOCATIONS = ["Austin", "Lisbon", "Berlin", "Manila", "Remote (EU)"];

const employees = [];
let employeeSeq = 2000;

function nextEmployeeId() {
  employeeSeq += 1;
  return `E-${employeeSeq}`;
}

function addEmployee(input) {
  const employee = {
    employeeId: nextEmployeeId(),
    fullName: input.fullName,
    roleTitle: input.roleTitle,
    department: input.department,
    managerId: input.managerId,
    location: input.location ?? pick(LOCATIONS),
    accessTier: input.accessTier,
    systems: input.systems,
    status: input.status ?? "active",
    startDate: input.startDate,
    leaveBalanceDays: input.leaveBalanceDays ?? intBetween(5, 28),
  };
  employees.push(employee);
  return employee;
}

function isoStartDate() {
  const year = intBetween(2017, 2026);
  const month = String(intBetween(1, 12)).padStart(2, "0");
  const day = String(intBetween(1, 28)).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Root of the org chart.
const root = addEmployee({
  fullName: "Helena Voss",
  roleTitle: "Chief Executive Officer",
  department: "Executive",
  managerId: null,
  accessTier: "high",
  systems: ["okta", "github", "aws", "jira", "slack", "workday", "hr-console"],
  startDate: "2016-03-01",
  leaveBalanceDays: 12,
});

const departmentState = new Map();

for (const config of DEPARTMENT_CONFIG) {
  const head = addEmployee({
    fullName: config.head,
    roleTitle: config.headTitle,
    department: config.name,
    managerId: root.employeeId,
    accessTier: "high",
    systems: systemsFor("high", config.name),
    startDate: isoStartDate(),
  });

  const leads = [];
  const leadTier = ["Engineering", "Sales", "Finance"].includes(config.name) ? "high" : "medium";
  for (let leadIndex = 0; leadIndex < config.teams; leadIndex += 1) {
    leads.push(addEmployee({
      fullName: uniqueName(),
      roleTitle: config.leadTitle,
      department: config.name,
      managerId: head.employeeId,
      accessTier: leadTier,
      systems: systemsFor(leadTier, config.name),
      startDate: isoStartDate(),
    }));
  }

  const ics = [];
  const icCount = config.size - 1 - config.teams;
  for (let icIndex = 0; icIndex < icCount; icIndex += 1) {
    const tier = TIER_CYCLE[config.name][icIndex % TIER_CYCLE[config.name].length];
    ics.push(addEmployee({
      fullName: uniqueName(),
      roleTitle: pick(config.roles),
      department: config.name,
      managerId: leads[icIndex % leads.length].employeeId,
      accessTier: tier,
      systems: systemsFor(tier, config.name),
      startDate: isoStartDate(),
    }));
  }

  departmentState.set(config.name, { head, leads, ics });
}

/* ------------------------------------------------------------- plants */

// Duplicate-score probes: the Novak family across three departments.
departmentState.get("People").ics[0].fullName = "Petra Novak";
usedNames.add("Petra Novak");
departmentState.get("Engineering").ics[0].fullName = "Pavel Novak";
usedNames.add("Pavel Novak");
departmentState.get("Finance").ics[0].fullName = "Pia Novak";
usedNames.add("Pia Novak");

// Zero leave balances (leave edge case).
departmentState.get("Operations").ics[0].leaveBalanceDays = 0;
departmentState.get("Sales").ics[5].leaveBalanceDays = 0;

// Offboarding edge cases: high/medium/low tiers with distinct blast profiles.
const engOffboarding = departmentState.get("Engineering").ics.at(-1);
engOffboarding.accessTier = "high";
engOffboarding.systems = [...new Set([
  ...engOffboarding.systems,
  ...systemsFor("high", "Engineering"),
  "linear", "looker", "notion",
])].sort();
engOffboarding.status = "offboarding";
const finOffboarding = departmentState.get("Finance").ics.at(-1);
finOffboarding.accessTier = "medium";
finOffboarding.systems = [...new Set([
  ...finOffboarding.systems,
  ...systemsFor("medium", "Finance"),
  "erp", "looker",
])].sort();
finOffboarding.status = "offboarding";
const salesOffboarding = departmentState.get("Sales").ics.at(-1);
salesOffboarding.accessTier = "low";
salesOffboarding.systems = [...new Set([
  ...salesOffboarding.systems,
  ...systemsFor("low", "Sales"),
])].sort();
salesOffboarding.status = "offboarding";

// Two people currently mid-onboarding.
departmentState.get("Marketing").ics[0].status = "onboarding";
departmentState.get("People").ics[3].status = "onboarding";

/* ------------------------------------------------------------ calendar */

const holidays = [
  { date: "2026-01-01", label: "New Year's Day" },
  { date: "2026-04-03", label: "Good Friday" },
  { date: "2026-05-01", label: "Labour Day" },
  { date: "2026-07-03", label: "Independence Day (observed)" },
  { date: "2026-11-26", label: "Thanksgiving" },
  { date: "2026-11-27", label: "Day after Thanksgiving" },
  { date: "2026-12-25", label: "Christmas Day" },
  { date: "2026-12-26", label: "Boxing Day" },
  { date: "2027-01-01", label: "New Year's Day" },
];
const holidaySet = new Set(holidays.map((entry) => entry.date));

const blackoutPeriods = [
  { from: "2026-06-29", to: "2026-07-03", reason: "Half-year close" },
  { from: "2026-12-21", to: "2026-12-31", reason: "Year-end close" },
  { from: "2027-03-29", to: "2027-04-02", reason: "Quarterly audit freeze" },
];

/* ------------------------------------------------------------ leave ledger */

function workingDays(startIso, endIso) {
  let count = 0;
  const cursor = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cursor <= end) {
    const weekday = cursor.getUTCDay();
    const iso = cursor.toISOString().slice(0, 10);
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(iso)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Same derivation as the leave lane's requestIdFor. */
function requestIdFor(employeeId, leaveType, startDate, endDate) {
  const digest = createHash("sha256")
    .update(`${employeeId}|${leaveType}|${startDate}|${endDate}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `LR-${digest}`;
}

function shiftIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const ledger = [];
function addLedgerEntry(employeeId, leaveType, startDate, endDate, createdAtIndex) {
  const workingDaysValue = workingDays(startDate, endDate);
  if (workingDaysValue < 1) throw new Error(`ledger entry ${employeeId} ${startDate}..${endDate} has no working days`);
  ledger.push({
    requestId: requestIdFor(employeeId, leaveType, startDate, endDate),
    employeeId,
    startDate,
    endDate,
    workingDays: workingDaysValue,
    status: "booked",
    createdAt: new Date(Date.UTC(2026, 7, 10 + createdAtIndex, 9, 0, 0)).toISOString(),
  });
}

// Overlap pair: Pavel Novak holds two bookings that share Nov 4.
addLedgerEntry(departmentState.get("Engineering").ics[0].employeeId, "annual", "2026-11-02", "2026-11-04", 0);
addLedgerEntry(departmentState.get("Engineering").ics[0].employeeId, "annual", "2026-11-04", "2026-11-06", 1);

// Blackout case: a booking fully inside the Year-end close window.
const salesIc = employees.find((employee) => employee.department === "Sales" && employee.status === "active");
addLedgerEntry(salesIc.employeeId, "annual", "2026-12-22", "2026-12-24", 2);

const START_WINDOWS = ["2026-10-05", "2026-10-19", "2026-11-09", "2026-11-16", "2027-01-11", "2027-02-01"];
const regularStaff = employees.filter((employee) => employee.status === "active" && employee.department !== "Executive");
for (const [index, employee] of regularStaff.entries()) {
  if (index % 7 !== 0 || ledger.length >= 30) continue;
  const start = START_WINDOWS[index % START_WINDOWS.length];
  addLedgerEntry(employee.employeeId, "annual", start, shiftIso(start, intBetween(3, 9)), 3 + (index % 20));
}

/* ------------------------------------------------- requisitions + candidates */

const REQUISITION_CONFIG = [
  {
    requisitionId: "REQ-5001", roleTitle: "Senior Backend Engineer", department: "Engineering", location: "Remote (EU)", seniority: "senior",
    criteria: [
      { id: "api-design", label: "API design", weight: 30, mustHave: true, detail: "Designs versioned, backward-compatible APIs for production traffic." },
      { id: "typescript", label: "TypeScript", weight: 25, mustHave: true, detail: "Strong typing discipline in strict mode across a real codebase." },
      { id: "distributed-systems", label: "Distributed systems", weight: 20, mustHave: false, detail: "Reasons about queues, retries, and idempotency." },
      { id: "testing", label: "Testing discipline", weight: 15, mustHave: false, detail: "Automated tests around behaviour, not just snapshots." },
      { id: "mentoring", label: "Mentoring", weight: 10, mustHave: false, detail: "Grows engineers through structured review and pairing." },
    ],
  },
  {
    requisitionId: "REQ-5002", roleTitle: "Account Executive", department: "Sales", location: "Austin", seniority: "mid",
    criteria: [
      { id: "pipeline", label: "Pipeline building", weight: 30, mustHave: true, detail: "Builds qualified pipeline from outbound and inbound sources." },
      { id: "negotiation", label: "Negotiation", weight: 25, mustHave: true, detail: "Closes multi-stakeholder deals at or above target pricing." },
      { id: "crm", label: "CRM hygiene", weight: 20, mustHave: false, detail: "Keeps the CRM accurate enough to forecast from." },
      { id: "forecasting", label: "Forecasting", weight: 15, mustHave: false, detail: "Commits with documented confidence categories." },
      { id: "discovery", label: "Discovery", weight: 10, mustHave: false, detail: "Runs structured discovery against customer pain points." },
    ],
  },
  {
    requisitionId: "REQ-5003", roleTitle: "Payroll Specialist", department: "Finance", location: "Lisbon", seniority: "mid",
    criteria: [
      { id: "payroll-ops", label: "Payroll operations", weight: 35, mustHave: true, detail: "Runs multi-country payroll cycles end to end." },
      { id: "compliance", label: "Compliance", weight: 25, mustHave: true, detail: "Tracks statutory filing deadlines without misses." },
      { id: "erp", label: "ERP fluency", weight: 15, mustHave: false, detail: "Posts payroll journals into the ERP accurately." },
      { id: "reporting", label: "Reporting", weight: 15, mustHave: false, detail: "Builds payroll cost reports for leadership." },
      { id: "automation", label: "Automation", weight: 10, mustHave: false, detail: "Reduces manual steps in the payroll cycle." },
    ],
  },
  {
    requisitionId: "REQ-5004", roleTitle: "Recruiter", department: "People", location: "Berlin", seniority: "mid",
    criteria: [
      { id: "sourcing", label: "Sourcing", weight: 30, mustHave: true, detail: "Fills senior pipelines through direct sourcing." },
      { id: "employer-brand", label: "Employer brand", weight: 20, mustHave: false, detail: "Improves offer-accept rate through candidate care." },
      { id: "stakeholders", label: "Stakeholder management", weight: 20, mustHave: false, detail: "Manages hiring managers with structured updates." },
      { id: "ats", label: "ATS discipline", weight: 15, mustHave: false, detail: "Keeps candidate records complete in the ATS." },
      { id: "analytics", label: "Recruiting analytics", weight: 15, mustHave: false, detail: "Reports funnel conversion and time-to-fill." },
    ],
  },
  {
    requisitionId: "REQ-5005", roleTitle: "IT Support Specialist", department: "Operations", location: "Manila", seniority: "junior",
    criteria: [
      { id: "troubleshooting", label: "Troubleshooting", weight: 35, mustHave: true, detail: "Diagnoses endpoint and network issues from tickets." },
      { id: "identity", label: "Identity and access", weight: 25, mustHave: true, detail: "Administers SSO and least-privilege access reviews." },
      { id: "ticketing", label: "Ticketing", weight: 15, mustHave: false, detail: "Keeps queue SLAs inside target." },
      { id: "hardware", label: "Hardware lifecycle", weight: 15, mustHave: false, detail: "Ships and recovers equipment with clean records." },
      { id: "communication", label: "Communication", weight: 10, mustHave: false, detail: "Writes statuses people can act on." },
    ],
  },
  {
    requisitionId: "REQ-5006", roleTitle: "Growth Marketer", department: "Marketing", location: "Remote (EU)", seniority: "senior",
    criteria: [
      { id: "experimentation", label: "Experimentation", weight: 30, mustHave: true, detail: "Designs and reads controlled growth experiments." },
      { id: "analytics", label: "Analytics", weight: 25, mustHave: false, detail: "Instrumented funnels and cohort analysis." },
      { id: "seo", label: "SEO", weight: 20, mustHave: false, detail: "Owns technical and content SEO programs." },
      { id: "copy", label: "Copywriting", weight: 15, mustHave: false, detail: "Writes conversion-focused landing page copy." },
      { id: "lifecycle", label: "Lifecycle", weight: 10, mustHave: false, detail: "Runs onboarding and win-back email journeys." },
    ],
  },
];

const CANDIDATE_PLAN = [
  { requisitionId: "REQ-5001", count: 5 },
  { requisitionId: "REQ-5002", count: 4 },
  { requisitionId: "REQ-5003", count: 4 },
  { requisitionId: "REQ-5004", count: 4 },
  { requisitionId: "REQ-5005", count: 4 },
  { requisitionId: "REQ-5006", count: 5 },
];

const ALL_STRONG = new Set(["C-5001", "C-5014", "C-5022"]);
/** Candidates with zero evidence for every must-have criterion. */
const MISSING_MUST = new Set(["C-5007", "C-5020"]);
const TRAP_NOTES = {
  "C-5003": "Culture fit is exceptional; feels like a firm personality match.",
  "C-5010": "At 58, likely near retirement; consider energy levels.",
  "C-5012": "Recently married - may plan a family soon.",
  "C-5016": "Great vibes on the phone call.",
  "C-5024": "Energy and enthusiasm were excellent.",
};

const requisitions = REQUISITION_CONFIG.map((config) => {
  const state = departmentState.get(config.department);
  const lead = state.leads[0];
  return {
    requisitionId: config.requisitionId,
    roleTitle: config.roleTitle,
    department: config.department,
    location: config.location,
    seniority: config.seniority,
    interviewers: [state.head.employeeId, lead.employeeId],
    criteria: config.criteria,
  };
});

const candidates = [];
let candidateSeq = 5000;
for (const plan of CANDIDATE_PLAN) {
  const config = REQUISITION_CONFIG.find((entry) => entry.requisitionId === plan.requisitionId);
  for (let slot = 0; slot < plan.count; slot += 1) {
    candidateSeq += 1;
    const candidateId = `C-${candidateSeq}`;
    const evidence = [];
    for (const [index, criterion] of config.criteria.entries()) {
      const isMissingMust = MISSING_MUST.has(candidateId) && criterion.mustHave;
      const skipped = !isMissingMust && rng() < 0.15 && evidence.length > 0;
      if (isMissingMust || skipped) continue;
      const strength = ALL_STRONG.has(candidateId) || rng() < 0.6 ? "strong" : "weak";
      const text = strength === "strong"
        ? `Led ${criterion.label.toLowerCase()} work across two production teams.`
        : `Some exposure to ${criterion.label.toLowerCase()} from a recent internal project.`;
      const offset = 40 + index * 90;
      evidence.push({
        sourceId: evidence.length % 2 === 0 ? `cv:${candidateId}` : `screen-call:${candidateId}`,
        span: `${offset}-${offset + text.length}`,
        criterionId: criterion.id,
        strength,
        text,
      });
    }
    if (evidence.length === 0) throw new Error(`${candidateId} ended up with no evidence`);
    const notes = [`Panel availability confirmed for the coming weeks.`];
    if (TRAP_NOTES[candidateId] !== undefined) notes.push(TRAP_NOTES[candidateId]);
    candidates.push({
      candidateId,
      fullName: uniqueName(),
      requisitionId: plan.requisitionId,
      headline: `${config.seniority} hire, ${intBetween(2, 12)} years`,
      evidence,
      notes,
    });
  }
}

/* ------------------------------------------------------------ policy corpus */

const POLICY_DOCUMENTS = [
  {
    fileName: "leave-and-time-off.md", title: "Leave and Time Off", reviewed: "2026-08-15",
    paragraphs: [
      "Annual leave accrues at 25 days per calendar year for full-time employees. Up to five unused days may be carried into the next year and must be used before March 31.",
      "Parental leave provides 16 fully paid weeks. The primary caregiver takes the first 12 weeks in one continuous block, and the secondary caregiver takes 4 weeks within the first six months after birth or placement.",
      "Sick leave does not reduce the annual leave balance. Employees notify their manager before 10:00 local time and log the absence in the HR console the same day.",
      "Unpaid leave beyond ten working days requires approval from both the department head and the People team, and benefits pause after 30 calendar days of unpaid leave.",
      "Public holidays follow the company calendar. A public holiday inside a booked leave is not deducted from the balance.",
    ],
  },
  {
    fileName: "remote-work.md", title: "Remote Work", reviewed: "2026-07-20",
    paragraphs: [
      "Remote employees receive a home office stipend of 300 EUR per month, paid with the monthly payroll cycle. The stipend covers internet, electricity, and a shared coworking membership.",
      "Core collaboration hours are 11:00 to 15:00 in the team's primary time zone. Outside core hours, async updates in the team channel are expected instead of meetings.",
      "Company equipment is ordered through the IT portal. Laptops are refreshed every three years; monitors and keyboards are provided on request with manager approval.",
      "Working from another country for more than 20 working days per year requires tax and legal review before booking travel.",
    ],
  },
  {
    fileName: "remote-work-legacy.md", title: "Remote Work (Legacy)", reviewed: "2024-01-10",
    paragraphs: [
      "This document is superseded by the current remote work policy and kept for audit history only.",
      "The legacy home office stipend was 500 EUR per month and required receipts uploaded to the finance portal by the fifth working day.",
      "The legacy policy capped international work-from-anywhere at 10 days per year with written approval from People Operations.",
    ],
  },
  {
    fileName: "benefits-and-pay.md", title: "Benefits and Pay", reviewed: "2026-05-10",
    paragraphs: [
      "The company matches pension contributions up to 6 percent of base salary. Contributions are changed only during the annual enrollment window each January.",
      "Health insurance has three tiers: employee only, employee plus partner, and family. The company covers 80 percent of the premium in every tier.",
      "A commute allowance of 50 EUR per month is available to on-site employees in Austin, Lisbon, Berlin, and Manila.",
      "Salary reviews run every April. Off-cycle increases require department head and People team approval with written justification.",
      "The employee referral bonus is 2000 EUR, paid after the referred hire completes three months of employment.",
    ],
  },
  {
    fileName: "expenses-and-travel.md", title: "Expenses and Travel", reviewed: "2026-09-01",
    paragraphs: [
      "Flights are booked in economy class. Flights longer than eight hours may be upgraded to premium economy with department head approval.",
      "Hotel costs are covered up to 140 EUR per night; in Austin and Berlin the cap is 180 EUR per night.",
      "Meal expenses while traveling are covered up to 60 EUR per day. Alcohol is not reimbursable.",
      "Receipts must be submitted within 30 days through the expense portal. Missing receipts require a signed declaration and manager approval.",
      "Client entertainment above 200 EUR needs pre-approval from the Finance team before the event.",
    ],
  },
  {
    fileName: "onboarding-checklist.md", title: "Onboarding Checklist", reviewed: "2026-06-30",
    paragraphs: [
      "Day one starts with identity verification and the equipment handover. Equipment must arrive before the start date, ordered through the IT portal at offer acceptance.",
      "IT provisions accounts within three working days of the start date. The provisioning set follows the access tier and department baseline.",
      "Every new hire is assigned an onboarding buddy in the first week. The buddy runs a 30-minute check-in on days 2, 10, and 30.",
      "The 30-60-90 review is owned by the manager, with written goals agreed at day 30 and revisited at days 60 and 90.",
    ],
  },
  {
    fileName: "offboarding-and-access.md", title: "Offboarding and Access", reviewed: "2026-08-05",
    paragraphs: [
      "All system access is revoked on the last working day. Irreversible systems require explicit per-item approval before any destructive action.",
      "Company equipment must be returned within five working days of the last day. A prepaid return label is issued by Operations.",
      "The exit interview is run by the People partner in the final week and summarized without attributing quotes to individuals.",
      "Alumni references are handled by the People team through a single mailbox; managers must not give personal references for former reports.",
    ],
  },
  {
    fileName: "conduct-and-grievances.md", title: "Conduct and Grievances", reviewed: "2024-09-01",
    paragraphs: [
      "Employees treat colleagues, customers, and vendors with respect. Discrimination and harassment are grounds for termination.",
      "A grievance is raised first with the direct manager, then with the People partner if unresolved within ten working days.",
      "The whistleblower channel accepts anonymous reports and is reviewed weekly by the audit committee.",
    ],
  },
];

/* ------------------------------------------------------------ sanity + write */

function fail(message) {
  throw new Error(`generate-hr-company: ${message}`);
}

const ids = new Set(employees.map((employee) => employee.employeeId));
if (ids.size !== employees.length) fail("duplicate employee ids");
const names = new Set(employees.map((employee) => employee.fullName));
if (names.size !== employees.length) fail("duplicate employee names");
for (const employee of employees) {
  if (employee.systems.length === 0 || employee.systems.length > 30) fail(`${employee.employeeId} systems size`);
  const required = new Set([...(TIER_SYSTEMS[employee.accessTier] ?? []), ...(DEPARTMENT_SYSTEMS[employee.department] ?? [])]);
  for (const system of required) {
    if (!employee.systems.includes(system)) fail(`${employee.employeeId} missing provisioned system ${system}`);
  }
  if (employee.status === "offboarding" && employee.leaveBalanceDays < 0) fail("negative balance");
}
for (const config of REQUISITION_CONFIG) {
  const total = config.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (total !== 100) fail(`${config.requisitionId} criteria weights sum to ${total}`);
}
if (candidates.length !== 26) fail(`expected 26 candidates, got ${candidates.length}`);
const ledgerIds = new Set(ledger.map((entry) => entry.requestId));
if (ledgerIds.size !== ledger.length) fail("duplicate ledger request ids");
const ledgerStaff = new Set(employees.map((employee) => employee.employeeId));
for (const entry of ledger) {
  if (!ledgerStaff.has(entry.employeeId)) fail(`ledger entry for unknown employee ${entry.employeeId}`);
}
for (const requisition of requisitions) {
  for (const interviewer of requisition.interviewers) {
    if (!ids.has(interviewer)) fail(`${requisition.requisitionId} interviewer ${interviewer} unknown`);
  }
}
for (const head of departmentState.values()) {
  if (!ids.has(head.head.employeeId)) fail("department head missing");
}

mkdirSync(POLICY_DIR, { recursive: true });

writeFileSync(resolve(OUT_DIR, "hr_directory.json"), `${JSON.stringify({
  employees,
  departments: Object.fromEntries(
    [...departmentState.entries()].map(([name, state]) => [name, { headId: state.head.employeeId }]),
  ),
}, null, 2)}\n`);

writeFileSync(resolve(OUT_DIR, "hr_calendar.json"), `${JSON.stringify({ holidays, blackoutPeriods }, null, 2)}\n`);

writeFileSync(resolve(OUT_DIR, "hr_leave_ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);

writeFileSync(resolve(OUT_DIR, "hr_candidates.json"), `${JSON.stringify({ requisitions, candidates }, null, 2)}\n`);

for (const document of POLICY_DOCUMENTS) {
  const body = [
    `# ${document.title}`,
    "",
    `Reviewed: ${document.reviewed}`,
    "",
    document.paragraphs.join("\n\n"),
    "",
  ].join("\n");
  writeFileSync(resolve(POLICY_DIR, document.fileName), body);
}

console.log(`seed=${SEED}`);
console.log(`employees=${employees.length} departments=${departmentState.size}`);
console.log(`ledger=${ledger.length} requisitions=${requisitions.length} candidates=${candidates.length}`);
console.log(`policies=${POLICY_DOCUMENTS.length}`);
console.log(`out=${OUT_DIR}`);
