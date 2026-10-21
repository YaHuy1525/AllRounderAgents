import { describe, expect, it } from "vitest";

import {
  caseHeaderModel,
  collectHttpsLinks,
  eventsForStep,
  formatCost,
  inferLane,
  LANE_HEADER_FIELDS,
  LANE_LABELS,
  laneForDomain,
  laneForWorkflow,
  parseCaseDocSnap,
  stepStates,
  stepsForLane,
  type CaseEvent,
  type CaseHeaderApproval,
  type CaseHeaderInput,
  type CaseHeaderRun,
  type CaseHeaderRunStep,
  type LaneId,
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

describe("case header model", () => {
  const LANE_IDS: LaneId[] = [
    "generic",
    "support",
    "coding",
    "finance",
    "review",
    "issues",
    "features",
    "dependencies",
    "accessibility",
    "vendors",
    "leave",
    "onboarding",
    "offboarding",
    "screening",
    "hr-help",
  ];

  function headerStep(overrides: Partial<CaseHeaderRunStep> = {}): CaseHeaderRunStep {
    return {
      stepId: "select-pr",
      title: "Select PR",
      index: 0,
      state: "done",
      artifact: null,
      receipt: null,
      actionHash: null,
      regenerations: 0,
      ...overrides,
    };
  }

  function headerRun(overrides: Partial<CaseHeaderRun> = {}): CaseHeaderRun {
    return {
      runId: "run-1",
      workflow: "review",
      status: "awaiting_human",
      attempt: 2,
      queuePosition: null,
      waitingOn: null,
      heldSlots: [],
      currentStepId: "select-pr",
      stepCount: 4,
      stepsDone: 1,
      startedAt: "2026-10-07T08:00:00Z",
      finishedAt: null,
      lockTarget: "acme/app#77",
      lockedBy: null,
      outcome: null,
      cancelReason: null,
      steps: [
        headerStep({
          artifact: { summary: "PR #77 is ready to review", repository: "acme/app" },
        }),
      ],
      ...overrides,
    };
  }

  function headerInput(overrides: Partial<CaseHeaderInput> = {}): CaseHeaderInput {
    const lane = overrides.lane ?? "support";
    const steps = stepsForLane(lane);
    return {
      ticket: {
        key: "ABC-1",
        summary: "Crash on Apple login",
        status: "In progress",
        issueType: "Bug",
        priority: "High",
        assignee: "Anna",
        labels: [],
        project: "shop",
      },
      record: null,
      lane,
      steps,
      states: stepStates(steps, [], false),
      runs: [],
      run: null,
      approvals: [],
      now: Date.parse("2026-10-07T09:00:00Z"),
      ...overrides,
    };
  }

  it("defines a labeled field set for every lane", () => {
    for (const lane of LANE_IDS) {
      expect(LANE_LABELS[lane]).not.toBe("");
      expect(LANE_HEADER_FIELDS[lane].length).toBeGreaterThanOrEqual(3);
    }
  });

  it("renders a sensible header for every lane", () => {
    for (const lane of LANE_IDS) {
      const model = caseHeaderModel(headerInput({ lane }));
      expect(model.laneLabel).toBe(LANE_LABELS[lane]);
      expect(model.key).toBe("ABC-1");
      expect(model.title).toBe("Crash on Apple login");
      expect(model.summary).not.toBe("");
      expect(model.facts.length).toBeGreaterThanOrEqual(2);
      expect(model.facts.length).toBeLessThanOrEqual(4);
      for (const fact of model.facts) {
        expect(fact.label).not.toBe("");
        expect(fact.value).not.toBe("");
      }
      expect(model.risks.length).toBeLessThanOrEqual(3);
      for (const risk of model.risks) {
        expect(risk.source).not.toBe("");
        expect(risk.stepId).not.toBeNull();
      }
      expect(model.next.stepId).not.toBeNull();
      expect(model.next.source).not.toBe("");
    }
  });

  it("swaps key facts per lane", () => {
    const review = caseHeaderModel(headerInput({ lane: "review", run: headerRun() }));
    expect(review.facts).toEqual([
      { label: "Pull request", value: "acme/app#77" },
      { label: "Repo", value: "acme/app" },
      { label: "Progress", value: "1 of 4 steps done" },
      { label: "Attempt", value: "2" },
    ]);

    const accessibility = caseHeaderModel(
      headerInput({
        lane: "accessibility",
        run: headerRun({
          workflow: "accessibility",
          status: "running",
          attempt: 1,
          currentStepId: "violations",
          stepCount: 4,
          stepsDone: 2,
          lockTarget: null,
          steps: [
            headerStep({
              stepId: "violations",
              title: "Violations",
              state: "running",
              artifact: {
                repository: "acme/web",
                violations: [{ rule: "color-contrast" }, { rule: "label" }, { rule: "focus-order" }],
                files: 6,
              },
            }),
          ],
        }),
      }),
    );
    expect(accessibility.facts).toEqual([
      { label: "Repo", value: "acme/web" },
      { label: "Violations", value: "3" },
      { label: "Files", value: "6" },
      { label: "Progress", value: "2 of 4 steps done" },
    ]);

    const screening = caseHeaderModel(
      headerInput({
        lane: "screening",
        run: headerRun({
          workflow: "screening",
          attempt: 1,
          currentStepId: "screen",
          stepCount: 4,
          stepsDone: 1,
          lockTarget: null,
          steps: [
            headerStep({
              stepId: "screen",
              title: "Screen",
              state: "awaiting_human",
              artifact: { totalFlags: 5 },
            }),
          ],
        }),
      }),
    );
    expect(screening.facts).toEqual([
      { label: "Flags", value: "5" },
      { label: "Progress", value: "1 of 4 steps done" },
      { label: "Assignee", value: "Anna" },
      { label: "Priority", value: "High" },
    ]);
  });

  it("headlines the awaiting run and points next at its step", () => {
    const model = caseHeaderModel(headerInput({ lane: "review", run: headerRun() }));
    expect(model.status).toEqual({ label: "Awaiting you", tone: "warn" });
    expect(model.summary).toBe("PR #77 is ready to review");
    expect(model.risks).toEqual([]);
    expect(model.next).toEqual({
      label: "Select PR",
      detail: "Waiting for your decision on this step",
      tone: "warn",
      stepId: "select-pr",
      source: "run:run-1:select-pr",
    });
  });

  it("names the ceiling a queued run actually waits on", () => {
    const queuedNext = (overrides: Partial<CaseHeaderRun>) =>
      caseHeaderModel(
        headerInput({ lane: "review", run: headerRun({ status: "queued", ...overrides }) }),
      ).next;

    expect(queuedNext({ queuePosition: 1, waitingOn: "model" })).toEqual({
      label: "Waiting for a model-call slot",
      detail: "Queue position 1",
      tone: "neutral",
      stepId: "select-pr",
      source: "run:run-1:queue",
    });
    expect(queuedNext({ queuePosition: 1, waitingOn: "apply" })).toEqual({
      label: "Waiting for an apply slot",
      detail: "Queue position 1",
      tone: "neutral",
      stepId: "select-pr",
      source: "run:run-1:queue",
    });
    // The server's own run kind, and anything unknown, keeps the run-slot word.
    expect(queuedNext({ queuePosition: 1, waitingOn: "run" }).label).toBe("Waiting for a run slot");
    expect(queuedNext({ queuePosition: 2, waitingOn: "ghost" }).label).toBe("Waiting for a run slot");
  });

  it("keeps the historical wording when the server recorded no ceiling", () => {
    const model = caseHeaderModel(
      headerInput({
        lane: "review",
        run: headerRun({ status: "queued", queuePosition: null, waitingOn: null, heldSlots: [] }),
      }),
    );
    expect(model.next).toEqual({
      label: "Waiting for a run slot",
      detail: "Queued behind other runs on a run slot",
      tone: "neutral",
      stepId: "select-pr",
      source: "run:run-1:queue",
    });
  });

  it("flags a blocked run and points at the lock evidence", () => {
    const model = caseHeaderModel(
      headerInput({
        lane: "review",
        run: headerRun({ status: "blocked", lockedBy: "run-2-owner" }),
      }),
    );
    expect(model.status).toEqual({ label: "Blocked", tone: "danger" });
    expect(model.risks[0]).toEqual({
      label: "Blocked on acme/app#77",
      detail: "Held by run run-2-ow. Retry the lock from the step panel.",
      tone: "danger",
      stepId: "select-pr",
      source: "run:run-1:lock",
    });
    expect(model.next).toEqual({
      label: "Retry the lock",
      detail: "Blocked on acme/app#77, held by run run-2-ow",
      tone: "danger",
      stepId: "select-pr",
      source: "run:run-1:lock",
    });
  });

  it("surfaces artifact risks with their provenance", () => {
    const model = caseHeaderModel(
      headerInput({
        lane: "offboarding",
        run: headerRun({
          workflow: "offboarding",
          attempt: 1,
          currentStepId: "access-audit",
          stepCount: 5,
          stepsDone: 2,
          lockTarget: null,
          steps: [
            headerStep({
              stepId: "access-audit",
              title: "Access Audit",
              index: 1,
              state: "awaiting_human",
              artifact: {
                risks: [
                  { kind: "network-exposure", severity: "high", summary: "Legacy VPN still reachable" },
                  { label: "Legacy VPN", detail: "Token not revoked" },
                ],
              },
            }),
          ],
        }),
      }),
    );
    expect(model.risks).toEqual([
      {
        label: "network-exposure",
        detail: "Legacy VPN still reachable",
        tone: "danger",
        stepId: "access-audit",
        source: "artifact:run-1:access-audit",
      },
      {
        label: "Legacy VPN",
        detail: "Token not revoked",
        tone: "warn",
        stepId: "access-audit",
        source: "artifact:run-1:access-audit",
      },
    ]);
  });

  it("lists receipts with signed actions and pending gates", () => {
    const gate: CaseHeaderApproval = {
      id: "gate-1",
      scope: "hr-help:approve",
      approver: "teamlead",
      decision: null,
      expiresAt: "2026-12-01T00:00:00Z",
    };
    const model = caseHeaderModel(
      headerInput({
        lane: "review",
        run: headerRun({
          status: "running",
          attempt: 1,
          currentStepId: "review-options",
          stepsDone: 2,
          lockTarget: null,
          steps: [
            headerStep({ receipt: "receipt-abc", actionHash: "abcdef1234567890" }),
            headerStep({
              stepId: "review-options",
              title: "Review Options",
              index: 1,
              receipt: "receipt-def",
              actionHash: "0011223344556677",
            }),
          ],
        }),
        approvals: [gate],
      }),
    );
    expect(model.receipts.signed).toBe(2);
    expect(model.receipts.pending).toBe(1);
    expect(model.receipts.items[0]).toEqual({
      label: "Select PR · action abcdef123456",
      state: "signed",
      source: "run:run-1:select-pr:receipt",
    });
    expect(model.receipts.items.at(-1)).toEqual({
      label: "hr-help:approve · teamlead",
      state: "pending",
      source: "approval:gate-1",
    });
  });

  it("warns before a gate expires and points next at the gate", () => {
    const gate: CaseHeaderApproval = {
      id: "gate-2",
      scope: "support:gate",
      approver: "lead",
      decision: null,
      expiresAt: "2026-10-07T09:10:00Z",
    };
    const model = caseHeaderModel(headerInput({ lane: "support", approvals: [gate] }));
    expect(model.risks[0]).toMatchObject({
      label: "Gate expires soon",
      tone: "warn",
      stepId: "gate",
      source: "approval:gate-2",
    });
    expect(model.risks[0]?.detail).toContain("support:gate expires at");
    expect(model.next).toEqual({
      label: "Decide the gate",
      detail: "support:gate · lead must act before this gate expires",
      tone: "warn",
      stepId: "gate",
      source: "approval:gate-2",
    });
  });

  it("flags a rejected gate and records the decision", () => {
    const gate: CaseHeaderApproval = {
      id: "gate-3",
      scope: "support:gate",
      approver: "lead",
      decision: "rejected",
      expiresAt: "2026-10-08T09:00:00Z",
    };
    const model = caseHeaderModel(headerInput({ lane: "support", approvals: [gate] }));
    expect(model.risks[0]).toEqual({
      label: "Gate rejected",
      detail: "support:gate was rejected by lead",
      tone: "danger",
      stepId: "gate",
      source: "approval:gate-3",
    });
    expect(model.receipts.items[0]).toEqual({
      label: "support:gate · lead",
      state: "rejected",
      source: "approval:gate-3",
    });
  });

  it("prompts a run when a high-priority ticket has none", () => {
    const model = caseHeaderModel(headerInput());
    expect(model.status).toEqual({ label: "In progress", tone: "info" });
    expect(model.summary).toBe("No activity recorded yet");
    expect(model.risks).toEqual([
      {
        label: "No run yet",
        detail: "High priority ticket with no run started",
        tone: "warn",
        stepId: "input",
        source: "ticket:ABC-1:priority",
      },
    ]);
    expect(model.next).toEqual({
      label: "Start the run",
      detail: "No run has been started for ABC-1 yet",
      tone: "info",
      stepId: "input",
      source: "ticket:ABC-1",
    });
  });

  it("routes a record-only case to its next open step", () => {
    const model = caseHeaderModel(
      headerInput({
        lane: "leave",
        record: {
          id: "case-9",
          domain: "leave",
          status: "open",
          events: [withKind("leave.intake.completed")],
        },
        states: ["done", "current", "future", "future"],
      }),
    );
    expect(model.status).toEqual({ label: "Open", tone: "info" });
    expect(model.summary).toBe("Latest event: leave.intake.completed");
    expect(model.next).toEqual({
      label: "Policy Check",
      detail: "The next step with no recorded evidence",
      tone: "info",
      stepId: "policy-check",
      source: "case:case-9:policy-check",
    });
  });

  it("reviews the outcome of a completed run", () => {
    const model = caseHeaderModel(
      headerInput({
        lane: "review",
        run: headerRun({
          status: "completed",
          attempt: 1,
          currentStepId: null,
          stepCount: 4,
          stepsDone: 4,
          finishedAt: "2026-10-07T08:40:00Z",
          lockTarget: null,
          outcome: "PR reviewed and receipts recorded",
          steps: [
            headerStep({
              artifact: { summary: "PR #77 selected" },
              receipt: "receipt-abc",
              actionHash: "abcdef1234567890",
            }),
            headerStep({ stepId: "review-options", title: "Review Options", index: 1 }),
            headerStep({ stepId: "ai-review", title: "AI Review", index: 2 }),
            headerStep({
              stepId: "complete",
              title: "Complete",
              index: 3,
              artifact: { summary: "Review posted to PR #77" },
            }),
          ],
        }),
      }),
    );
    expect(model.status).toEqual({ label: "Completed", tone: "ok" });
    expect(model.summary).toBe("Review posted to PR #77");
    expect(model.risks).toEqual([]);
    expect(model.next).toEqual({
      label: "Review the outcome",
      detail: "PR reviewed and receipts recorded",
      tone: "ok",
      stepId: "complete",
      source: "run:run-1:outcome",
    });
    expect(model.receipts.signed).toBe(1);
  });
});

describe("doc snap drafts", () => {
  const SNAP = {
    snapId: "snap-1",
    docType: "invoice",
    source: {
      filename: "invoice.txt",
      contentType: "text/plain",
      sha256: "a".repeat(64),
      bytes: 96,
    },
    fields: { abn: "51 824 753 556", expiry: "2027-03-14", junk: 7, blank: "" },
    flags: [
      { code: "abn_checksum", severity: "ok", message: "ABN checksum valid.", field: "abn" },
      { code: "expiry", severity: "warning", message: "Expires in 30 day(s).", field: "expiry" },
    ],
    extractor: "heuristic-v1",
    createdAt: "2026-10-09T02:00:00Z",
  };

  it("parses a stored draft and drops non-string field entries", () => {
    const draft = parseCaseDocSnap(SNAP);
    expect(draft).not.toBeNull();
    expect(draft?.snapId).toBe("snap-1");
    expect(draft?.docType).toBe("invoice");
    expect(draft?.source.filename).toBe("invoice.txt");
    expect(draft?.source.bytes).toBe(96);
    expect(draft?.fields).toEqual({ abn: "51 824 753 556", expiry: "2027-03-14" });
    expect(draft?.flags).toEqual(SNAP.flags);
    expect(draft?.extractor).toBe("heuristic-v1");
    expect(draft?.createdAt).toBe("2026-10-09T02:00:00Z");
  });

  it("rejects drafts without an id or a source record", () => {
    expect(parseCaseDocSnap(null)).toBeNull();
    expect(parseCaseDocSnap("nope")).toBeNull();
    expect(parseCaseDocSnap({ ...SNAP, snapId: "" })).toBeNull();
    expect(parseCaseDocSnap({ ...SNAP, source: null })).toBeNull();
  });

  it("drops malformed flags, defaults unknown severities, and fills missing text", () => {
    const draft = parseCaseDocSnap({
      ...SNAP,
      flags: [
        ...SNAP.flags,
        { code: "x", severity: "critical" },
        "junk",
        { code: "y", severity: "critical", message: "Unrated severity." },
      ],
      docType: undefined,
      extractor: 7,
    });
    expect(draft?.flags).toHaveLength(3);
    expect(draft?.flags[2]).toEqual({
      code: "y",
      severity: "warning",
      message: "Unrated severity.",
      field: "",
    });
    expect(draft?.docType).toBe("unknown");
    expect(draft?.extractor).toBe("");
  });
});
