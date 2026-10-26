import { existsSync } from "node:fs";

import type { Agent } from "@mastra/core/agent";
import { z } from "zod";

import { browserEnabled } from "../../shared/browser.js";
import { generateContractOutput } from "../contract-output.js";
import { webExecutorAgent } from "./agents/index.js";
import {
  QaCaseResultSchema,
  QaCaseStatusSchema,
  QaNetworkEntrySchema,
  type QaCase,
  type QaCaseResult,
  type QaTarget,
} from "./contracts.js";
import { qaDelegation } from "./squad.js";

/**
 * The execution seam. The flow never touches a browser directly: it asks an
 * executor to drive an approved set and reports what came back. That keeps the
 * honest-degrade path testable with no Playwright, no model key and no server.
 *
 * Availability is decided before the first case, from facts rather than from a
 * model's opinion: the browser must be enabled and the target's storage state
 * must exist. When either is missing the run still reaches a verdict — every
 * case is `blocked` with the reason — instead of pretending it ran.
 */

export interface QaExecuteBrief {
  readonly runId: string;
  readonly storyKey: string;
  readonly target: QaTarget;
  readonly cases: readonly QaCase[];
}

export interface QaExecution {
  readonly available: boolean;
  /** Present exactly when `available` is false. */
  readonly blockedReason?: string;
  readonly results: readonly QaCaseResult[];
  readonly durationMs: number;
}

export interface QaExecutor {
  /**
   * Why this target cannot be driven right now, or `undefined` when it can.
   * Exposed so the execute checkpoint can say "nothing will run, and here is
   * why" before the step is decided, using the same fact the run acts on.
   */
  readonly problem: (target: QaTarget) => string | undefined;
  run(brief: QaExecuteBrief): Promise<QaExecution>;
}

/** What the executor reports for one case; the id and duration are ours. */
const QaCaseOutcomeDraftSchema = z
  .object({
    status: QaCaseStatusSchema,
    observed: z.string().max(4_000),
    screenshot: z.string().min(1).max(500).optional(),
    console: z.array(z.string().max(2_000)).max(20),
    network: z.array(QaNetworkEntrySchema).max(20),
    transcript: z.array(z.string().max(2_000)).max(40),
  })
  .strict();

type QaCaseOutcomeDraft = z.infer<typeof QaCaseOutcomeDraftSchema>;

