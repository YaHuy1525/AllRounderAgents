import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import { SECURITY_FLOW_STEPS, type DecideAction, type EvidenceClaim, type Severity } from "./contracts.js";
import {
  classifySignals,
  containmentIdFor,
  containmentTarget,
  mitreFor,
  riskFor,
  validateClaims,
  type DecideModelContext,
  type InvestigateModelContext,
  type ReportModelContext,
  type RetrievedItem,
  type SecurityModel,
  type TriageModelContext,
} from "./flow.js";
import {
  MemoryAssetDirectory,
  MemoryCaseHistory,
  MemoryContainmentRegistry,
  MemoryTelemetrySearch,
  MemoryThreatIntel,
  type CaseHistory,
  type ContainmentRegistry,
  type ContainmentRequest,
  type ContainmentResult,
  type Environment,
} from "./tools/seams.js";

/**
 * Golden-gate style evals for the security lane: pinned cases live in
 * `evals/security_alert_cases.jsonl` and are replayed here through the same
 * exported engines and the same `securityFlow` the host registers. A mismatch
 * fails with the exact `expected`-vs-`actual` pair so a regression shows up
 * as a data diff, not a silent drift (the HR lanes and the dispatcher golden
 * tickets follow the same idea).
 *
 * The §8 guardrail corpora (`security_injection_corpus.jsonl`,
 * `security_fp_corpus.jsonl`) replay through the same `securityFlow:triage`
 * checkpoint: injected alerts must land on `unknown` with flags, while
 * legitimate-but-scary SOC artifacts must pass through untouched.
 */

const PROCEED_HASH = "0".repeat(64);
const RECEIPT_ID = "receipt-eval-1";
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");
const EVAL_RUN_ID = "run-eval-1";
const EVAL_CASE_ID = "case-eval-1";

interface LaneEvalCase {
  id: string;
  lane: string;
  engine: string;
  args?: unknown[];
  expected?: unknown;
  input?: Record<string, unknown>;
  ticketKey?: string;
  expect?: Record<string, unknown>;
}

function loadJsonl(relativePath: string): LaneEvalCase[] {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const cases: LaneEvalCase[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path}:${index + 1} is not a JSON object`);
    }
    cases.push(parsed as LaneEvalCase);
  }
  return cases;
}

const CASES = loadJsonl("../../../../evals/security_alert_cases.jsonl");
const INJECTION_CASES = loadJsonl("../../../../evals/security_injection_corpus.jsonl");
const FP_CASES = loadJsonl("../../../../evals/security_fp_corpus.jsonl");

function entryById(cases: LaneEvalCase[], id: string): LaneEvalCase {
  const entry = cases.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Missing eval case ${id}`);
  return entry;
}

function caseById(id: string): LaneEvalCase {
  return entryById(CASES, id);
}

