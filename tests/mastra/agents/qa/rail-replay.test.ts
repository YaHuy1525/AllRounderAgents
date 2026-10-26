import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../../../src/mastra/mastra.js";
import { MemoryQaCaseStore, decodeCases } from "../../../../src/mastra/agents/qa/cases.js";
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
} from "../../../../src/mastra/agents/qa/contracts.js";
import type { QaDefectFiler, QaFileBrief } from "../../../../src/mastra/agents/qa/defects.js";
import type { QaExecuteBrief, QaExecution, QaExecutor } from "../../../../src/mastra/agents/qa/executor.js";
import type { QaAnalyseBrief, QaDesignBrief, QaSquadModel } from "../../../../src/mastra/agents/qa/squad.js";

/**
 * The committed qa-squad candidate, regenerated from the rail library.
 *
 * A live produce needs a running API, this Mastra, a browser and a logged-in
 * storage state, and that is the one manual step the plan keeps for a human. The
 * CI tier is this replay: the six committed cases are driven through the real
 * nine-step flow — real design validation, real coverage math, real `assess`,
 * real `close` — with only the executor and the filer injected. It is the tier
 * the test plan names ("flow steps driven with injected fakes"), and every line
 * it writes says so in `origin` so no one reads the file as a console run.
 *
 * Regenerate with `QA_EVAL_WRITE_CANDIDATE=1 npx vitest run rail-replay`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const LIBRARY = join(REPO_ROOT, "evals", "qa", "cases", "console-rail.jsonl");
const CANDIDATE = join(REPO_ROOT, "evals", "judge", "candidates", "qa-squad.jsonl");

const STORY = "OPS-4210";
const SCOPE =
  "The approval console rail: every workspace destination in the nav, the start-run card and its "
  + "required fields, and the decision row on an open run.";
const RUN_ID = "run-qa-rail-1";
const PROCEED_HASH = "0".repeat(64);
const COLLECTED_AT = "2026-10-25T09:00:00+00:00";
const ORIGIN =
  "rail replay: evals/qa/cases/console-rail.jsonl driven through the real qa flow with an injected "
  + "executor and filer and an in-memory case store; no console, browser or model ran";

/** The one case the replay reports as a product defect, so filing is exercised. */
const FAILING_CASE = "QA-RAIL-006";

function railLibrary(): QaCase[] {
  return decodeCases(readFileSync(LIBRARY, "utf8"));
}

/** The first `data-qa` hook a case names; the affordance it is really about. */
function firstHook(item: QaCase): string {
  for (const step of item.steps) {
    const match = /data-qa="([^"]+)"/.exec(step.target);
    if (match !== null) return match[1]!;
  }
  return item.id;
}

/**
 * Designs the committed library back at the flow. Requirements are derived from
 * the cases, so the coverage math in `design` and `approve-cases` runs over the
 * real set rather than over a set built to satisfy it.
 */
class RailSquad implements QaSquadModel {
  constructor(private readonly cases: QaCase[]) {}

  async analyse(brief: QaAnalyseBrief): Promise<QaAnalysis> {
    return {
      storyKey: brief.storyKey,
      summary: "The console rail: destinations, the start card and the decision row.",
      requirements: this.cases.map((item) => ({
        id: item.requirementIds[0]!,
        text: item.title,
        acceptance: [item.expected],
        source: "story" as const,
      })),
      ambiguities: [],
      coverageNotes: [],
    };
  }

  async design(_brief: QaDesignBrief): Promise<QaCase[]> {
    return [...this.cases];
  }
}

function outcomeOf(item: QaCase): Record<string, unknown> {
  const hook = firstHook(item);
  if (item.id === FAILING_CASE) {
    return {
      caseId: item.id,
      status: "failed",
      observed:
        'At the first checkpoint [data-qa="decision-back"] was enabled, so the decision row offered '
        + "a way back from a step that has no predecessor.",
      evidence: {
        console: ['decision row: back disabled=false, proceed disabled=false'],
        network: [],
        transcript: [
          'read [data-qa="decision-back"] -> enabled',
          'read [data-qa="decision-proceed"] -> "Proceed"',
        ],
      },
      durationMs: 940,
    };
  }
  return {
    caseId: item.id,
    status: "passed",
    observed: `${item.id}: ${item.title} — [data-qa="${hook}"] carried the observation the case states.`,
    evidence: {
      console: [],
      network: [],
      transcript: ["navigate -> /", `read [data-qa="${hook}"] -> matched`],
    },
    durationMs: 820,
  };
}

function railExecutor(): QaExecutor {
  return {
    problem: () => undefined,
    async run(brief: QaExecuteBrief): Promise<QaExecution> {
      const results: QaCaseResult[] = brief.cases.map((item) =>
        QaCaseResultSchema.parse(outcomeOf(item)),
      );
      return { available: true, results, durationMs: 4_920 };
    },
  };
}

function railFiler(): QaDefectFiler {
  return {
    async file(brief: QaFileBrief): Promise<QaDefectReceipt[]> {
      return brief.defects.map((defect) =>
        QaDefectReceiptSchema.parse({
          caseId: defect.caseId,
          correlationId: defect.correlationId,
          action: "created",
          ticketKey: "OPS-4301",
          status: "open",
        }),
      );
    },
  };
}

