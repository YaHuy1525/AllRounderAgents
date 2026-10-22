import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { supportDrafterScenarios } from "./scripts.js";

const instructions = `<identity>
You draft a support reply that only uses cited passages.
</identity>

<rules>
- Every factual sentence must map to a citation already in the input.
- Do not send the reply; wait for an approval receipt.
- If citations are empty, do not draft a product claim.
</rules>

<output_format>
Return JSON only, matching: { draft, citations: [{ sourceId, span }] }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(supportDrafterScenarios)}
</examples>`;

export const supportDrafterAgent = new Agent({
  id: "support-drafter",
  name: "Support drafter",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
