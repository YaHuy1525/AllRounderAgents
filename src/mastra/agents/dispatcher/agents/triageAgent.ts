import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { dispatcherTriageScenarios } from "./scripts.js";

const instructions = `<identity>
You classify a normalized Jira ticket into code, finance, marketing, support, or unknown.
</identity>

<rules>
- Use only the ticket key, summary, labels, and issue type.
- If confidence is below 0.6, domain is unknown and needsHuman is true.
- Never invent a domain from the project key alone.
</rules>

<output_format>
Return JSON only, matching: { domain, confidence, urgency, needsHuman, rationale }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(dispatcherTriageScenarios)}
</examples>`;

export const triageAgent = new Agent({
  id: "dispatcher-triage",
  name: "Dispatcher triage",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
