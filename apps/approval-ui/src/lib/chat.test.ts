import { describe, expect, it } from "vitest";

import {
  addContextChip,
  artifactHighlights,
  blockersReply,
  buildChatRequest,
  CHAT_AGENTS,
  createTaskDraft,
  createTaskReply,
  draftReply,
  ensureRunContextChip,
  parseCreateTaskIntent,
  quickActionsFor,
  removeContextChip,
  runContextSuffix,
  summarizeRunReply,
  type ChatTicket,
} from "./chat.js";
import type { RunDetail, RunSummary } from "./runs.js";
import type { InboxTask } from "./taskInbox.js";

describe("assistant context chips", () => {
  it("adds chips keyed by uppercase ticket key", () => {
    const chips = addContextChip([], { key: "eng-7", summary: "Refund flow" });
    expect(chips).toEqual([{ key: "ENG-7", summary: "Refund flow" }]);
  });

  it("removes chips by key", () => {
    const chips = addContextChip(
      addContextChip([], { key: "ENG-1", summary: "A" }),
      { key: "ENG-2", summary: "B" },
    );
    expect(removeContextChip(chips, "ENG-1").map((chip) => chip.key)).toEqual(["ENG-2"]);
    expect(removeContextChip(chips, "NOPE-1")).toEqual(chips);
  });

  it("ignores payloads that are not ticket keys", () => {
    expect(addContextChip([], { key: "<script>", summary: "x" })).toEqual([]);
    expect(addContextChip([], { key: "not a key", summary: "x" })).toEqual([]);
  });

  it("deduplicates chips and moves the latest to the front", () => {
    const chips = addContextChip(
      addContextChip([], { key: "ENG-1", summary: "old" }),
      { key: "ENG-1", summary: "new" },
    );
    expect(chips).toEqual([{ key: "ENG-1", summary: "new" }]);
  });
});

describe("chat payload", () => {
  it("sends the agent, chips, and board snapshot", () => {
    const payload = buildChatRequest({
      message: "  status?  ",
      agent: CHAT_AGENTS[2].id,
      chips: [{ key: "ENG-1", summary: "A" }],
      tickets: [
        { key: "ENG-1", summary: "A" },
        { key: "ENG-2", summary: "B" },
      ],
    });
    expect(payload.message).toBe("status?");
    expect(payload.agent).toBe("coding");
    expect(payload.selectedKey).toBe("ENG-1");
    expect(payload.tickets.map((ticket) => ticket.key)).toEqual(["ENG-1", "ENG-2"]);
  });

  it("caps the ticket payload at the server limit", () => {
    const tickets = Array.from({ length: 60 }, (_, index) => ({
      key: `ENG-${index + 1}`,
      summary: "x",
    }));
    const payload = buildChatRequest({ message: "hi", agent: "triage", chips: [], tickets });
    expect(payload.tickets).toHaveLength(40);
  });

  it("falls back to the board selection when no chip is attached", () => {
    const payload = buildChatRequest({
      message: "hi",
      agent: "triage",
      chips: [],
      tickets: [],
      selectedKey: "ENG-9",
    });
    expect(payload.selectedKey).toBe("ENG-9");
  });
});

// -------------------------------------------------------------- U8 fixtures

const TICKET: ChatTicket = {
  key: "ENG-1",
  summary: "Build board",
  status: "To Do",
  issueType: "Story",
  priority: "High",
  assignee: "Alex",
  labels: [],
};

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "3f8a2c1d-0000-0000-0000-000000000000",
    workflow: "review",
    ticketKey: "ENG-1",
    status: "awaiting_human",
    queuePosition: null,
    waitingOn: null,
    heldSlots: [],
    currentStepId: "review-options",
    stepCount: 4,
    stepsDone: 1,
    startedAt: "2026-10-08T09:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeStep(overrides: Partial<RunDetail["steps"][number]> = {}): RunDetail["steps"][number] {
  return {
    stepId: "select-pr",
    index: 0,
    title: "Select PR",
    state: "done",
    artifact: null,
    decision: null,
    receipt: null,
    actionHash: null,
    regenerations: 0,
    updatedAt: "2026-10-08T09:05:00Z",
    ...overrides,
  };
}

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    ...makeSummary(),
    caseId: "case-1",
    attempt: 1,
    heartbeatAt: "2026-10-08T09:10:00Z",
    lockTarget: null,
    lockedBy: null,
    outcome: null,
    cancelReason: null,
    sideEffects: {},
    steps: [makeStep()],
    ...overrides,
  };
}

