import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the offboarding auditor. Expected outputs are
 * on-contract (`AuditModelOutputSchema`): the audit narrative and the
 * confidence the access-audit checkpoint shows beside the entry table.
 */
export const offboardingAuditScenarios: AgentScenario[] = [
  {
    name: "standard departure with low-blast revocations",
    input: {
      employeeLabel: "S. O.",
      roleTitle: "Support Specialist",
      department: "Operations",
      lastDay: "2026-11-06",
      entries: [
        {
          system: "okta",
          label: "Identity provider",
          blastRadius: "medium",
          riskScore: 40,
          reversibility: "recoverable",
          detail:
            "Deactivation ends every SSO session downstream; reactivation restores access from the identity record.",
        },
        {
          system: "slack",
          label: "Messaging",
          blastRadius: "low",
          riskScore: 10,
          reversibility: "reversible",
          detail: "Deactivation frees the seat; message history remains searchable.",
        },
        {
          system: "zendesk",
          label: "Support desk",
          blastRadius: "low",
          riskScore: 20,
          reversibility: "reversible",
          detail: "Agent removal ends ticket access; historical tickets stay.",
        },
      ],
      risks: [
        {
          id: "high-blast",
          label: "High-blast revocations",
          tier: "low",
          detail: "No high-blast systems.",
        },
        {
          id: "irreversible",
          label: "Irreversible actions",
          tier: "low",
          detail: "No irreversible actions.",
        },
        {
          id: "standard-revocations",
          label: "Standard revocations",
          tier: "medium",
          detail: "3 system(s) follow the standard revoke path.",
        },
      ],
    },
    expectedOutput: {
      summary:
        "Three standard revocations with no high-blast or irreversible systems; identity deactivation is recoverable, so the case approval path is sufficient.",
      confidence: 0.84,
    },
  },
  {
    name: "privileged departure with high-blast finance access",
    input: {
      employeeLabel: "M. S.",
      roleTitle: "Finance Manager",
      department: "Finance",
      lastDay: "2026-10-30",
      entries: [
        {
          system: "banking",
          label: "Banking",
          blastRadius: "high",
          riskScore: 75,
          reversibility: "recoverable",
          detail:
            "Removing the banking user ends payment-approval rights; pending batches must be reassigned first.",
        },
        {
          system: "payroll",
          label: "Payroll system",
          blastRadius: "high",
          riskScore: 70,
          reversibility: "recoverable",
          detail:
            "Removing the payroll user stops pay runs processing; re-granting requires Finance sign-off.",
        },
        {
          system: "aws",
          label: "Cloud infrastructure",
          blastRadius: "high",
          riskScore: 65,
          reversibility: "irreversible",
          detail:
            "Deleting the IAM user destroys its access keys; they cannot be restored, only recreated.",
        },
      ],
      risks: [
        {
          id: "high-blast",
          label: "High-blast revocations",
          tier: "high",
          detail: "3 system(s) require explicit per-item approval: banking, payroll, aws.",
        },
        {
          id: "irreversible",
          label: "Irreversible actions",
          tier: "high",
          detail:
            "1 system(s) destroy credentials or archive records; export or back up first: aws.",
        },
        {
          id: "standard-revocations",
          label: "Standard revocations",
          tier: "low",
          detail: "0 system(s) follow the standard revoke path.",
        },
      ],
    },
    expectedOutput: {
      summary:
        "Three high-blast finance and cloud revocations need explicit per-item approval, and the cloud access keys are irreversible — export what is needed and reassign pending payment batches before sign-off.",
      confidence: 0.66,
    },
  },
];