/** Exact expected-vs-actual failure line, golden-gate style. */
function expectSame(id: string, actual: unknown, expected: unknown): void {
  try {
    expect(actual).toEqual(expected);
  } catch {
    throw new Error(`FAIL ${id}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

/** Dotted-path lookup: object keys and array indices, e.g. `signers.0.state`. */
function resolvePath(root: unknown, path: string): { found: boolean; value: unknown } {
  let current = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/* ------------------------------------------------------------ fake model */

/**
 * Deterministic stand-in for the four scripted agents: rationales restate the
 * fired signal rules, claims cite the first two retrieved items, and the risk
 * score is echoed back — so every pinned artifact stays stable offline.
 */
class EvalSecurityModel implements SecurityModel {
  async triage(context: TriageModelContext) {
    const rules = context.signals.signals.map((signal) => signal.id).join(", ");
    return {
      rationale: `Signals ${rules === "" ? "(none)" : rules}; ${context.signals.classification}/${context.signals.severity}.`,
    };
  }

  async investigate(context: InvestigateModelContext) {
    const first = context.retrieved[0];
    const second = context.retrieved[1] ?? first;
    if (first === undefined || second === undefined) {
      throw new Error("eval investigation needs a retrieved item");
    }
    return {
      claims: [
        { claim: `Eval claim A for ${context.alertId}.`, sourceId: first.sourceId, span: "0-2" },
        { claim: `Eval claim B for ${context.alertId}.`, sourceId: second.sourceId, span: "0-2" },
      ],
      missingEvidence: [],
      summary: `Eval investigation of ${context.alertId}.`,
    };
  }

  async decide(context: DecideModelContext) {
    return {
      reasoningClaims: context.claims.length > 1 ? [0, 1] : [0],
      detectionProposal: null,
      confidence: 0.8,
      summary: `Eval disposition ${context.proposedAction} at risk ${context.risk.score}.`,
    };
  }

  async report(context: ReportModelContext) {
    return { summary: `Executed ${context.action} as ${context.outcome} (${context.containmentId}).` };
  }
}

/* ------------------------------------------------------------ replay engines */

const PURE_ENGINES: Record<string, (...args: unknown[]) => unknown> = {
  "security.classifySignals": (raw) => {
    const result = classifySignals(raw as string);
    return {
      score: result.score,
      classification: result.classification,
      severity: result.severity,
      confidence: result.confidence,
      rules: result.signals.map((signal) => signal.id),
      flags: result.injectionFlags,
    };
  },
  "security.mitreFor": (text, indicators) =>
    mitreFor(text as string, indicators as readonly string[]).map((technique) => technique.id),
  "security.validateClaims": (claims, retrieved) =>
    validateClaims(claims as readonly EvidenceClaim[], retrieved as readonly RetrievedItem[]),
  "security.riskFor": (action, severity, environment, blocked) => {
    const risk = riskFor(
      action as DecideAction,
      severity as Severity,
      environment as Environment | null,
      blocked as boolean,
    );
    return {
      score: risk.score,
      tier: risk.tier,
      blastRadius: risk.blastRadius,
      reversibility: risk.reversibility,
      refused: risk.refused,
    };
  },
  "security.containmentIdFor": (alert) =>
    containmentIdFor(alert as { alertId: string; host?: string | undefined }),
  "security.containmentTarget": (alertId, host) =>
    containmentTarget(alertId as string, host as string | undefined),
};

/* ------------------------------------------------------------- flow driver */

interface SuspendView {
  artifact: Record<string, unknown>;
  target?: string;
}

interface FlowLike {
  createRun: () => Promise<{
    start: (args: { inputData: Record<string, unknown> }) => Promise<unknown>;
    resume: (args: { resumeData: Record<string, unknown> }) => Promise<unknown>;
  }>;
}

function suspendView(outcome: unknown, stepId: string): SuspendView {
  const view = outcome as {
    status?: string;
    error?: unknown;
    suspendPayload?: Record<string, SuspendView | undefined>;
  };
  if (view.status !== "suspended") {
    const failure = view.error;
    const detail =
      typeof failure === "object" && failure !== null && "message" in failure
        ? String((failure as { message: unknown }).message)
        : String(view.error ?? view.status);
    throw new Error(`expected suspension at ${stepId}, got ${detail}`);
  }
  const payload = view.suspendPayload?.[stepId];
  if (payload?.artifact === undefined) {
    throw new Error(`no suspend payload for ${stepId}`);
  }
  return payload;
}

function failureMessage(outcome: unknown): string {
  const view = outcome as { error?: unknown };
  const failure = view.error;
  return typeof failure === "object" && failure !== null && "message" in failure
    ? String((failure as { message: unknown }).message)
    : String(failure);
}

/**
 * The API records the human sign-off as an `edit` carrying the fully approved
 * signer chain; the walk applies it before leaving the approve checkpoint.
 */
function approvalEdit(artifact: Record<string, unknown>): Record<string, unknown> {
  const signers = (artifact["signers"] as Array<Record<string, unknown>>).map((signer) => ({
    ...signer,
    state: "approved",
    approvedAt: FIXED_NOW.toISOString(),
  }));
  return { ...artifact, signers, allApproved: true };
}

interface WalkOptions {
  ticketKey: string;
  stopAt?: string | undefined;
  seedEffects?: Record<string, Record<string, unknown>> | undefined;
  runId?: string | undefined;
  caseId?: string | undefined;
}

interface WalkResult {
  views: Record<string, Record<string, unknown>>;
  artifacts: Record<string, Record<string, unknown>>;
  final: unknown;
}

/** Drive the security flow from the start, optionally stopping at a step. */
async function walkFlow(
  flow: FlowLike,
  input: Record<string, unknown>,
  options: WalkOptions,
): Promise<WalkResult> {
  const decisions: Record<string, Record<string, unknown>> = {};
  const artifacts: Record<string, Record<string, unknown>> = {};
  const effects: Record<string, Record<string, unknown>> = { ...options.seedEffects };
  const views: Record<string, Record<string, unknown>> = {};
  const envelope = (decision?: Record<string, unknown>): Record<string, unknown> => ({
    runId: options.runId ?? EVAL_RUN_ID,
    workflow: "security",
    ticketKey: options.ticketKey,
    caseId: options.caseId ?? EVAL_CASE_ID,
    attempt: 1,
    input,
    decisions,
    artifacts,
    effects,
    ...(decision === undefined ? {} : { decision }),
  });

  const run = await flow.createRun();
  let outcome: unknown = await run.start({ inputData: envelope() });
  for (let index = 0; index < SECURITY_FLOW_STEPS.length; index += 1) {
    const stepId = SECURITY_FLOW_STEPS[index]!;
    const view = suspendView(outcome, stepId);
    views[stepId] = view.artifact;
    if (stepId === options.stopAt) return { views, artifacts, final: outcome };
    artifacts[stepId] = view.artifact;
    if (stepId === "approve") artifacts["approve"] = approvalEdit(view.artifact);
    // Forward decisions carry the receipt reference the contain executor
    // requires before acting (the API issues one per checkpoint).
    const decision: Record<string, unknown> = {
      action: "proceed",
      actionHash: PROCEED_HASH,
      receiptId: RECEIPT_ID,
    };
    decisions[stepId] = decision;
    outcome = await run.resume({ resumeData: envelope(decision) });
    if (SECURITY_FLOW_STEPS[index + 1] === undefined) return { views, artifacts, final: outcome };
  }
  throw new Error("flow never suspended");
}

class CountingContainment implements ContainmentRegistry {
  calls = 0;
  private readonly inner = new MemoryContainmentRegistry();

  async execute(request: ContainmentRequest): Promise<ContainmentResult> {
    this.calls += 1;
    return this.inner.execute(request);
  }
}

function securityRuntime(
  options: { containment?: ContainmentRegistry; caseHistory?: CaseHistory } = {},
): { flow: FlowLike; caseHistory: CaseHistory } {
  const caseHistory = options.caseHistory ?? new MemoryCaseHistory();
  const mastra = createAllRounderMastra({
    security: {
      telemetry: new MemoryTelemetrySearch(),
      assets: new MemoryAssetDirectory(),
      intel: new MemoryThreatIntel(),
      containment: options.containment ?? new MemoryContainmentRegistry(),
      caseHistory,
      model: new EvalSecurityModel(),
      now: () => FIXED_NOW,
    },
  });
  const flow = mastra.getWorkflow("securityFlow");
  if (flow === undefined) throw new Error("securityFlow is not registered");
  return { flow: flow as unknown as FlowLike, caseHistory };
}

async function replayFlowCase(entry: LaneEvalCase): Promise<void> {
  const stepId = entry.engine.split(":")[1];
  if (stepId === undefined || stepId === "") {
    throw new Error(`Case ${entry.id} names no flow step`);
  }
  const { flow } = securityRuntime();
  const walk = await walkFlow(flow, entry.input ?? {}, {
    ticketKey: entry.ticketKey ?? "",
    stopAt: stepId,
  });
  const view = walk.views[stepId];
  if (view === undefined) throw new Error(`Case ${entry.id}: no suspended view for ${stepId}`);
  for (const [path, expected] of Object.entries(entry.expect ?? {})) {
    const resolved = resolvePath(view, path);
    if (!resolved.found) throw new Error(`FAIL ${entry.id}: missing path ${path}`);
    expectSame(`${entry.id}.${path}`, resolved.value, expected);
  }
}

async function replayCase(entry: LaneEvalCase): Promise<void> {
  const pure = PURE_ENGINES[entry.engine];
  if (pure !== undefined) {
    expectSame(entry.id, pure(...(entry.args ?? [])), entry.expected);
    return;
  }
  if (entry.engine.includes(":")) {
    await replayFlowCase(entry);
    return;
  }
  throw new Error(`Unknown eval engine ${entry.engine}`);
}

function seedReceipt(alertId: string, host: string): Record<string, unknown> {
  const containmentId = containmentIdFor({ alertId, host });
  return {
    alertId,
    action: "contain",
    outcome: "contained",
    containmentId,
    idempotencyKey: containmentId,
    target: containmentTarget(alertId, host),
    registryRef: `containment-registry:${containmentId}`,
    completedAt: FIXED_NOW.toISOString(),
    evidenceRef: "run:run-eval-seed#investigate",
    summary: "Seeded receipt for the replay eval.",
  };
}

describe("Security lane golden evals", () => {
  it("pins cases for the security lane", () => {
    const lanes = [...new Set(CASES.map((entry) => entry.lane))].sort();
    expect(lanes).toEqual(["security"]);
  });

  it("keeps case ids unique across all corpora", () => {
    const ids = [...CASES, ...INJECTION_CASES, ...FP_CASES].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const entry of CASES) {
    it(entry.id, async () => {
      await replayCase(entry);
    }, 30_000);
  }
});

describe("Security injection corpus (§8)", () => {
  it("covers at least six tricks, all pinned unknown with flags, never benign", () => {
    expect(INJECTION_CASES.length).toBeGreaterThanOrEqual(6);
    const lanes = [...new Set(INJECTION_CASES.map((entry) => entry.lane))];
    expect(lanes).toEqual(["security"]);
    const undecided = INJECTION_CASES.filter(
      (entry) => entry.expect?.["classification"] !== "unknown",
    ).map((entry) => entry.id);
    expect(undecided).toEqual([]);
    const unflagged = INJECTION_CASES.filter((entry) => {
      const flags = entry.expect?.["injectionFlags"];
      return !Array.isArray(flags) || flags.length === 0;
    }).map((entry) => entry.id);
    expect(unflagged).toEqual([]);
  });

  for (const entry of INJECTION_CASES) {
    it(entry.id, async () => {
      await replayCase(entry);
    }, 30_000);
  }
});

describe("Security false-positive corpus (§8)", () => {
  it("keeps legitimate SOC artifacts free of injection flags", () => {
    expect(FP_CASES.length).toBeGreaterThanOrEqual(6);
    const lanes = [...new Set(FP_CASES.map((entry) => entry.lane))];
    expect(lanes).toEqual(["security"]);
    const flagged = FP_CASES.filter((entry) => {
      const flags = entry.expect?.["injectionFlags"];
      return !Array.isArray(flags) || flags.length > 0;
    }).map((entry) => entry.id);
    expect(flagged).toEqual([]);
  });

  for (const entry of FP_CASES) {
    it(entry.id, async () => {
      await replayCase(entry);
    }, 30_000);
  }
});

describe("Security lane flow invariants", () => {
  it(
    "completes SEC-102 with the signed contain receipt and the closed case",
    async () => {
      const entry = caseById("security-sec-102-decide");
      const registry = new CountingContainment();
      const { flow, caseHistory } = securityRuntime({ containment: registry });
      const walk = await walkFlow(flow, entry.input ?? {}, { ticketKey: "SEC-102" });
      const final = walk.final as {
        status?: string;
        result?: {
          receipt?: Record<string, unknown>;
          effects?: Record<string, { actionHash?: string } | undefined>;
        };
      };
      expect(final.status).toBe("success");
      expect(final.result?.receipt).toEqual({
        alertId: "SEC-102",
        action: "contain",
        outcome: "contained",
        containmentId: "SEC-2FCF0A5A",
        idempotencyKey: "SEC-2FCF0A5A",
        target: "containment:SEC-2FCF0A5A",
        registryRef: "containment-registry:SEC-2FCF0A5A",
        completedAt: FIXED_NOW.toISOString(),
        evidenceRef: "run:run-eval-1#investigate",
        summary: "Executed contain as contained (SEC-2FCF0A5A).",
      });
      expect(final.result?.effects?.["contain"]?.actionHash).toBe(PROCEED_HASH);
      expect(registry.calls).toBe(1);
      await expect(caseHistory.lookup("SEC-102")).resolves.toMatchObject({
        caseId: EVAL_CASE_ID,
        alertId: "SEC-102",
        host: "fin-db-01",
        classification: "tp",
        disposition: "contained",
        techniqueIds: ["T1053.005", "T1059.001", "T1071", "T1071.001"],
        closedAt: FIXED_NOW.toISOString(),
      });
    },
    30_000,
  );

  it(
    "replays the contain effect without re-executing it",
    async () => {
      const entry = caseById("security-sec-102-approve");
      const registry = new CountingContainment();
      const { flow } = securityRuntime({ containment: registry });
      const seeded = seedReceipt("SEC-102", "fin-db-01");
      const walk = await walkFlow(flow, entry.input ?? {}, {
        ticketKey: "SEC-102",
        seedEffects: { contain: { actionHash: PROCEED_HASH, receipt: seeded } },
      });
      const final = walk.final as { status?: string; result?: { receipt?: Record<string, unknown> } };
      expect(final.status).toBe("success");
      expect(final.result?.receipt).toEqual(seeded);
      expect(registry.calls).toBe(0);
    },
    30_000,
  );

  it(
    "refuses containment without the signed receipt reference",
    async () => {
      const entry = caseById("security-sec-102-contain");
      const { flow } = securityRuntime();
      const decisions: Record<string, Record<string, unknown>> = {};
      const artifacts: Record<string, Record<string, unknown>> = {};
      const effects: Record<string, Record<string, unknown>> = {};
      const envelope = (decision?: Record<string, unknown>): Record<string, unknown> => ({
        runId: EVAL_RUN_ID,
        workflow: "security",
        ticketKey: "SEC-102",
        caseId: EVAL_CASE_ID,
        attempt: 1,
        input: entry.input ?? {},
        decisions,
        artifacts,
        effects,
        ...(decision === undefined ? {} : { decision }),
      });
      const run = await flow.createRun();
      let outcome: unknown = await run.start({ inputData: envelope() });
      for (const stepId of ["ingest", "triage", "investigate", "decide", "approve"]) {
        const view = suspendView(outcome, stepId);
        artifacts[stepId] = stepId === "approve" ? approvalEdit(view.artifact) : view.artifact;
        const decision = { action: "proceed", actionHash: PROCEED_HASH, receiptId: RECEIPT_ID };
        decisions[stepId] = decision;
        outcome = await run.resume({ resumeData: envelope(decision) });
      }
      suspendView(outcome, "contain");
      // A forward decision without the receipt reference: the executor must
      // fail closed instead of executing the side effect.
      const unsigned = { action: "proceed", actionHash: PROCEED_HASH };
      decisions["contain"] = unsigned;
      outcome = await run.resume({ resumeData: envelope(unsigned) });
      expect((outcome as { status?: string }).status).toBe("failed");
      expect(failureMessage(outcome)).toBe(
        "Containment requires the signed security:contain receipt before acting",
      );
    },
    30_000,
  );

  it(
    "rejects the duplicate alert before triage",
    async () => {
      const entry = caseById("security-sec-101-ingest");
      const { flow } = securityRuntime();
      const decisions: Record<string, Record<string, unknown>> = {};
      const artifacts: Record<string, Record<string, unknown>> = {};
      const effects: Record<string, Record<string, unknown>> = {};
      const envelope = (decision?: Record<string, unknown>): Record<string, unknown> => ({
        runId: EVAL_RUN_ID,
        workflow: "security",
        ticketKey: "SEC-777",
        caseId: EVAL_CASE_ID,
        attempt: 1,
        input: entry.input ?? {},
        decisions,
        artifacts,
        effects,
        ...(decision === undefined ? {} : { decision }),
      });
      const run = await flow.createRun();
      const started = suspendView(await run.start({ inputData: envelope() }), "ingest");
      expect(started.artifact["dedupe"]).toEqual({ seenBefore: true, priorCaseId: "case-7777" });
      artifacts["ingest"] = started.artifact;
      const decision = { action: "proceed", actionHash: PROCEED_HASH };
      decisions["ingest"] = decision;
      const outcome = (await run.resume({ resumeData: envelope(decision) })) as { status?: string };
      expect(outcome.status).toBe("failed");
      expect(failureMessage(outcome)).toBe(
        "Alert SEC-777 already closed as case case-7777; link the duplicate instead of re-running",
      );
    },
    30_000,
  );

  it(
    "keeps the containment id stable across runs and case ids",
    async () => {
      const entry = caseById("security-sec-102-contain");
      const first = await walkFlow(securityRuntime().flow, entry.input ?? {}, {
        ticketKey: "SEC-102",
        stopAt: "contain",
        runId: "run-eval-a",
        caseId: "case-eval-a",
      });
      const second = await walkFlow(securityRuntime().flow, entry.input ?? {}, {
        ticketKey: "SEC-102",
        stopAt: "contain",
        runId: "run-eval-b",
        caseId: "case-eval-b",
      });
      const firstPreview = first.views["contain"] as
        | { containmentId?: unknown; target?: unknown }
        | undefined;
      const secondPreview = second.views["contain"] as
        | { containmentId?: unknown; target?: unknown }
        | undefined;
      expect(firstPreview?.containmentId).toBe("SEC-2FCF0A5A");
      expect(firstPreview?.containmentId).toBe(secondPreview?.containmentId);
      expect(firstPreview?.target).toBe("containment:SEC-2FCF0A5A");
      expect(firstPreview?.target).toBe(secondPreview?.target);
    },
    30_000,
  );

  it(
    "completes the host-free alert with the host-free containment id",
    async () => {
      const entry = caseById("security-sec-101-decide");
      const { flow } = securityRuntime();
      const walk = await walkFlow(flow, entry.input ?? {}, { ticketKey: "SEC-101" });
      const final = walk.final as {
        status?: string;
        result?: { receipt?: { containmentId?: unknown; target?: unknown } };
      };
      expect(final.status).toBe("success");
      expect(final.result?.receipt?.containmentId).toBe("SEC-F804D6AD");
      expect(final.result?.receipt?.target).toBe("containment:SEC-F804D6AD");
    },
    30_000,
  );

  it(
    "escalates a flagged injection attempt to a human end to end",
    async () => {
      const entry = entryById(INJECTION_CASES, "security-inj-override-suppression");
      const { flow, caseHistory } = securityRuntime();
      const walk = await walkFlow(flow, entry.input ?? {}, { ticketKey: "SEC-701" });
      const final = walk.final as {
        status?: string;
        result?: { receipt?: { outcome?: unknown } };
      };
      expect(final.status).toBe("success");
      expect(final.result?.receipt?.outcome).toBe("escalated");
      const decideView = walk.views["decide"] as { requiresHuman?: unknown } | undefined;
      expect(decideView?.requiresHuman).toBe(true);
      await expect(caseHistory.lookup("SEC-701")).resolves.toMatchObject({
        classification: "unknown",
        disposition: "escalated",
      });
    },
    30_000,
  );

  it(
    "lets the legitimate encoded-PowerShell artifact complete the run",
    async () => {
      const entry = entryById(FP_CASES, "security-fp-base64-powershell");
      const registry = new CountingContainment();
      const { flow } = securityRuntime({ containment: registry });
      const walk = await walkFlow(flow, entry.input ?? {}, { ticketKey: "SEC-801" });
      const final = walk.final as {
        status?: string;
        result?: { receipt?: { outcome?: unknown } };
      };
      expect(final.status).toBe("success");
      expect(final.result?.receipt?.outcome).toBe("escalated");
      expect(registry.calls).toBe(1);
    },
    30_000,
  );
});
