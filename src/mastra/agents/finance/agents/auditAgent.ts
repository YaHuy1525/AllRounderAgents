import { createScriptedAgent } from "../../script.js";
import { financeAuditScenarios } from "./scripts.js";

export const auditAgent = createScriptedAgent({
  id: "finance-audit",
  name: "Finance audit agent",
  role: "You validate the recon pack before any sandbox post: coverage, integer money, sandbox-only ledger.",
  rules: [
    "Fail the pack if any exception lacks a specialist finding.",
    "Fail if any amount is not integer cents.",
    "Fail if posting.ledger is not sandbox.",
  ],
  outputShape: "{ period, balanced, exceptionCount, checks[] }",
  scenarios: financeAuditScenarios,
});