function makeTask(overrides: Partial<InboxTask> = {}): InboxTask {
  return {
    runId: "run-1",
    workflow: "review",
    ticketKey: "ENG-1",
    status: "awaiting_human",
    stepId: "verify",
    stepTitle: "Verify",
    stepsDone: 1,
    stepCount: 4,
    startedAt: "2026-10-08T09:00:00Z",
    waitingSince: "2026-10-08T10:00:00Z",
    receipts: 1,
    lockTarget: null,
    lockedBy: null,
    ...overrides,
  };
}

// ----------------------------------------------------------- lane actions

describe("lane quick actions", () => {
  it("keeps the neutral trio for a selected ticket with a run", () => {
    expect(quickActionsFor("generic", { hasTicket: true, hasRun: true }).map((item) => item.id)).toEqual([
      "summarize-run",
      "list-blockers",
      "create-task",
    ]);
  });

  it("hides summarize without a run and adds the lane draft action", () => {
    const actions = quickActionsFor("vendors", { hasTicket: true, hasRun: false });
    expect(actions.map((item) => item.id)).toEqual(["list-blockers", "draft-chase", "create-task"]);
    expect(actions.find((item) => item.id === "draft-chase")?.label).toBe("Draft chase");
  });

  it("returns nothing without a selected ticket", () => {
    expect(quickActionsFor("review", { hasTicket: false, hasRun: true })).toEqual([]);
  });
});

