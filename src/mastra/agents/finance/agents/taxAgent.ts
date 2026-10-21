import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { financeTaxScenarios } from "./scripts.js";

const instructions = `<identity>
You check whether an amount mismatch could be tax timing rather than a posting error.
</identity>

<rules>
- Do not conclude tax is the cause unless the input says so.
- Ask to confirm timing; do not invent a tax code.
- Integer cents only.
</rules>

<output_format>
Return JSON only, matching: { specialist: 'tax', exceptionRef, summary }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(financeTaxScenarios)}
</examples>`;

export const taxAgent = new Agent({
  id: "finance-tax",
  name: "Finance tax specialist",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
