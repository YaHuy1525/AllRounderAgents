import { describe, expect, it } from "vitest";

import { queueOrder, riskBand } from "./approvalQueue";
import type { Approval } from "./models";

/** Builds one approval; only risk and id matter for the queue rule. */
function gate(id: string, risk: number | null): Approval {
  return {
    id,
    caseId: "case-1",
    action: {},
    evidence: [],
    approver: "user-1",
    scope: "run:review",
    expiresAt: "2026-10-21T12:10:00Z",
    decision: null,
    comment: null,
    decidedAt: null,
    risk,
  };
}

function ids(approvals: Approval[]): string[] {
  return approvals.map((approval) => approval.id);
}

describe("approval queue order", () => {
  it("puts the highest band first even when it was created last", () => {
    const input = [gate("low-first", 10), gate("medium", 55), gate("high-last", 90)];
    expect(ids(queueOrder(input))).toEqual(["high-last", "medium", "low-first"]);
  });

  it("keeps equal bands in age order", () => {
    // The server returns rows oldest-first; input order is the age record.
    const input = [gate("old-55", 55), gate("mid-10", 10), gate("new-55", 55)];
    expect(ids(queueOrder(input))).toEqual(["old-55", "new-55", "mid-10"]);
  });

  it("sorts unranked gates after every declared band", () => {
    const input = [gate("oldest-null", null), gate("low", 10), gate("newest-high", 90)];
    expect(ids(queueOrder(input))).toEqual(["newest-high", "low", "oldest-null"]);
  });

  it("preserves insertion order for an all-null queue", () => {
    const input = [gate("a", null), gate("b", null), gate("c", null)];
    expect(ids(queueOrder(input))).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const input = [gate("low", 10), gate("high", 90)];
    queueOrder(input);
    expect(ids(input)).toEqual(["low", "high"]);
  });
});

describe("approval risk chip", () => {
  it("renders nothing for an unranked gate", () => {
    expect(riskBand(null)).toBeNull();
  });

  it("colours only the three anchors 10/55/90", () => {
    expect(riskBand(10)).toEqual({ label: "Low", className: "approval-risk risk-low" });
    expect(riskBand(55)).toEqual({ label: "Medium", className: "approval-risk risk-medium" });
    expect(riskBand(90)).toEqual({ label: "High", className: "approval-risk risk-high" });
  });

  it("keeps a non-anchor band neutral so colour cannot contradict its number", () => {
    // An operator may declare any 0-100 band; only the anchors get a chip
    // colour, so 100 shows the honest number in the plain pill.
    expect(riskBand(100)).toEqual({ label: "Risk 100", className: "approval-risk" });
    for (const band of [0, 11, 50, 89, 100]) {
      expect(riskBand(band)?.className).toBe("approval-risk");
      expect(riskBand(band)?.label).toBe(`Risk ${band}`);
    }
  });
});
