import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../../mastra.js";
import { MemoryQaCaseStore, caseSetHash, type QaCaseStore } from "../cases.js";
import {
  QA_FLOW_STEPS,
  QaCaseResultSchema,
  QaDefectReceiptSchema,
  QaRunStateSchema,
  type QaAnalysis,
  type QaCase,
  type QaCaseResult,
  type QaDefectReceipt,
  type QaFlowStepId,
  type QaRunState,
} from "../contracts.js";
import type { QaDefectFiler, QaFileBrief } from "../defects.js";
import type { QaExecuteBrief, QaExecution, QaExecutor } from "../executor.js";
import type { QaAnalyseBrief, QaDesignBrief, QaSquadModel } from "../squad.js";

/**
 * The nine-step walk, driven the way the API drives it: one decision per
 * checkpoint, and the effects map carried forward exactly as
 * `run.side_effects` carries it between passes.
 *
 * The two writes are the point of the exercise. `execute` and `file-defects`
 * suspend with a plan and act only on a forward decision, so a checkpoint can
 * show what is about to happen — and a re-driven pass can prove it happened
 * once. No browser, no model, no network: every dep is a fake.
 */

const PROCEED_HASH = "0".repeat(64);

function qaInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storyKey: "OPS-123",
    scope: "Approving a leave request from the console",
    target: "local-console",
    maxCases: 10,
    ...overrides,
  };
}

function analysis(): QaAnalysis {
  return {
    storyKey: "OPS-123",
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
    target: "local-console",
  };
}

function fullSet(): QaCase[] {
  return [testCase("QA-OPS-001", ["R1"]), testCase("QA-OPS-002", ["R2"])];
}

/** Serves queued case sets in order, repeating the last one. */
class FakeSquad implements QaSquadModel {
  readonly analyseStoryKeys: string[] = [];
  readonly designFeedback: Array<string | undefined> = [];
  private readonly designs: QaCase[][];

  constructor(designs: QaCase[][] = [fullSet()]) {
    this.designs = designs;
  }

  async analyse(brief: QaAnalyseBrief): Promise<QaAnalysis> {
    this.analyseStoryKeys.push(brief.storyKey);
    return analysis();
  }

  async design(brief: QaDesignBrief): Promise<QaCase[]> {
    this.designFeedback.push(brief.feedback);
    const index = Math.min(this.designFeedback.length - 1, this.designs.length - 1);
    return [...this.designs[index]!];
  }
}

function passed(caseId: string): Record<string, unknown> {
  return {
    caseId,
    status: "passed",
    observed: `${caseId}: the queue rendered the request`,
    evidence: { console: ["queue rendered"], network: [], transcript: ["opened /approvals"] },
    durationMs: 8,
  };
}

function failed(caseId: string): Record<string, unknown> {
  return {
    caseId,
    status: "failed",
    observed: `${caseId}: the queue rendered "No pending requests"`,
    evidence: { console: ["No pending requests"], network: [], transcript: ["opened /approvals"] },
    durationMs: 9,
  };
}

function blocked(caseId: string, reason: string): Record<string, unknown> {
  return {
    caseId,
    status: "blocked",
    observed: reason,
    evidence: { console: [], network: [], transcript: [] },
    durationMs: 0,
  };
}

interface FakeExecutor extends QaExecutor {
  readonly calls: QaExecuteBrief[];
}

function fakeExecutor(
  options: {
    problem?: string;
    outcomes?: (item: QaCase) => Record<string, unknown>;
  } = {},
): FakeExecutor {
  const calls: QaExecuteBrief[] = [];
  const outcomeOf = options.outcomes ?? ((item: QaCase) => passed(item.id));
  return {
    calls,
    problem: () => options.problem,
    async run(brief: QaExecuteBrief): Promise<QaExecution> {
      calls.push(brief);
      if (options.problem !== undefined) {
        const reason = options.problem;
        return {
          available: false,
          blockedReason: reason,
          results: brief.cases.map((item) => QaCaseResultSchema.parse(blocked(item.id, reason))),
          durationMs: 0,
        };
      }
      const results: QaCaseResult[] = brief.cases.map((item) =>
        QaCaseResultSchema.parse(outcomeOf(item)),
      );
      return { available: true, results, durationMs: 20 };
    },
  };
}

interface FakeFiler extends QaDefectFiler {
  readonly briefs: QaFileBrief[];
}

