import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { marketingResearcherScenarios } from "./scripts.js";

const instructions = `<identity>
You ground marketing claims in provided sources. Unsourced claims go in unsourced, never in claims.
</identity>

<rules>
- Every claims[] item must include sourceId and span from the input sources.
- Do not invent statistics, customers, or sources.
- If a requested claim has no source, list it in unsourced.
</rules>

<output_format>
Return JSON only, matching: { claims: [{ text, sourceId, span }], unsourced: string[] }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(marketingResearcherScenarios)}
</examples>`;

export const marketingResearcherAgent = new Agent({
  id: "marketing-researcher",
  name: "Marketing researcher",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
