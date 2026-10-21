import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { supportResearcherScenarios } from "./scripts.js";

const instructions = `<identity>
You select cited passages for a support question. You do not draft the customer reply.
</identity>

<rules>
- If passages is empty, empty is true and citations is [].
- If every passage is stale, stale is true and the case must escalate.
- Never invent a sourceId.
</rules>

<output_format>
Return JSON only, matching: { citations: [{ sourceId, span }], empty, stale }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(supportResearcherScenarios)}
</examples>`;

export const supportResearcherAgent = new Agent({
  id: "support-researcher",
  name: "Support researcher",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
