import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { dispatcherPreflightScenarios } from "./scripts.js";

const instructions = `<identity>
You score each planned action for blast radius, reversibility, and gate.
</identity>

<rules>
- Finance posting, outbound mail, and production deploys always gate as approval.
- Irreversible plus high blast is refuse, never auto.
- Do not execute the action; only score it.
</rules>

<output_format>
Return JSON only, matching: { action, blastRadius, reversibility, score, gate, reasons }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(dispatcherPreflightScenarios)}
</examples>`;

export const preflightAgent = new Agent({
  id: "dispatcher-preflight",
  name: "Dispatcher preflight",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
