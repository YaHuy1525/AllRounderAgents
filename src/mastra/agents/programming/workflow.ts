import {
  EscalationSchema,
  PatchPlanSchema,
  PreviewManifestSchema,
  RootCauseAnalysisSchema,
  ValidationReportSchema,
  type ChangeManifestEntry,
  type CriticReport,
  type Escalation,
  type PatchPlan,
  type PreviewManifest,
  type PullRequestReceipt,
  type RootCauseAnalysis,
  type ValidationReport,
} from "./contracts.js";
import {
  GitHubSourceReader,
  GitHubWriter,
  RepositoryPolicyError,
  StaleSourceError,
  computePatchHash,
} from "./tools/github.js";
import type { ValidatorRegistry } from "./tools/validators.js";

export interface CodingWorkflowInput {
  runId: string;
  tenantId: string;
  ticketKey: string;
  owner: string;
  repo: string;
  baseBranch: string;
  sourceSha: string;
  branch: string;
  problem: string;
  approvedDestructivePaths: string[];
}

export interface InvestigationContext {
  input: CodingWorkflowInput;
  source: Pick<GitHubSourceReader, "content">;
}

export interface CodingModel {
  investigate(context: InvestigationContext, brief?: string): Promise<RootCauseAnalysis>;
  planPatch(context: InvestigationContext, rca: RootCauseAnalysis, brief?: string): Promise<PatchPlan>;
  repairPatch(context: InvestigationContext, patch: PatchPlan, report: ValidationReport): Promise<PatchPlan>;
  /**
   * Optional spec-based critic (A2). Runs the validatorAgent to score the
   * patch against the ticket acceptance criteria plus the cited evidence, not
   * the model's own restatement. Absent means the critic gate is skipped.
   */
  verify?(context: InvestigationContext, patch: PatchPlan, rca: RootCauseAnalysis): Promise<CriticReport>;
  /**
   * Optional actual-cost seam: returns the accumulated micro-USD the model
   * spent for `runId` and clears it, so the flow can fold a run's real token
   * spend into its terminal record. Absent means the run reports zero cost
   * (deterministic test fakes and offline lanes never instrument usage).
   */
  consumeUsage?(runId: string): number;
}

export interface CodingRunRecord {
  input: CodingWorkflowInput;
  rca: RootCauseAnalysis;
  manifest?: PreviewManifest;
  validation: ValidationReport;
  pr?: PullRequestReceipt;
  escalation?: Escalation;
  /**
   * Harness self-correction counters (A7 bridge) recorded so the benchmark can
   * attribute the build-verify-fix effort per run, not just assert it happened.
   */
  harness?: CodingHarnessSignals;
  /**
   * Actual token-derived spend for this run in micro-USD, folded from the
   * model's usage at the terminal step. 0 for models that do not instrument it.
   */
  costUsdMicro?: number;
  /**
   * Sandbox path: the disk fingerprint of the change (no file bodies) and a
   * bounded diff excerpt, archived instead of transporting whole files.
   */
  changeManifest?: ChangeManifestEntry[];
  diffExcerpt?: string;
}

export interface CodingHarnessSignals {
  validationAttempts: number;
  repairApplied: boolean;
  criticBlocked: boolean;
  doomLoopStops: boolean;
  checksRun: number;
}

export interface CodingRunStore {
  save(record: CodingRunRecord): Promise<void>;
}

export class MemoryCodingRunStore implements CodingRunStore {
  readonly records = new Map<string, CodingRunRecord>();

  async save(record: CodingRunRecord): Promise<void> {
    this.records.set(record.input.runId, structuredClone(record));
  }
}

export interface NamedStep {
  id: string;
}

export interface CodingWorkflowResult {
  runId: string;
  status: "draft_pr_opened" | "awaiting_ci" | "escalated";
  rca: RootCauseAnalysis;
  validation: ValidationReport;
  manifest?: PreviewManifest;
  pr?: PullRequestReceipt;
  escalation?: Escalation;
  /** Actual token-derived spend for this run in micro-USD; 0 when uninstrumented. */
  costUsdMicro?: number;
}

export const EMPTY_VALIDATION: ValidationReport = {
  passed: false,
  attempts: 1,
  results: [],
};

