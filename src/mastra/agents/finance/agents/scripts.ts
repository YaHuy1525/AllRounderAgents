import type { AgentScenario } from "../../script.js";

export const financeGlScenarios: AgentScenario[] = [
  {
    name: "unmatched ledger PAY-1",
    input: {
      type: "unmatched_ledger",
      account: "2000",
      currency: "USD",
      externalRef: "PAY-1",
      ledgerCents: -5000,
      bankCents: null,
      deltaCents: 5000,
    },
    expectedOutput: {
      specialist: "gl",
      exceptionRef: "PAY-1",
      summary: "Ledger PAY-1 has no bank match; review unpresented items.",
    },
  },
  {
    name: "amount mismatch INV-2",
    input: {
      type: "amount_mismatch",
      account: "1000",
      currency: "USD",
      externalRef: "INV-2",
      ledgerCents: 2500,
      bankCents: 2400,
      deltaCents: -100,
    },
    expectedOutput: {
      specialist: "gl",
      exceptionRef: "INV-2",
      summary: "Amount mismatch of -100 cents on INV-2.",
    },
  },
];

export const financeTreasuryScenarios: AgentScenario[] = [
  {
    name: "unmatched bank DEP-9",
    input: {
      type: "unmatched_bank",
      account: "1000",
      currency: "USD",
      externalRef: "DEP-9",
      ledgerCents: null,
      bankCents: 3000,
      deltaCents: 3000,
    },
    expectedOutput: {
      specialist: "treasury",
      exceptionRef: "DEP-9",
      summary: "Bank DEP-9 has no ledger match; check cutoff and deposits in transit.",
    },
  },
];

export const financeTaxScenarios: AgentScenario[] = [
  {
    name: "tax timing on INV-2",
    input: {
      type: "amount_mismatch",
      externalRef: "INV-2",
      deltaCents: -100,
    },
    expectedOutput: {
      specialist: "tax",
      exceptionRef: "INV-2",
      summary: "Confirm tax timing is not the -100 cent variance on INV-2.",
    },
  },
];

export const financeAuditScenarios: AgentScenario[] = [
  {
    name: "month-end pack with three exceptions",
    input: {
      period: "2026-08",
      exceptionRefs: ["INV-2", "PAY-1", "DEP-9"],
      postingLedger: "sandbox",
    },
    expectedOutput: {
      period: "2026-08",
      balanced: false,
      exceptionCount: 3,
      checks: [
        { id: "exceptions-have-rca", passed: true, detail: "Every exception has at least one specialist finding." },
        { id: "integer-money", passed: true, detail: "All money values are integer cents." },
        { id: "sandbox-ledger-only", passed: true, detail: "Posting adapters stay on the sandbox ledger." },
      ],
    },
  },
];
