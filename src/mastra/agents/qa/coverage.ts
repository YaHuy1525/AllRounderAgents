import type { QaAnalysis, QaCase, QaGap } from "./contracts.js";

/**
 * Deterministic coverage math for the qa lane. Pure on purpose: the same
 * answer must come from the design step, the approval gate, the auditor tool,
 * and a test, so no part of "is this set complete" depends on a model.
 *
 * The parameters are structural picks rather than whole contracts, so the
 * auditor tool can ask the same question about a hand-supplied requirement list
 * without fabricating a full analysis.
 */

/** Requirement ids a case cites that the analysis never declared. */
export function unknownRequirementRefs(
  analysis: Pick<QaAnalysis, "requirements">,
  cases: readonly Pick<QaCase, "id" | "requirementIds">[],
): string[] {
  const known = new Set(analysis.requirements.map((requirement) => requirement.id));
  const problems: string[] = [];
  for (const item of cases) {
    for (const requirementId of item.requirementIds) {
      if (!known.has(requirementId)) {
        problems.push(`case ${item.id} cites unknown requirement ${requirementId}`);
      }
    }
  }
  return problems;
}

/**
 * Requirements no case reaches. This is the gap list the approval gate refuses
 * to accept and the console renders, so a run cannot claim coverage it does
 * not have. An ambiguous requirement is still a requirement: it must be
 * covered by a case that asserts the chosen reading, not silently dropped.
 */
export function coverageGaps(
  analysis: Pick<QaAnalysis, "requirements" | "ambiguities">,
  cases: readonly Pick<QaCase, "requirementIds">[],
): QaGap[] {
  const covered = new Set<string>();
  for (const item of cases) {
    for (const requirementId of item.requirementIds) {
      covered.add(requirementId);
    }
  }
  const gaps: QaGap[] = [];
  for (const requirement of analysis.requirements) {
    if (!covered.has(requirement.id)) {
      const ambiguity = analysis.ambiguities.find((entry) => entry.includes(requirement.id));
      gaps.push({
        requirementId: requirement.id,
        reason:
          ambiguity === undefined
            ? "no case asserts this requirement"
            : `no case asserts this requirement; it is also flagged ambiguous: ${ambiguity}`,
      });
    }
  }
  return gaps;
}

/** One line per gap, fed back to the designer on its single bounded re-ask. */
export function describeGaps(gaps: readonly QaGap[]): string {
  return gaps.map((gap) => `${gap.requirementId}: ${gap.reason}`).join("; ");
}
