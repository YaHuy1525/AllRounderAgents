import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaseHeader } from "@/components/console/CaseHeader";
import type { CaseHeaderModel } from "@/lib/cases";

function model(overrides: Partial<CaseHeaderModel> = {}): CaseHeaderModel {
  return {
    key: "ABC-1",
    lane: "review",
    laneLabel: "PR Review",
    status: { label: "Awaiting you", tone: "warn" },
    title: "Crash on Apple login",
    summary: "PR #77 is ready to review",
    facts: [
      { label: "Pull request", value: "acme/app#77" },
      { label: "Progress", value: "1 of 4 steps done" },
    ],
    risks: [
      {
        label: "Blocked on acme/app#77",
        detail: "Held by run run-2-ow. Retry the lock from the step panel.",
        tone: "danger",
        stepId: "select-pr",
        source: "run:run-1:lock",
      },
    ],
    next: {
      label: "Select PR",
      detail: "Waiting for your decision on this step",
      tone: "warn",
      stepId: "select-pr",
      source: "run:run-1:select-pr",
    },
    receipts: {
      signed: 2,
      pending: 1,
      items: [
        {
          label: "Select PR · action abcdef123456",
          state: "signed",
          source: "run:run-1:select-pr:receipt",
        },
        {
          label: "hr-help:approve · teamlead",
          state: "pending",
          source: "approval:gate-1",
        },
      ],
    },
    ...overrides,
  };
}

describe("case header card", () => {
  it("renders the five blocks with title, pill, and provenance", () => {
    const html = renderToString(<CaseHeader model={model()} onFocusStep={() => {}} />);
    expect(html).toContain('aria-label="Case overview"');
    expect(html).toContain("ABC-1 · PR Review");
    expect(html).toContain("Crash on Apple login");
    expect(html).toContain("case-pill tone-warn");
    expect(html).toContain("Awaiting you");
    expect(html).toContain("PR #77 is ready to review");
    expect(html).toContain("Key facts");
    expect(html).toContain("Pull request");
    expect(html).toContain("acme/app#77");
    expect(html).toContain("case-risk tone-danger");
    expect(html).toContain('title="run:run-1:lock"');
    expect(html).toContain("Held by run run-2-ow.");
    expect(html).toContain("case-next tone-warn");
    expect(html).toContain('title="run:run-1:select-pr"');
    expect(html).toContain("Waiting for your decision on this step");
    expect(html).toContain("Receipts");
    expect(html).toContain("2 signed · 1 pending");
    expect(html).toContain("case-receipt state-signed");
    expect(html).toContain("case-receipt state-pending");
    expect(html).toContain("Select PR · action abcdef123456");
  });

  it("shows calm copy when there is nothing to report", () => {
    const html = renderToString(
      <CaseHeader model={model({ risks: [], receipts: { signed: 0, pending: 0, items: [] } })} />,
    );
    expect(html).toContain("No risks detected.");
    expect(html).toContain("No receipts yet.");
    expect(html).not.toContain("case-risk");
  });

  it("disables focus controls without a handler", () => {
    const live = renderToString(<CaseHeader model={model()} onFocusStep={() => {}} />);
    expect(live).not.toContain("disabled");
    const inert = renderToString(<CaseHeader model={model()} />);
    expect(inert).toContain("disabled");
  });

  it("forwards header actions beside the title", () => {
    const html = renderToString(
      <CaseHeader
        model={model()}
        onFocusStep={() => {}}
        actions={<span className="test-run-badge">Run #3</span>}
      />,
    );
    expect(html).toContain("ticket-view-actions");
    expect(html).toContain("Run #3");
  });
});
