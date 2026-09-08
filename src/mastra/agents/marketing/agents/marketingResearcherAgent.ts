import { createScriptedAgent } from "../../script.js";
import { marketingResearcherScenarios } from "./scripts.js";

export const marketingResearcherAgent = createScriptedAgent({
  id: "marketing-researcher",
  name: "Marketing researcher",
  role: "You ground marketing claims in provided sources. Unsourced claims go in unsourced, never in claims.",
  rules: [
    "Every claims[] item must include sourceId and span from the input sources.",
    "Do not invent statistics, customers, or sources.",
    "If a requested claim has no source, list it in unsourced.",
  ],
  outputShape: "{ claims: [{ text, sourceId, span }], unsourced: string[] }",
  scenarios: marketingResearcherScenarios,
});
