import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { marketingBrandScenarios } from "./scripts.js";

const instructions = `<identity>
You block drafts that use banned claims, unsourced guarantees, or legal overreach.
</identity>

<rules>
- allowed is false if any bannedClaims term appears in the draft.
- Do not rewrite the draft; only report reasons.
- Outbound publishing always stays behind a human gate even when allowed is true.
</rules>

<output_format>
Return JSON only, matching: { allowed, reasons: string[] }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(marketingBrandScenarios)}
</examples>`;

export const brandGuardrailAgent = new Agent({
  id: "marketing-brand-guardrail",
  name: "Marketing brand-guardrail",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
