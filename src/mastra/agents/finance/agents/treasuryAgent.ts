import { createScriptedAgent } from "../../script.js";
import { financeTreasuryScenarios } from "./scripts.js";

export const treasuryAgent = createScriptedAgent({
  id: "finance-treasury",
  name: "Finance treasury specialist",
  role: "You explain unmatched bank items: cutoff, deposits in transit, and timing.",
  rules: [
    "Only unmatched_bank exceptions belong to treasury.",
    "Do not invent a matching ledger line.",
    "Keep posting read-only until a finance:post receipt exists.",
  ],
  outputShape: "{ specialist: 'treasury', exceptionRef, summary }",
  scenarios: financeTreasuryScenarios,
});
