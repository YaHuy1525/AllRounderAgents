import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MemoryQaCaseStore,
  caseSetHash,
  caseSetProblems,
  decodeCases,
  encodeCases,
} from "../../../../src/mastra/agents/qa/cases.js";
import type { QaAnalysis, QaCase } from "../../../../src/mastra/agents/qa/contracts.js";
import { coverageGaps, describeGaps, unknownRequirementRefs } from "../../../../src/mastra/agents/qa/coverage.js";
import { resolveQaTarget } from "../../../../src/mastra/agents/qa/contracts.js";

function testCase(id: string, requirementIds: string[]): QaCase {
  return {
    id,
    requirementIds,
    title: `Case ${id}`,
    kind: "ui",
    preconditions: [],
    steps: [{ action: "Open the queue", target: "/approvals" }],
    expected: "The queue renders the pending request.",
    tags: [],
    target: "local-console",
  };
}

function analysis(): QaAnalysis {
  return {
    storyKey: "OPS-123",
    summary: "Two requirements.",
    requirements: [
      { id: "R1", text: "First.", acceptance: [], source: "story" },
      { id: "R2", text: "Second.", acceptance: [], source: "story" },
    ],
    ambiguities: ["R2 has two readings"],
    coverageNotes: [],
  };
}

describe("qa case set hash", () => {
  it("ignores the order the model emitted", () => {
    const forward = [testCase("QA-OPS-001", ["R1"]), testCase("QA-OPS-002", ["R2"])];
    const shuffled = [forward[1]!, forward[0]!];
    expect(caseSetHash(shuffled)).toBe(caseSetHash(forward));
  });

  it("changes when a case changes", () => {
    const before = [testCase("QA-OPS-001", ["R1"])];
    const after = [{ ...testCase("QA-OPS-001", ["R1"]), expected: "Something else." }];
    expect(caseSetHash(after)).not.toBe(caseSetHash(before));
  });

  it("names a repeated id instead of hashing an ambiguous set", () => {
    const cases = [testCase("QA-OPS-001", ["R1"]), testCase("QA-OPS-001", ["R2"])];
    expect(caseSetProblems(cases)).toEqual(["case id QA-OPS-001 appears more than once"]);
  });
});

describe("qa case file", () => {
  it("round-trips one case per line", () => {
    const cases = [testCase("QA-OPS-001", ["R1"]), testCase("QA-OPS-002", ["R2"])];
    const text = encodeCases(cases);
    expect(text.trimEnd().split("\n")).toHaveLength(2);
    expect(decodeCases(text)).toEqual(cases);
  });

  it("tolerates blank lines and comments", () => {
    const caseLine = JSON.stringify(testCase("QA-OPS-001", ["R1"]));
    const text = `# the approved set\n\n${caseLine}\n`;
    expect(decodeCases(text)).toEqual([testCase("QA-OPS-001", ["R1"])]);
  });

  it("names the line that breaks the contract", () => {
    const bad = `${JSON.stringify(testCase("QA-OPS-001", ["R1"]))}\n{"id":"nope"}\n`;
    expect(() => decodeCases(bad)).toThrow(/case file line 2: contract violation/);
  });
});

describe("qa coverage", () => {
  it("lists the requirements no case reaches", () => {
    expect(coverageGaps(analysis(), [testCase("QA-OPS-001", ["R1"])])).toEqual([
      { requirementId: "R2", reason: "no case asserts this requirement; it is also flagged ambiguous: R2 has two readings" },
    ]);
  });

  it("reports full coverage as no gaps", () => {
    const cases = [testCase("QA-OPS-001", ["R1", "R2"])];
    expect(coverageGaps(analysis(), cases)).toEqual([]);
  });

  it("names a case that cites a requirement the analysis never declared", () => {
    expect(unknownRequirementRefs(analysis(), [testCase("QA-OPS-003", ["R7"])])).toEqual([
      "case QA-OPS-003 cites unknown requirement R7",
    ]);
  });

  it("describes gaps in one line for the re-ask", () => {
    expect(describeGaps([{ requirementId: "R2", reason: "uncovered" }])).toBe("R2: uncovered");
  });
});

describe("qa target registry", () => {
  it("resolves the published profile", () => {
    expect(resolveQaTarget("local-console")).toMatchObject({ key: "local-console" });
  });

  it("refuses an unknown key by name", () => {
    expect(() => resolveQaTarget("prod")).toThrow('Unknown QA target "prod"');
  });
});

describe("the console rail library", () => {
  // The eval suite's six cases (evals/qa/cases/console-rail.jsonl) are the
  // pinned behaviour: a prompt edit that loosens the squad shows up as a gate
  // regression. They are read here through the same decoder the case store
  // uses, and every hook they name is checked against the console source, so
  // the library cannot drift away from the affordances it targets.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  function railLibrary(): QaCase[] {
    const path = join(repoRoot, "evals", "qa", "cases", "console-rail.jsonl");
    return decodeCases(readFileSync(path, "utf8"));
  }

  /** Hooks the console ships, plus the prefixes it builds per field. */
  function consoleHooks(): { exact: Set<string>; prefixes: string[] } {
    const root = join(repoRoot, "apps", "approval-ui", "src", "components");
    const exact = new Set<string>();
    const prefixes = new Set<string>();
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".tsx")) continue;
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(/data-qa="([^"]+)"/g)) exact.add(match[1]!);
        // `data-qa={`start-input-${field.id}`}` ships a family, not one hook.
        for (const match of text.matchAll(/data-qa=\{\s*`([^`$]+)\$\{/g)) {
          prefixes.add(match[1]!);
        }
      }
    };
    walk(root);
    return { exact, prefixes: [...prefixes] };
  }

  it("is six quotable cases, decoded by the case store's own reader", () => {
    expect(railLibrary().map((item) => item.id)).toEqual([
      "QA-RAIL-001",
      "QA-RAIL-002",
      "QA-RAIL-003",
      "QA-RAIL-004",
      "QA-RAIL-005",
      "QA-RAIL-006",
    ]);
  });

  it("targets only hooks the console actually ships", () => {
    const { exact, prefixes } = consoleHooks();
    expect(exact.size).toBeGreaterThan(10);
    for (const item of railLibrary()) {
      for (const step of item.steps) {
        for (const match of step.target.matchAll(/data-qa="([^"]+)"/g)) {
          const hook = match[1]!;
          const shipped = exact.has(hook) || prefixes.some((prefix) => hook.startsWith(prefix));
          expect(shipped, `${item.id} targets ${hook}, which the console does not ship`).toBe(true);
        }
      }
    }
  });

  it("states each expectation as an observation, not an intention", () => {
    for (const item of railLibrary()) {
      expect(item.expected.trim()).not.toBe("");
      expect(item.expected).not.toMatch(/\b(it works|works as expected|the form validates)\b/i);
    }
  });
});

describe("qa memory store", () => {
  it("lists only the story it was asked about", async () => {
    const store = new MemoryQaCaseStore();
    await store.save({
      storyKey: "OPS-123",
      caseSetHash: caseSetHash([testCase("QA-OPS-001", ["R1"])]),
      approvedCaseIds: ["QA-OPS-001"],
      cases: [testCase("QA-OPS-001", ["R1"])],
    });
    await store.save({
      storyKey: "OPS-999",
      caseSetHash: caseSetHash([testCase("QA-OPS-002", ["R1"])]),
      approvedCaseIds: ["QA-OPS-002"],
      cases: [testCase("QA-OPS-002", ["R1"])],
    });
    expect((await store.list("OPS-123")).map((record) => record.storyKey)).toEqual(["OPS-123"]);
  });
});
