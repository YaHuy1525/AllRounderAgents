import { createHash } from "node:crypto";

import type { Agent } from "@mastra/core/agent";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { InnerOutput } from "@mastra/core/workflows";
import { z } from "zod";

import {
  CodingWorkflowInputSchema,
  CodingWorkflowOutputSchema,
  ChangeManifestSchema,
  CriticReportSchema,
  EscalationSchema,
  PatchPlanSchema,
  PreviewManifestSchema,
  PullRequestReceiptSchema,
  RootCauseAnalysisSchema,
  ValidationReportSchema,
  type CodingWorkflowOutput,
  type ChangeManifestEntry,
  type CriticReport,
  type PatchPlan,
  type PreviewManifest,
  type RootCauseAnalysis,
  type ValidationReport,
} from "./contracts.js";
import { generateContractOutput } from "../contract-output.js";
import { modelTierConfig } from "../../shared/model.js";
import { actorAgent, investigatorAgent, validatorAgent } from "./agents/index.js";
import {
  RepositoryPolicyError,
  StaleSourceError,
  computePatchHash,
  type GitHubRepositoryTools,
} from "./tools/github.js";
import { ValidatorRegistry } from "./tools/validators.js";
import type { LaneSandbox, SandboxHandle } from "./tools/sandbox-backend.js";
import { SandboxRepoChecks } from "./tools/sandbox-backend.js";
import {
  EMPTY_VALIDATION,
  MemoryCodingRunStore,
  codingPullRequestBody,
  type CodingHarnessSignals,
  type CodingModel,
  type CodingRunRecord,
  type CodingRunStore,
  type CodingWorkflowInput,
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

/**
 * Harness self-correction counters carried through the flow state so the
 * archived `CodingRunRecord` exposes them to the benchmark (A7 bridge):
 * validationAttempts/repairApplied (A1+repair), criticBlocked (A2),
 * doomLoopStops (A3), checksRun (A1).
 */
const CodingHarnessSignalsSchema = z
  .object({
    validationAttempts: z.number().int().min(0).max(2),
    repairApplied: z.boolean(),
    criticBlocked: z.boolean(),
    doomLoopStops: z.boolean(),
    checksRun: z.number().int().min(0),
  })
  .strict();

const CodingRunStateSchema = z
  .object({
    input: CodingWorkflowInputSchema,
    rca: RootCauseAnalysisSchema.optional(),
    patch: PatchPlanSchema.optional(),
    /**
     * Sandbox path: the durable representation of the proposed change. The
     * bytes live in the container; run state only carries path + per-file
     * sha256/bytes + validators, so storage scales with the change, not the
     * file size.
     */
    changeManifest: ChangeManifestSchema.optional(),
    /** Sandbox path: bounded diff excerpt archived with the run. */
    diffExcerpt: z.string().max(8_000).optional(),
    manifest: PreviewManifestSchema.optional(),
    validation: ValidationReportSchema,
    pr: PullRequestReceiptSchema.optional(),
    escalation: EscalationSchema.optional(),
    /** Destructive paths granted by an approved resume; empty unless gated. */
    grantedApprovals: z.array(z.string().max(500)).optional(),
    /** Harness counters set once the validate step runs (A7). */
    harness: CodingHarnessSignalsSchema.optional(),
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
  /** Present when SANDBOX_GIT_LANES includes `coding`: per-run Docker sandbox plumbing. */
  readonly sandbox?: LaneSandbox;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(message: string, max = 1_900): string {
  return message.length <= max ? message : `${message.slice(0, max)}…`;
}

/**
 * A4: a compact environment brief prepended to the investigator/actor prompts.
 * It states the repo snapshot and cited evidence, the validators the output
 * will be scored by, and that a human gate stands behind them — so the model
 * produces testable, validatable output rather than a plausible-looking patch.
 */
function environmentBrief(
  context: InvestigationContext,
  evidence: RootCauseAnalysis["evidence"] | undefined,
): string {
  const repository = `${context.input.owner}/${context.input.repo}@${context.input.baseBranch}`;
  const evidenceLines =
    evidence === undefined || evidence.length === 0
      ? ["- (none cited yet)"]
      : evidence.map((item) => `- ${item.path}:${item.startLine}-${item.endLine}`);
  return [
    "Environment brief:",
    `- Repository snapshot: ${repository} @ ${context.input.sourceSha}`,
    "- Available deterministic validators: json, yaml, xml, basic-syntax.",
    "- Your output is scored by those validators and then a spec-based critic and a human gate before any Draft PR opens.",
    "- Output must satisfy the ticket acceptance criteria and stay within the cited evidence; anything unvalidatable or off-spec is rejected.",
    "- Cited evidence locations:",
    ...evidenceLines,
  ].join("\n");
}

/**
 * Default live model: the scripted OpenRouter agents that already exist for
 * this lane (investigator + actor, plus the spec critic for the A2 gate). Every
 * call is deterministic-only on the output side — JSON is parsed through the
 * same zod contracts the deterministic workflow uses. Tests never hit these;
 * they inject a `CodingModel` fake. Reasoning-tier routing (A6) gives
 * investigation, planning and the critic the higher tier and mechanical repair
 * the cheaper tier; each records its model id so cost is attributable per stage.
 */
export function createCodingAgentModel(options: {
  readonly investigator?: Agent;
  readonly actor?: Agent;
  readonly validator?: Agent;
  /** Sandbox path: the actor's files land in the container; the prompt says so. */
  readonly sandboxMode?: boolean;
} = {}): CodingModel {
  const investigator = options.investigator ?? investigatorAgent;
  const actor = options.actor ?? actorAgent;
  const validator = options.validator ?? validatorAgent;
  const reasoning = { model: modelTierConfig("reasoning") };
  const mechanical = { model: modelTierConfig("mechanical") };
  // The flow is a registered singleton, so this model instance is shared across
  // every run. Usage is therefore keyed by runId (never a single running total)
  // and each run's entry is cleared when the terminal step consumes it, so one
  // run's spend can never leak into another's cost.
  const usageByRun = new Map<string, number>();
  const track = (runId: string, costMicro: number): void => {
    usageByRun.set(runId, (usageByRun.get(runId) ?? 0) + costMicro);
  };
  return {
    async investigate(context: InvestigationContext): Promise<RootCauseAnalysis> {
      const prompt = [
        environmentBrief(context, undefined),
        "",
        "Investigate this coding ticket from a Jira bug report.",
        `Ticket: ${context.input.ticketKey}`,
        `Repository: ${context.input.owner}/${context.input.repo}@${context.input.baseBranch}`,
        "Problem:",
        context.input.problem,
        "",
        "Rules:",
        "- Verify repository files with the available GitHub repository tools (file read, directory listing, code search) before citing them; quote only lines you actually read.",
        "- If repository reads are unavailable and the ticket names no files, return evidence [] with fixable false and confidence below 0.4.",
        "- Do not propose a patch.",
        'Return JSON matching { summary, confidence, evidence[{ path, startLine, endLine, excerpt }], fixable }.',
      ].join("\n");
      return generateContractOutput(investigator, prompt, RootCauseAnalysisSchema, "Investigator", {
        ...reasoning,
        tracingOptions: {
          tags: ["lane:coding", "call:investigate"],
          metadata: { agent: "investigator", ticketKey: context.input.ticketKey },
        },
        onUsage: (cost) => track(context.input.runId, cost),
      });
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
        environmentBrief(context, rca.evidence),
        "",
        "Plan a surgical patch for the cited root cause.",
        `Ticket: ${context.input.ticketKey}`,
        "Root cause summary:",
        rca.summary,
        "",
        "Current source at the evidence paths:",
        ...(evidenceFiles.length === 0 ? ["(no readable evidence)"] : evidenceFiles),
        ...(options.sandboxMode
          ? [
              "",
              "Execution mode: your returned files are written verbatim into a real git checkout in a per-run",
              "sandbox container, which is then validated, committed and pushed from disk. Judge the change",
              "against the source above; it is the exact current content of those files.",
            ]
          : []),
        "",
        "Rules:",
        "- Patch only files named in the RCA evidence.",
        "- files must list at least one file (a whole-file replacement); never return an empty list.",
        "- Keep the change the smallest that fixes the cited cause.",
        "- validators must be one or more of json, yaml, xml, basic-syntax.",
        'Return JSON matching { summary, files[{ path, content, validators }] }.',
      ].join("\n");
      return generateContractOutput(actor, prompt, PatchPlanSchema, "Actor", {
        ...reasoning,
        tracingOptions: {
          tags: ["lane:coding", "call:plan-patch"],
          metadata: { agent: "actor", ticketKey: context.input.ticketKey },
        },
        onUsage: (cost) => track(context.input.runId, cost),
      });
    },

    async repairPatch(
      context: InvestigationContext,
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
      return generateContractOutput(actor, prompt, PatchPlanSchema, "Actor repair", {
        ...mechanical,
        tracingOptions: {
          tags: ["lane:coding", "call:repair"],
          metadata: { agent: "actor", ticketKey: context.input.ticketKey },
        },
        onUsage: (cost) => track(context.input.runId, cost),
      });
    },

    async verify(
      context: InvestigationContext,
      patch: PatchPlan,
      rca: RootCauseAnalysis,
    ): Promise<CriticReport> {
      const prompt = [
        environmentBrief(context, rca.evidence),
        "",
        "Verify this patch against the ticket acceptance criteria and the cited evidence.",
        `Ticket: ${context.input.ticketKey}`,
        "Acceptance criteria (from the problem statement):",
        context.input.problem,
        "",
        "Root cause summary:",
        rca.summary,
        "",
        "Patch:",
        JSON.stringify(patch, null, 2),
        "",
        "Rules:",
        "- Judge the patch against the acceptance criteria and the cited locations, not the actor's own summary.",
        "- Set passed false when any criterion is unmet or the patch is off-spec.",
        "- Never edit the patch.",
        "Return JSON matching { passed, critique, checkedCriteria[] }.",
      ].join("\n");
      return generateContractOutput(validator, prompt, CriticReportSchema, "Spec critic", {
        ...reasoning,
        tracingOptions: {
          tags: ["lane:coding", "call:critic"],
          metadata: { agent: "critic", ticketKey: context.input.ticketKey },
        },
        onUsage: (cost) => track(context.input.runId, cost),
      });
    },

    consumeUsage(runId: string): number {
      const total = usageByRun.get(runId) ?? 0;
      usageByRun.delete(runId);
      return total;
    },
  };
}

/**
 * Mastra `codingFlow`: load-context -> investigate -> strict-rca ->
 * plan-surgical-patch -> preflight -> patch -> validate -> draft-pr ->
 * evidence-close. Destructive-path patches suspend at `preflight` for a signed
 * approval, so nothing reaches GitHub without a receipt, and every policy check
 * and validator stays deterministic.
 */
export function createCodingFlow(deps: CodingFlowDeps) {
  const { github } = deps;
  const reader = github.reader;
  const writer = github.writer;
  const sandbox = deps.sandbox;
  const validators = deps.validators ?? new ValidatorRegistry();
  const model = deps.model ?? createCodingAgentModel({ sandboxMode: sandbox !== undefined });
  const store = deps.store ?? new MemoryCodingRunStore();
  const confidenceFloor = deps.confidenceFloor ?? 0.8;

  /**
   * Sandbox path helpers: the per-run container is provisioned from the full
   * run context, the actor's bytes land on its disk, and every gate hashes
   * what the disk actually holds. The handle registry on the backend lets
   * working-tree reads and the working-tree commit find it — including after
   * a resume in a restarted process, because acquire reconnects by branch.
   */
  const provisionSandbox = async (input: CodingWorkflowInput): Promise<SandboxHandle> => {
    if (sandbox === undefined) throw new Error("Coding flow: sandbox path requested without wiring");
    const handle = await sandbox.provisioner.acquire({
      owner: input.owner,
      repo: input.repo,
      baseBranch: input.baseBranch,
      sourceSha: input.sourceSha,
      branch: input.branch,
      runId: input.runId,
    });
    sandbox.backend.track(handle);
    return handle;
  };

  /** Entries the gates hash: disk fingerprints on the sandbox path. */
  function gateEntries(
    state: CodingRunState,
    patch: PatchPlan,
  ): ChangeManifestEntry[] | PatchPlan["files"] {
    return state.changeManifest ?? patch.files;
  }

  function escalate(
    state: CodingRunState,
    reason: z.infer<typeof EscalationSchema.shape.reason>,
    detail: string,
    options: {
      validation?: ValidationReport | undefined;
      manifest?: PreviewManifest | undefined;
      pr?: unknown;
      harness?: CodingHarnessSignals | undefined;
    } = {},
  ): CodingRunState {
    return {
      ...state,
      close: "escalated",
      validation: options.validation ?? state.validation,
      ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
      ...(options.pr === undefined ? {} : { pr: options.pr as CodingRunState["pr"] }),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
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
        if (sandbox === undefined) return { ...state, patch };
        // Sandbox path: the actor's bytes are landed in the container and the
        // durable state keeps only the manifest read back from disk.
        const handle = await provisionSandbox(state.input);
        await sandbox.backend.writePatchFiles(handle, patch.files);
        const changeManifest = await sandbox.backend.readDiskManifest(handle, patch.files);
        return { ...state, patch, changeManifest };
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
            gateEntries(state, patch),
            requireRca(state).evidence,
            granted,
          );
          return { ...state, manifest, grantedApprovals: granted };
        } catch (error) {
          if (error instanceof RepositoryPolicyError && error.code === "approval_required") {
            if (resumeData === undefined) {
              // Sandbox path: the fingerprints shown to the approver come from
              // the container's disk, not from transported strings; the schema
              // never carried content, so no bodies are stored in the suspend
              // payload either way.
              const suspendEntries = state.changeManifest
                ?? patch.files.map((file) => ({
                  path: file.path,
                  sha256: createHash("sha256").update(file.content).digest("hex"),
                  bytes: Buffer.byteLength(file.content),
                  validators: file.validators,
                }));
              return await suspend({
                runId: input.runId,
                ticketKey: input.ticketKey,
                repository: `${input.owner}/${input.repo}`,
                branch: input.branch,
                summary: patch.summary,
                actionHash: computePatchHash(suspendEntries),
                files: suspendEntries.map((file) => ({
                  path: file.path,
                  sha256: file.sha256,
                  bytes: file.bytes,
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
      const context: InvestigationContext = { input: state.input, source: reader };
      let patch = requirePatch(state);
      let manifest = state.manifest;
      // Sandbox path: run the repository's real test/build commands inside
      // the container via the RepoChecks seam instead of the host seam.
      const stepValidators = sandbox === undefined
        ? validators
        : new ValidatorRegistry(new SandboxRepoChecks(
            sandbox.provisioner,
            (process.env.SANDBOX_TEST_COMMANDS ?? "")
              .split(",")
              .map((command) => command.trim())
              .filter((command) => command !== ""),
          ));
      // Sandbox path: land repaired bytes on disk and re-read the manifest,
      // so every hash below is a hash of what the container will commit.
      // `diskEntries` carries the latest disk fingerprint for the gates.
      let diskEntries: ChangeManifestEntry[] | undefined;
      const landAndRead = async (next: PatchPlan): Promise<ChangeManifestEntry[]> => {
        if (sandbox === undefined) return [];
        const handle = await provisionSandbox(state.input);
        await sandbox.backend.writePatchFiles(handle, next.files);
        diskEntries = await sandbox.backend.readDiskManifest(handle, next.files);
        return diskEntries;
      };
      const entriesFor = (plan: PatchPlan): ChangeManifestEntry[] | PatchPlan["files"] =>
        diskEntries ?? gateEntries(state, plan);
      let report = stepValidators.validate(patch);
      // Harness counters (A7 bridge) for this run, mutated as the self-correction
      // ladder runs; always attached to the state so the archived record shows
      // the effort, not just the outcome.
      const harness: CodingHarnessSignals = {
        validationAttempts: 1,
        repairApplied: false,
        criticBlocked: false,
        doomLoopStops: false,
        checksRun: 0,
      };

      if (!report.passed) {
        const failedHash = computePatchHash(entriesFor(patch));
        let repaired: PatchPlan;
        try {
          repaired = PatchPlanSchema.parse(
            await model.repairPatch(context, patch, report),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown model failure";
          return escalate(
            state,
            "path_denied",
            `The repaired patch did not satisfy the safe patch contract: ${message}`,
            { validation: report, harness },
          );
        }
        // A3: a repair that reproduces the identical failed patch is a doom
        // loop, not a second attempt. Stop before spending the repair budget.
        // Sandbox path: the compared hash is the repaired disk fingerprint.
        const repairedEntries = await landAndRead(repaired);
        const repairedHash = computePatchHash(sandbox === undefined ? repaired.files : repairedEntries);
        if (repairedHash === failedHash) {
          harness.doomLoopStops = true;
          return escalate(
            state,
            "doom_loop",
            "The repair reproduced an identical failed patch; stopping before a second attempt",
            { validation: report, harness },
          );
        }
        patch = repaired;
        harness.repairApplied = true;
        harness.validationAttempts = 2;
        try {
          manifest = writer.preflight(
            state.input.owner,
            state.input.repo,
            state.input.baseBranch,
            state.input.branch,
            state.input.sourceSha,
            entriesFor(patch),
            requireRca(state).evidence,
            approvedPaths(state),
          );
          report = stepValidators.validate(patch, 2);
          if (!report.passed) {
            return escalate(
              state,
              "validation_failed_after_repair",
              "Allowlisted validation failed after the single repair attempt",
              { validation: report, manifest, harness },
            );
          }
        } catch (error) {
          if (error instanceof RepositoryPolicyError && error.code === "approval_required") {
            return escalate(
              state,
              "approval_required",
              "The repair introduced a destructive path; a new approval-gated run is required",
              { validation: report, harness },
            );
          }
          if (error instanceof RepositoryPolicyError) {
            return escalate(state, "path_denied", error.message, { validation: report, harness });
          }
          throw error;
        }
      }

      // A1: optional per-repo real-tooling checks, gated to pre-Draft-PR (only
      // after the structure floor passed). Skipped with a logged reason when
      // the repo does not afford them.
      const checkOutcome = await stepValidators.runChecks(
        patch,
        `${state.input.owner}/${state.input.repo}`,
      );
      if (checkOutcome.ran) {
        harness.checksRun = checkOutcome.results.length;
        const failures = checkOutcome.results.filter((result) => !result.passed);
        if (failures.length > 0) {
          report = ValidationReportSchema.parse({
            ...report,
            results: [...report.results, ...failures],
            passed: false,
          });
          return escalate(
            state,
            "validation_failed_after_repair",
            `Per-repo checks failed: ${failures.map((result) => `${result.validator} ${result.path}`).join("; ")}`,
            { validation: report, manifest, harness },
          );
        }
      }

      // A2: enforced pre-completion verification. The spec critic gates the
      // patch against the acceptance criteria before a Draft PR; on a block it
      // gets one targeted regeneration (critique attached) while the structural
      // repair budget is still unspent, then escalates.
      if (model.verify !== undefined) {
        let verdict = CriticReportSchema.parse(
          await model.verify(context, patch, requireRca(state)),
        );
        if (!verdict.passed && harness.validationAttempts === 1) {
          const critique: ValidationReport = ValidationReportSchema.parse({
            passed: false,
            attempts: 1,
            results: [{
              validator: "spec-critic",
              path: patch.files[0]?.path ?? "",
              passed: false,
              message: verdict.critique,
            }],
          });
          const regenerated = PatchPlanSchema.safeParse(
            await model.repairPatch(context, patch, critique),
          );
          // Land the regenerated bytes first on the sandbox path so the
          // acceptance comparison, the preflight and the validators all see
          // the disk fingerprint; a regeneration identical to the disk before
          // the land is rejected, mirroring the doom-loop arm above.
          const preRegenHash = sandbox === undefined
            ? computePatchHash(patch.files)
            : computePatchHash(entriesFor(patch));
          const regenEntries = regenerated.success
            ? sandbox === undefined
              ? regenerated.data.files
              : await landAndRead(regenerated.data)
            : undefined;
          if (
            regenerated.success
            && regenEntries !== undefined
            && computePatchHash(regenEntries) !== preRegenHash
          ) {
            const regenManifest = writer.preflight(
              state.input.owner,
              state.input.repo,
              state.input.baseBranch,
              state.input.branch,
              state.input.sourceSha,
              regenEntries,
              requireRca(state).evidence,
              approvedPaths(state),
            );
            const regenReport = stepValidators.validate(regenerated.data, 2);
            if (regenReport.passed) {
              patch = regenerated.data;
              manifest = regenManifest;
              report = regenReport;
              harness.repairApplied = true;
              harness.validationAttempts = 2;
              verdict = CriticReportSchema.parse(
                await model.verify(context, patch, requireRca(state)),
              );
            }
          }
        }
        if (!verdict.passed) {
          harness.criticBlocked = true;
          return escalate(
            state,
            "critic_blocked",
            verdict.critique,
            { validation: report, manifest, harness },
          );
        }
      }

      return {
        ...state,
        patch,
        validation: report,
        harness,
        ...(diskEntries !== undefined ? { changeManifest: diskEntries } : {}),
        ...(manifest === undefined ? {} : { manifest }),
      };
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
      let sandboxDiffExcerpt: string | undefined;
      try {
        pr = await writer.apply(
          manifest,
          state.changeManifest ?? patch.files,
          `[${state.input.ticketKey}] ${patch.summary}`,
          codingPullRequestBody(state.input, rca, manifest, state.validation),
        );
        if (sandbox !== undefined) {
          // The working tree is now committed and pushed; keep a bounded diff
          // excerpt for the archive, then the container has served its purpose.
          const handle = sandbox.provisioner.peek(state.input.branch)
            ?? await provisionSandbox(state.input);
          sandboxDiffExcerpt = await sandbox.backend.diffExcerpt(handle);
        }
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
        ...(sandboxDiffExcerpt === undefined
          ? {}
          : { diffExcerpt: sandboxDiffExcerpt.slice(0, 8_000) }),
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
      // Consume this run's real token spend (set by the OpenRouter model calls
      // routed through generateContractOutput). Fakes without a usage seam
      // report zero. Cleared here so the shared model instance stays leak-free.
      const costUsdMicro = model.consumeUsage?.(state.input.runId) ?? 0;
      const record: CodingRunRecord = {
        input: state.input,
        rca: requireRca(state),
        validation: state.validation,
        ...(state.manifest === undefined ? {} : { manifest: state.manifest }),
        ...(state.pr === undefined ? {} : { pr: state.pr }),
        ...(state.harness === undefined ? {} : { harness: state.harness }),
        ...(state.escalation === undefined ? {} : { escalation: state.escalation }),
        ...(state.changeManifest === undefined ? {} : { changeManifest: state.changeManifest }),
        ...(state.diffExcerpt === undefined ? {} : { diffExcerpt: state.diffExcerpt }),
        costUsdMicro,
      };
      await store.save(record);
      // Sandbox teardown: the terminal step of every path (open, escalated,
      // rejected) releases the host-owned container and its credential.
      if (sandbox !== undefined) {
        sandbox.backend.untrack(state.input.branch);
        await sandbox.provisioner.destroy(state.input.branch);
      }
      const output: CodingWorkflowOutput = {
        runId: state.input.runId,
        status: state.close,
        rca: record.rca,
        validation: record.validation,
        ...(record.manifest === undefined ? {} : { manifest: record.manifest }),
        ...(record.pr === undefined ? {} : { pr: record.pr }),
        ...(record.escalation === undefined ? {} : { escalation: record.escalation }),
        costUsdMicro,
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
