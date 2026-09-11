import { describe, expect, it } from "vitest";

import {
  collectHttpsLinks,
  eventsForStep,
  formatCost,
  inferLane,
  laneForDomain,
  stepStates,
  stepsForLane,
  type CaseEvent,
} from "./cases.js";

function withKind(kind: string): CaseEvent {
  return { actor: "agent", kind, payload: {}, created_at: "2026-09-10T10:00:00Z" };
}

describe("lane step plans", () => {
  it("renders only the steps the support lane actually runs", () => {
    const ids = stepsForLane("support").map((step) => step.id);
    expect(ids).toEqual(["input", "retrieve", "draft", "validation", "gate", "results"]);
    expect(ids).not.toContain("environment");
  });

  it("keeps the environment step for coding but not for support", () => {
    expect(stepsForLane("coding").map((step) => step.id)).toContain("environment");
    expect(stepsForLane("support").map((step) => step.id)).not.toContain("environment");
  });

  it("maps case domains onto lanes", () => {
    expect(laneForDomain("support")).toBe("support");
    expect(laneForDomain("coding")).toBe("coding");
    expect(laneForDomain("programming")).toBe("coding");
    expect(laneForDomain("finance")).toBe("finance");
    expect(laneForDomain("other-domain")).toBe("generic");
  });

  it("infers a lane from the ticket text when no run exists", () => {
    expect(inferLane({ summary: "Support: refund request", labels: [] })).toBe("support");
    expect(inferLane({ summary: "Fix repo patch", labels: [] })).toBe("coding");
    expect(inferLane({ summary: "Reconcile the ledger", labels: [] })).toBe("finance");
    expect(inferLane({ summary: "Something else", labels: [] })).toBe("generic");
  });
});

describe("stepper states", () => {
  it("marks every step future before a run exists", () => {
    const states = stepStates(stepsForLane("coding"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });

  it("marks executed steps done and the next open step current", () => {
    const events = [
      withKind("case.created"),
      withKind("support.retrieve.completed"),
      withKind("draft.ready"),
    ];
    const states = stepStates(stepsForLane("support"), events, true);
    expect(states).toEqual(["done", "done", "done", "current", "future", "future"]);
  });

  it("routes case events to the step that owns them", () => {
    const gate = stepsForLane("support").find((step) => step.id === "gate")!;
    const events = [withKind("approval.requested"), withKind("draft.ready")];
    expect(eventsForStep(gate, events).map((event) => event.kind)).toEqual([
      "approval.requested",
    ]);
  });
});

describe("result helpers", () => {
  it("formats run costs", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(12_500)).toBe("$0.0125");
  });

  it("collects only HTTPS links, deduplicated", () => {
    const links = collectHttpsLinks({
      pr: "https://example.com/pr/1",
      insecure: "http://insecure.example.com",
      nested: ["https://example.com/pr/1", "javascript:alert(1)"],
    });
    expect(links).toEqual(["https://example.com/pr/1"]);
  });
});
