import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { InnerOutput } from "@mastra/core/workflows";
import { z } from "zod";

import {
  MemoryQaCaseStore,
  caseSetHash,
  caseSetProblems,
  type QaCaseRecord,
  type QaCaseStore,
} from "./cases.js";
import { assessQa, countResults, selectDefects } from "./assess.js";
import {
  QA_FLOW_STEPS,
  QaAnalysisSchema,
  QaApprovalEffectSchema,
  QaCaseSetArtifactSchema,
  QaDefectSetArtifactSchema,
  QaExecutionArtifactSchema,
  QaExecutionPlanSchema,
  QaFilingArtifactSchema,
  QaFilingPlanSchema,
  QaFlowOutputSchema,
  QaIntakeArtifactSchema,
  QaRunStateSchema,
  QaSuspendSchema,
  QaVerdictSchema,
  qaTarget,
  resolveQaTarget,
  type QaAnalysis,
  type QaApprovalEffect,
  type QaCase,
  type QaCaseSetArtifact,
  type QaDefectReceipt,
  type QaDefectSetArtifact,
  type QaExecutionArtifact,
  type QaExecutionPlan,
  type QaFilingArtifact,
  type QaFilingPlan,
  type QaFlowOutput,
  type QaIntakeArtifact,
  type QaRunState,
  type QaSuspendPayload,
  type QaVerdict,
  type StepDecision,
} from "./contracts.js";
import { coverageGaps, describeGaps, unknownRequirementRefs } from "./coverage.js";
import { qaDefectFilerFromEnv, type QaDefectFiler } from "./defects.js";
import { createQaExecutor, type QaExecutor } from "./executor.js";
import { createQaSquadModel, type QaSquadModel } from "./squad.js";

/**
 * How many times the design step asks the squad for a case set. One bounded
 * re-ask, not a loop: the second set is what a human sees, and an uncovered
 * requirement is then a visible gap the approval gate refuses rather than a
 * silent retry that never ends.
 */
const DESIGN_ATTEMPTS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuild the API envelope for this pass. On `start` the workflow input is the
 * authoritative envelope; on `resume` the resume data carries the full
 * envelope plus the just-recorded `decision`, so it wins key-by-key. The
 * effect map is unioned for the same reason as the bills lane: an approval or a
 * side effect the workflow snapshot already holds must survive into the next
 * pass even when the API's copy has not caught up.
 */
function mergeState(inputData: unknown, resumeData: unknown): QaRunState {
  const base = QaRunStateSchema.parse(inputData);
  if (!isRecord(resumeData)) return base;
  const resumed = QaRunStateSchema.parse({ ...base, ...resumeData });
  return QaRunStateSchema.parse({
    ...resumed,
    effects: { ...base.effects, ...resumed.effects },
  });
}

/** The `decision` field is resume-only: never leak it into the next step. */
function forwardState(state: QaRunState): QaRunState {
  if (state.decision === undefined) return state;
  const { decision: _decision, ...rest } = state;
  return rest;
}

function currentDecision(
  state: QaRunState,
  stepId: (typeof QA_FLOW_STEPS)[number],
): StepDecision | undefined {
  return state.decision ?? state.decisions[stepId];
}

function isForward(decision: StepDecision | undefined): decision is StepDecision {
  return decision?.action === "proceed" || decision?.action === "edit";
}

function guidanceOf(decision: StepDecision | undefined): string | undefined {
  if (decision?.action !== "regenerate") return undefined;
  const guidance = decision.guidance;
  return typeof guidance === "string" && guidance.trim() !== "" ? guidance : undefined;
}

/**
 * Resolve the artifact a step should move forward with: the API-stored copy
 * with the recorded `edit` overrides merged on top (same merge the run service
 * applies for the scripted engine). Missing copies fall back to a recompute at
 * the call site; contract violations surface loudly.
 */
function effectiveArtifact<S extends z.ZodTypeAny>(
  state: QaRunState,
  stepId: (typeof QA_FLOW_STEPS)[number],
  schema: S,
): z.output<S> | undefined {
  const raw = state.artifacts[stepId];
  if (raw === undefined) return undefined;
  const decision = state.decisions[stepId];
  const edits = decision?.action === "edit" && isRecord(decision.edits) ? decision.edits : {};
  const parsed = schema.safeParse({ ...raw, ...edits });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`QA flow: ${stepId} artifact contract violation: ${detail}`);
  }
  return parsed.data;
}

