import { readFileSync } from "node:fs";

/**
 * Data-driven access to the coding-quality rubric. The criteria, weights,
 * pass-at thresholds, ordinal levels, and the suite threshold all live in
 * `evals/judge/rubrics/coding-quality.json`, so the judge set is generated from
 * that file rather than re-hardcoded in TypeScript. This is the same rubric the
 * Python judge reads, so the native and Python paths stay in parity.
 */

export type CriterionKind = "deterministic" | "score" | "noul" | "choice";

export interface CriterionSpec {
  id: string;
  kind: CriterionKind;
  weight: number;
  instructions: string;
  levels: string[];
  pass_at: number;
  applies_to_tags: string[];
}

export interface Rubric {
  suite: string;
  version: number;
  threshold: number;
  criteria: CriterionSpec[];
}

const RUBRIC_PATH = new URL(
  "../../../../evals/judge/rubrics/coding-quality.json",
  import.meta.url,
);

/** True when a criterion with `applies_to_tags` is in scope for the given tags. */
export function appliesToTags(spec: CriterionSpec, tags: string[]): boolean {
  if (spec.applies_to_tags.length === 0) return true;
  return spec.applies_to_tags.some((tag) => tags.includes(tag));
}

/** Parse + validate the coding-quality rubric from the committed JSONL/JSON fixture. */
export function loadCodingRubric(): Rubric {
  const raw = JSON.parse(readFileSync(RUBRIC_PATH, "utf8")) as {
    suite: string;
    version: number;
    threshold?: number;
    criteria: Array<Partial<CriterionSpec> & { id: string; kind: CriterionKind }>;
  };
  return {
    suite: raw.suite,
    version: raw.version,
    threshold: raw.threshold ?? 0.8,
    criteria: raw.criteria.map((criterion) => ({
      id: criterion.id,
      kind: criterion.kind,
      weight: criterion.weight ?? 1,
      instructions: criterion.instructions ?? "",
      levels: criterion.levels ?? [],
      pass_at: criterion.pass_at ?? 0.5,
      applies_to_tags: criterion.applies_to_tags ?? [],
    })),
  };
}