export function codingPullRequestBody(
  input: Pick<CodingWorkflowInput, "ticketKey">,
  rca: RootCauseAnalysis,
  manifest: PreviewManifest,
  validation: ValidationReport,
): string {
  return [
    `Ticket: ${input.ticketKey}`,
    `Source SHA: ${manifest.sourceSha}`,
    `Patch hash: ${manifest.patchHash}`,
    "",
    "RCA evidence",
    ...rca.evidence.map((item) => `- ${item.path}:${item.startLine}-${item.endLine}`),
    "",
    "Validation",
    ...validation.results.map((item) => `- ${item.validator} ${item.path}: ${item.message}`),
  ].join("\n");
}

export class CodingWorkflow {
  readonly steps: NamedStep[] = [
    { id: "load-context" },
    { id: "investigate" },
    { id: "strict-rca" },
    { id: "plan-surgical-patch" },
    { id: "preflight" },
    { id: "patch" },
    { id: "validate" },
    { id: "draft-pr" },
    { id: "evidence-close" },
  ];

  constructor(
    private readonly reader: GitHubSourceReader,
    private readonly writer: GitHubWriter,
    private readonly validators: ValidatorRegistry,
    private readonly model: CodingModel,
    private readonly store: CodingRunStore,
    private readonly confidenceFloor: number,
  ) {}

