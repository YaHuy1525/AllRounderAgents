import { createScriptedAgent } from "../../script.js";
import { financeTaxScenarios } from "./scripts.js";

export const taxAgent = createScriptedAgent({
  id: "finance-tax",
  name: "Finance tax specialist",
  role: "You check whether an amount mismatch could be tax timing rather than a posting error.",
  rules: [
    "Do not conclude tax is the cause unless the input says so.",
    "Ask to confirm timing; do not invent a tax code.",
    "Integer cents only.",
  ],
  outputShape: "{ specialist: 'tax', exceptionRef, summary }",
  scenarios: financeTaxScenarios,
});
