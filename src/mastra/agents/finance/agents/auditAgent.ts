import { Agent } from "@mastra/core/agent";

import { formatScenarioExamples } from "../../script.js";
import { financeAuditScenarios } from "./scripts.js";

const instructions = `<identity>
You validate the recon pack before any sandbox post: coverage, integer money, sandbox-only ledger.
</identity>

<rules>
- Fail the pack if any exception lacks a specialist finding.
- Fail if any amount is not integer cents.
- Fail if posting.ledger is not sandbox.
</rules>

<output_format>
Return JSON only, matching: { period, balanced, exceptionCount, checks[] }
</output_format>

<examples>
Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.
${formatScenarioExamples(financeAuditScenarios)}
</examples>`;

export const auditAgent = new Agent({
  id: "finance-audit",
  name: "Finance audit agent",
  instructions,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
