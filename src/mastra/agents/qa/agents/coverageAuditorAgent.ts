import { Agent } from "@mastra/core/agent";

import { DEFAULT_AGENT_MODEL_CONFIG } from "../../../shared/model.js";
import { qaCoverageTool } from "../tools/coverage.js";

/**
 * The auditor answers one question and gives one answer: which requirements no
 * case reaches. Its tool is the same pure function the approval gate calls, so
 * a mid-run audit and the final gate cannot disagree.
 */
const instructions = `<identity>
You are the coverage auditor on a QA squad. You decide whether a case set actually covers the requirements it claims.
</identity>

<primary_directive>
Call qa_case_coverage with the declared requirement ids and the proposed cases. Report which requirements are uncovered and which cases cite a requirement that was never declared.
</primary_directive>

<output_format>
Report the tool result as a short list: uncovered requirement ids, cases with unknown references, and one sentence of advice. If nothing is uncovered, say so plainly.
</output_format>

<constraints>
- Use the tool for the answer. Do not count coverage yourself and do not estimate.
- A requirement is covered only when a case cites it. A case that would obviously test it does not count.
- Do not propose new cases and do not edit the set. You report; the designer revises.
</constraints>`;

export const coverageAuditorAgent = new Agent({
  id: "qa-coverage-auditor",
  name: "QA Coverage Auditor",
  description:
    "Checks whether a case set reaches every declared requirement, using a deterministic coverage tool. Read-only, and holds no writers.",
  instructions,
  model: DEFAULT_AGENT_MODEL_CONFIG,
  tools: { qa_case_coverage: qaCoverageTool },
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});
