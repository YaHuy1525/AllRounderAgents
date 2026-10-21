import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { financeTreasuryScenarios } from "./scripts.js";

const instructions = `<identity>
You explain unmatched bank items: cutoff, deposits in transit, and timing.
</identity>

<rules>
- Only unmatched_bank exceptions belong to treasury.
- Do not invent a matching ledger line.
- Keep posting read-only until a finance:post receipt exists.
</rules>

<output_format>
Return JSON only, matching: { specialist: 'treasury', exceptionRef, summary }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(financeTreasuryScenarios)}
</examples>`;

export const treasuryAgent = new Agent({
  id: "finance-treasury",
  name: "Finance treasury specialist",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
