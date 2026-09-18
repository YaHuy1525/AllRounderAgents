import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the onboarding verifier. Expected outputs are
 * on-contract (`VerifyModelOutputSchema`): the verification summary and the
 * confidence the verify checkpoint shows beside the check table.
 */
export const onboardingVerifierScenarios: AgentScenario[] = [
  {
    name: "clean new-hire package",
    input: {
      candidateLabel: "N. E.",
      roleTitle: "Data Engineer",
      department: "Engineering",
      startDate: "2026-10-05",
      checks: [
        { id: "id-verification", label: "Photo ID", status: "pass", detail: "Passport scan on file." },
        { id: "right-to-work", label: "Right-to-work evidence", status: "pass", detail: "Visa evidence on file." },
        { id: "signed-contract", label: "Signed employment contract", status: "pass", detail: "Countersigned contract on file." },
        { id: "tax-form", label: "Tax / payroll form", status: "pass", detail: "Payroll form on file." },
        { id: "bank-details", label: "Bank account details", status: "pass", detail: "Account ownership letter on file." },
        { id: "start-date", label: "Start date", status: "pass", detail: "Starts in 22 calendar day(s)." },
        { id: "manager-assignment", label: "Manager assignment", status: "pass", detail: "Reports to E-1002." },
        { id: "duplicate-screening", label: "Duplicate screening", status: "pass", detail: "No lookalike directory records." },
      ],
      candidates: [],
    },
    expectedOutput: {
      summary:
        "All checks pass: the identity, right-to-work, contract, tax and banking evidence is on file, the start date clears the payroll cut-off, and no lookalike directory record exists.",
      confidence: 0.87,
    },
  },
  {
    name: "waived right-to-work with a name lookalike",
    input: {
      candidateLabel: "J. A.",
      roleTitle: "Platform Engineer",
      department: "Engineering",
      startDate: "2026-10-05",
      checks: [
        { id: "right-to-work", label: "Right-to-work evidence", status: "flag", detail: "Waived: renewal pending." },
        { id: "duplicate-screening", label: "Duplicate screening", status: "fail", detail: "Likely duplicate of E-1001 (score 1.00)." },
      ],
      candidates: [
        { employeeId: "E-1001", label: "J. A.", matchScore: 1, matchedOn: ["full name", "department"] },
      ],
    },
    expectedOutput: {
      summary:
        "The right-to-work waiver is documented, but the name and department closely match existing employee E-1001; confirm this is a distinct person before proceeding.",
      confidence: 0.62,
    },
  },
];

/**
 * Few-shot scenarios for the onboarding risk analyst. Expected outputs are
 * on-contract (`RiskModelOutputSchema`): the risk narrative and confidence
 * the risk-score checkpoint shows beside the score meter.
 */
export const onboardingRiskScenarios: AgentScenario[] = [
  {
    name: "low tier with complete documents",
    input: {
      candidateLabel: "S. O.",
      roleTitle: "Support Specialist",
      score: 0,
      tier: "low",
      factors: [
        { id: "access-tier", label: "Access tier", points: 0, detail: "low access tier requested." },
        { id: "document-coverage", label: "Document coverage", points: 0, detail: "5 of 5 required documents received." },
        { id: "verification-findings", label: "Verification findings", points: 0, detail: "0 failing and 0 flagged checks." },
        { id: "duplicate-risk", label: "Duplicate risk", points: 0, detail: "No duplicate candidates." },
      ],
      requiredSigners: ["people-partner"],
    },
    expectedOutput: {
      summary:
        "Score 0 places the new hire in the low tier: documents are complete and verification is clean, so a single people partner sign-off is enough.",
      confidence: 0.85,
    },
  },
  {
    name: "high tier with lookalike findings",
    input: {
      candidateLabel: "J. A.",
      roleTitle: "Platform Engineer",
      score: 70,
      tier: "high",
      factors: [
        { id: "access-tier", label: "Access tier", points: 30, detail: "high access tier requested." },
        { id: "document-coverage", label: "Document coverage", points: 0, detail: "5 of 5 required documents received." },
        { id: "verification-findings", label: "Verification findings", points: 15, detail: "1 failing and 0 flagged checks." },
        { id: "duplicate-risk", label: "Duplicate risk", points: 25, detail: "Closest candidate scores 1.00." },
      ],
      requiredSigners: ["people-partner", "department-head", "people-ops-director"],
    },
    expectedOutput: {
      summary:
        "Score 70 lands in the high tier: high access plus a lookalike directory match need the people partner, department head, and people ops director to sign before provisioning.",
      confidence: 0.68,
    },
  },
];
