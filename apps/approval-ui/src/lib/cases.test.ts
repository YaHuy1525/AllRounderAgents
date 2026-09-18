import { describe, expect, it } from "vitest";

import {
  collectHttpsLinks,
  eventsForStep,
  formatCost,
  inferLane,
  laneForDomain,
  laneForWorkflow,
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

describe("review lane", () => {
  it("follows the review run definition step order", () => {
    const ids = stepsForLane("review").map((step) => step.id);
    expect(ids).toEqual(["select-pr", "review-options", "ai-review", "complete"]);
  });

  it("maps only shipped workflows onto the review lane", () => {
    expect(laneForWorkflow("review")).toBe("review");
    expect(laneForWorkflow("support")).toBeNull();
    expect(laneForWorkflow("review-follow-up")).toBeNull();
  });
});

describe("issue resolution lane", () => {
  it("follows the issues run definition step order", () => {
    const ids = stepsForLane("issues").map((step) => step.id);
    expect(ids).toEqual(["issue-selection", "analysis", "implementation", "complete"]);
  });

  it("maps the issues workflow onto the issues lane", () => {
    expect(laneForWorkflow("issues")).toBe("issues");
    expect(laneForWorkflow("review")).toBe("review");
    expect(laneForWorkflow("issues-follow-up")).toBeNull();
  });

  it("marks executed issue steps done and the next open step current", () => {
    const events = [
      withKind("case.created"),
      withKind("issue.selected"),
      withKind("affected.files.identified"),
      withKind("patch.applied"),
    ];
    const states = stepStates(stepsForLane("issues"), events, true);
    expect(states).toEqual(["done", "done", "done", "current"]);
  });

  it("keeps every issue step future before a run exists", () => {
    const states = stepStates(stepsForLane("issues"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });
});

describe("feature implementation lane", () => {
  it("follows the features run definition step order", () => {
    const ids = stepsForLane("features").map((step) => step.id);
    expect(ids).toEqual(["feature-selection", "scope-design", "implementation", "complete"]);
  });

  it("maps the features workflow onto the features lane", () => {
    expect(laneForWorkflow("features")).toBe("features");
    expect(laneForWorkflow("issues")).toBe("issues");
    expect(laneForWorkflow("features-follow-up")).toBeNull();
  });

  it("marks executed feature steps done and the next open step current", () => {
    const events = [
      withKind("feature.selected"),
      withKind("scope.defined"),
      withKind("patch.applied"),
    ];
    const states = stepStates(stepsForLane("features"), events, true);
    expect(states).toEqual(["done", "done", "done", "current"]);
  });

  it("keeps every feature step future before a run exists", () => {
    const states = stepStates(stepsForLane("features"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });
});

describe("dependency update lane", () => {
  it("follows the dependencies run definition step order", () => {
    const ids = stepsForLane("dependencies").map((step) => step.id);
    expect(ids).toEqual(["scan", "group", "apply", "validate", "merge"]);
  });

  it("maps the dependencies workflow onto the dependencies lane", () => {
    expect(laneForWorkflow("dependencies")).toBe("dependencies");
    expect(laneForWorkflow("features")).toBe("features");
    expect(laneForWorkflow("dependencies-follow-up")).toBeNull();
  });

  it("keeps every dependency step future before a run exists", () => {
    const states = stepStates(stepsForLane("dependencies"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });
});

describe("accessibility audit lane", () => {
  it("follows the accessibility run definition step order", () => {
    const ids = stepsForLane("accessibility").map((step) => step.id);
    expect(ids).toEqual(["crawl", "violations", "fix", "re-scan"]);
  });

  it("maps the accessibility workflow onto the accessibility lane", () => {
    expect(laneForWorkflow("accessibility")).toBe("accessibility");
    expect(laneForWorkflow("dependencies")).toBe("dependencies");
    expect(laneForWorkflow("accessibility-follow-up")).toBeNull();
  });

  it("keeps every accessibility step future before a run exists", () => {
    const states = stepStates(stepsForLane("accessibility"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });
});

describe("vendor onboarding lane", () => {
  it("follows the vendors run definition step order", () => {
    const ids = stepsForLane("vendors").map((step) => step.id);
    expect(ids).toEqual(["collect", "verify", "risk-score", "approve", "create"]);
  });

  it("maps the vendors workflow onto the vendors lane", () => {
    expect(laneForWorkflow("vendors")).toBe("vendors");
    expect(laneForWorkflow("accessibility")).toBe("accessibility");
    expect(laneForWorkflow("vendors-follow-up")).toBeNull();
  });

  it("maps vendor domains and ticket text onto the vendors lane", () => {
    expect(laneForDomain("vendor")).toBe("vendors");
    expect(laneForDomain("vendor-onboarding")).toBe("vendors");
    expect(inferLane({ summary: "Onboard a new vendor", labels: [] })).toBe("vendors");
    expect(inferLane({ summary: "Invoice from a vendor", labels: [] })).toBe("vendors");
  });

  it("keeps every vendor step future before a run exists", () => {
    const states = stepStates(stepsForLane("vendors"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });

  it("marks collected and verified steps done with the risk score current", () => {
    const events = [withKind("vendor.collect.completed"), withKind("vendor.verify.completed")];
    const states = stepStates(stepsForLane("vendors"), events, true);
    expect(states).toEqual(["done", "done", "current", "future", "future"]);
  });
});

describe("leave lane", () => {
  it("follows the leave run definition step order", () => {
    const ids = stepsForLane("leave").map((step) => step.id);
    expect(ids).toEqual(["intake", "policy-check", "approve", "apply"]);
  });

  it("maps the leave workflow onto the leave lane", () => {
    expect(laneForWorkflow("leave")).toBe("leave");
    expect(laneForWorkflow("vendors")).toBe("vendors");
    expect(laneForWorkflow("leave-follow-up")).toBeNull();
  });

  it("keeps every leave step future before a run exists", () => {
    const states = stepStates(stepsForLane("leave"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });

  it("marks the intake done with the policy check current", () => {
    const states = stepStates(stepsForLane("leave"), [withKind("leave.intake.completed")], true);
    expect(states).toEqual(["done", "current", "future", "future"]);
  });
});

describe("new-hire onboarding lane", () => {
  it("follows the onboarding run definition step order", () => {
    const ids = stepsForLane("onboarding").map((step) => step.id);
    expect(ids).toEqual(["collect", "verify", "risk-score", "approve", "provision"]);
  });

  it("maps the onboarding workflow onto the onboarding lane", () => {
    expect(laneForWorkflow("onboarding")).toBe("onboarding");
    expect(laneForWorkflow("leave")).toBe("leave");
    expect(laneForWorkflow("onboarding-follow-up")).toBeNull();
  });

  it("keeps every onboarding step future before a run exists", () => {
    const states = stepStates(stepsForLane("onboarding"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });

  it("marks collected and verified steps done with the risk score current", () => {
    const events = [
      withKind("onboarding.collect.completed"),
      withKind("onboarding.verify.completed"),
    ];
    const states = stepStates(stepsForLane("onboarding"), events, true);
    expect(states).toEqual(["done", "done", "current", "future", "future"]);
  });
});

describe("employee offboarding lane", () => {
  it("follows the offboarding run definition step order", () => {
    const ids = stepsForLane("offboarding").map((step) => step.id);
    expect(ids).toEqual(["intake", "access-audit", "approve", "revoke", "attest"]);
  });

  it("maps the offboarding workflow onto the offboarding lane", () => {
    expect(laneForWorkflow("offboarding")).toBe("offboarding");
    expect(laneForWorkflow("onboarding")).toBe("onboarding");
    expect(laneForWorkflow("offboarding-follow-up")).toBeNull();
  });

  it("keeps every offboarding step future before a run exists", () => {
    const states = stepStates(stepsForLane("offboarding"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });

  it("marks intake and audit done with the approval gate current", () => {
    const events = [
      withKind("offboarding.intake.completed"),
      withKind("offboarding.audit.completed"),
    ];
    const states = stepStates(stepsForLane("offboarding"), events, true);
    expect(states).toEqual(["done", "done", "current", "future", "future"]);
  });
});

describe("candidate screening lane", () => {
  it("follows the screening run definition step order", () => {
    const ids = stepsForLane("screening").map((step) => step.id);
    expect(ids).toEqual(["requisition", "screen", "shortlist", "schedule"]);
  });

  it("maps the screening workflow onto the screening lane", () => {
    expect(laneForWorkflow("screening")).toBe("screening");
    expect(laneForWorkflow("offboarding")).toBe("offboarding");
    expect(laneForWorkflow("screening-follow-up")).toBeNull();
  });

  it("keeps every screening step future before a run exists", () => {
    const states = stepStates(stepsForLane("screening"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });

  it("marks requisition and screen done with the shortlist current", () => {
    const events = [
      withKind("screening.requisition.completed"),
      withKind("screening.screen.completed"),
    ];
    const states = stepStates(stepsForLane("screening"), events, true);
    expect(states).toEqual(["done", "done", "current", "future"]);
  });
});

describe("hr help lane", () => {
  it("follows the hr-help run definition step order", () => {
    const ids = stepsForLane("hr-help").map((step) => step.id);
    expect(ids).toEqual(["intake", "retrieve", "draft", "approve", "send"]);
  });

  it("maps the hr-help workflow onto the hr-help lane", () => {
    expect(laneForWorkflow("hr-help")).toBe("hr-help");
    expect(laneForWorkflow("screening")).toBe("screening");
    expect(laneForWorkflow("hr-help-follow-up")).toBeNull();
  });

  it("keeps every hr-help step future before a run exists", () => {
    const states = stepStates(stepsForLane("hr-help"), [], false);
    expect(states.every((state) => state === "future")).toBe(true);
  });

  it("marks intake and retrieve done with the draft current", () => {
    const events = [
      withKind("hr-help.intake.completed"),
      withKind("hr-help.retrieve.completed"),
    ];
    const states = stepStates(stepsForLane("hr-help"), events, true);
    expect(states).toEqual(["done", "done", "current", "future", "future"]);
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
