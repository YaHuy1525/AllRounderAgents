import { describe, expect, it } from "vitest";

import {
  assessQa,
  correlationIdOf,
  countResults,
  orderedResults,
  selectDefects,
} from "../../../../src/mastra/agents/qa/assess.js";
import { caseSetHash } from "../../../../src/mastra/agents/qa/cases.js";
import {
  QaExecutionArtifactSchema,
  type QaAnalysis,
  type QaCase,
  type QaCaseStatus,
  type QaDefectSetArtifact,
  type QaExecutionArtifact,
} from "../../../../src/mastra/agents/qa/contracts.js";

/**
 * `assessQa()` is the one place a run's outcome becomes a verdict, so these
 * tests are about the two rules that keep it honest: a requirement is verified
 * only by a passing case, and only a `failed` case becomes a defect. Everything
 * else — a missing browser, a case the executor never reached — is an honest
 * non-answer that must not turn into a ticket.
 */

const RUN_ID = "run-qa-1";
const STORY = "OPS-123";
const TARGET = "local-console";

function analysis(): QaAnalysis {
  return {
    storyKey: STORY,
    summary: "A reviewer approves a pending leave request from the console.",
    requirements: [
      {
        id: "R1",
        text: "The queue lists pending leave requests.",
        acceptance: ["A pending request appears with its requester and dates"],
        source: "story",
      },
      {
        id: "R2",
        text: "Approving a request records the decision.",
        acceptance: ["The request leaves the queue as approved"],
        source: "scope",
      },
    ],
    ambiguities: [],
    coverageNotes: [],
  };
}

function testCase(id: string, requirementIds: string[]): QaCase {
  return {
    id,
    requirementIds,
    title: `Case ${id}`,
    kind: "ui",
    preconditions: ["A pending leave request exists"],
    steps: [{ action: "Open the approvals queue", target: "/approvals" }],
    expected: "The queue shows the pending request with an Approve action.",
    tags: ["leave"],
    target: TARGET,
  };
}

/** The approved set: one case per requirement. */
function cases(): QaCase[] {
  return [testCase("QA-OPS-001", ["R1"]), testCase("QA-OPS-002", ["R2"])];
}

function emptyEvidence(): Record<string, unknown> {
  return { console: [], network: [], transcript: [] };
}

function result(
  caseId: string,
  status: QaCaseStatus,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    caseId,
    status,
    observed: `${caseId} reported ${status}`,
    evidence: emptyEvidence(),
    durationMs: 12,
    ...extra,
  };
}

function execution(overrides: Record<string, unknown> = {}): QaExecutionArtifact {
  return QaExecutionArtifactSchema.parse({
    runId: RUN_ID,
    storyKey: STORY,
    targetKey: TARGET,
    caseSetHash: caseSetHash(cases()),
    approvedCaseIds: cases().map((item) => item.id),
    available: true,
    results: [],
    durationMs: 1_200,
    ...overrides,
  });
}

function verdictOf(asset: QaExecutionArtifact) {
  return assessQa({
    storyKey: STORY,
    targetKey: TARGET,
    analysis: analysis(),
    cases: cases(),
    execution: asset,
  });
}

