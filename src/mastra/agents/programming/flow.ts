import { createHash } from "node:crypto";

import type { Agent } from "@mastra/core/agent";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { InnerOutput } from "@mastra/core/workflows";
import { z } from "zod";

import {
  CodingWorkflowInputSchema,
  CodingWorkflowOutputSchema,
  EscalationSchema,
  PatchPlanSchema,
  PreviewManifestSchema,
  PullRequestReceiptSchema,
  RootCauseAnalysisSchema,
  ValidationReportSchema,
  type CodingWorkflowOutput,
  type PatchPlan,
  type PreviewManifest,
  type RootCauseAnalysis,
  type ValidationReport,
} from "./contracts.js";
import { generateContractOutput } from "../contract-output.js";
import { actorAgent, investigatorAgent } from "./agents/index.js";
import {
  RepositoryPolicyError,
  StaleSourceError,
  computePatchHash,
  type GitHubRepositoryTools,
} from "./tools/github.js";
import { ValidatorRegistry } from "./tools/validators.js";
import {
  EMPTY_VALIDATION,
  MemoryCodingRunStore,
  codingPullRequestBody,
  type CodingModel,
  type CodingRunRecord,
  type CodingRunStore,
  type InvestigationContext,
} from "./workflow.js";

/**
 * Named steps of the Mastra coding flow. Ids match the deterministic
 * `CodingWorkflow` skeleton so both implementations expose one contract.
 */
export const CODING_FLOW_STEPS = [
  "load-context",
  "investigate",
  "strict-rca",
  "plan-surgical-patch",
  "preflight",
  "patch",
  "validate",
  "draft-pr",
  "evidence-close",
] as const;

export type CodingFlowStepId = (typeof CODING_FLOW_STEPS)[number];

const CodingRunStateSchema = z
  .object({
    input: CodingWorkflowInputSchema,
    rca: RootCauseAnalysisSchema.optional(),
    patch: PatchPlanSchema.optional(),
    manifest: PreviewManifestSchema.optional(),
    validation: ValidationReportSchema,
    pr: PullRequestReceiptSchema.optional(),
    escalation: EscalationSchema.optional(),
    /** Destructive paths granted by an approved resume; empty unless gated. */
    grantedApprovals: z.array(z.string().max(500)).optional(),
    close: z.enum(["escalated", "draft_pr_opened", "awaiting_ci"]).optional(),
  })
  .strict();

type CodingRunState = z.infer<typeof CodingRunStateSchema>;

