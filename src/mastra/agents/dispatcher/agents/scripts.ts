import type { AgentScenario } from "../../script.js";

export const dispatcherTriageScenarios: AgentScenario[] = [
  {
    name: "month-end recon ticket",
    input: {
      key: "SCRUM-5",
      summary: "Reconcile September month-end ledger against bank",
      labels: ["finance", "ledger"],
    },
    expectedOutput: {
      domain: "finance",
      confidence: 0.92,
      urgency: 3,
      needsHuman: false,
      rationale: "Summary and labels are finance reconciliation work.",
    },
  },
  {
    name: "unknown one-line ticket",
    input: { key: "SCRUM-99", summary: "Please look", labels: [] },
    expectedOutput: {
      domain: "unknown",
      confidence: 0.2,
      urgency: 2,
      needsHuman: true,
      rationale: "Not enough signal to choose a domain; escalate.",
    },
  },
];

export const dispatcherPreflightScenarios: AgentScenario[] = [
  {
    name: "sandbox journal post",
    input: { action: "finance.sandbox-post", blastRadiusHint: "ledger" },
    expectedOutput: {
      action: "finance.sandbox-post",
      blastRadius: "high",
      reversibility: "compensable",
      score: 72,
      gate: "approval",
      reasons: ["Money movement requires a finance:post receipt."],
    },
  },
  {
    name: "jira comment only",
    input: { action: "jira.comment", blastRadiusHint: "ticket" },
    expectedOutput: {
      action: "jira.comment",
      blastRadius: "low",
      reversibility: "reversible",
      score: 12,
      gate: "auto",
      reasons: ["Commenting on Jira is reversible and low blast."],
    },
  },
];