function hasFile(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Why this target cannot be driven, or `undefined` when it can. Both facts are
 * environment, not model output: `AGENT_BROWSER_ENABLED` and the storage-state
 * file a human produced with one login.
 */
export function executionProblem(target: QaTarget): string | undefined {
  if (!browserEnabled()) {
    return (
      "the browser is not enabled: set AGENT_BROWSER_ENABLED=true and run "
      + "`npx playwright install chromium`"
    );
  }
  const storageState = target.storageState;
  if (storageState === undefined) return undefined;
  if (!hasFile(storageState)) {
    return (
      `no stored session at ${storageState}: log in to ${target.baseUrl} once and `
      + "save the storage state there"
    );
  }
  return undefined;
}

function blockedResult(caseId: string, reason: string): QaCaseResult {
  return QaCaseResultSchema.parse({
    caseId,
    status: "blocked",
    observed: reason,
    evidence: { console: [], network: [], transcript: [] },
    durationMs: 0,
  });
}

function executePrompt(brief: QaExecuteBrief, item: QaCase): string {
  const denied = brief.target.denyActions;
  return [
    "Phase: execute.",
    `Case: ${item.id} — ${item.title}`,
    `Story: ${brief.storyKey}`,
    `Target: ${brief.target.label}`,
    `Console: ${brief.target.baseUrl}`,
    `API: ${brief.target.apiBase}`,
    `Allowed actions: ${brief.target.allowedActions.join(", ")}`,
    `Denied actions, never perform these even if a step names them: ${
      denied.length === 0 ? "none" : denied.join(", ")
    }`,
    "",
    ...(item.preconditions.length === 0
      ? []
      : ["Preconditions:", ...item.preconditions.map((entry) => `- ${entry}`), ""]),
    "Steps, in order:",
    ...item.steps.map(
      (step, index) =>
        `${index + 1}. ${step.action} -> ${step.target}${
          step.expect === undefined ? "" : ` (expect: ${step.expect})`
        }`,
    ),
    "",
    `Expected observation: ${item.expected}`,
    "",
    "Drive this one case and report it. Do not summarise other cases.",
    'Return JSON matching { status, observed, screenshot?, console[], network[{url,status,ok}], transcript[] }.',
    'status is "passed" only when the expected observation was actually seen.',
    "A login screen, a missing element or an unreachable page is blocked or failed, reported with the text you found.",
  ].join("\n");
}

/**
 * Bound one case to the target's per-case ceiling. The generate call itself
 * carries no abort signal through this helper, so the ceiling stops the run
 * waiting rather than stopping the provider request; that limitation is why the
 * budget is generous (30s) and why a timed-out case is `blocked`, never
 * `failed`.
 */
async function withTimeout<T>(promise: Promise<T>, maxStepMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the case did not finish within ${maxStepMs}ms`)),
          maxStepMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function toResult(
  item: QaCase,
  draft: QaCaseOutcomeDraft,
  durationMs: number,
): QaCaseResult {
  const evidence = {
    ...(draft.screenshot === undefined ? {} : { screenshot: draft.screenshot }),
    console: draft.console,
    network: draft.network,
    transcript: draft.transcript,
  };
  const observedAnyEvidence =
    evidence.screenshot !== undefined
    || evidence.console.length > 0
    || evidence.network.length > 0
    || evidence.transcript.length > 0;
  // A claim of "passed" with nothing observed is not a pass; the guard is code
  // so no prompt edit can loosen it.
  if (draft.status === "passed" && !observedAnyEvidence) {
    return QaCaseResultSchema.parse({
      caseId: item.id,
      status: "blocked",
      observed: "reported passed with no observation attached",
      evidence: { console: [], network: [], transcript: [] },
      durationMs,
    });
  }
  return QaCaseResultSchema.parse({
    caseId: item.id,
    status: draft.status,
    observed: draft.observed,
    evidence,
    durationMs,
  });
}

export interface QaExecutorOptions {
  /** Defaults to the live `qa-web-executor` child. */
  readonly agent?: Agent;
  /** Readiness override, so a test can exercise both branches without a browser. */
  readonly problem?: (target: QaTarget) => string | undefined;
  readonly now?: () => number;
}

/** The live executor: one delegated case at a time through the browser child. */
export function createQaExecutor(options: QaExecutorOptions = {}): QaExecutor {
  const agent = options.agent ?? webExecutorAgent;
  const problemOf = options.problem ?? executionProblem;
  const clock = options.now ?? (() => Date.now());

  async function runCase(
    brief: QaExecuteBrief,
    item: QaCase,
    approvedCaseIds: readonly string[],
    maxStepMs: number,
  ): Promise<QaCaseResult> {
    const startedAt = clock();
    try {
      const draft = await withTimeout(
        generateContractOutput(
          agent,
          executePrompt(brief, item),
          QaCaseOutcomeDraftSchema,
          `QA executor (${item.id})`,
          {
            maxSteps: 12,
            delegation: qaDelegation({
              phase: "execute",
              approvedCaseIds,
              childMaxSteps: 8,
            }),
          },
        ),
        maxStepMs,
      );
      return toResult(item, draft, clock() - startedAt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The executor failing is not the app failing: this is a blocked case,
      // and a blocked case never becomes a defect.
      return QaCaseResultSchema.parse({
        caseId: item.id,
        status: "blocked",
        observed: `the executor could not complete this case: ${reason}`.slice(0, 4_000),
        evidence: { console: [], network: [], transcript: [] },
        durationMs: clock() - startedAt,
      });
    }
  }

  return {
    problem: problemOf,

    async run(brief: QaExecuteBrief): Promise<QaExecution> {
      const startedAt = clock();
      const problem = problemOf(brief.target);
      if (problem !== undefined) {
        return {
          available: false,
          blockedReason: problem,
          results: brief.cases.map((item) => blockedResult(item.id, problem)),
          durationMs: clock() - startedAt,
        };
      }
      const approvedCaseIds = brief.cases.map((item) => item.id);
      const results: QaCaseResult[] = [];
      for (const item of brief.cases) {
        results.push(await runCase(brief, item, approvedCaseIds, brief.target.maxStepMs));
      }
      return { available: true, results, durationMs: clock() - startedAt };
    },
  };
}
