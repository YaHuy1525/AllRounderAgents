import { describe, expect, it } from "vitest";

import {
  decisionHistory,
  formatLatency,
  formatRate,
  sanitizeMetricsSummary,
  type MetricsSummary,
} from "./metrics.js";
import type { Approval } from "./models.js";

const SUMMARY: MetricsSummary = {
  generatedAt: "2026-01-01T00:00:00+00:00",
  runs: { total: 4, completed: 3, failed: 1, cancelled: 0, successRate: 0.75 },
  workflows: [
    { workflow: "review", total: 3, completed: 2, failed: 1, cancelled: 0 },
  ],
  decisions: { proceed: 2, abort: 1 },
  queue: { active: 2, queued: 0, running: 1, awaitingHuman: 1, blocked: 0 },
  latency: {
    overall: { count: 12, p50: 0.025, p95: 0.0475 },
    http: [{ route: "/runs", count: 12, p50: 0.025, p95: 0.0475 }],
  },
};

describe("metrics summary sanitizer", () => {
  it("accepts a well-formed summary payload", () => {
    expect(sanitizeMetricsSummary(SUMMARY)).toEqual(SUMMARY);
  });

  it("drops malformed workflow rows and decision entries, never the payload", () => {
    const result = sanitizeMetricsSummary({
      ...SUMMARY,
      workflows: [...SUMMARY.workflows, { workflow: "", total: 1 }, { workflow: "x" }, "junk"],
      decisions: { proceed: 2, broken: "many" },
    });
    expect(result?.workflows).toEqual(SUMMARY.workflows);
    expect(result?.decisions).toEqual({ proceed: 2 });
  });

  it("keeps null percentiles and null success rates", () => {
    const result = sanitizeMetricsSummary({
      ...SUMMARY,
      runs: { ...SUMMARY.runs, successRate: null },
      latency: { overall: { count: 0, p50: null, p95: null }, http: [] },
    });
    expect(result?.runs.successRate).toBeNull();
    expect(result?.latency.overall).toEqual({ count: 0, p50: null, p95: null });
    expect(result?.latency.http).toEqual([]);
  });

  it("rejects payloads with malformed core sections", () => {
    expect(sanitizeMetricsSummary(null)).toBeNull();
    expect(sanitizeMetricsSummary({})).toBeNull();
    expect(sanitizeMetricsSummary({ ...SUMMARY, generatedAt: 7 })).toBeNull();
    expect(sanitizeMetricsSummary({ ...SUMMARY, runs: { total: 1 } })).toBeNull();
    expect(sanitizeMetricsSummary({ ...SUMMARY, queue: { active: -1 } })).toBeNull();
    expect(sanitizeMetricsSummary({ ...SUMMARY, latency: {} })).toBeNull();
    expect(
      sanitizeMetricsSummary({
        ...SUMMARY,
        latency: { overall: { count: 1, p50: "fast", p95: null }, http: [] },
      }),
    ).toBeNull();
  });
});

describe("metrics formatting", () => {
  it("formats latency in ms under a second and seconds above", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(0.025)).toBe("25ms");
    expect(formatLatency(0.0475)).toBe("48ms");
    expect(formatLatency(1.234)).toBe("1.23s");
  });

  it("formats rates as percentages without trailing noise", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0.75)).toBe("75%");
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(0.9877)).toBe("98.8%");
  });
});

describe("decision history", () => {
  const approval = (overrides: Partial<Approval>): Approval => ({
    id: "ap-1",
    caseId: "case-1",
    action: {},
    evidence: [],
    approver: "user-1",
    scope: "support:send",
    expiresAt: "2026-01-02T00:00:00+00:00",
    decision: null,
    comment: null,
    decidedAt: null,
    ...overrides,
  });

  it("keeps only decided approvals, newest first", () => {
    const rows = decisionHistory([
      approval({ id: "pending" }),
      approval({ id: "old", decision: "approved", decidedAt: "2026-01-01T09:00:00+00:00" }),
      approval({
        id: "undated",
        decision: "rejected",
        decidedAt: null,
      }),
      approval({
        id: "new",
        decision: "rejected",
        comment: "no",
        decidedAt: "2026-01-01T10:00:00+00:00",
      }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
    expect(rows[0]).toEqual({
      id: "new",
      scope: "support:send",
      approver: "user-1",
      decision: "rejected",
      comment: "no",
      decidedAt: "2026-01-01T10:00:00+00:00",
    });
  });
});
