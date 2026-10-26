import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { coverageGaps, unknownRequirementRefs } from "../coverage.js";

/**
 * The coverage auditor's only tool, and it is pure: no I/O, no model, no
 * writers. The auditor exists so the supervisor can ask "is this set
 * complete?" mid-run and get the same answer the approval gate will get, which
 * is what makes the gate predictable instead of a surprise at the end.
 */
export const qaCoverageTool = createTool({
  id: "qa_case_coverage",
  description:
    "Check a proposed case set against the requirement ids it is supposed to cover. "
    + "Returns the requirements no case reaches, plus any case citing a requirement that was never declared. "
    + "It reads the supplied lists only: it runs no test and touches no page or ticket.",
  inputSchema: z.object({
    requirementIds: z
      .array(z.string().min(1).max(20))
      .min(1)
      .max(50)
      .describe("Every requirement id the analysis declared, for example [\"R1\", \"R2\"]."),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            requirementIds: z.array(z.string().min(1).max(20)).min(1).max(20),
          })
          .strict(),
      )
      .max(25)
      .describe("The cases as [{ id, requirementIds }], enough to judge coverage."),
  }),
  outputSchema: z
    .object({
      covered: z.array(z.string()),
      gaps: z.array(z.object({ requirementId: z.string(), reason: z.string() }).strict()),
      problems: z.array(z.string()),
    })
    .strict(),
  execute: async ({ requirementIds, cases }) => {
    const analysis = {
      requirements: requirementIds.map((id) => ({
        id,
        text: id,
        acceptance: [],
        source: "scope" as const,
      })),
      ambiguities: [] as string[],
    };
    const gaps = coverageGaps(analysis, cases);
    const problems = unknownRequirementRefs(analysis, cases);
    const uncovered = new Set(gaps.map((gap) => gap.requirementId));
    return {
      covered: requirementIds.filter((id) => !uncovered.has(id)),
      gaps,
      problems,
    };
  },
});
