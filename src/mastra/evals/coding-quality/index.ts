import {
  codingCoverageEvidenceResolvesScorer,
  codingAllCriteriaCoveredScorer,
  codingValidationPassedScorer,
  deterministicGateResults,
  type GateResult,
} from "./gates.ts";
import { buildJudgeScorers, extractTags, type JudgeScorerEntry } from "./judge.ts";
import { appliesToTags, loadCodingRubric, type CriterionSpec, type Rubric } from "./rubric.ts";
import { codingSnapshot, codingOutputFromArtifacts, codingState } from "./snapshot.ts";
import type { CodingSnapshot, FeaturesArtifacts, CodingTicket } from "./snapshot.ts";

/**
 * Public surface of the native coding-quality eval. This module is consumed by
 * three places, all sharing the same rubric-driven logic:
 *   * `src/mastra/mastra.ts` registers the assembled scorers so dataset
 *     experiments persist their scores to `mastra_scorers`;
 *   * `scripts/run-coding-quality-eval.mjs` runs the in-process experiment and
 *     aggregates a suite verdict;
 *   * `src/mastra/evals/__tests__/coding-quality.test.ts` asserts the gates, the
 *     gate-veto regression, and the aggregation without any model.
 */

export { codingSnapshot, codingOutputFromArtifacts, codingState, deterministicGateResults };
export { appliesToTags, loadCodingRubric };
export type { CodingSnapshot, CodingTicket, FeaturesArtifacts, GateResult, Rubric, CriterionSpec };

export interface CriterionOutcome {
  criterionId: string;
  source: "deterministic" | "judge";
  applied: boolean;
  normalized: number;
  passed: boolean;
  detail: string;
  confidence?: number | null;
}

export interface CaseEvaluation {
  caseId: string;
  score: number;
  passed: boolean;
  tags: string[];
  outcomes: CriterionOutcome[];
  error: string | null;
}

/** Score value the judge produced for one dimension, from a scorer run. */
export interface JudgeScoreInput {
  normalized: number;
  confidence?: number | null;
  detail?: string;
}

function weightsByCriterion(rubric: Rubric): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const spec of rubric.criteria) weights[spec.id] = spec.weight;
  return weights;
}

/**
 * Weight the deterministic gates + the applicable judge dimensions into one case
 * score and verdict. Mirrors `judging.JudgeService.evaluate_case`, with the
 * project's stricter suite rule: a case passes only when every deterministic gate
 * passes, every applied judge dimension clears its `pass_at`, and the weighted
 * score clears the suite threshold. A judge dimension that was not run (offline)
 * is left out of the weighted total rather than scored 0.
 */
export function scoreCase(options: {
  rubric: Rubric;
  caseId: string;
  tags: string[];
  gateResults: GateResult[];
  judgeScores: Record<string, JudgeScoreInput>;
  error?: string | null;
}): CaseEvaluation {
  const { rubric, caseId, tags, gateResults, judgeScores } = options;
  const outcomes: CriterionOutcome[] = gateResults.map((gate) => ({
    criterionId: gate.id,
    source: "deterministic" as const,
    applied: true,
    normalized: gate.passed ? 1 : 0,
    passed: gate.passed,
    detail: gate.detail,
  }));

  const appliedJudgeIds = new Set<string>();
  for (const spec of rubric.criteria) {
    if (spec.kind === "deterministic") continue;
    if (!appliesToTags(spec, tags)) continue;
    const judge = judgeScores[spec.id];
    if (judge === undefined) continue;
    appliedJudgeIds.add(spec.id);
    const normalized = Math.max(0, Math.min(1, judge.normalized));
    outcomes.push({
      criterionId: spec.id,
      source: "judge",
      applied: true,
      normalized,
      passed: normalized >= spec.pass_at,
      detail: judge.detail ?? "",
      confidence: judge.confidence ?? null,
    });
  }

  const weights = weightsByCriterion(rubric);
  const applied = outcomes.filter((outcome) => outcome.applied);
  const totalWeight = applied.reduce((sum, outcome) => sum + (weights[outcome.criterionId] ?? 1), 0);
  const score =
    totalWeight > 0
      ? applied.reduce(
          (sum, outcome) => sum + outcome.normalized * (weights[outcome.criterionId] ?? 1),
          0,
        ) / totalWeight
      : 0;

  const deterministicOk = applied
    .filter((outcome) => outcome.source === "deterministic")
    .every((outcome) => outcome.passed);
  const judgeDimsOk = applied
    .filter((outcome) => outcome.source === "judge")
    .every((outcome) => outcome.passed);

  return {
    caseId,
    score,
    passed:
      (options.error ?? null) === null && deterministicOk && judgeDimsOk && score >= rubric.threshold,
    tags,
    outcomes,
    error: options.error ?? null,
  };
}

