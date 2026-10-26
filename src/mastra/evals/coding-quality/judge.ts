import { createScorer, notScorable } from "@mastra/core/evals";
import { z } from "zod";

import { appliesToTags, type CriterionSpec, type Rubric } from "./rubric.ts";
import type { CodingSnapshot } from "./snapshot.ts";

/**
 * The rubric-driven LLM judge set for coding-quality. Built entirely from
 * `evals/judge/rubrics/coding-quality.json`: every `score` and `noul` criterion
 * becomes a `createScorer().analyze()` judge, so criteria stay data-driven and
 * no verdict logic is hardcoded here.
 *
 * Design note (a deliberate deviation from the plan text): the plan named
 * `createClassifierScorer` for the ordinal `score` criteria. That primitive
 * requires constructing a configured `Classifier` object per rubric, which is
 * heavier and couples the judge to a second framework surface. `createScorer`
 * with an `.analyze()` step is the canonical LLM-as-judge primitive, expresses
 * both binary (`noul`) and graded (`score`) dimensions, and keeps the whole set
 * generated from one rubric. The ordinal `levels` are embedded in the prompt and
 * the judge returns a graded 0..1 value.
 *
 * Offline safety: these scorers only reach the model when a judge is configured.
 * When no judge model is present the runner registers just the deterministic
 * gates, so the coverage-gate veto is still provable in CI and the LLM judge is
 * never a merge gate.
 */

const JUDGE_INSTRUCTIONS =
  "You are a strict code-review judge. Score only the provided state. Do not " +
  "reward length or style. Reply with strict JSON containing a numeric `value` " +
  "in 0..1 and a one-line `reason`.";

const judgeOutputSchema = z.object({
  value: z.number().min(0).max(1),
  reason: z.string(),
});

export interface JudgeScorerEntry {
  spec: CriterionSpec;
  scorer: ReturnType<typeof buildJudgeScorer>;
}

function stateOf(value: unknown): CodingSnapshot | null {
  const snapshot = value as CodingSnapshot | null;
  return snapshot && typeof snapshot === "object" && snapshot.state !== undefined ? snapshot : null;
}

/** Render the judge prompt for one criterion against the run state. */
function buildPrompt(spec: CriterionSpec, snapshot: CodingSnapshot): string {
  const lines = [`Criterion: ${spec.id}`, `Instruction: ${spec.instructions}`, ""];
  if (spec.levels.length > 0) {
    lines.push("Score levels (worst to best):");
    spec.levels.forEach((level, index) => lines.push(`  ${index}. ${level}`));
    lines.push("");
  }
  lines.push("State (JSON):", JSON.stringify(snapshot.state, null, 2), "");
  lines.push('Reply shape: {"value": 0.0, "reason": "short"}');
  return lines.join("\n");
}

/**
 * Build one judge scorer. When `model` is a configured judge model it is attached
 * as the scorer's `judge`, so `.analyze()` calls it. Without a model the scorer
 * still constructs (for registration) but its analyze step will not run in an
 * offline experiment because the runner only passes the gate scorers.
 */
export function buildJudgeScorer(spec: CriterionSpec, judge?: { model: string }) {
  return createScorer({
    id: `coding-quality.${spec.id}`,
    name: `Coding judge: ${spec.id}`,
    description: spec.instructions,
    ...(judge === undefined
      ? {}
      : { judge: { model: judge.model, instructions: JUDGE_INSTRUCTIONS } }),
  })
    .preprocess(({ run }) => stateOf(run.output))
    .analyze({
      description: `Judge the ${spec.id} criterion against the run state.`,
      outputSchema: judgeOutputSchema,
      createPrompt: ({ results }) => {
        const snapshot = results.preprocessStepResult as CodingSnapshot | null;
        if (snapshot === null) return "No coding state available.";
        return buildPrompt(spec, snapshot);
      },
    })
    .generateScore(({ run, results }) => {
      const snapshot = results.preprocessStepResult as CodingSnapshot | null;
      const tags = extractTags(run.groundTruth);
      if (snapshot === null) {
        return notScorable("No coding-quality snapshot on this run (live trace).");
      }
      if (!appliesToTags(spec, tags)) {
        return notScorable(`${spec.id} does not apply to tags [${tags.join(", ")}].`);
      }
      const analyze = results.analyzeStepResult as { value?: number } | undefined;
      const value = typeof analyze?.value === "number" ? Math.max(0, Math.min(1, analyze.value)) : 0;
      return spec.kind === "score" && spec.levels.length > 1 ? value : value >= spec.pass_at ? 1 : 0;
    })
    .generateReason(({ results }) => {
      const analyze = results.analyzeStepResult as { reason?: string } | undefined;
      return analyze?.reason ?? "The judge returned no reason.";
    });
}

/** Read the case tags the task target carried on `run.groundTruth`. */
export function extractTags(groundTruth: unknown): string[] {
  const record = groundTruth as { tags?: unknown } | null;
  return Array.isArray(record?.tags) ? record.tags.map((tag) => String(tag)) : [];
}

/**
 * Assemble the judge set from the rubric: one entry per non-deterministic
 * criterion, carrying the criterion spec so the aggregation can read its weight
 * and pass-at threshold. `judge` is supplied only when a model is configured.
 */
export function buildJudgeScorers(rubric: Rubric, judge?: { model: string }): JudgeScorerEntry[] {
  return rubric.criteria
    .filter((spec) => spec.kind !== "deterministic")
    .map((spec) => ({ spec, scorer: buildJudgeScorer(spec, judge) }));
}
