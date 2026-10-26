import { describe, expect, it } from "vitest";

import { criticAgreementScorer, patchContractScorer, rcaGoldenPathScorer } from "../../../src/mastra/shared/scorers.js";

// Minimal MastraDBMessage-shaped fixture: the scorers read only
// content.parts[].text of the last message with text. The element type is
// pulled from a scorer's own run() signature so the test never imports the
// full message union.
type ScorerOutput = Parameters<typeof rcaGoldenPathScorer.run>[0]["output"];

function assistantMessage(text: string): ScorerOutput[number] {
  return {
    id: `fixture-${text.slice(0, 8)}`,
    createdAt: new Date(),
    role: "assistant",
    content: { format: 2, parts: [{ type: "text", text }] },
  } as unknown as ScorerOutput[number];
}

function reply(object: unknown): ScorerOutput {
  return [assistantMessage(JSON.stringify(object))];
}

describe("rcaGoldenPathScorer", () => {
  const rca = (path: string, confidence: number) => ({
    summary: "s",
    confidence,
    evidence: [{ path, startLine: 1, endLine: 2, excerpt: "x" }],
    fixable: true,
  });

  it("scores 1 when the golden path is cited at or above the floor", async () => {
    const result = await rcaGoldenPathScorer.run({
      output: reply(rca("src/auth/login.ts", 0.9)),
      groundTruth: { path: "src/auth/login.ts", fixable: true },
    });
    expect(result.score).toBe(1);
  });

  it("scores 0 when the golden path is cited but confidence is below the floor", async () => {
    const result = await rcaGoldenPathScorer.run({
      output: reply(rca("src/auth/login.ts", 0.5)),
      groundTruth: { path: "src/auth/login.ts", fixable: true },
    });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("below the 0.8 floor");
  });

  it("scores 0 when a different path is cited", async () => {
    const result = await rcaGoldenPathScorer.run({
      output: reply(rca("src/auth/logout.ts", 0.9)),
      groundTruth: { path: "src/auth/login.ts", fixable: true },
    });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("Did not cite the golden path");
  });

  it("scores 1 for an unfixable ticket that reports no evidence", async () => {
    const result = await rcaGoldenPathScorer.run({
      output: reply({ summary: "s", confidence: 0.2, evidence: [], fixable: false }),
      groundTruth: { path: null, fixable: false },
    });
    expect(result.score).toBe(1);
  });

  it("scores 0 when an unfixable ticket hallucinates evidence", async () => {
    const result = await rcaGoldenPathScorer.run({
      output: reply(rca("src/guess.ts", 0.9)),
      groundTruth: { path: null, fixable: false },
    });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("Expected empty evidence");
  });

  it("is not scorable without a golden path (live trace)", async () => {
    const result = await rcaGoldenPathScorer.run({ output: reply(rca("a.ts", 0.9)) });
    expect(result.score).toBeUndefined();
    expect(result.notScorable?.reason).toContain("No golden root-cause path");
  });
});

describe("patchContractScorer", () => {
  const file = (path: string, content = "export const ok = 1;\n", validators = ["basic-syntax"]) => ({
    path,
    content,
    validators,
  });

  it("scores 1 for a well-formed patch confined to the golden path", async () => {
    const result = await patchContractScorer.run({
      output: reply({ summary: "s", files: [file("src/auth/login.ts")] }),
      groundTruth: { path: "src/auth/login.ts" },
    });
    expect(result.score).toBe(1);
  });

  it("scores 0.5 when the patch also touches files beyond the citation", async () => {
    const result = await patchContractScorer.run({
      output: reply({
        summary: "s",
        files: [file("src/auth/login.ts"), file("src/auth/logout.ts")],
      }),
      groundTruth: { path: "src/auth/login.ts" },
    });
    expect(result.score).toBe(0.5);
    expect(result.reason).toContain("beyond the cited");
  });

  it("scores 0 for an empty file list", async () => {
    const result = await patchContractScorer.run({
      output: reply({ summary: "s", files: [] }),
      groundTruth: { path: "src/auth/login.ts" },
    });
    expect(result.score).toBe(0);
  });

  it("scores 0 when content is a diff/placeholder rather than full text", async () => {
    const result = await patchContractScorer.run({
      output: reply({ summary: "s", files: [file("src/auth/login.ts", "@@ -1 +1 @@\n")] }),
      groundTruth: { path: "src/auth/login.ts" },
    });
    expect(result.score).toBe(0);
  });

  it("scores 0 for an unknown validator", async () => {
    const result = await patchContractScorer.run({
      output: reply({ summary: "s", files: [file("src/auth/login.ts", "x\n", ["eslint"])] }),
      groundTruth: { path: "src/auth/login.ts" },
    });
    expect(result.score).toBe(0);
  });

  it("still scores a valid patch on a live trace with no golden path", async () => {
    const result = await patchContractScorer.run({
      output: reply({ summary: "s", files: [file("src/a.ts")] }),
    });
    expect(result.score).toBe(1);
  });

  it("scores 0 for an off-contract reply", async () => {
    const result = await patchContractScorer.run({ output: [assistantMessage("no json")] });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("did not contain a JSON patch-plan object");
  });
});

describe("criticAgreementScorer", () => {
  const verdict = (passed: boolean, checked: string[] = ["c1"]) => ({
    passed,
    critique: "c",
    checkedCriteria: checked,
  });

  it("scores 1 when the verdict agrees with the golden gate", async () => {
    const pass = await criticAgreementScorer.run({
      output: reply(verdict(true)),
      groundTruth: { passed: true },
    });
    const block = await criticAgreementScorer.run({
      output: reply(verdict(false)),
      groundTruth: { passed: false },
    });
    expect(pass.score).toBe(1);
    expect(block.score).toBe(1);
  });

  it("scores 0 when the verdict disagrees", async () => {
    const result = await criticAgreementScorer.run({
      output: reply(verdict(true)),
      groundTruth: { passed: false },
    });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("disagrees with the golden gate");
  });

  it("scores 0 when no criteria were named", async () => {
    const result = await criticAgreementScorer.run({
      output: reply(verdict(true, [])),
      groundTruth: { passed: true },
    });
    expect(result.score).toBe(0);
  });

  it("is not scorable without a golden verdict (live trace)", async () => {
    const result = await criticAgreementScorer.run({ output: reply(verdict(true)) });
    expect(result.score).toBeUndefined();
    expect(result.notScorable?.reason).toContain("No golden verdict");
  });
});
