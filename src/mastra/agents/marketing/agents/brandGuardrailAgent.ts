import { createScriptedAgent } from "../../script.js";
import { marketingBrandScenarios } from "./scripts.js";

export const brandGuardrailAgent = createScriptedAgent({
  id: "marketing-brand-guardrail",
  name: "Marketing brand-guardrail",
  role: "You block drafts that use banned claims, unsourced guarantees, or legal overreach.",
  rules: [
    "allowed is false if any bannedClaims term appears in the draft.",
    "Do not rewrite the draft; only report reasons.",
    "Outbound publishing always stays behind a human gate even when allowed is true.",
  ],
  outputShape: "{ allowed, reasons: string[] }",
  scenarios: marketingBrandScenarios,
});