  async run(input: CodingWorkflowInput): Promise<CodingWorkflowResult> {
    this.reader.assertRepository(input.owner, input.repo, input.baseBranch);
    const context: InvestigationContext = { input, source: this.reader };
    const rca = RootCauseAnalysisSchema.parse(await this.model.investigate(context));
    if (rca.evidence.length === 0 || rca.confidence < this.confidenceFloor) {
      return this.escalate(input, rca, EMPTY_VALIDATION, "insufficient_evidence", "RCA evidence or confidence is below policy");
    }
    if (!rca.fixable) {
      return this.escalate(input, rca, EMPTY_VALIDATION, "unfixable", "Diagnosis is evidence-backed but has no safe repository fix");
    }

    const plannedPatch = PatchPlanSchema.safeParse(await this.model.planPatch(context, rca));
    if (!plannedPatch.success) {
      return this.escalate(
        input,
        rca,
        EMPTY_VALIDATION,
        "path_denied",
        "The proposed patch did not satisfy the safe patch contract",
      );
    }
    let patch = plannedPatch.data;
    let manifest: PreviewManifest;
    try {
      manifest = PreviewManifestSchema.parse(this.writer.preflight(
        input.owner,
        input.repo,
        input.baseBranch,
        input.branch,
        input.sourceSha,
        patch.files,
        rca.evidence,
        input.approvedDestructivePaths,
      ));
    } catch (error) {
      if (error instanceof RepositoryPolicyError) {
        const reason = error.code === "approval_required" ? "approval_required" : "path_denied";
        return this.escalate(input, rca, EMPTY_VALIDATION, reason, error.message);
      }
      throw error;
    }

    if (await this.reader.sourceSha(input.owner, input.repo, input.baseBranch) !== input.sourceSha) {
      return this.escalate(input, rca, EMPTY_VALIDATION, "stale_source", "Base branch changed after investigation");
    }

    const harness: CodingHarnessSignals = {
      validationAttempts: 1,
      repairApplied: false,
      criticBlocked: false,
      doomLoopStops: false,
      checksRun: 0,
    };

    let validation = this.validators.validate(patch);
    if (!validation.passed) {
      const failedHash = computePatchHash(patch.files);
      const repairedPatch = PatchPlanSchema.safeParse(
        await this.model.repairPatch(context, patch, validation),
      );
      if (!repairedPatch.success) {
        return this.escalate(
          input,
          rca,
          validation,
          "path_denied",
          "The repaired patch did not satisfy the safe patch contract",
          manifest,
          undefined,
          harness,
        );
      }
      // A3: a repair that reproduces the identical failed patch is a doom loop,
      // not a second attempt. Stop before spending the repair budget.
      if (computePatchHash(repairedPatch.data.files) === failedHash) {
        harness.doomLoopStops = true;
        return this.escalate(
          input,
          rca,
          validation,
          "doom_loop",
          "The repair reproduced an identical failed patch; stopping before a second attempt",
          manifest,
          undefined,
          harness,
        );
      }
      patch = repairedPatch.data;
      harness.repairApplied = true;
      harness.validationAttempts = 2;
      try {
        manifest = PreviewManifestSchema.parse(this.writer.preflight(
          input.owner,
          input.repo,
          input.baseBranch,
          input.branch,
          input.sourceSha,
          patch.files,
          rca.evidence,
          input.approvedDestructivePaths,
        ));
      } catch (error) {
        if (error instanceof RepositoryPolicyError) {
          const reason = error.code === "approval_required" ? "approval_required" : "path_denied";
          return this.escalate(input, rca, validation, reason, error.message, undefined, undefined, harness);
        }
        throw error;
      }
      validation = this.validators.validate(patch, 2);
      if (!validation.passed) {
        return this.escalate(
          input,
          rca,
          validation,
          "validation_failed_after_repair",
          "Allowlisted validation failed after the single repair attempt",
          manifest,
          undefined,
          harness,
        );
      }
    }

    // A1: optional per-repo real-tooling checks, gated to pre-Draft-PR (only
    // after the structure floor passed). Skipped with a logged reason when the
    // repo does not afford them.
    const checkOutcome = await this.validators.runChecks(patch, `${input.owner}/${input.repo}`);
    if (checkOutcome.ran) {
      harness.checksRun = checkOutcome.results.length;
      const failures = checkOutcome.results.filter((result) => !result.passed);
      if (failures.length > 0) {
        validation = ValidationReportSchema.parse({
          ...validation,
          results: [...validation.results, ...failures],
          passed: false,
        });
        return this.escalate(
          input,
          rca,
          validation,
          "validation_failed_after_repair",
          `Per-repo checks failed: ${failures.map((result) => `${result.validator} ${result.path}`).join("; ")}`,
          manifest,
          undefined,
          harness,
        );
      }
    }

    let pr: PullRequestReceipt;
    try {
      pr = await this.writer.apply(
        manifest,
        patch.files,
        `[${input.ticketKey}] ${patch.summary}`,
        codingPullRequestBody(input, rca, manifest, validation),
      );
    } catch (error) {
      if (error instanceof StaleSourceError) {
        return this.escalate(input, rca, validation, "stale_source", error.message, manifest, undefined, harness);
      }
      throw error;
    }

    const ciStatus = await this.writer.checks(input.owner, input.repo, pr.commitSha);
    validation = ValidationReportSchema.parse({ ...validation, ciStatus });
    if (ciStatus === "failure") {
      return this.escalate(
        input,
        rca,
        validation,
        "ci_failed",
        "GitHub checks reported failure; Draft PR remains for review",
        manifest,
        pr,
        harness,
      );
    }
    const costUsdMicro = this.model.consumeUsage?.(input.runId) ?? 0;
    const record: CodingRunRecord = { input, rca, manifest, validation, pr, harness, costUsdMicro };
    await this.store.save(record);
    return {
      runId: input.runId,
      status: ciStatus === "pending" ? "awaiting_ci" : "draft_pr_opened",
      rca,
      validation,
      manifest,
      pr,
      costUsdMicro,
    };
  }

  private async escalate(
    input: CodingWorkflowInput,
    rca: RootCauseAnalysis,
    validation: ValidationReport,
    reason: Escalation["reason"],
    detail: string,
    manifest?: PreviewManifest,
    pr?: PullRequestReceipt,
    harness?: CodingHarnessSignals,
  ): Promise<CodingWorkflowResult> {
    const escalation = EscalationSchema.parse({
      reason,
      diagnosisOnly: true,
      detail,
    });
    const costUsdMicro = this.model.consumeUsage?.(input.runId) ?? 0;
    const record: CodingRunRecord = {
      input,
      rca,
      validation,
      ...(manifest === undefined ? {} : { manifest }),
      ...(pr === undefined ? {} : { pr }),
      ...(harness === undefined ? {} : { harness }),
      escalation,
      costUsdMicro,
    };
    await this.store.save(record);
    return {
      runId: input.runId,
      status: "escalated",
      rca,
      validation,
      ...(manifest === undefined ? {} : { manifest }),
      ...(pr === undefined ? {} : { pr }),
      escalation,
      costUsdMicro,
    };
  }
}
