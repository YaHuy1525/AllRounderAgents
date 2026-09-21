import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the four security-lane agents. Expected outputs are
 * on-contract: the triage rationale (`TriageModelOutputSchema`), the cited
 * evidence pack draft (`InvestigateModelOutputSchema`), the decide narrative
 * (`DecideModelOutputSchema`), and the case-close attestation
 * (`ReportModelOutputSchema`). The deterministic engines stay authoritative —
 * the scripts show the shape, never a second source of classification.
 */

export const alertTriageScenarios: AgentScenario[] = [
  {
    name: "phishing lure against the finance inbox",
    input: {
      title: "Gateway flagged credential phishing lure",
      alertSource: "email",
      signals: [{ id: "credential-phishing", weight: 35, matches: ["credential", "phishing"] }],
      candidateTechniques: [{ id: "T1566", name: "Phishing", tactic: "initial-access" }],
    },
    expectedOutput: {
      rationale:
        "The gateway captured a credential-harvesting lure aimed at the finance inbox. The credential-phishing signal fires once at +35, which lands the alert at medium severity with the T1566 technique; no benign or false-positive signals were present.",
    },
  },
  {
    name: "signed maintenance script",
    input: {
      title: "IT maintenance script signed by Contoso",
      alertSource: "siem",
      signals: [
        { id: "execution", weight: 20, matches: ["powershell"] },
        { id: "benign-admin", weight: -40, matches: ["approved change", "signed by", "software update"] },
      ],
      candidateTechniques: [{ id: "T1059.001", name: "PowerShell", tactic: "execution" }],
    },
    expectedOutput: {
      rationale:
        "The script is signed and linked to an approved change. The benign-administrative signal at -40 outweighs the execution signal at +20, so the alert resolves to benign at low severity; confidence stays low because negative and positive signals conflict.",
    },
  },
];

export const investigationScenarios: AgentScenario[] = [
  {
    name: "encoded PowerShell with telemetry and intel",
    input: {
      alertId: "SEC-102",
      triage: { classification: "tp", severity: "critical" },
      retrieved: [
        {
          sourceId: "telemetry:EVT-102-2",
          sourceTool: "telemetry",
          text: "2026-09-17T08:12:00Z fin-db-01 edr process: powershell.exe -EncodedCommand base64",
        },
        {
          sourceId: "intel:203.0.113.77",
          sourceTool: "threat_intel",
          text: "203.0.113.77 · malicious · known command-and-control endpoint (intel-feed:stix)",
        },
      ],
    },
    expectedOutput: {
      claims: [
        {
          claim: "fin-db-01 executed an encoded PowerShell command at 08:12Z.",
          sourceId: "telemetry:EVT-102-2",
          span: "0-40",
        },
        {
          claim: "The contacted address is a known command-and-control endpoint.",
          sourceId: "intel:203.0.113.77",
          span: "0-30",
        },
      ],
      missingEvidence: [],
      summary:
        "The pack ties the encoded command to a known-bad command-and-control endpoint on fin-db-01; both claims cite retrieved telemetry and intel records.",
    },
  },
  {
    name: "thin coverage with a prior false positive",
    input: {
      alertId: "SEC-105",
      triage: { classification: "tp", severity: "medium" },
      retrieved: [
        {
          sourceId: "case:case-9003",
          sourceTool: "case_history",
          text: "case-9003 · fp/closed · prior benign web-server scan matched the same process pattern",
        },
      ],
    },
    expectedOutput: {
      claims: [
        {
          claim: "A prior case on the same asset closed as a false positive with the same process pattern.",
          sourceId: "case:case-9003",
          span: "0-40",
        },
      ],
      missingEvidence: ["No telemetry events for the alert window."],
      summary:
        "Only case-history coverage was retrievable; the prior false positive is cited, and the missing telemetry is recorded rather than guessed around.",
    },
  },
];

export const decideScenarios: AgentScenario[] = [
  {
    name: "critical containment on a production database",
    input: {
      alertId: "SEC-102",
      proposedAction: "contain",
      risk: { score: 90, tier: "critical", blastRadius: "high", reversibility: "irreversible" },
      claims: [
        { index: 0, claim: "fin-db-01 executed an encoded PowerShell command at 08:12Z." },
        { index: 1, claim: "The contacted address is a known command-and-control endpoint." },
      ],
    },
    expectedOutput: {
      reasoningClaims: [0, 1],
      detectionProposal:
        "Add a detection rule for encoded PowerShell spawning scheduled tasks on production database hosts.",
      confidence: 0.86,
      summary:
        "Claims 0 and 1 show execution and command-and-control on a production database; the risk score lands at critical, so containment with CISO sign-off is justified.",
    },
  },
  {
    name: "phishing with no endpoint action",
    input: {
      alertId: "SEC-101",
      proposedAction: "escalate",
      risk: { score: 25, tier: "medium", blastRadius: "low", reversibility: "reversible" },
      claims: [
        { index: 0, claim: "The lure address resolves to a malicious credential page." },
        { index: 1, claim: "No endpoint telemetry exists because the alert is mail-side." },
      ],
    },
    expectedOutput: {
      reasoningClaims: [0, 1],
      detectionProposal: "Tune the gateway rule to auto-quarantine lookalike login-page lures.",
      confidence: 0.72,
      summary:
        "The lure is malicious but no endpoint was touched; escalation to the human queue fits a medium-tier mail-side incident.",
    },
  },
];

export const reportingScenarios: AgentScenario[] = [
  {
    name: "contained production host",
    input: {
      alertId: "SEC-102",
      action: "contain",
      outcome: "contained",
      containmentId: "SEC-1A2B3C4D",
    },
    expectedOutput: {
      summary:
        "fin-db-01 was isolated at the EDR layer under containment SEC-1A2B3C4D; the case closes with the cited evidence pack and the CISO-signed approval.",
    },
  },
  {
    name: "escalated mail-side phishing",
    input: {
      alertId: "SEC-101",
      action: "escalate",
      outcome: "escalated",
      containmentId: "SEC-5E6F7A8B",
    },
    expectedOutput: {
      summary:
        "The credential-phishing lure (SEC-101) was escalated to the human queue for mailbox cleanup; no endpoint containment was executed.",
    },
  },
];
