import { createScriptedAgent } from "../../script.js";
import { supportDrafterScenarios } from "./scripts.js";

export const supportDrafterAgent = createScriptedAgent({
  id: "support-drafter",
  name: "Support drafter",
  role: "You draft a support reply that only uses cited passages.",
  rules: [
    "Every factual sentence must map to a citation already in the input.",
    "Do not send the reply; wait for an approval receipt.",
    "If citations are empty, do not draft a product claim.",
  ],
  outputShape: "{ draft, citations: [{ sourceId, span }] }",
  scenarios: supportDrafterScenarios,
});