/** Score a snapshot from a task-target run: gates always, judge dims when scored. */
export function evaluateSnapshot(options: {
  rubric: Rubric;
  caseId: string;
  snapshot: CodingSnapshot;
  tags: string[];
  judgeScores?: Record<string, JudgeScoreInput>;
  error?: string | null;
}): CaseEvaluation {
  return scoreCase({
    rubric: options.rubric,
    caseId: options.caseId,
    tags: options.tags,
    gateResults: deterministicGateResults(options.snapshot.output),
    judgeScores: options.judgeScores ?? {},
    error: options.error ?? null,
  });
}

export interface SuiteReport {
  suite: string;
  rubric_version: number;
  judge_id: string | null;
  generated_at: string;
  score: number;
  pass_rate: number;
  cases: CaseEvaluation[];
  means: Record<string, number>;
}

/** Average per-case scores + per-criterion means (ported from `aggregate_suite`). */
export function aggregateSuite(options: {
  rubric: Rubric;
  judgeId: string | null;
  generatedAt: string;
  results: CaseEvaluation[];
}): SuiteReport {
  const { rubric, judgeId, generatedAt, results } = options;
  const buckets: Record<string, number[]> = {};
  for (const result of results) {
    for (const outcome of result.outcomes) {
      if (!outcome.applied) continue;
      (buckets[outcome.criterionId] ??= []).push(outcome.normalized);
    }
  }
  const means: Record<string, number> = {};
  for (const [criterionId, values] of Object.entries(buckets).sort()) {
    means[criterionId] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  const score = results.length > 0 ? results.reduce((sum, result) => sum + result.score, 0) / results.length : 0;
  const passRate =
    results.length > 0 ? results.filter((result) => result.passed).length / results.length : 0;
  return {
    suite: rubric.suite,
    rubric_version: rubric.version,
    judge_id: judgeId,
    generated_at: generatedAt,
    score,
    pass_rate: passRate,
    cases: results,
    means,
  };
}

const MEAN_TOLERANCE = 0.06;
const CASE_TOLERANCE = 0.2;

/** Regression gate vs a baseline report (ported from `compare_with_baseline`). */
export function compareWithBaseline(
  current: SuiteReport,
  baseline: SuiteReport,
): { passed: boolean; regressions: string[] } {
  const regressions: string[] = [];
  if (current.score < baseline.score - MEAN_TOLERANCE) {
    regressions.push(
      `suite mean dropped ${baseline.score.toFixed(3)} -> ${current.score.toFixed(3)} (tolerance ${MEAN_TOLERANCE})`,
    );
  }
  const baselineCases: Record<string, number> = {};
  for (const testCase of baseline.cases) baselineCases[testCase.caseId] = testCase.score;
  for (const testCase of current.cases) {
    const base = baselineCases[testCase.caseId];
    if (base === undefined) continue;
    if (testCase.score < base - CASE_TOLERANCE) {
      regressions.push(`${testCase.caseId}: ${base.toFixed(3)} -> ${testCase.score.toFixed(3)}`);
    }
  }
  const errored = current.cases.some((testCase) => testCase.error !== null);
  return { passed: regressions.length === 0 && !errored, regressions };
}

/** The deterministic gate scorers, always safe to register (no model, no fs). */
export const codingQualityGateScorers = {
  codingAllCriteriaCovered: codingAllCriteriaCoveredScorer,
  codingCoverageEvidenceResolves: codingCoverageEvidenceResolvesScorer,
  codingValidationPassed: codingValidationPassedScorer,
};

export type JudgeModelConfig = { model: string };

/**
 * Build the judge set from the committed rubric. Returns the judge scorer entries
 * (id -> { spec, scorer }); throws only if the rubric file cannot be read. Callers
 * must pass a `judge` model config; without one there is nothing to register.
 */
export function buildCodingQualityJudges(judge: JudgeModelConfig): JudgeScorerEntry[] {
  return buildJudgeScorers(loadCodingRubric(), judge);
}

/** The suite threshold, read from the rubric. */
export function codingQualityThreshold(): number {
  return loadCodingRubric().threshold;
}

export { extractTags };
