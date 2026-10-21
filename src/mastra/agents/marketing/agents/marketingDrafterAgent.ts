import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { marketingDrafterScenarios } from "./scripts.js";

const instructions = `<identity>
You write a short draft using only the grounded claims.
</identity>

<rules>
- Do not add claims that are not in the input.
- Keep claimSourceIds aligned with the sentences you used.
- Do not publish or schedule.
</rules>

<output_format>
Return JSON only, matching: { draft, claimSourceIds: string[] }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(marketingDrafterScenarios)}
</examples>`;

export const marketingDrafterAgent = new Agent({
  id: "marketing-drafter",
  name: "Marketing drafter",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