export const CodingApprovalSuspendSchema = z
  .object({
    runId: z.string().min(1),
    ticketKey: z.string().min(1),
    repository: z.string().min(1),
    branch: z.string().min(1),
    summary: z.string().min(1).max(2_000),
    actionHash: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(
      z.object({
        path: z.string().min(1).max(500),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().nonnegative(),
        validators: z.array(z.string().min(1)),
      }).strict(),
    ),
    destructivePaths: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type CodingApprovalSuspendPayload = z.infer<typeof CodingApprovalSuspendSchema>;

export const CodingApprovalResumeSchema = z
  .object({
    decision: z.enum(["approved", "rejected", "expired"]),
    receipt: z.string().min(1).optional(),
  })
  .strict();

export type CodingApprovalResumeData = z.infer<typeof CodingApprovalResumeSchema>;

export interface CodingFlowDeps {
  readonly github: GitHubRepositoryTools;
  readonly model?: CodingModel;
  readonly store?: CodingRunStore;
  readonly validators?: ValidatorRegistry;
  readonly confidenceFloor?: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(message: string, max = 1_900): string {
  return message.length <= max ? message : `${message.slice(0, max)}…`;
}

/**
 * Default live model: the scripted OpenRouter agents that already exist for
 * this lane (investigator + actor). Every call is deterministic-only on the
 * output side — JSON is parsed through the same zod contracts the
 * deterministic workflow uses. Tests never hit these; they inject a
 * `CodingModel` fake.
 */
export function createCodingAgentModel(options: {
  readonly investigator?: Agent;
  readonly actor?: Agent;
} = {}): CodingModel {
  const investigator = options.investigator ?? investigatorAgent;
  const actor = options.actor ?? actorAgent;
  return {
    async investigate(context: InvestigationContext): Promise<RootCauseAnalysis> {
      const prompt = [
        "Investigate this coding ticket from a Jira bug report.",
        `Ticket: ${context.input.ticketKey}`,
        `Repository: ${context.input.owner}/${context.input.repo}@${context.input.baseBranch}`,
        "Problem:",
        context.input.problem,
        "",
        "Rules:",
        "- Cite file paths with line ranges only when the ticket itself names them.",
        "- If no file-level evidence is visible, return evidence [] with fixable false and confidence below 0.4.",
        "- Do not propose a patch.",
        'Return JSON matching { summary, confidence, evidence[{ path, startLine, endLine, excerpt }], fixable }.',
      ].join("\n");
      return generateContractOutput(investigator, prompt, RootCauseAnalysisSchema, "Investigator");
    },

    async planPatch(context: InvestigationContext, rca: RootCauseAnalysis): Promise<PatchPlan> {
      const evidenceFiles: string[] = [];
      for (const item of rca.evidence.slice(0, 4)) {
        try {
          const file = await context.source.content(
            context.input.owner,
            context.input.repo,
            item.path,
            context.input.sourceSha,
          );
          evidenceFiles.push(
            `--- ${item.path} (${item.startLine}-${item.endLine}) ---\n${file.content.slice(0, 6_000)}`,
          );
        } catch {
          evidenceFiles.push(`--- ${item.path} --- (unreadable; do not invent content)`);
        }
      }
      const prompt = [
        "Plan a surgical patch for the cited root cause.",
        `Ticket: ${context.input.ticketKey}`,
        "Root cause summary:",
        rca.summary,
        "",
        "Current source at the evidence paths:",
        ...(evidenceFiles.length === 0 ? ["(no readable evidence)"] : evidenceFiles),
        "",
        "Rules:",
        "- Patch only files named in the RCA evidence.",
        "- files must list at least one file (a whole-file replacement); never return an empty list.",
        "- Keep the change the smallest that fixes the cited cause.",
        "- validators must be one or more of json, yaml, xml, basic-syntax.",
        'Return JSON matching { summary, files[{ path, content, validators }] }.',
      ].join("\n");
      return generateContractOutput(actor, prompt, PatchPlanSchema, "Actor");
    },

    async repairPatch(
      _context: InvestigationContext,
      patch: PatchPlan,
      report: ValidationReport,
    ): Promise<PatchPlan> {
      const prompt = [
        "Repair this patch so it passes its own validators.",
        "Patch:",
        JSON.stringify(patch, null, 2),
        "",
        "Validator failures:",
        ...report.results.map((result) => `- ${result.validator} ${result.path}: ${result.message}`),
        "",
        "Rules:",
        "- Keep the same file paths.",
        "- Return the complete repaired patch, not a diff.",
        'Return JSON matching { summary, files[{ path, content, validators }] }.',
      ].join("\n");
      return generateContractOutput(actor, prompt, PatchPlanSchema, "Actor repair");
    },
  };
}

/**
 * Mastra `codingFlow`: the coding lane as named, suspendable workflow steps
 * (load-context -> investigate -> strict-rca -> plan-surgical-patch ->
 * preflight -> patch -> validate -> draft-pr -> evidence-close).
 *
 * Destructive-path patches suspend at `preflight` for a signed human
 * approval; nothing is written to GitHub before an approved resume with a
 * receipt. All policy checks and validators stay deterministic — the model
 * is injected (`deps.model`), defaulting to the scripted OpenRouter agents.
 */
export function createCodingFlow(deps: CodingFlowDeps) {
  const { github } = deps;
  const reader = github.reader;
  const writer = github.writer;
  const validators = deps.validators ?? new ValidatorRegistry();
  const model = deps.model ?? createCodingAgentModel();
  const store = deps.store ?? new MemoryCodingRunStore();
  const confidenceFloor = deps.confidenceFloor ?? 0.8;

  function escalate(
    state: CodingRunState,
    reason: z.infer<typeof EscalationSchema.shape.reason>,
    detail: string,
    options: { validation?: ValidationReport; manifest?: PreviewManifest; pr?: unknown } = {},
  ): CodingRunState {
    return {
      ...state,
      close: "escalated",
      validation: options.validation ?? state.validation,
      ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
      ...(options.pr === undefined ? {} : { pr: options.pr as CodingRunState["pr"] }),
      escalation: EscalationSchema.parse({ reason, diagnosisOnly: true, detail: truncate(detail) }),
    };
  }

  function requireRca(state: CodingRunState): RootCauseAnalysis {
    if (state.rca === undefined) throw new Error("Coding flow: RCA missing before use");
    return state.rca;
  }

  function requirePatch(state: CodingRunState): PatchPlan {
    if (state.patch === undefined) throw new Error("Coding flow: patch missing before use");
    return state.patch;
  }

  function approvedPaths(state: CodingRunState): string[] {
    return unique([...state.input.approvedDestructivePaths, ...(state.grantedApprovals ?? [])]);
  }

  function deniedDestructivePaths(state: CodingRunState): string[] {
    const allowed = new Set(approvedPaths(state));
    return requirePatch(state).files
      .filter((file) => reader.isDestructive(file.path) && !allowed.has(file.path))
      .map((file) => file.path);
  }

  function stateWithRca(state: CodingRunState, rca: RootCauseAnalysis): CodingRunState {
    return { ...state, rca };
  }

  const loadContext = createStep({
    id: CODING_FLOW_STEPS[0],
    inputSchema: CodingWorkflowInputSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => ({
      input: CodingWorkflowInputSchema.parse(inputData),
      validation: EMPTY_VALIDATION,
    }),
  });

  const investigate = createStep({
    id: CODING_FLOW_STEPS[1],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData as CodingRunState;
      if (state.close !== undefined) return state;
      const context: InvestigationContext = { input: state.input, source: reader };
      let rca: RootCauseAnalysis;
      try {
        rca = RootCauseAnalysisSchema.parse(await model.investigate(context));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown model failure";
        rca = {
          summary: truncate(`Investigation could not be completed: ${message}`, 4_000),
          confidence: 0,
          evidence: [],
          fixable: false,
        };
        return escalate(stateWithRca(state, rca), "insufficient_evidence", message);
      }
      return stateWithRca(state, rca);
    },
  });

  const strictRca = createStep({
    id: CODING_FLOW_STEPS[2],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData as CodingRunState;
      if (state.close !== undefined) return state;
      const rca = requireRca(state);
      if (rca.evidence.length === 0 || rca.confidence < confidenceFloor) {
        return escalate(
          state,
          "insufficient_evidence",
          "RCA evidence or confidence is below policy",
        );
      }
      if (!rca.fixable) {
        return escalate(
          state,
          "unfixable",
          "Diagnosis is evidence-backed but has no safe repository fix",
        );
      }
      return state;
    },
  });

  const planSurgicalPatch = createStep({
    id: CODING_FLOW_STEPS[3],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData as CodingRunState;
      if (state.close !== undefined) return state;
      const context: InvestigationContext = { input: state.input, source: reader };
      try {
        const patch = PatchPlanSchema.parse(await model.planPatch(context, requireRca(state)));
        return { ...state, patch };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown model failure";
        return escalate(
          state,
          "path_denied",
          `The proposed patch did not satisfy the safe patch contract: ${message}`,
        );
      }
    },
  });

  const preflight = createStep({
    id: CODING_FLOW_STEPS[4],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    resumeSchema: CodingApprovalResumeSchema,
    suspendSchema: CodingApprovalSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      const state = inputData as CodingRunState;
      if (state.close !== undefined) return state;
      const patch = requirePatch(state);
      const { input } = state;
      const approvals = approvedPaths(state);

      const preflightOrSuspend = async (
        granted: string[],
      ): Promise<CodingRunState | InnerOutput> => {
        try {
          const manifest = writer.preflight(
            input.owner,
            input.repo,
            input.baseBranch,
            input.branch,
            input.sourceSha,
            patch.files,
            requireRca(state).evidence,
            granted,
          );
          return { ...state, manifest, grantedApprovals: granted };
        } catch (error) {
          if (error instanceof RepositoryPolicyError && error.code === "approval_required") {
            if (resumeData === undefined) {
              return await suspend({
                runId: input.runId,
                ticketKey: input.ticketKey,
                repository: `${input.owner}/${input.repo}`,
                branch: input.branch,
                summary: patch.summary,
                actionHash: computePatchHash(patch.files),
                files: patch.files.map((file) => ({
                  path: file.path,
                  sha256: createHash("sha256").update(file.content).digest("hex"),
                  bytes: Buffer.byteLength(file.content),
                  validators: file.validators,
                })),
                destructivePaths: deniedDestructivePaths(state),
              });
            }
            return escalate(
              state,
              "path_denied",
              "The approved resume still did not satisfy repository policy",
            );
          }
          if (error instanceof RepositoryPolicyError) {
            return escalate(state, "path_denied", error.message);
          }
          throw error;
        }
      };

      if (resumeData === undefined) {
        return preflightOrSuspend(approvals);
      }
      if (resumeData.decision !== "approved" || resumeData.receipt === undefined) {
        return escalate(
          state,
          "approval_rejected",
          `Approval was ${resumeData.decision} for ${input.ticketKey}`,
        );
      }
      return preflightOrSuspend(unique([...approvals, ...deniedDestructivePaths(state)]));
    },
  });

  const patch = createStep({
    id: CODING_FLOW_STEPS[5],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData as CodingRunState;
      if (state.close !== undefined) return state;
      const actual = await reader.sourceSha(state.input.owner, state.input.repo, state.input.baseBranch);
      if (actual !== state.input.sourceSha) {
        return escalate(state, "stale_source", "Base branch changed after investigation");
      }
      return state;
    },
  });

  const validate = createStep({
    id: CODING_FLOW_STEPS[6],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData as CodingRunState;
      if (state.close !== undefined) return state;
      let patch = requirePatch(state);
      let report = validators.validate(patch);
      if (report.passed) {
        return { ...state, validation: report };
      }

      let repaired: PatchPlan;
      try {
        repaired = PatchPlanSchema.parse(
          await model.repairPatch(
            { input: state.input, source: reader },
            patch,
            report,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown model failure";
        return escalate(
          state,
          "path_denied",
          `The repaired patch did not satisfy the safe patch contract: ${message}`,
          { validation: report },
        );
      }
      patch = repaired;

      try {
        const manifest = writer.preflight(
          state.input.owner,
          state.input.repo,
          state.input.baseBranch,
          state.input.branch,
          state.input.sourceSha,
          patch.files,
          requireRca(state).evidence,
          approvedPaths(state),
        );
        report = validators.validate(patch, 2);
        if (!report.passed) {
          return escalate(
            state,
            "validation_failed_after_repair",
            "Allowlisted validation failed after the single repair attempt",
            { validation: report, manifest },
          );
        }
        return { ...state, patch, manifest, validation: report };
      } catch (error) {
        if (error instanceof RepositoryPolicyError && error.code === "approval_required") {
          return escalate(
            state,
            "approval_required",
            "The repair introduced a destructive path; a new approval-gated run is required",
            { validation: report },
          );
        }
        if (error instanceof RepositoryPolicyError) {
          return escalate(state, "path_denied", error.message, { validation: report });
        }
        throw error;
      }
    },
  });

  const draftPr = createStep({
    id: CODING_FLOW_STEPS[7],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData as CodingRunState;
      if (state.close !== undefined) return state;
      const patch = requirePatch(state);
      const manifest = state.manifest;
      if (manifest === undefined) throw new Error("Coding flow: manifest missing before Draft PR");
      const rca = requireRca(state);

      let pr: CodingRunState["pr"];
      try {
        pr = await writer.apply(
          manifest,
          patch.files,
          `[${state.input.ticketKey}] ${patch.summary}`,
          codingPullRequestBody(state.input, rca, manifest, state.validation),
        );
      } catch (error) {
        if (error instanceof StaleSourceError) {
          return escalate(
            state,
            "stale_source",
            "Base branch changed after investigation",
            { manifest },
          );
        }
        throw error;
      }

      const ciStatus = await writer.checks(state.input.owner, state.input.repo, pr.commitSha);
      const validation = ValidationReportSchema.parse({ ...state.validation, ciStatus });
      if (ciStatus === "failure") {
        return escalate(
          state,
          "ci_failed",
          "GitHub checks reported failure; Draft PR remains for review",
          { validation, manifest, pr },
        );
      }
      // Typed separately so the fresh literal keeps the literal union (the step
      // execute has no contextual typing when inputData is unknown).
      const close: CodingRunState["close"] =
        ciStatus === "pending" ? "awaiting_ci" : "draft_pr_opened";
      return {
        ...state,
        pr,
        validation,
        close,
      };
    },
  });

  const evidenceClose = createStep({
    id: CODING_FLOW_STEPS[8],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingWorkflowOutputSchema,
    execute: async ({ inputData }) => {
      const state = inputData as CodingRunState;
      if (state.close === undefined) {
        throw new Error("Coding flow: run ended without a terminal decision");
      }
      const record: CodingRunRecord = {
        input: state.input,
        rca: requireRca(state),
        validation: state.validation,
        ...(state.manifest === undefined ? {} : { manifest: state.manifest }),
        ...(state.pr === undefined ? {} : { pr: state.pr }),
        ...(state.escalation === undefined ? {} : { escalation: state.escalation }),
      };
      await store.save(record);
      const output: CodingWorkflowOutput = {
        runId: state.input.runId,
        status: state.close,
        rca: record.rca,
        validation: record.validation,
        ...(record.manifest === undefined ? {} : { manifest: record.manifest }),
        ...(record.pr === undefined ? {} : { pr: record.pr }),
        ...(record.escalation === undefined ? {} : { escalation: record.escalation }),
      };
      return CodingWorkflowOutputSchema.parse(output);
    },
  });

  return createWorkflow({
    id: "codingFlow",
    inputSchema: CodingWorkflowInputSchema,
    outputSchema: CodingWorkflowOutputSchema,
    options: {
      validateInputs: true,
    },
  })
    .then(loadContext)
    .then(investigate)
    .then(strictRca)
    .then(planSurgicalPatch)
    .then(preflight)
    .then(patch)
    .then(validate)
    .then(draftPr)
    .then(evidenceClose)
    .commit();
}