/**
 * The side-effect record a step wrote, read back from the effects map. Effects
 * are how a write survives between checkpoints: a suspend payload echoes the
 * map, and the API persists it as `side_effects`.
 */
function effectRecord<S extends z.ZodTypeAny>(
  state: QaRunState,
  stepId: (typeof QA_FLOW_STEPS)[number],
  schema: S,
): z.output<S> | undefined {
  const raw = state.effects[stepId];
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function suspendPayload(
  artifact: Record<string, unknown>,
  target: string | undefined,
  effects: QaRunState["effects"],
): QaSuspendPayload {
  return QaSuspendSchema.parse({
    artifact,
    ...(target === undefined ? {} : { target }),
    effects,
  });
}

/** Approval-case ids in set order, which is the order the console renders. */
function caseIds(cases: readonly QaCase[]): string[] {
  return cases.map((item) => item.id);
}

function approvalOf(state: QaRunState): QaApprovalEffect | undefined {
  return effectRecord(state, "approve-cases", QaApprovalEffectSchema);
}

export interface QaFlowDeps {
  /**
   * The squad behind the two model phases. Injected by tests; the live default
   * routes through the supervisor agent and its delegation gate.
   */
  readonly model?: QaSquadModel;
  /** Where an approved set is kept. Defaults to the in-process store. */
  readonly store?: QaCaseStore;
  /** How an approved set is driven. Defaults to the browser-backed executor. */
  readonly executor?: QaExecutor;
  /** How an approved finding reaches Jira. Defaults to the console bridge. */
  readonly filer?: QaDefectFiler;
  /** Clock seam, so a filing timestamp is deterministic in a test. */
  readonly now?: () => Date;
}

/**
 * Mastra `qaFlow`: one requirement, from wording to a closed evidence pack.
 *
 *   intake -> analyse -> design -> approve-cases -> execute -> assess
 *          -> approve-defects -> file-defects -> close
 *
 * A missing browser yields `blocked` rather than a fake pass, the verdict comes
 * only from observed results, and filing keys on `{storyKey}:{caseId}` so a re-run
 * comments instead of filing a twin.
 */
export function createQaFlow(deps: QaFlowDeps = {}) {
  const model = deps.model ?? createQaSquadModel();
  const store = deps.store ?? new MemoryQaCaseStore();
  const executor = deps.executor ?? createQaExecutor();
  const filer = deps.filer ?? qaDefectFilerFromEnv();
  const now = deps.now ?? (() => new Date());

  function computeIntake(state: QaRunState): QaIntakeArtifact {
    // An unknown target key throws here, at the first checkpoint, rather than
    // inside the executor against whatever URL happened to be configured.
    const target = resolveQaTarget(state.input.target);
    return QaIntakeArtifactSchema.parse({
      storyKey: state.input.storyKey,
      scope: state.input.scope,
      target,
      maxCases: state.input.maxCases,
    });
  }

  function intakeOf(state: QaRunState): QaIntakeArtifact {
    return effectiveArtifact(state, "intake", QaIntakeArtifactSchema) ?? computeIntake(state);
  }

  function caseSetOf(state: QaRunState): QaCaseSetArtifact {
    const artifact =
      effectiveArtifact(state, "approve-cases", QaCaseSetArtifactSchema) ??
      effectiveArtifact(state, "design", QaCaseSetArtifactSchema);
    if (artifact === undefined) {
      throw new Error("QA flow: the case set is missing from this run");
    }
    return artifact;
  }

  async function computeAnalyse(
    state: QaRunState,
    guidance: string | undefined,
  ): Promise<QaAnalysis> {
    const intake = intakeOf(state);
    return QaAnalysisSchema.parse(
      await model.analyse({
        storyKey: intake.storyKey,
        scope: intake.scope,
        target: intake.target,
        ...(guidance === undefined ? {} : { guidance }),
      }),
    );
  }

  /**
   * Ask the squad for a case set, then hold it to the deterministic checks
   * before a human ever sees it: duplicate ids are a broken identity, an
   * unknown requirement id is an invented requirement, and an uncovered
   * requirement is a gap. The first two are re-asked once and then fail; the
   * third is published as a gap so the approval gate can refuse it.
   */
  async function computeDesign(
    state: QaRunState,
    guidance: string | undefined,
  ): Promise<QaCaseSetArtifact> {
    const intake = intakeOf(state);
    const analysis = effectiveArtifact(state, "analyse", QaAnalysisSchema);
    if (analysis === undefined) {
      throw new Error(
        "QA flow: the requirement analysis is missing before a case set can be designed",
      );
    }

    let feedback = guidance;
    for (let attempt = 1; attempt <= DESIGN_ATTEMPTS; attempt += 1) {
      const produced = await model.design({
        storyKey: intake.storyKey,
        scope: intake.scope,
        target: intake.target,
        analysis,
        maxCases: intake.maxCases,
        ...(feedback === undefined ? {} : { feedback }),
      });
      if (produced.length === 0) {
        throw new Error("QA flow: the designer returned no cases");
      }
      const truncated = produced.length > intake.maxCases;
      const cases = truncated ? produced.slice(0, intake.maxCases) : produced;
      const structural = [...caseSetProblems(cases), ...unknownRequirementRefs(analysis, cases)];
      if (structural.length > 0) {
        if (attempt === DESIGN_ATTEMPTS) {
          throw new Error(`QA flow: the case set is not usable: ${structural.join("; ")}`);
        }
        feedback = `the previous set was not usable: ${structural.join("; ")}`;
        continue;
      }
      const gaps = coverageGaps(analysis, cases);
      if (gaps.length === 0 || attempt === DESIGN_ATTEMPTS) {
        return QaCaseSetArtifactSchema.parse({
          storyKey: intake.storyKey,
          target: intake.target,
          cases,
          gaps,
          truncated,
          caseSetHash: caseSetHash(cases),
        });
      }
      feedback = `the previous set left these requirements uncovered: ${describeGaps(gaps)}`;
    }
    throw new Error("QA flow: the designer never produced a case set");
  }

  /**
   * Approve the set: the gate and the write in one place. A forward decision
   * with an uncovered requirement is refused here, so an approval can never
   * mean "probably covered". The hash is recomputed from the cases actually
   * approved, which is what makes an edited set a distinct record.
   */
  async function executeApprove(
    state: QaRunState,
    artifact: QaCaseSetArtifact,
  ): Promise<QaCaseRecord> {
    const analysis = effectiveArtifact(state, "analyse", QaAnalysisSchema);
    if (analysis === undefined) {
      throw new Error(
        "QA flow: the requirement analysis is missing before a case set can be approved",
      );
    }
    const structural = [
      ...caseSetProblems(artifact.cases),
      ...unknownRequirementRefs(analysis, artifact.cases),
    ];
    if (structural.length > 0) {
      throw new Error(`QA flow: the approved case set is not usable: ${structural.join("; ")}`);
    }
    const gaps = coverageGaps(analysis, artifact.cases);
    if (gaps.length > 0) {
      throw new Error(
        `QA flow: cannot approve a case set with uncovered requirements: ${describeGaps(gaps)}`,
      );
    }
    return await store.save({
      storyKey: artifact.storyKey,
      caseSetHash: caseSetHash(artifact.cases),
      approvedCaseIds: caseIds(artifact.cases),
      cases: artifact.cases,
    });
  }

  /**
   * What `execute` will drive, resolved before the write so the checkpoint can
   * show it. The approval record names the cases; a run whose approval names a
   * case the set does not contain is a broken record, not a partial run.
   */
  function computeExecutionPlan(state: QaRunState): QaExecutionPlan {
    const intake = intakeOf(state);
    const caseSet = caseSetOf(state);
    const approvedCaseIds = approvalOf(state)?.approvedCaseIds ?? caseIds(caseSet.cases);
    const byId = new Map(caseSet.cases.map((item) => [item.id, item]));
    const unknown = approvedCaseIds.filter((caseId) => !byId.has(caseId));
    if (unknown.length > 0) {
      throw new Error(
        `QA flow: the approval names cases the case set does not contain: ${unknown.join(", ")}`,
      );
    }
    const problem = executor.problem(intake.target);
    return QaExecutionPlanSchema.parse({
      runId: state.runId,
      storyKey: intake.storyKey,
      targetKey: intake.target.key,
      caseSetHash: caseSet.caseSetHash,
      approvedCaseIds,
      cases: approvedCaseIds.map((caseId) => byId.get(caseId) as QaCase),
      available: problem === undefined,
      ...(problem === undefined ? {} : { blockedReason: problem }),
      maxStepMs: intake.target.maxStepMs,
    });
  }

  async function executeRun(
    state: QaRunState,
    plan: QaExecutionPlan,
  ): Promise<QaExecutionArtifact> {
    const intake = intakeOf(state);
    const execution = await executor.run({
      runId: state.runId,
      storyKey: plan.storyKey,
      target: intake.target,
      cases: plan.cases,
    });
    return QaExecutionArtifactSchema.parse({
      runId: state.runId,
      storyKey: plan.storyKey,
      targetKey: plan.targetKey,
      caseSetHash: plan.caseSetHash,
      approvedCaseIds: plan.approvedCaseIds,
      available: execution.available,
      ...(execution.blockedReason === undefined
        ? {}
        : { blockedReason: execution.blockedReason }),
      results: [...execution.results],
      durationMs: execution.durationMs,
    });
  }

  /** `assessQa()` over the execution record; no model, no network. */
  function computeAssess(state: QaRunState): QaVerdict {
    const intake = intakeOf(state);
    const analysis = effectiveArtifact(state, "analyse", QaAnalysisSchema);
    if (analysis === undefined) {
      throw new Error("QA flow: the requirement analysis is missing before assessment");
    }
    const execution = effectRecord(state, "execute", QaExecutionArtifactSchema);
    if (execution === undefined) {
      throw new Error("QA flow: the execution record is missing before assessment");
    }
    return assessQa({
      storyKey: intake.storyKey,
      targetKey: intake.target.key,
      analysis,
      cases: caseSetOf(state).cases,
      execution,
    });
  }

  /**
   * The findings gate. Proceeding means "file everything that failed"; an
   * `edit` decision narrows the list, and `selectDefects` refuses an id that
   * names no finding.
   */
  function computeDefectSet(state: QaRunState): QaDefectSetArtifact {
    const verdict = effectiveArtifact(state, "assess", QaVerdictSchema);
    if (verdict === undefined) {
      throw new Error("QA flow: the verdict is missing before the defect gate");
    }
    return QaDefectSetArtifactSchema.parse({
      runId: state.runId,
      caseSetHash: caseSetOf(state).caseSetHash,
      defects: verdict.defects,
      approvedDefectIds: verdict.defects.map((defect) => defect.caseId),
    });
  }

  function computeFilingPlan(state: QaRunState): QaFilingPlan {
    const intake = intakeOf(state);
    const artifact = effectiveArtifact(state, "approve-defects", QaDefectSetArtifactSchema);
    if (artifact === undefined) {
      throw new Error("QA flow: the defect decisions are missing before filing");
    }
    return QaFilingPlanSchema.parse({
      runId: state.runId,
      storyKey: intake.storyKey,
      targetKey: intake.target.key,
      caseSetHash: caseSetOf(state).caseSetHash,
      defects: selectDefects(artifact),
    });
  }

  async function executeFiling(
    state: QaRunState,
    plan: QaFilingPlan,
  ): Promise<QaFilingArtifact> {
    const verdict = effectiveArtifact(state, "assess", QaVerdictSchema);
    if (verdict === undefined) {
      throw new Error("QA flow: the verdict is missing, so there is nothing to file");
    }
    const receipts = await filer.file({
      runId: state.runId,
      storyKey: plan.storyKey,
      targetKey: plan.targetKey,
      caseSetHash: plan.caseSetHash,
      defects: plan.defects,
      results: verdict.results,
    });
    return QaFilingArtifactSchema.parse({
      runId: state.runId,
      caseSetHash: plan.caseSetHash,
      receipts,
      filedAt: now().toISOString(),
    });
  }

  /**
   * The evidence pack. `filed` excludes the `skipped` answers, because a case
   * that passes on a story with no defect wrote nothing.
   */
  function computeClose(state: QaRunState): QaFlowOutput {
    const intake = intakeOf(state);
    const approval = approvalOf(state);
    if (approval === undefined) {
      throw new Error("QA flow: the case approval record is missing before the run can close");
    }
    const verdict = effectiveArtifact(state, "assess", QaVerdictSchema);
    if (verdict === undefined) {
      throw new Error("QA flow: the verdict is missing before the run can close");
    }
    const filing = effectRecord(state, "file-defects", QaFilingArtifactSchema);
    const filed: QaDefectReceipt[] = (filing?.receipts ?? []).filter(
      (receipt) => receipt.action !== "skipped",
    );
    return QaFlowOutputSchema.parse({
      runId: state.runId,
      status: "completed",
      storyKey: intake.storyKey,
      targetKey: intake.target.key,
      caseSetHash: approval.caseSetHash,
      approvedCaseIds: [...approval.approvedCaseIds],
      caseCount: approval.approvedCaseIds.length,
      approvedAt: approval.approvedAt,
      executionAvailable: verdict.executionAvailable,
      counts: countResults(verdict.results, verdict.defects.length, filed.length),
      gaps: verdict.gaps,
      failedCaseIds: verdict.results
        .filter((result) => result.status === "failed")
        .map((result) => result.caseId),
      filed,
    });
  }

  const intake = createStep({
    id: QA_FLOW_STEPS[0],
    inputSchema: QaRunStateSchema,
    outputSchema: QaRunStateSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<QaRunState | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "intake");
      if (isForward(decision)) {
        void intakeOf(state);
        return forwardState(state);
      }
      const artifact = computeIntake(state);
      return await suspend(
        suspendPayload(artifact, qaTarget(artifact.storyKey, artifact.target.key), state.effects),
      );
    },
  });

  const analyse = createStep({
    id: QA_FLOW_STEPS[1],
    inputSchema: QaRunStateSchema,
    outputSchema: QaRunStateSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<QaRunState | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "analyse");
      if (isForward(decision)) {
        const artifact = effectiveArtifact(state, "analyse", QaAnalysisSchema);
        if (artifact === undefined) {
          throw new Error(
            "QA flow: the requirement analysis is missing before a case set can be designed",
          );
        }
        return forwardState(state);
      }
      const artifact = await computeAnalyse(state, guidanceOf(decision));
      const intakeArtifact = intakeOf(state);
      return await suspend(
        suspendPayload(
          artifact,
          qaTarget(intakeArtifact.storyKey, intakeArtifact.target.key),
          state.effects,
        ),
      );
    },
  });

  const design = createStep({
    id: QA_FLOW_STEPS[2],
    inputSchema: QaRunStateSchema,
    outputSchema: QaRunStateSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<QaRunState | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "design");
      if (isForward(decision)) {
        const artifact = effectiveArtifact(state, "design", QaCaseSetArtifactSchema);
        if (artifact === undefined) {
          throw new Error("QA flow: the case set is missing before it can be approved");
        }
        return forwardState(state);
      }
      const artifact = await computeDesign(state, guidanceOf(decision));
      return await suspend(
        suspendPayload(artifact, qaTarget(artifact.storyKey, artifact.target.key), state.effects),
      );
    },
  });

  const approveCases = createStep({
    id: QA_FLOW_STEPS[3],
    inputSchema: QaRunStateSchema,
    outputSchema: QaRunStateSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<QaRunState | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "approve-cases");
      const artifact = caseSetOf(state);
      if (!isForward(decision)) {
        return await suspend(
          suspendPayload(artifact, qaTarget(artifact.storyKey, artifact.target.key), state.effects),
        );
      }
      // Approval is the write, so it happens here and nowhere earlier. The
      // store keys on `(storyKey, caseSetHash)` and keeps the first record,
      // so re-driving an unchanged approval cannot move the approval time.
      const record = await executeApprove(state, artifact);
      const approval = QaApprovalEffectSchema.parse({
        caseSetHash: record.caseSetHash,
        approvedCaseIds: [...record.approvedCaseIds],
        approvedAt: record.approvedAt,
      });
      return QaRunStateSchema.parse({
        ...forwardState(state),
        effects: { ...state.effects, "approve-cases": approval },
      });
    },
  });

  const execute = createStep({
    id: QA_FLOW_STEPS[4],
    inputSchema: QaRunStateSchema,
    outputSchema: QaRunStateSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<QaRunState | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "execute");
      const plan =
        effectiveArtifact(state, "execute", QaExecutionPlanSchema) ?? computeExecutionPlan(state);
      if (!isForward(decision)) {
        return await suspend(
          suspendPayload(
            plan,
            qaTarget(plan.storyKey, plan.targetKey),
            state.effects,
          ),
        );
      }
      // A re-driven pass for the same case set reuses the record it already
      // has: driving the console twice for one approval would double the spend
      // and the blast radius.
      const existing = effectRecord(state, "execute", QaExecutionArtifactSchema);
      const artifact =
        existing !== undefined && existing.caseSetHash === plan.caseSetHash
          ? existing
          : await executeRun(state, plan);
      return QaRunStateSchema.parse({
        ...forwardState(state),
        effects: { ...state.effects, execute: artifact },
      });
    },
  });

  const assess = createStep({
    id: QA_FLOW_STEPS[5],
    inputSchema: QaRunStateSchema,
    outputSchema: QaRunStateSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<QaRunState | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "assess");
      if (isForward(decision)) {
        const artifact = effectiveArtifact(state, "assess", QaVerdictSchema);
        if (artifact === undefined) {
          throw new Error("QA flow: the verdict is missing before the defect gate");
        }
        return forwardState(state);
      }
      const artifact = computeAssess(state);
      const intakeArtifact = intakeOf(state);
      return await suspend(
        suspendPayload(
          artifact,
          qaTarget(intakeArtifact.storyKey, intakeArtifact.target.key),
          state.effects,
        ),
      );
    },
  });

  const approveDefects = createStep({
    id: QA_FLOW_STEPS[6],
    inputSchema: QaRunStateSchema,
    outputSchema: QaRunStateSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<QaRunState | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "approve-defects");
      const artifact =
        effectiveArtifact(state, "approve-defects", QaDefectSetArtifactSchema) ??
        computeDefectSet(state);
      if (!isForward(decision)) {
        return await suspend(
          suspendPayload(
            artifact,
            qaTarget(state.input.storyKey, state.input.target),
            state.effects,
          ),
        );
      }
      // Validated before it is recorded, so a narrowed list that names no
      // finding fails here rather than at the write.
      selectDefects(artifact);
      return forwardState(state);
    },
  });

  const fileDefects = createStep({
    id: QA_FLOW_STEPS[7],
    inputSchema: QaRunStateSchema,
    outputSchema: QaRunStateSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<QaRunState | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "file-defects");
      const plan =
        effectiveArtifact(state, "file-defects", QaFilingPlanSchema) ?? computeFilingPlan(state);
      if (!isForward(decision)) {
        return await suspend(
          suspendPayload(plan, qaTarget(plan.storyKey, plan.targetKey), state.effects),
        );
      }
      const existing = effectRecord(state, "file-defects", QaFilingArtifactSchema);
      const covered =
        existing !== undefined
        && existing.caseSetHash === plan.caseSetHash
        && plan.defects.every((defect) =>
          existing.receipts.some((receipt) => receipt.caseId === defect.caseId),
        );
      const artifact = covered ? existing : await executeFiling(state, plan);
      return QaRunStateSchema.parse({
        ...forwardState(state),
        effects: { ...state.effects, "file-defects": artifact },
      });
    },
  });

  const close = createStep({
    id: QA_FLOW_STEPS[8],
    inputSchema: QaRunStateSchema,
    outputSchema: QaFlowOutputSchema,
    resumeSchema: QaRunStateSchema,
    suspendSchema: QaSuspendSchema,
    execute: async ({
      inputData,
      resumeData,
      suspend,
    }): Promise<QaFlowOutput | InnerOutput> => {
      const state = mergeState(inputData, resumeData);
      const decision = currentDecision(state, "close");
      const artifact = effectiveArtifact(state, "close", QaFlowOutputSchema) ?? computeClose(state);
      if (!isForward(decision)) {
        return await suspend(
          suspendPayload(
            artifact,
            qaTarget(artifact.storyKey, artifact.targetKey),
            state.effects,
          ),
        );
      }
      return artifact;
    },
  });

  return createWorkflow({
    id: "qaFlow",
    inputSchema: QaRunStateSchema,
    outputSchema: QaFlowOutputSchema,
    options: {
      validateInputs: true,
    },
  })
    .then(intake)
    .then(analyse)
    .then(design)
    .then(approveCases)
    .then(execute)
    .then(assess)
    .then(approveDefects)
    .then(fileDefects)
    .then(close)
    .commit();
}