function buildFlow(cases: QaCase[]) {
  const mastra = createAllRounderMastra({
    qa: {
      model: new RailSquad(cases),
      store: new MemoryQaCaseStore(),
      executor: railExecutor(),
      filer: railFiler(),
      now: () => new Date("2026-10-25T09:00:00.000Z"),
    },
  });
  const flow = mastra.getWorkflow("qaFlow");
  if (flow === undefined) throw new Error("qaFlow is not registered");
  return flow;
}

type QaFlow = ReturnType<typeof buildFlow>;

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

/** The envelopes the API sends, built the way `RunService` builds them. */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  readonly input: Record<string, unknown> = {
    storyKey: STORY,
    scope: SCOPE,
    target: "local-console",
    maxCases: 10,
  };

  envelope(): QaRunState {
    return QaRunStateSchema.parse({
      runId: RUN_ID,
      workflow: "qa",
      ticketKey: STORY,
      caseId: "case-rail",
      attempt: 1,
      input: this.input,
      decisions: this.decisions,
      artifacts: this.artifacts,
      effects: this.effects,
    });
  }

  resume(stepId: QaFlowStepId): QaRunState {
    const decision = { action: "proceed", actionHash: PROCEED_HASH };
    this.decisions[stepId] = decision;
    return QaRunStateSchema.parse({ ...this.envelope(), decision });
  }
}

/** Walk every checkpoint, proceeding at each, and return the artifact map. */
async function replay(): Promise<Record<string, Record<string, unknown>>> {
  const cases = railLibrary();
  const flow: QaFlow = buildFlow(cases);
  const walk = new Walk();
  const run = await flow.createRun();
  let outcome: unknown = await run.start({ inputData: walk.envelope() });
  for (const stepId of QA_FLOW_STEPS) {
    const payload = suspendView(outcome, stepId);
    walk.artifacts[stepId] = payload.artifact;
    Object.assign(walk.effects, payload.effects ?? {});
    outcome = await run.resume({ resumeData: walk.resume(stepId) });
  }
  const done = outcome as { status?: string };
  if (done.status !== "success") throw new Error(`expected success, got ${String(done.status)}`);
  return walk.artifacts;
}

interface Rows {
  [key: string]: unknown;
}

function rows(value: unknown): Rows[] {
  return Array.isArray(value) ? (value as Rows[]) : [];
}

/**
 * `approvedAt` is stamped by the store from the wall clock, not from the
 * injected `now`, so it is the one field a replay cannot reproduce. Everything
 * else in the close artifact is a function of the library.
 */
function withoutStamp(artifact: Record<string, unknown> | undefined): Record<string, unknown> {
  const { approvedAt: _stamp, ...rest } = artifact ?? {};
  return rest;
}

function candidateLine(
  item: QaCase,
  artifacts: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return {
    caseId: item.id,
    storeCaseId: null,
    suite: "qa-squad",
    workflow: "qa",
    ticketKey: STORY,
    runId: null,
    status: "replayed",
    outcome: "completed",
    artifacts,
    decisions: QA_FLOW_STEPS.length,
    latencySeconds: null,
    collectedAt: COLLECTED_AT,
    error: null,
    origin: ORIGIN,
  };
}

describe("the qa-squad candidate", () => {
  // One walk serves both cases below; the flow is cheap but the assertion
  // messages read better when the verdict is stated once.
  const fresh = replay;

  it("walks the rail library to a verdict with one filed defect", async () => {
    const artifacts = await fresh();
    const verdict = artifacts.assess!;
    const closing = artifacts.close!;

    expect(verdict.executionAvailable).toBe(true);
    expect((verdict.results as unknown[]).length).toBe(6);
    expect(rows(verdict.gaps).map((gap) => gap.requirementId)).toEqual(["R6"]);

    const defects = rows(verdict.defects);
    expect(defects.map((defect) => defect.caseId)).toEqual([FAILING_CASE]);
    for (const ref of defects[0]!.evidenceRefs as string[]) {
      expect(ref.startsWith(`qa:${RUN_ID}:${FAILING_CASE}:`)).toBe(true);
    }

    expect(rows(closing.filed).map((receipt) => receipt.caseId)).toEqual([FAILING_CASE]);
    expect(closing.failedCaseIds).toEqual([FAILING_CASE]);
    expect(closing.counts).toEqual({
      cases: 6,
      passed: 5,
      failed: 1,
      blocked: 0,
      notRun: 0,
      defects: 1,
      filed: 1,
    });
  });

  it("records the committed candidate, when asked to", async () => {
    if (process.env.QA_EVAL_WRITE_CANDIDATE !== "1") return;
    const artifacts = await fresh();
    const lines = railLibrary().map((item) => JSON.stringify(candidateLine(item, artifacts)));
    writeFileSync(CANDIDATE, `${lines.join("\n")}\n`, "utf8");
    expect(readFileSync(CANDIDATE, "utf8").trimEnd().split("\n")).toHaveLength(6);
  });

  it("agrees with the committed candidate on the verdict and the close", async () => {
    const artifacts = await fresh();
    const committed = readFileSync(CANDIDATE, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(committed.map((line) => line.caseId)).toEqual(railLibrary().map((item) => item.id));
    for (const line of committed) {
      const held = line.artifacts as Record<string, Record<string, unknown>>;
      expect(held.assess).toEqual(artifacts.assess);
      expect(withoutStamp(held.close)).toEqual(withoutStamp(artifacts.close));
    }
  });
});
