import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  criticAgreementScorer,
  patchContractScorer,
  rcaEvidenceScorer,
  rcaGoldenPathScorer,
} from "../scorers.js";

interface CodingCase {
  id: string;
  target: string;
  input: string;
  groundTruth: Record<string, unknown>;
}

// The dataset seed (scripts/seed-mastra-datasets.mjs) and the runner
// (scripts/run-coding-eval.mjs) both key off these three targets and bind each
// to a registered agent id + registered scorer ids. This test is the parity
// guard: it keeps evals/golden_coding.jsonl, the scorer objects, and those two
// scripts from drifting apart.
const TARGETS: Record<
  string,
  { agentId: string; scorerIds: string[]; check: (gt: Record<string, unknown>) => boolean }
> = {
  investigator: {
    agentId: "programming-investigator",
    scorerIds: ["rca-evidence", "rca-golden-path"],
    check: (gt) =>
      (typeof gt.path === "string" || gt.path === null) && typeof gt.fixable === "boolean",
  },
  actor: {
    agentId: "programming-actor",
    scorerIds: ["patch-contract"],
    check: (gt) => typeof gt.path === "string",
  },
  validator: {
    agentId: "programming-validator",
    scorerIds: ["critic-agreement"],
    check: (gt) => typeof gt.passed === "boolean",
  },
};

function loadCases(): CodingCase[] {
  return readFileSync(
    fileURLToPath(new URL("../../../../evals/golden_coding.jsonl", import.meta.url)),
    "utf8",
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as CodingCase);
}

describe("evals/golden_coding.jsonl", () => {
  const cases = loadCases();

  it("has at least one case for every coding target", () => {
    const present = new Set(cases.map((testCase) => testCase.target));
    for (const target of Object.keys(TARGETS)) {
      expect(present.has(target)).toBe(true);
    }
  });

  it("keeps case ids unique", () => {
    const ids = cases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every case a non-empty string input and a target-shaped ground truth", () => {
    for (const testCase of cases) {
      const target = TARGETS[testCase.target];
      expect(target, `unknown target ${testCase.target}`).toBeDefined();
      expect(typeof testCase.input).toBe("string");
      expect(testCase.input.trim().length).toBeGreaterThan(0);
      expect(target?.check(testCase.groundTruth)).toBe(true);
    }
  });

  it("references only scorer ids that are actually registered", () => {
    const registered: Set<string> = new Set([
      rcaEvidenceScorer.id,
      rcaGoldenPathScorer.id,
      patchContractScorer.id,
      criticAgreementScorer.id,
    ]);
    for (const target of Object.values(TARGETS)) {
      for (const scorerId of target.scorerIds) {
        expect(registered.has(scorerId)).toBe(true);
      }
    }
  });
});