describe("qa assess", () => {
  it("keys every finding on the story and the case, and nothing else", () => {
    expect(correlationIdOf("OPS-123", "QA-OPS-001")).toBe("OPS-123:QA-OPS-001");
    // Stable across runs: the key is what makes a re-run comment, not duplicate.
    expect(correlationIdOf("OPS-123", "QA-OPS-001")).toBe(
      correlationIdOf("OPS-123", "QA-OPS-001"),
    );
  });

  it("verifies a requirement only through a passing case", () => {
    const verdict = verdictOf(
      execution({
        results: [
          result("QA-OPS-001", "passed", { evidence: { console: ["queue rendered"], network: [], transcript: [] } }),
          result("QA-OPS-002", "passed", { evidence: { console: ["approval recorded"], network: [], transcript: [] } }),
        ],
      }),
    );
    expect(verdict.executionAvailable).toBe(true);
    expect(verdict.gaps).toEqual([]);
    expect(verdict.defects).toEqual([]);
    expect(verdict.results.map((item) => item.status)).toEqual(["passed", "passed"]);
    expect(verdict.blockedReason).toBeUndefined();
  });

  it("turns nothing but a failure into a finding", () => {
    const verdict = verdictOf(
      execution({
        results: [
          result("QA-OPS-001", "failed", {
            observed: "the queue is empty",
            evidence: {
              screenshot: ".qa/screens/QA-OPS-001.png",
              console: ["HTTP 500 from /api/runs"],
              network: [{ url: "http://localhost:8000/api/runs", status: 500, ok: false }],
              transcript: ["clicked Approvals"],
            },
          }),
          result("QA-OPS-002", "blocked", { observed: "login screen instead of the queue" }),
        ],
      }),
    );

    expect(verdict.defects).toHaveLength(1);
    expect(verdict.defects[0]).toMatchObject({
      caseId: "QA-OPS-001",
      title: "[QA] QA-OPS-001: Case QA-OPS-001",
      correlationId: "OPS-123:QA-OPS-001",
    });
    expect(verdict.defects[0]?.evidenceRefs).toEqual([
      `qa:${RUN_ID}:QA-OPS-001:screenshot`,
      `qa:${RUN_ID}:QA-OPS-001:console:1`,
      `qa:${RUN_ID}:QA-OPS-001:network:1:500`,
      `qa:${RUN_ID}:QA-OPS-001:transcript:1`,
    ]);
    expect(verdict.defects[0]?.body).toContain("Expected: The queue shows the pending request");
    expect(verdict.defects[0]?.body).toContain("Observed: the queue is empty");
    expect(verdict.defects[0]?.body).toContain(`run ${RUN_ID}`);
    // The blocked case is a non-answer: it is reported, and it files nothing.
    expect(verdict.defects.some((defect) => defect.caseId === "QA-OPS-002")).toBe(false);
  });

  it("cites the observation when a failure captured no evidence", () => {
    const verdict = verdictOf(execution({ results: [result("QA-OPS-001", "failed")] }));
    expect(verdict.defects[0]?.evidenceRefs).toEqual([`qa:${RUN_ID}:QA-OPS-001:observed`]);
  });

  it("rates a failure high unless another passing case still covers its requirement", () => {
    const isolated = verdictOf(execution({ results: [result("QA-OPS-001", "failed")] }));
    expect(isolated.defects[0]?.severity).toBe("high");

    // R2 is covered by QA-OPS-002 passing, so the failure is a regression in a
    // behaviour something else still proves.
    const overlapping = assessQa({
      storyKey: STORY,
      targetKey: TARGET,
      analysis: analysis(),
      cases: [testCase("QA-OPS-001", ["R1", "R2"]), testCase("QA-OPS-002", ["R2"])],
      execution: execution({
        results: [result("QA-OPS-001", "failed"), result("QA-OPS-002", "passed")],
      }),
    });
    expect(overlapping.defects[0]?.severity).toBe("medium");
  });

  it("reports a requirement whose cases were all blocked, quoting each", () => {
    const verdict = verdictOf(
      execution({
        results: [
          result("QA-OPS-001", "passed"),
          result("QA-OPS-002", "blocked", { observed: "no stored session" }),
        ],
      }),
    );
    expect(verdict.gaps).toEqual([
      {
        requirementId: "R2",
        reason: "no case covering this requirement passed: QA-OPS-002 blocked",
      },
    ]);
  });

  it("never invents a pass for a case the executor did not report", () => {
    const missing = orderedResults(execution({ results: [result("QA-OPS-001", "passed")] }), cases());
    expect(missing.map((item) => [item.caseId, item.status])).toEqual([
      ["QA-OPS-001", "passed"],
      ["QA-OPS-002", "not_run"],
    ]);
    expect(missing[1]?.observed).toBe("the executor returned no result for this case");

    const unavailable = orderedResults(
      execution({ available: false, blockedReason: "the browser is not enabled", results: [] }),
      cases(),
    );
    expect(unavailable.map((item) => item.status)).toEqual(["blocked", "blocked"]);
    expect(unavailable[0]?.observed).toBe("the browser is not enabled");
  });

  it("degrades to an honest non-answer when nothing could be driven", () => {
    const verdict = verdictOf(
      execution({
        available: false,
        blockedReason: "no stored session at .qa/auth/local-console.json",
        results: [result("QA-OPS-001", "blocked"), result("QA-OPS-002", "blocked")],
      }),
    );
    expect(verdict.executionAvailable).toBe(false);
    expect(verdict.blockedReason).toBe("no stored session at .qa/auth/local-console.json");
    expect(verdict.defects).toEqual([]);
    expect(verdict.gaps.map((gap) => gap.requirementId)).toEqual(["R1", "R2"]);
    expect(verdict.gaps[0]?.reason).toContain("blocked");
  });

  it("refuses to file a finding for a case that reported none", () => {
    const approved = (ids: string[]): QaDefectSetArtifact => ({
      runId: RUN_ID,
      caseSetHash: caseSetHash(cases()),
      defects: [
        {
          caseId: "QA-OPS-001",
          title: "one",
          body: "body",
          severity: "high",
          evidenceRefs: ["ref"],
          correlationId: "OPS-123:QA-OPS-001",
        },
      ],
      approvedDefectIds: ids,
    });

    expect(selectDefects(approved([]))).toEqual([]);
    expect(selectDefects(approved(["QA-OPS-001"]))).toHaveLength(1);
    expect(() => selectDefects(approved(["QA-OPS-002"]))).toThrow(
      "cannot file findings for cases that reported none: QA-OPS-002",
    );
  });

  it("counts every status, so the close step never re-tallies", () => {
    const results = [
      result("QA-OPS-001", "passed"),
      result("QA-OPS-002", "failed"),
      result("QA-OPS-003", "blocked"),
      result("QA-OPS-004", "not_run"),
    ].map((item) => ({
      caseId: item.caseId as string,
      status: item.status as QaCaseStatus,
      observed: "",
      evidence: { console: [], network: [], transcript: [] },
      durationMs: 0,
    }));
    expect(countResults(results, 1, 1)).toEqual({
      cases: 4,
      passed: 1,
      failed: 1,
      blocked: 1,
      notRun: 1,
      defects: 1,
      filed: 1,
    });
  });
});