function fakeFiler(): FakeFiler {
  const briefs: QaFileBrief[] = [];
  return {
    briefs,
    async file(brief: QaFileBrief): Promise<QaDefectReceipt[]> {
      briefs.push(brief);
      return brief.defects.map((defect) =>
        QaDefectReceiptSchema.parse({
          caseId: defect.caseId,
          correlationId: defect.correlationId,
          action: "created",
          ticketKey: "OPS-77",
          status: "open",
        }),
      );
    },
  };
}

function harness(
  options: {
    model?: QaSquadModel;
    store?: QaCaseStore;
    executor?: QaExecutor;
    filer?: QaDefectFiler;
  } = {},
) {
  const store = options.store ?? new MemoryQaCaseStore();
  const model = options.model ?? new FakeSquad();
  const executor = options.executor ?? fakeExecutor();
  const filer = options.filer ?? fakeFiler();
  const mastra = createAllRounderMastra({
    qa: { model, store, executor, filer, now: () => new Date("2026-10-25T09:00:00.000Z") },
  });
  const flow = mastra.getWorkflow("qaFlow");
  if (flow === undefined) throw new Error("qaFlow is not registered");
  return { flow, store, model, executor, filer, mastra };
}

type QaFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<QaFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = qaInput();
  attempt = 1;
  readonly runId: string;
  private readonly ticketKey: string;

  constructor(identity: { runId?: string; input?: Record<string, unknown> } = {}) {
    this.runId = identity.runId ?? "run-qa-1";
    this.ticketKey = identity.input?.storyKey === undefined ? "OPS-123" : String(identity.input.storyKey);
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): QaRunState {
    return QaRunStateSchema.parse({
      runId: this.runId,
      workflow: "qa",
      ticketKey: this.ticketKey,
      caseId: "case-1",
      attempt: this.attempt,
      input: this.input,
      decisions: this.decisions,
      artifacts: this.artifacts,
      effects: this.effects,
    });
  }

  /** Record a decision the way `RunService.decide()` does, then build resume data. */
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): QaRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return QaRunStateSchema.parse({ ...this.envelope(), decision });
  }
}

interface SuspendView {
  artifact: Record<string, unknown>;
  target?: string;
  effects?: Record<string, Record<string, unknown>>;
}

function suspendView(outcome: unknown, stepId: QaFlowStepId): SuspendView {
  const view = outcome as {
    status?: string;
    suspendPayload?: Record<string, SuspendView | undefined>;
  };
  if (view.status !== "suspended") {
    throw new Error(`expected suspension at ${stepId}, got ${String(view.status)}`);
  }
  const payload = view.suspendPayload?.[stepId];
  if (payload?.artifact === undefined) throw new Error(`no suspend payload for ${stepId}`);
  return payload;
}

