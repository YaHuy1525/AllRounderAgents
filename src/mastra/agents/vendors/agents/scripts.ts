import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the vendor verifier. Expected outputs are
 * on-contract (`VerifyModelOutputSchema`): the verification summary and the
 * confidence the verify checkpoint shows beside the check table.
 */
export const vendorVerifierScenarios: AgentScenario[] = [
  {
    name: "clean documentation package",
    input: {
      vendorName: "Northwind Supply Ltd",
      taxId: "GB-812345678",
      country: "GB",
      checks: [
        { id: "registration", label: "Company registration", status: "pass", detail: "Certificate matches the registry." },
        { id: "tax-id", label: "Tax ID certificate", status: "pass", detail: "VAT certificate on file." },
        { id: "tax-format", label: "Tax ID format", status: "pass", detail: "Format matches GB expectations." },
        { id: "bank-letter", label: "Bank letter", status: "pass", detail: "Account ownership letter on file." },
        { id: "insurance", label: "Insurance certificate", status: "pass", detail: "Liability cover valid." },
        { id: "duplicate-screening", label: "Duplicate screening", status: "pass", detail: "No lookalike records." },
      ],
      candidates: [],
    },
    expectedOutput: {
      summary:
        "All six checks pass: the registration, tax and banking evidence matches the requester's data and no lookalike record exists.",
      confidence: 0.88,
    },
  },
  {
    name: "waived insurance with a lookalike",
    input: {
      vendorName: "Northwind Supply Limited",
      taxId: "GB812345678",
      country: "GB",
      checks: [
        { id: "insurance", label: "Insurance certificate", status: "flag", detail: "Waived: renewal pending." },
        { id: "duplicate-screening", label: "Duplicate screening", status: "fail", detail: "Likely duplicate of V-2C91A7F4 (score 0.91)." },
      ],
      candidates: [
        { vendorId: "V-2C91A7F4", legalName: "Northwind Supply Ltd", matchScore: 0.91, matchedOn: ["legalName"] },
      ],
    },
    expectedOutput: {
      summary:
        "The insurance waiver is documented, but the legal name and tax ID closely match existing vendor V-2C91A7F4; confirm this is a distinct entity before proceeding.",
      confidence: 0.63,
    },
  },
];

/**
 * Few-shot scenarios for the vendor risk analyst. Expected outputs are
 * on-contract (`RiskModelOutputSchema`): the risk narrative and confidence
 * the risk-score checkpoint shows beside the score meter.
 */
export const vendorRiskScenarios: AgentScenario[] = [
  {
    name: "low tier with complete documents",
    input: {
      vendorName: "Northwind Supply Ltd",
      score: 0,
      tier: "low",
      factors: [
        { id: "document-coverage", label: "Document coverage", points: 0, detail: "4 of 4 required documents received." },
        { id: "verification-findings", label: "Verification findings", points: 0, detail: "0 failing and 0 flagged checks." },
        { id: "duplicate-risk", label: "Duplicate risk", points: 0, detail: "No duplicate candidates." },
      ],
      requiredSigners: ["procurement-lead"],
    },
    expectedOutput: {
      summary:
        "Score 0 places the vendor in the low tier: documents are complete, verification is clean, so a single procurement lead sign-off is enough.",
      confidence: 0.86,
    },
  },
  {
    name: "medium tier with a waiver",
    input: {
      vendorName: "Northwind Supply Ltd",
      score: 32,
      tier: "medium",
      factors: [
        { id: "document-coverage", label: "Document coverage", points: 12, detail: "1 of 4 required documents waived (insurance)." },
        { id: "verification-findings", label: "Verification findings", points: 10, detail: "0 failing and 2 flagged checks." },
        { id: "duplicate-risk", label: "Duplicate risk", points: 10, detail: "Closest candidate scores 0.62." },
      ],
      requiredSigners: ["procurement-lead", "finance-manager"],
    },
    expectedOutput: {
      summary:
        "Score 32 lands in the medium tier: the insurance waiver and two flagged checks need a finance manager co-sign before the record is created.",
      confidence: 0.74,
    },
  },
];
