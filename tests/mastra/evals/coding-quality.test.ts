import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  codingAllCriteriaCoveredScorer,
  codingCoverageEvidenceResolvesScorer,
  codingValidationPassedScorer,
} from "../../../src/mastra/evals/coding-quality/gates.ts";
import {
  codingSnapshot,
  deterministicGateResults,
  loadCodingRubric,
  scoreCase,
  type CodingTicket,
  type FeaturesArtifacts,
} from "../../../src/mastra/evals/coding-quality/index.ts";

/**
 * Offline, no-model verification of the native coding-quality eval. It reads the
 * committed candidate + case fixtures, rebuilds each snapshot, runs the
 * deterministic gate scorers, and exercises the weighted aggregation. The whole
 * suite is green without any judge key, and it reproduces the current Python
 * outcome: the clean candidates pass every gate and the partial CSV export fails
 * the coverage gate even when a stubbed judge returns 1.0 everywhere.
 */

interface CandidateRecord {
  caseId: string;
  artifacts: FeaturesArtifacts;
}

interface CaseRecord {
  caseId: string;
  tags: string[];
  input: CodingTicket;
}

function readJsonl<T>(relativePath: string): T[] {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

const candidates = readJsonl<CandidateRecord>("../../../evals/judge/candidates/coding-quality.jsonl");
const cases = readJsonl<CaseRecord>("../../../evals/judge/cases/coding_quality_cases.jsonl");
const rubric = loadCodingRubric();

const candidateByCase = new Map(candidates.map((candidate) => [candidate.caseId, candidate]));
const caseById = new Map(cases.map((testCase) => [testCase.caseId, testCase]));

function snapshotFor(caseId: string) {
  const candidate = candidateByCase.get(caseId);
  const testCase = caseById.get(caseId);
  if (candidate === undefined || testCase === undefined) {
    throw new Error(`missing fixture for ${caseId}`);
  }
  return {
    snapshot: codingSnapshot(candidate.artifacts, testCase.input),
    tags: testCase.tags,
  };
}

function fullMarkJudgeScores(tags: string[]): Record<string, { normalized: number }> {
  const scores: Record<string, { normalized: number }> = {};
  for (const spec of rubric.criteria) {
    if (spec.kind === "deterministic") continue;
    const applicable =
      spec.applies_to_tags.length === 0 || spec.applies_to_tags.some((tag) => tags.includes(tag));
    if (applicable) scores[spec.id] = { normalized: 1 };
  }
  return scores;
}

describe("coding-quality deterministic gates", () => {
  it("passes all three gates for the clean doc-snap candidate", async () => {
    const { snapshot, tags } = snapshotFor("feat-doc-snap-spinner");
    const gateScores = await Promise.all(
      [codingAllCriteriaCoveredScorer, codingCoverageEvidenceResolvesScorer, codingValidationPassedScorer].map(
        (scorer) => scorer.run({ output: snapshot, groundTruth: { tags } }),
      ),
    );
    expect(gateScores.map((result) => result.score)).toEqual([1, 1, 1]);
  });

  it("passes all three gates for the clean settings-theme candidate", async () => {
    const { snapshot, tags } = snapshotFor("feat-settings-theme");
    const results = deterministicGateResults(snapshot.output);
    expect(results.every((gate) => gate.passed)).toBe(true);
  });

  it("fails the coverage gate on the partial CSV export", () => {
    const { snapshot } = snapshotFor("feat-csv-export-partial");
    const results = Object.fromEntries(
      deterministicGateResults(snapshot.output).map((gate) => [gate.id, gate.passed]),
    );
    expect(results.all_criteria_covered).toBe(false);
    expect(results.coverage_evidence_resolves).toBe(false);
    expect(results.validation_passed).toBe(true);
  });

  it("is not scorable when handed a live trace with no snapshot", async () => {
    const result = await codingAllCriteriaCoveredScorer.run({ output: undefined });
    expect(result.score).toBeUndefined();
    expect(result.notScorable?.reason).toContain("No coding-quality snapshot");
  });
});

describe("coding-quality weighted aggregation", () => {
  it("reproduces the current 0.83-but-fail outcome for the partial export", () => {
    const { snapshot, tags } = snapshotFor("feat-csv-export-partial");
    const evaluation = scoreCase({
      rubric,
      caseId: "feat-csv-export-partial",
      tags,
      gateResults: deterministicGateResults(snapshot.output),
      judgeScores: fullMarkJudgeScores(tags),
    });
    // The stubbed judge lifts the weighted score over the 0.8 threshold, yet the
    // deterministic coverage gate still vetoes the case.
    expect(evaluation.score).toBeCloseTo(0.833, 3);
    expect(evaluation.score).toBeGreaterThanOrEqual(rubric.threshold);
    expect(evaluation.passed).toBe(false);
  });

  it("passes the clean candidates with a full-mark stubbed judge", () => {
    for (const caseId of ["feat-doc-snap-spinner", "feat-settings-theme"]) {
      const { snapshot, tags } = snapshotFor(caseId);
      const evaluation = scoreCase({
        rubric,
        caseId,
        tags,
        gateResults: deterministicGateResults(snapshot.output),
        judgeScores: fullMarkJudgeScores(tags),
      });
      expect(evaluation.passed).toBe(true);
      expect(evaluation.score).toBe(1);
    }
  });

  it("honours applies_to_tags by leaving the tests dimension out of a non-tests case", () => {
    const { snapshot, tags } = snapshotFor("feat-settings-theme");
    const evaluation = scoreCase({
      rubric,
      caseId: "feat-settings-theme",
      tags,
      gateResults: deterministicGateResults(snapshot.output),
      judgeScores: { test_covers_the_fix: { normalized: 1 } },
    });
    // `test_covers_the_fix` does not apply (the case has no `tests` tag), so it is
    // excluded even though a score was offered for it.
    expect(evaluation.outcomes.some((outcome) => outcome.criterionId === "test_covers_the_fix")).toBe(
      false,
    );
  });

  it("drops judge dimensions that were never scored (offline path)", () => {
    const { snapshot, tags } = snapshotFor("feat-doc-snap-spinner");
    const offline = scoreCase({
      rubric,
      caseId: "feat-doc-snap-spinner",
      tags,
      gateResults: deterministicGateResults(snapshot.output),
      judgeScores: {},
    });
    expect(offline.outcomes.every((outcome) => outcome.source === "deterministic")).toBe(true);
    expect(offline.passed).toBe(true);
  });
});
