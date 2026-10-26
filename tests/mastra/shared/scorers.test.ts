import { describe, expect, it } from "vitest";

import { dispatcherRoutingScorer, rcaEvidenceScorer } from "../../../src/mastra/shared/scorers.js";

// Minimal MastraDBMessage-shaped fixture: the scorer only reads
// content.parts[].text of the last message with text. The element type is
// pulled from the scorer's own run() signature so the test never imports the
// full message union.
type ScorerOutput = Parameters<typeof rcaEvidenceScorer.run>[0]["output"];

function assistantMessage(text: string): ScorerOutput[number] {
  return {
    id: `fixture-${text.slice(0, 8)}`,
    createdAt: new Date(),
    role: "assistant",
    content: { format: 2, parts: [{ type: "text", text }] },
  } as unknown as ScorerOutput[number];
}

describe("rcaEvidenceScorer", () => {
  it("scores 1 for policy-clean RCA evidence", async () => {
    const rca = {
      summary: "Null deref in loader",
      confidence: 0.9,
      evidence: [{ path: "src/loader.ts", startLine: 10, endLine: 14, excerpt: "const x = y.z" }],
      fixable: true,
    };
    const result = await rcaEvidenceScorer.run({ output: [assistantMessage(JSON.stringify(rca))] });
    expect(result.score).toBe(1);
    expect(result.reason).toContain("1 evidence item(s)");
  });

  it("scores 0.5 when evidence is well-formed but confidence misses the floor", async () => {
    const rca = {
      summary: "Guess",
      confidence: 0.6,
      evidence: [{ path: "a.ts", startLine: 1, endLine: 2, excerpt: "x" }],
      fixable: false,
    };
    const result = await rcaEvidenceScorer.run({ output: [assistantMessage(JSON.stringify(rca))] });
    expect(result.score).toBe(0.5);
    expect(result.reason).toContain("below the 0.8 floor");
  });

  it("scores 0 for empty evidence or an off-contract reply", async () => {
    const empty = await rcaEvidenceScorer.run({
      output: [assistantMessage(JSON.stringify({ summary: "s", confidence: 0.9, evidence: [], fixable: false }))],
    });
    expect(empty.score).toBe(0);
    const prose = await rcaEvidenceScorer.run({ output: [assistantMessage("no json here")] });
    expect(prose.score).toBe(0);
    expect(prose.reason).toContain("did not contain a JSON RCA object");
  });

  it("scores 0 when an evidence item lacks a valid line range", async () => {
    const rca = {
      summary: "s",
      confidence: 0.9,
      evidence: [{ path: "a.ts", startLine: 20, endLine: 5, excerpt: "x" }],
      fixable: true,
    };
    const result = await rcaEvidenceScorer.run({ output: [assistantMessage(JSON.stringify(rca))] });
    expect(result.score).toBe(0);
  });
});

describe("dispatcherRoutingScorer", () => {
  const decision = { domain: "code", confidence: 0.9, urgency: "medium", needsHuman: false, rationale: "r" };

  it("scores 1 when domain and gate match the golden ground truth", async () => {
    const result = await dispatcherRoutingScorer.run({
      output: [assistantMessage(JSON.stringify(decision))],
      groundTruth: { domain: "code", gate: "auto" },
    });
    expect(result.score).toBe(1);
  });

  it("scores 0 on a domain miss or a gate miss", async () => {
    const wrongDomain = await dispatcherRoutingScorer.run({
      output: [assistantMessage(JSON.stringify(decision))],
      groundTruth: { domain: "finance", gate: "auto" },
    });
    expect(wrongDomain.score).toBe(0);
    expect(wrongDomain.reason).toContain("expected finance but got code");
    const wrongGate = await dispatcherRoutingScorer.run({
      output: [assistantMessage(JSON.stringify(decision))],
      groundTruth: { domain: "code", gate: "human" },
    });
    expect(wrongGate.score).toBe(0);
  });

  it("is not scorable without ground truth (live trace)", async () => {
    const result = await dispatcherRoutingScorer.run({
      output: [assistantMessage(JSON.stringify(decision))],
    });
    expect(result.score).toBeUndefined();
    expect(result.notScorable?.reason).toContain("No golden ground truth");
  });
});
