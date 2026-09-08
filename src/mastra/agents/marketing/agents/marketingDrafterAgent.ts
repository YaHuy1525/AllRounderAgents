import { createScriptedAgent } from "../../script.js";
import { marketingDrafterScenarios } from "./scripts.js";

export const marketingDrafterAgent = createScriptedAgent({
  id: "marketing-drafter",
  name: "Marketing drafter",
  role: "You write a short draft using only the grounded claims.",
  rules: [
    "Do not add claims that are not in the input.",
    "Keep claimSourceIds aligned with the sentences you used.",
    "Do not publish or schedule.",
  ],
  outputShape: "{ draft, claimSourceIds: string[] }",
  scenarios: marketingDrafterScenarios,
});
