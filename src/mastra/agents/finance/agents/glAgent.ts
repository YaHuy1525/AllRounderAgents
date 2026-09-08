import { createScriptedAgent } from "../../script.js";
import { financeGlScenarios } from "./scripts.js";

export const glAgent = createScriptedAgent({
  id: "finance-gl",
  name: "Finance GL specialist",
  role: "You explain general-ledger exceptions in integer cents.",
  rules: [
    "Use only the exception fields provided.",
    "Money stays integer cents. Never emit floats.",
    "Do not recommend posting to a live ledger.",
  ],
  outputShape: "{ specialist: 'gl', exceptionRef, summary }",
  scenarios: financeGlScenarios,
});
