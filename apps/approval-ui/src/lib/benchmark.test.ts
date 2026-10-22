import { describe, expect, it } from "vitest";

import {
  formatMicroUsd,
  sanitizeBenchmark,
  type BenchmarkLane,
  type BenchmarkSummary,
  type BenchmarkTotals,
} from "./benchmark.js";
import { formatRate } from "./metrics.js";

const LANE: BenchmarkLane = {
  workflow: "review",
  title: "PR review",
  terminalRuns: 3,
  passes: 2,
  passRate: 0.6667,
  costUsdMicro: 4200,
  costPerPassUsdMicro: 2100,
  gateReceipts: 5,
  selfCorrection: {
    repairApplied: 1,
    criticBlocked: 0,
    doomLoopStops: 1,
    validationAttempts: 2,
    checksRun: 3,
  },
  steps: [
    {
      stepId: "ai-review",
      title: "AI review",
      gates: 4,
      approvals: 2,
      retries: 1,
      stops: 1,
      revisits: 0,
      approvalRate: 0.5,
    },
  ],
};

const TOTALS: BenchmarkTotals = {
  terminalRuns: 3,
  passes: 2,
  passRate: 0.6667,
  costUsdMicro: 4200,
  costPerPassUsdMicro: 2100,
  gateReceipts: 5,
  selfCorrection: {
    repairApplied: 1,
    criticBlocked: 0,
    doomLoopStops: 1,
    validationAttempts: 2,
    checksRun: 3,
  },
};

const SUMMARY: BenchmarkSummary = {
  generatedAt: "2026-01-01T00:00:00+00:00",
  laneScope: ["review", "issues"],
  lanes: [LANE],
  totals: TOTALS,
};

describe("benchmark sanitizer", () => {
  it("accepts a well-formed benchmark payload", () => {
    expect(sanitizeBenchmark(SUMMARY)).toEqual(SUMMARY);
  });

  it("keeps null pass rates and null cost-per-pass", () => {
    const result = sanitizeBenchmark({
      ...SUMMARY,
      lanes: [{ ...LANE, passRate: null, costPerPassUsdMicro: null, passes: 0 }],
      totals: { ...TOTALS, passRate: null, costPerPassUsdMicro: null },
    });
    expect(result?.lanes[0]?.passRate).toBeNull();
    expect(result?.lanes[0]?.costPerPassUsdMicro).toBeNull();
    expect(result?.totals.costPerPassUsdMicro).toBeNull();
  });

  it("drops a malformed step row but keeps the lane and payload", () => {
    const result = sanitizeBenchmark({
      ...SUMMARY,
      lanes: [
        {
          ...LANE,
          steps: [
            ...LANE.steps,
            { stepId: "", title: "no id" },
            { stepId: "ok", title: "Missing counts" },
            "junk",
          ],
        },
      ],
    });
    expect(result?.lanes[0]?.steps).toEqual(LANE.steps);
  });

  it("drops a malformed lane but keeps the rest of the document", () => {
    const result = sanitizeBenchmark({
      ...SUMMARY,
      lanes: [LANE, { workflow: "", title: "no workflow" }, "junk"],
    });
    expect(result?.lanes).toEqual([LANE]);
  });

  it("defaults malformed self-correction counters to zero", () => {
    const result = sanitizeBenchmark({
      ...SUMMARY,
      lanes: [{ ...LANE, selfCorrection: { repairApplied: "many" } }],
    });
    expect(result?.lanes[0]?.selfCorrection).toEqual({
      repairApplied: 0,
      criticBlocked: 0,
      doomLoopStops: 0,
      validationAttempts: 0,
      checksRun: 0,
    });
  });

  it("rejects payloads missing the core totals or timestamp", () => {
    expect(sanitizeBenchmark(null)).toBeNull();
    expect(sanitizeBenchmark({})).toBeNull();
    expect(sanitizeBenchmark({ ...SUMMARY, generatedAt: 7 })).toBeNull();
    expect(sanitizeBenchmark({ ...SUMMARY, totals: { terminalRuns: 1 } })).toBeNull();
  });

  it("degrades a malformed lanes list to empty rather than failing the payload", () => {
    const result = sanitizeBenchmark({ ...SUMMARY, lanes: "not-a-list" });
    expect(result?.lanes).toEqual([]);
    expect(result?.totals).toEqual(TOTALS);
  });
});

describe("benchmark formatting", () => {
  it("formats micro-USD as dollars above a cent and raw micro below", () => {
    expect(formatMicroUsd(null)).toBe("—");
    expect(formatMicroUsd(0)).toBe("$0.00");
    expect(formatMicroUsd(4200)).toBe("$0.0042");
    expect(formatMicroUsd(123456)).toBe("$0.12");
    expect(formatMicroUsd(40)).toBe("40µUSD");
  });

  it("reuses the shared rate formatter", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0.6667)).toBe("66.7%");
    expect(formatRate(1)).toBe("100%");
  });
});
