import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the leave advisor. Expected outputs are on-contract
 * (`PolicyModelOutputSchema`): the policy narrative and the confidence the
 * policy-check checkpoint shows beside the check table.
 */
export const leaveAdvisorScenarios: AgentScenario[] = [
  {
    name: "clean annual leave within balance",
    input: {
      employeeLabel: "J. A.",
      leaveType: "annual",
      startDate: "2026-10-12",
      endDate: "2026-10-16",
      workingDays: 5,
      balanceBefore: 14,
      balanceAfter: 9,
      checks: [
        { id: "balance", label: "Balance", status: "pass", detail: "9 days remain after this request." },
        { id: "coverage", label: "Team coverage", status: "pass", detail: "No overlapping bookings." },
        { id: "blackout", label: "Blackout window", status: "pass", detail: "No blackout period in range." },
      ],
      verdict: "ok",
    },
    expectedOutput: {
      summary:
        "Five working days of annual leave sit comfortably inside the remaining balance, no overlapping booking exists and the range avoids every blackout window.",
      confidence: 0.88,
    },
  },
  {
    name: "blackout overlap needs an exception",
    input: {
      employeeLabel: "M. S.",
      leaveType: "annual",
      startDate: "2026-12-22",
      endDate: "2026-12-24",
      workingDays: 3,
      balanceBefore: 15,
      balanceAfter: 12,
      checks: [
        { id: "balance", label: "Balance", status: "pass", detail: "12 days remain after this request." },
        { id: "coverage", label: "Team coverage", status: "flag", detail: "Overlaps booking LR-7A2C41D9." },
        { id: "blackout", label: "Blackout window", status: "flag", detail: "Year-end close (2026-12-21 to 2026-12-31)." },
      ],
      verdict: "exception_required",
    },
    expectedOutput: {
      summary:
        "The balance covers the three days, but the range falls inside the year-end close and overlaps another booking, so an exception sign-off is required before the entry is booked.",
      confidence: 0.66,
    },
  },
];