describe("run:step context", () => {
  it("suffixes chips with the short run id and current step", () => {
    expect(runContextSuffix({ runId: "3f8a2c1d-0000", currentStepId: "verify" })).toBe(
      "run 3f8a2c1d at verify",
    );
    expect(runContextSuffix({ runId: "3f8a2c1d-0000", currentStepId: null })).toBe("run 3f8a2c1d");
  });

  it("adds the selected ticket chip with its run context", () => {
    const chips = ensureRunContextChip([], {
      key: "eng-1",
      summary: "Build board",
      run: { runId: "3f8a2c1d-0000", currentStepId: "verify" },
    });
    expect(chips).toEqual([
      { key: "ENG-1", summary: "Build board · run 3f8a2c1d at verify" },
    ]);
  });

  it("enriches an existing chip in place and stays idempotent", () => {
    const start = [
      { key: "ENG-1", summary: "Build board" },
      { key: "ENG-2", summary: "Other" },
    ];
    const once = ensureRunContextChip(start, {
      key: "ENG-1",
      summary: "Build board",
      run: { runId: "3f8a2c1d-0000", currentStepId: null },
    });
    expect(once.map((chip) => chip.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(once[0]?.summary).toBe("Build board · run 3f8a2c1d");
    expect(once[1]).toBe(start[1]);
    const twice = ensureRunContextChip(once, {
      key: "ENG-1",
      summary: "Build board",
      run: { runId: "3f8a2c1d-0000", currentStepId: null },
    });
    expect(twice).toBe(once);
  });

  it("ignores null runs and invalid keys", () => {
    const chips = [{ key: "ENG-1", summary: "Build board" }];
    expect(
      ensureRunContextChip(chips, { key: "ENG-1", summary: "Build board", run: null }),
    ).toBe(chips);
    expect(
      ensureRunContextChip(chips, {
        key: "bad key",
        summary: "x",
        run: { runId: "r", currentStepId: null },
      }),
    ).toBe(chips);
  });
});

describe("create-task intent", () => {
  it("recognizes the intent and keeps the task text", () => {
    expect(parseCreateTaskIntent("create task: chase PO-884 from Ben")).toEqual({
      text: "chase PO-884 from Ben",
    });
    expect(parseCreateTaskIntent("Create Task - send the W-9")).toEqual({ text: "send the W-9" });
    expect(parseCreateTaskIntent("  create task")).toEqual({ text: "" });
  });

  it("leaves other messages alone", () => {
    expect(parseCreateTaskIntent("create tasks for the team")).toBeNull();
    expect(parseCreateTaskIntent("what blocks ENG-1?")).toBeNull();
  });
});

// ------------------------------------------------------- summarize answers

describe("summarize this run", () => {
  it("returns risks, next, and receipt links for a blocked run", () => {
    const run = makeSummary({ status: "blocked" });
    const detail = makeDetail({
      status: "blocked",
      lockTarget: "vendors-lock",
      lockedBy: "12ab34cd-0000-0000-0000-000000000000",
      steps: [
        makeStep({ receipt: "receipt-1", actionHash: "abcdef1234567890" }),
        makeStep({
          stepId: "review-options",
          index: 1,
          title: "Review Options",
          state: "blocked",
        }),
      ],
    });
    const reply = summarizeRunReply({ ticket: TICKET, run, detail });
    expect(reply.body).toContain("**Run 3f8a2c1d · review · Blocked**");
    expect(reply.body).toContain("Blocked on vendors-lock");
    expect(reply.body).toContain("**Next:**");
    expect(reply.body).toContain("**Receipts:** 1 signed · 0 pending");
    expect(reply.links[0]).toEqual({
      kind: "run",
      label: "Open run 3f8a2c1d",
      runId: run.runId,
      workflow: "review",
      ticketKey: "ENG-1",
    });
    expect(reply.links).toContainEqual({
      kind: "step",
      label: "Blocked on vendors-lock",
      runId: run.runId,
      workflow: "review",
      ticketKey: "ENG-1",
      stepId: "review-options",
    });
    expect(reply.links).toContainEqual({
      kind: "receipt",
      label: "Receipt · Select PR · action abcdef123456",
      runId: run.runId,
      workflow: "review",
      ticketKey: "ENG-1",
      stepId: "select-pr",
    });
  });

  it("answers from the summary alone when the detail is missing", () => {
    const reply = summarizeRunReply({ ticket: TICKET, run: makeSummary(), detail: null });
    expect(reply.body).toContain("No risks flagged on this run.");
    expect(reply.body).toContain("**Next:** review-options");
    expect(reply.body).toContain("**Receipts:** 0 signed · 0 pending");
    expect(reply.links.map((link) => link.kind)).toEqual(["run", "step"]);
  });
});

// -------------------------------------------------------------- blockers

describe("list blockers", () => {
  it("hands back the inbox link when nothing waits", () => {
    const reply = blockersReply([]);
    expect(reply.body).toContain("No runs are waiting on a human right now");
    expect(reply.links).toEqual([{ kind: "inbox", label: "Open the Task Inbox" }]);
  });

  it("lists awaiting before blocked and links every card", () => {
    const reply = blockersReply([
      makeTask({
        runId: "run-2",
        ticketKey: "ENG-2",
        status: "blocked",
        stepId: "collect",
        stepTitle: null,
        receipts: 2,
        lockTarget: "vendors-lock",
        lockedBy: "12ab34cd-0000-0000-0000-000000000000",
      }),
      makeTask(),
    ]);
    expect(reply.body).toContain("**2 run(s) need a human**");
    expect(reply.body.indexOf("ENG-1")).toBeLessThan(reply.body.indexOf("ENG-2"));
    expect(reply.body).toContain("**ENG-1 · Awaiting you** at Verify");
    expect(reply.body).toContain("1 receipt");
    expect(reply.body).toContain("**ENG-2 · Blocked** at collect");
    expect(reply.body).toContain("2 receipts");
    expect(reply.body).toContain("held on vendors-lock by run 12ab34cd");
    expect(reply.links).toContainEqual({
      kind: "step",
      label: "ENG-1 · Verify",
      runId: "run-1",
      workflow: "review",
      ticketKey: "ENG-1",
      stepId: "verify",
    });
    expect(reply.links).toContainEqual({
      kind: "step",
      label: "ENG-2 · collect",
      runId: "run-2",
      workflow: "review",
      ticketKey: "ENG-2",
      stepId: "collect",
    });
  });
});

// ----------------------------------------------------------------- drafts

describe("artifact highlights", () => {
  it("keeps outstanding entries and drops resolved ones", () => {
    expect(
      artifactHighlights({
        documents: [
          { label: "W-9", status: "pending" },
          { label: "COI", status: "received" },
          { name: "Bank letter", status: "outstanding" },
        ],
      }),
    ).toEqual(["W-9 (pending)", "Bank letter (outstanding)"]);
  });

  it("accepts bare strings and caps at four", () => {
    expect(artifactHighlights({ items: ["Send the form", "  ", "Pay the fee"] })).toEqual([
      "Send the form",
      "Pay the fee",
    ]);
    expect(
      artifactHighlights({ checks: ["a", "b", "c", "d", "e"] }),
    ).toHaveLength(4);
    expect(artifactHighlights(null)).toEqual([]);
  });
});

describe("lane drafts", () => {
  it("drafts a chase from the waiting step's artifact", () => {
    const run = makeSummary({ workflow: "vendors", currentStepId: "collect", status: "awaiting_human" });
    const detail = makeDetail({
      workflow: "vendors",
      currentStepId: "collect",
      steps: [
        makeStep({ stepId: "intake", title: "Intake", receipt: "receipt-1" }),
        makeStep({
          stepId: "collect",
          index: 1,
          title: "Collect",
          state: "awaiting_human",
          artifact: {
            documents: [
              { label: "W-9", status: "pending" },
              { label: "COI", status: "received" },
            ],
          },
        }),
      ],
    });
    const reply = draftReply({ actionId: "draft-chase", ticket: TICKET, run, detail });
    expect(reply.source).toBe("draft · review before sending");
    expect(reply.body).toContain("Draft — review before sending.");
    expect(reply.body).toContain("Subject: Outstanding items — ENG-1");
    expect(reply.body).toContain("- W-9 (pending)");
    expect(reply.body).not.toContain("COI");
    expect(reply.links).toContainEqual({
      kind: "ticket",
      label: "Open ENG-1",
      ticketKey: "ENG-1",
    });
    expect(reply.links).toContainEqual({
      kind: "step",
      label: "Collect (waiting step)",
      runId: run.runId,
      workflow: "vendors",
      ticketKey: "ENG-1",
      stepId: "collect",
    });
    expect(reply.links).toContainEqual({
      kind: "receipt",
      label: "Receipt · Intake",
      runId: run.runId,
      workflow: "vendors",
      ticketKey: "ENG-1",
      stepId: "intake",
    });
  });

  it("falls back to a clean template without a run", () => {
    const reply = draftReply({ actionId: "draft-hr-reply", ticket: TICKET, run: null, detail: null });
    expect(reply.body).toContain("Subject: Your HR question — ENG-1");
    expect(reply.links).toEqual([{ kind: "ticket", label: "Open ENG-1", ticketKey: "ENG-1" }]);
  });
});

// ------------------------------------------------------------ task create

describe("create task", () => {
  it("derives an issue-resolution start from a bug ticket", () => {
    const bug: ChatTicket = { ...TICKET, key: "ENG-2", issueType: "Bug", summary: "Crash on login" };
    const draft = createTaskDraft({ ticket: bug, taskText: "Fix the login crash" });
    expect(draft).toEqual({
      ticketKey: "ENG-2",
      workflow: "issues",
      workflowLabel: "Issue Resolution",
      input: {
        ticketKey: "ENG-2",
        ticketSummary: "Crash on login",
        candidates: [{ key: "ENG-2", summary: "Crash on login", status: "To Do" }],
      },
      title: "Fix the login crash",
      detail: "Fix the login crash",
    });
  });

  it("derives a feature run from a story ticket and defaults the title", () => {
    const draft = createTaskDraft({ ticket: TICKET, taskText: "" });
    expect(draft?.workflow).toBe("features");
    expect(draft?.workflowLabel).toBe("Feature Implementation");
    expect(draft?.title).toBe("Build board");
  });

  it("derives dependency and HR start inputs", () => {
    const deps: ChatTicket = { ...TICKET, key: "ENG-3", summary: "Bump lodash dependency" };
    expect(createTaskDraft({ ticket: deps, taskText: "Upgrade lodash" })).toMatchObject({
      workflow: "dependencies",
      input: {},
    });
    const hr: ChatTicket = { ...TICKET, key: "HR-9", issueType: "Task", summary: "HR help: leave question" };
    expect(createTaskDraft({ ticket: hr, taskText: "What is the parental leave policy?" })).toMatchObject({
      workflow: "hr-help",
      input: { question: "What is the parental leave policy?" },
    });
  });

  it("refuses workflows whose inputs must not be invented", () => {
    const vendors: ChatTicket = { ...TICKET, key: "PO-7", summary: "Vendor onboarding for Northwind" };
    expect(createTaskDraft({ ticket: vendors, taskText: "Chase the W-9" })).toBeNull();
    const reply = createTaskReply({ ticket: vendors, taskText: "Chase the W-9" });
    expect(reply.task).toBeUndefined();
    expect(reply.body).toContain("must not invent");
    expect(reply.links).toEqual([{ kind: "ticket", label: "Open PO-7", ticketKey: "PO-7" }]);
  });

  it("returns a confirmable draft with the inbox link", () => {
    const bug: ChatTicket = { ...TICKET, key: "ENG-2", issueType: "Bug", summary: "Crash on login" };
    const reply = createTaskReply({ ticket: bug, taskText: "Fix the login crash" });
    expect(reply.task?.workflow).toBe("issues");
    expect(reply.body).toContain("**Issue Resolution** run");
    expect(reply.links).toEqual([
      { kind: "ticket", label: "Open ENG-2", ticketKey: "ENG-2" },
      { kind: "inbox", label: "Open the Task Inbox" },
    ]);
  });
});