/** Drive the flow from the start until it suspends at `stopAt`, proceeding earlier steps. */
async function walkTo(
  flow: QaFlowHandle,
  walk: Walk,
  stopAt: QaFlowStepId,
): Promise<{ run: WorkflowRunHandle; payload: SuspendView }> {
  const run = await flow.createRun();
  let outcome: unknown = await run.start({ inputData: walk.envelope() });
  for (const stepId of QA_FLOW_STEPS) {
    const payload = suspendView(outcome, stepId);
    walk.artifacts[stepId] = payload.artifact;
    // The API persists the payload's effects as `side_effects` and sends them
    // back on the next pass; this is that echo.
    Object.assign(walk.effects, payload.effects ?? {});
    if (stepId === stopAt) return { run, payload };
    outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Walk every checkpoint and proceed at the last one, returning the close artifact. */
async function runToClose(
  flow: QaFlowHandle,
  walk: Walk,
): Promise<{ payload: SuspendView; result: Record<string, unknown> }> {
  const { run, payload } = await walkTo(flow, walk, "close");
  const done = await run.resume({
    resumeData: walk.resume("close", "proceed", { actionHash: PROCEED_HASH }),
  });
  if (done.status !== "success") throw new Error(`expected success, got ${String(done.status)}`);
  return { payload, result: done.result as Record<string, unknown> };
}

/**
 * Read a failure whichever way the engine reports it: a rejected promise or a
 * `status: "failed"` outcome. Returns the text so an assertion can look for
 * the message the step actually threw.
 */
async function failureText(promise: Promise<unknown>): Promise<string> {
  let outcome: { status?: string; error?: unknown };
  try {
    outcome = (await promise) as { status?: string; error?: unknown };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const message = (outcome.error as { message?: unknown } | undefined)?.message;
  return `${String(outcome.status)} ${
    typeof message === "string" ? message : JSON.stringify(outcome.error ?? {})
  }`;
}

describe("Mastra qaFlow", () => {
  it("registers the nine steps in plan order", () => {
    const { flow } = harness();
    expect(flow.id).toBe("qaFlow");
    expect(Object.keys(flow.steps)).toEqual([...QA_FLOW_STEPS]);
  });

  it("resolves the start at intake and suspends before any model work", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "intake");
    expect(payload.artifact).toMatchObject({
      storyKey: "OPS-123",
      scope: "Approving a leave request from the console",
      maxCases: 10,
      target: {
        key: "local-console",
        baseUrl: "http://localhost:3000",
        storageState: ".qa/auth/local-console.json",
        maxStepMs: 30_000,
      },
    });
    expect(payload.target).toBe("qa:local-console:OPS-123");
  });

  it("walks to approve-cases with a covered, hash-addressed case set", async () => {
    const { flow, model } = harness();
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "approve-cases");

    expect(walk.artifacts.analyse).toMatchObject({ storyKey: "OPS-123", ambiguities: [] });
    expect(payload.artifact).toMatchObject({
      gaps: [],
      truncated: false,
      caseSetHash: caseSetHash(fullSet()),
    });
    expect((payload.artifact.cases as unknown[]).length).toBe(2);
    expect(payload.target).toBe("qa:local-console:OPS-123");
    expect((model as FakeSquad).analyseStoryKeys).toEqual(["OPS-123"]);
  });

  it("records the approval as an effect, not as the end of the run", async () => {
    const { flow, store } = harness();
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "approve-cases");

    // Suspended at the gate: nothing has been written yet.
    expect(await store.list("OPS-123")).toHaveLength(0);

    const next = await run.resume({
      resumeData: walk.resume("approve-cases", "proceed", { actionHash: PROCEED_HASH }),
    });
    const plan = suspendView(next, "execute");
    Object.assign(walk.effects, plan.effects ?? {});

    const records = await store.list("OPS-123");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      storyKey: "OPS-123",
      caseSetHash: caseSetHash(fullSet()),
      approvedCaseIds: ["QA-OPS-001", "QA-OPS-002"],
    });
    // The approval travels in the effects map, which is what the next pass and
    // the console both read. The store stamps `approvedAt` itself, so the two
    // records agree by identity rather than by a clock the test chose.
    expect(walk.effects["approve-cases"]).toEqual({
      caseSetHash: caseSetHash(fullSet()),
      approvedCaseIds: ["QA-OPS-001", "QA-OPS-002"],
      approvedAt: records[0]?.approvedAt,
    });
  });

  it("suspends at execute with a plan and drives nothing until the decision", async () => {
    const { flow, executor } = harness();
    const fake = executor as FakeExecutor;
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "execute");

    expect(fake.calls).toEqual([]);
    expect(payload.artifact).toMatchObject({
      runId: "run-qa-1",
      storyKey: "OPS-123",
      targetKey: "local-console",
      caseSetHash: caseSetHash(fullSet()),
      approvedCaseIds: ["QA-OPS-001", "QA-OPS-002"],
      available: true,
      maxStepMs: 30_000,
    });
    expect((payload.artifact.cases as QaCase[]).map((item) => item.id)).toEqual([
      "QA-OPS-001",
      "QA-OPS-002",
    ]);

    const next = await run.resume({
      resumeData: walk.resume("execute", "proceed", { actionHash: PROCEED_HASH }),
    });
    const verdict = suspendView(next, "assess").artifact;

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.cases.map((item) => item.id)).toEqual(["QA-OPS-001", "QA-OPS-002"]);
    expect(verdict).toMatchObject({
      runId: "run-qa-1",
      executionAvailable: true,
      defects: [],
      gaps: [],
    });
    expect((verdict.results as QaCaseResult[]).map((item) => item.status)).toEqual([
      "passed",
      "passed",
    ]);
  });

  it("degrades honestly when the browser or its session is missing", async () => {
    const problem =
      "no stored session at .qa/auth/local-console.json: log in to http://localhost:3000 once";
    const executor = fakeExecutor({ problem });
    const { flow } = harness({ executor });
    const walk = new Walk();

    const { run, payload } = await walkTo(flow, walk, "execute");
    expect(payload.artifact).toMatchObject({ available: false, blockedReason: problem });

    const next = await run.resume({
      resumeData: walk.resume("execute", "proceed", { actionHash: PROCEED_HASH }),
    });
    const verdict = suspendView(next, "assess").artifact;
    expect(verdict).toMatchObject({ executionAvailable: false, blockedReason: problem, defects: [] });
    expect((verdict.results as QaCaseResult[]).map((item) => item.status)).toEqual([
      "blocked",
      "blocked",
    ]);
    // Every requirement is now unverified, and the reason says why.
    expect((verdict.gaps as Array<{ requirementId: string }>).map((gap) => gap.requirementId)).toEqual([
      "R1",
      "R2",
    ]);

    const fresh = new Walk();
    const { result } = await runToClose(flow, fresh);
    expect(result).toMatchObject({
      status: "completed",
      executionAvailable: false,
      counts: { cases: 2, passed: 0, failed: 0, blocked: 2, notRun: 0, defects: 0, filed: 0 },
      failedCaseIds: [],
      filed: [],
    });
  });

  it("files only what failed, and files it once", async () => {
    const executor = fakeExecutor({
      outcomes: (item) => (item.id === "QA-OPS-001" ? failed(item.id) : passed(item.id)),
    });
    const filer = fakeFiler();
    const { flow } = harness({ executor, filer });
    const walk = new Walk();

    const { run, payload } = await walkTo(flow, walk, "approve-defects");
    expect(payload.artifact).toMatchObject({
      defects: [{ caseId: "QA-OPS-001", severity: "high", correlationId: "OPS-123:QA-OPS-001" }],
      approvedDefectIds: ["QA-OPS-001"],
    });
    expect(filer.briefs).toEqual([]);

    const filing = suspendView(
      await run.resume({
        resumeData: walk.resume("approve-defects", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "file-defects",
    );
    expect(filing.artifact).toMatchObject({
      storyKey: "OPS-123",
      targetKey: "local-console",
      defects: [{ caseId: "QA-OPS-001" }],
    });
    // The plan checkpoint writes nothing either.
    expect(filer.briefs).toEqual([]);

    const closing = suspendView(
      await run.resume({
        resumeData: walk.resume("file-defects", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "close",
    );
    expect(filer.briefs).toHaveLength(1);
    expect(filer.briefs[0]?.defects.map((defect) => defect.caseId)).toEqual(["QA-OPS-001"]);
    expect(filer.briefs[0]?.results.map((item) => [item.caseId, item.status])).toEqual([
      ["QA-OPS-001", "failed"],
      ["QA-OPS-002", "passed"],
    ]);
    expect(closing.artifact).toMatchObject({
      status: "completed",
      approvedCaseIds: ["QA-OPS-001", "QA-OPS-002"],
      caseCount: 2,
      executionAvailable: true,
      counts: { cases: 2, passed: 1, failed: 1, blocked: 0, notRun: 0, defects: 1, filed: 1 },
      // R1's only case failed, so the requirement stays unverified even though
      // the failure is now a ticket. A filed defect is not a passing test.
      gaps: [{ requirementId: "R1" }],
      failedCaseIds: ["QA-OPS-001"],
      filed: [{ caseId: "QA-OPS-001", action: "created", ticketKey: "OPS-77" }],
    });
  });

  it("re-drives nothing once the same run already drove and filed", async () => {
    const executor = fakeExecutor({
      outcomes: (item) => (item.id === "QA-OPS-001" ? failed(item.id) : passed(item.id)),
    });
    const filer = fakeFiler();
    const { flow } = harness({ executor, filer });
    const walk = new Walk();

    const first = await runToClose(flow, walk);
    expect(executor.calls).toHaveLength(1);
    expect(filer.briefs).toHaveLength(1);
    expect(first.result.filed).toEqual([
      { caseId: "QA-OPS-001", correlationId: "OPS-123:QA-OPS-001", action: "created", ticketKey: "OPS-77", status: "open" },
    ]);

    // Same envelopes, same case set, same effects, and every checkpoint already
    // decided: the replay walks straight through, driving nothing and filing
    // nothing, and lands on the same evidence pack.
    const replay = await flow.createRun();
    const second = await replay.start({ inputData: walk.envelope() });
    expect(second.status).toBe("success");
    if (second.status !== "success") throw new Error("expected success");
    expect(second.result).toEqual(first.result);
    expect(executor.calls).toHaveLength(1);
    expect(filer.briefs).toHaveLength(1);
  });

  it("refuses a narrowed defect list that names no finding", async () => {
    const executor = fakeExecutor({
      outcomes: (item) => (item.id === "QA-OPS-001" ? failed(item.id) : passed(item.id)),
    });
    const { flow } = harness({ executor });
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "approve-defects");

    const outcome = await run.resume({
      resumeData: walk.resume("approve-defects", "edit", {
        actionHash: PROCEED_HASH,
        edits: { approvedDefectIds: ["QA-OPS-002"] },
      }),
    });
    expect(await failureText(Promise.resolve(outcome))).toContain(
      "cannot file findings for cases that reported none: QA-OPS-002",
    );
  });

  it("re-asks the designer once, then reports what is still uncovered", async () => {
    const model = new FakeSquad([[testCase("QA-OPS-001", ["R1"])], fullSet()]);
    const { flow } = harness({ model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "approve-cases");

    expect(model.designFeedback).toHaveLength(2);
    expect(model.designFeedback[0]).toBeUndefined();
    expect(model.designFeedback[1]).toContain("R2");
    expect(payload.artifact.gaps).toEqual([]);
    expect(payload.artifact.cases).toHaveLength(2);
  });

  it("refuses to approve a set that still leaves a requirement uncovered", async () => {
    const incomplete = [testCase("QA-OPS-001", ["R1"])];
    const model = new FakeSquad([incomplete, incomplete]);
    const { flow, store } = harness({ model });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "approve-cases");

    expect(payload.artifact.gaps).toEqual([
      { requirementId: "R2", reason: "no case asserts this requirement" },
    ]);

    const outcome = await run.resume({
      resumeData: walk.resume("approve-cases", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureText(Promise.resolve(outcome))).toContain(
      "cannot approve a case set with uncovered requirements: R2",
    );
    expect(await store.list("OPS-123")).toHaveLength(0);
  });

  it("fails when the designer cites a requirement the analysis never declared", async () => {
    const invented = [testCase("QA-OPS-001", ["R1", "R9"]), testCase("QA-OPS-002", ["R9"])];
    const model = new FakeSquad([invented, invented]);
    const { flow, store } = harness({ model });
    const walk = new Walk();
    const run = await flow.createRun();

    walk.artifacts.intake = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "intake",
    ).artifact;
    walk.artifacts.analyse = suspendView(
      await run.resume({
        resumeData: walk.resume("intake", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "analyse",
    ).artifact;

    const outcome = await run.resume({
      resumeData: walk.resume("analyse", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureText(Promise.resolve(outcome))).toContain("unknown requirement R9");
    // An invented requirement never reaches the approval gate or the store.
    expect(await store.list("OPS-123")).toHaveLength(0);
  });

  it("refuses an unknown target at the first checkpoint", async () => {
    const { flow } = harness();
    const walk = new Walk({ input: qaInput({ target: "prod" }) });
    const run = await flow.createRun();
    const outcome = await run.start({ inputData: walk.envelope() });
    expect(await failureText(Promise.resolve(outcome))).toContain('Unknown QA target "prod"');
  });

  it("truncates a set that exceeds the case budget instead of trusting the count", async () => {
    const model = new FakeSquad([fullSet()]);
    const { flow } = harness({ model });
    const walk = new Walk({ input: qaInput({ maxCases: 1 }) });
    const { payload } = await walkTo(flow, walk, "approve-cases");
    expect(payload.artifact.truncated).toBe(true);
    expect(payload.artifact.cases).toHaveLength(1);
    expect(payload.artifact.gaps).toEqual([
      { requirementId: "R2", reason: "no case asserts this requirement" },
    ]);
  });
});

describe("qa case store", () => {
  it("keeps the first record for a set, so a re-drive cannot move the stamp", async () => {
    const store = new MemoryQaCaseStore();
    const first = await store.save({
      storyKey: "OPS-123",
      caseSetHash: caseSetHash(fullSet()),
      approvedCaseIds: ["QA-OPS-001", "QA-OPS-002"],
      cases: fullSet(),
    });
    const again = await store.save({
      storyKey: "OPS-123",
      caseSetHash: caseSetHash(fullSet()),
      approvedCaseIds: ["QA-OPS-001", "QA-OPS-002"],
      cases: fullSet(),
    });
    expect(again.approvedAt).toBe(first.approvedAt);
    expect(await store.list("OPS-123")).toHaveLength(1);
    expect(
      await store.load("OPS-123", caseSetHash(fullSet())),
    ).toMatchObject({ caseSetHash: caseSetHash(fullSet()) });
  });
});
