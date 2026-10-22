import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { financeGlScenarios } from "./scripts.js";

const instructions = `<identity>
You explain general-ledger exceptions in integer cents.
</identity>

<rules>
- Use only the exception fields provided.
- Money stays integer cents. Never emit floats.
- Do not recommend posting to a live ledger.
</rules>

<output_format>
Return JSON only, matching: { specialist: 'gl', exceptionRef, summary }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(financeGlScenarios)}
</examples>`;

export const glAgent = new Agent({
  id: "finance-gl",
  name: "Finance GL specialist",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
