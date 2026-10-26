import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TaskInboxList,
  type TaskInboxListProps,
} from "@/components/console/TaskInboxView";
import type { InboxTask } from "@/lib/taskInbox";

function makeTask(overrides: Partial<InboxTask> = {}): InboxTask {
  return {
    runId: "run-1",
    workflow: "vendors",
    ticketKey: "PO-884",
    status: "awaiting_human",
    stepId: "chase",
    stepTitle: "Chase the purchase order",
    stepsDone: 2,
    stepCount: 4,
    startedAt: "2026-09-17T08:00:00Z",
    waitingSince: "2026-09-17T09:30:00Z",
    receipts: 1,
    lockTarget: null,
    lockedBy: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-09-17T10:00:00Z");

function renderList(overrides: Partial<TaskInboxListProps> = {}): string {
  const props: TaskInboxListProps = {
    tasks: [makeTask()],
    tickets: [{ key: "PO-884", summary: "Chase PO-884 from Ben by Thursday" }],
    canDecide: true,
    busyRunId: null,
    armedRunId: null,
    now: NOW,
    lastResult: null,
    actionError: null,
    onConfirm: () => {},
    onEdit: () => {},
    onReject: () => {},
    onRetryLock: () => {},
    onOpenRun: () => {},
    onOpenTicket: () => {},
    ...overrides,
  };
  return renderToString(<TaskInboxList {...props} />);
}

describe("task inbox cards", () => {
  it("renders an awaiting gate as a what/who/when card with the three actions", () => {
    const html = renderList();
    expect(html).toContain("PO-884");
    expect(html).toContain("Chase PO-884 from Ben by Thursday");
    expect(html).toContain("Chase the purchase order");
    expect(html).toContain("Awaiting you");
    expect(html).toContain("waiting 30m");
    expect(html).toContain("Vendor Onboarding");
    expect(html).toContain("2/4 steps");
    expect(html).toContain("1 receipt signed");
    expect(html).toContain("Confirm");
    expect(html).toContain("Edit");
    expect(html).toContain("Reject");
    expect(html).not.toContain("disabled");
  });

  it("renders a blocked stall with the lock and retry instead of confirm", () => {
    const html = renderList({
      tasks: [
        makeTask({
          status: "blocked",
          workflow: "review",
          lockTarget: "acme/app#77",
          lockedBy: "run-2",
        }),
      ],
    });
    expect(html).toContain("Blocked");
    expect(html).toContain("Lock acme/app#77");
    expect(html).toContain("Retry lock");
    expect(html).not.toContain("<span>Confirm</span>");
    expect(html).toContain("Reject");
  });

  it("flips reject to a two-click confirm once armed", () => {
    const html = renderList({ armedRunId: "run-1" });
    expect(html).toContain("Confirm reject");
  });

  it("disables every action without the approver role and explains why", () => {
    const html = renderList({ canDecide: false });
    expect(html).toContain("disabled");
    expect(html).toContain("approver or admin role");
  });

  it("keeps every action disabled for a card without a step to decide", () => {
    const html = renderList({ tasks: [makeTask({ stepId: null, stepTitle: null })] });
    expect(html).toContain("Waiting on a human step");
    expect(html).toContain("disabled");
  });

  it("locks all cards while one decision is in flight", () => {
    const html = renderList({
      tasks: [makeTask(), makeTask({ runId: "run-2", ticketKey: "ENG-9" })],
      busyRunId: "run-1",
    });
    expect((html.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe("task inbox notes", () => {
  it("shows the signed receipt with a link into the run's timeline", () => {
    const html = renderList({
      lastResult: {
        task: makeTask(),
        kind: "receipt",
        receipt: "rcpt-abc123456789",
      },
    });
    expect(html).toContain("Receipt signed");
    expect(html).toContain("rcpt-abc1234");
    expect(html).toContain("verifiable in PO-884&#x27;s timeline");
    expect(html).toContain("Open run");
  });

  it("names a rejected run as cancelled", () => {
    const html = renderList({
      lastResult: { task: makeTask(), kind: "cancelled", receipt: null },
    });
    expect(html).toContain("was rejected and cancelled");
  });

  it("surfaces the decision error above the cards", () => {
    const html = renderList({
      actionError: "The run advanced or the lock changed — refreshing the inbox.",
    });
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("refreshing the inbox");
  });

  it("lands on inbox zero with no tasks", () => {
    const html = renderList({ tasks: [] });
    expect(html).toContain("Inbox zero");
    expect(html).not.toContain("Confirm");
  });
});
