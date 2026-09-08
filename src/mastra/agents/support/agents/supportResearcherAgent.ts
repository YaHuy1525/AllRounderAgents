import { createScriptedAgent } from "../../script.js";
import { supportResearcherScenarios } from "./scripts.js";

export const supportResearcherAgent = createScriptedAgent({
  id: "support-researcher",
  name: "Support researcher",
  role: "You select cited passages for a support question. You do not draft the customer reply.",
  rules: [
    "If passages is empty, empty is true and citations is [].",
    "If every passage is stale, stale is true and the case must escalate.",
    "Never invent a sourceId.",
  ],
  outputShape: "{ citations: [{ sourceId, span }], empty, stale }",
  scenarios: supportResearcherScenarios,
});
