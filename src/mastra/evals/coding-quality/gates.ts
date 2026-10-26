import { createScorer, notScorable } from "@mastra/core/evals";

import type { CodingOutput, CodingSnapshot } from "./snapshot.ts";

/**
 * Deterministic coding-quality gates (ported from
 * `allrounder_api.judging.coding_deterministic_outcomes`). Coverage, evidence
 * grounding, and the validator verdict are facts recorded on the artifact, so
 * they are enforced mechanically and never sent to a judge. A failure on any of
 * these forces the case to fail regardless of the judge score.
 *
 * Each gate is its own registered `createScorer` so the number lands in
 * `mastra_scorers` and Studio can resolve it, exactly like the coding-lane
 * scorers in `src/mastra/shared/scorers.ts`.
 */

export type GateId = "all_criteria_covered" | "coverage_evidence_resolves" | "validation_passed";

export interface GateResult {
  id: GateId;
  passed: boolean;
  detail: string;
}

function changedPaths(output: CodingOutput): Set<string> {
  const paths = new Set<string>();
  for (const file of output.files) {
    if (file.included && file.path !== "") paths.add(file.path);
  }
  return paths;
}

/** Run the three mechanical gates over a normalized coding output. */
export function deterministicGateResults(output: CodingOutput): GateResult[] {
  const coverage = output.criteriaCoverage;
  const changed = changedPaths(output);
  const includedIds = new Set(
    output.acceptanceCriteria.filter((item) => item.included).map((item) => item.id),
  );
  const coveredIds = new Set(coverage.filter((item) => item.covered).map((item) => item.id));
  const checkedIds = includedIds.size > 0 ? includedIds : coveredIds;
  const missing = [...checkedIds].filter((id) => !coveredIds.has(id)).sort();
  const coveredChecked = [...checkedIds].filter((id) => coveredIds.has(id)).length;

  const allCovered: GateResult = {
    id: "all_criteria_covered",
    passed: checkedIds.size > 0 && missing.length === 0,
    detail:
      `covered ${coveredChecked} of ${checkedIds.size} criteria` +
      (missing.length > 0 ? `; uncovered: ${missing.join(", ")}` : ""),
  };

  const orphan = coverage
    .filter((item) => item.covered && !changed.has(item.evidence ?? ""))
    .map((item) => item.id)
    .sort();
  const evidenceResolves: GateResult = {
    id: "coverage_evidence_resolves",
    passed: orphan.length === 0,
    detail:
      orphan.length === 0
        ? "every covered criterion cites a changed file"
        : `covered criteria with no changed-file evidence: ${orphan.join(", ")}`,
  };

  const validation = output.validation;
  const validationPassed: GateResult = {
    id: "validation_passed",
    passed: validation.passed === true,
    detail: `validator passed=${String(validation.passed ?? null)} attempts=${String(
      validation.attempts ?? null,
    )}`,
  };

  return [allCovered, evidenceResolves, validationPassed];
}

/** Read the snapshot the task target handed to `run.output`, or mark not-scorable. */
function snapshotFrom(value: unknown): CodingSnapshot | null {
  const candidate = value as CodingSnapshot | null;
  if (candidate && typeof candidate === "object" && candidate.output !== undefined) return candidate;
  return null;
}

/** Build one binary gate scorer bound to a single `GateId`. */
function createGateScorer(gateId: GateId, name: string, description: string) {
  return createScorer({
    id: `coding-quality.${gateId}`,
    name,
    description,
  })
    .preprocess(({ run }) => {
      const snapshot = snapshotFrom(run.output);
      if (snapshot === null) return null;
      const result = deterministicGateResults(snapshot.output).find((item) => item.id === gateId);
      return result ?? null;
    })
    .generateScore(({ results }) => {
      const result = results.preprocessStepResult as GateResult | null;
      if (result === null) {
        return notScorable("No coding-quality snapshot on this run (live trace).");
      }
      return result.passed ? 1 : 0;
    })
    .generateReason(({ results }) => {
      const result = results.preprocessStepResult as GateResult | null;
      return result === null ? "No snapshot was supplied." : `${gateId}: ${result.detail}`;
    });
}

export const codingAllCriteriaCoveredScorer = createGateScorer(
  "all_criteria_covered",
  "Coding: all criteria covered",
  "Deterministic gate: every included acceptance criterion has a coverage row marked covered.",
);

export const codingCoverageEvidenceResolvesScorer = createGateScorer(
  "coverage_evidence_resolves",
  "Coding: coverage evidence resolves",
  "Deterministic gate: every covered criterion cites an evidence path that is among the changed files.",
);

export const codingValidationPassedScorer = createGateScorer(
  "validation_passed",
  "Coding: validation passed",
  "Deterministic gate: the lane validator report has passed true.",
);

export const codingGateScorers = [
  codingAllCriteriaCoveredScorer,
  codingCoverageEvidenceResolvesScorer,
  codingValidationPassedScorer,
] as const;
