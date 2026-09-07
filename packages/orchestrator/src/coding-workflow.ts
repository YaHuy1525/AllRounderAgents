import {
  EscalationSchema,
  PatchPlanSchema,
  PreviewManifestSchema,
  RootCauseAnalysisSchema,
  ValidationReportSchema,
  type Escalation,
  type PatchPlan,
  type PreviewManifest,
  type PullRequestReceipt,
  type RootCauseAnalysis,
  type ValidationReport,
} from "./coding-contracts.js";
import {
  GitHubSourceReader,
  GitHubWriter,
  RepositoryPolicyError,
  StaleSourceError,
} from "./github.js";
import type { ValidatorRegistry } from "./validators.js";

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
  investigate(context: InvestigationContext): Promise<RootCauseAnalysis>;
  planPatch(context: InvestigationContext, rca: RootCauseAnalysis): Promise<PatchPlan>;
  repairPatch(context: InvestigationContext, patch: PatchPlan, report: ValidationReport): Promise<PatchPlan>;
}

export interface CodingRunRecord {
  input: CodingWorkflowInput;
  rca: RootCauseAnalysis;
  manifest?: PreviewManifest;
  validation: ValidationReport;
  pr?: PullRequestReceipt;
  escalation?: Escalation;
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
}

const EMPTY_VALIDATION: ValidationReport = {
  passed: false,
  attempts: 1,
  results: [],
};

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

    let validation = this.validators.validate(patch);
    if (!validation.passed) {
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
        );
      }
      patch = repairedPatch.data;
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
          return this.escalate(input, rca, validation, reason, error.message);
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
        );
      }
    }

    let pr: PullRequestReceipt;
    try {
      pr = await this.writer.apply(
        manifest,
        patch.files,
        `[${input.ticketKey}] ${patch.summary}`,
        this.pullRequestBody(input, rca, manifest, validation),
      );
    } catch (error) {
      if (error instanceof StaleSourceError) {
        return this.escalate(input, rca, validation, "stale_source", error.message, manifest);
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
      );
    }
    const record: CodingRunRecord = { input, rca, manifest, validation, pr };
    await this.store.save(record);
    return {
      runId: input.runId,
      status: ciStatus === "pending" ? "awaiting_ci" : "draft_pr_opened",
      rca,
      validation,
      manifest,
      pr,
    };
  }

  private pullRequestBody(
    input: CodingWorkflowInput,
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

  private async escalate(
    input: CodingWorkflowInput,
    rca: RootCauseAnalysis,
    validation: ValidationReport,
    reason: Escalation["reason"],
    detail: string,
    manifest?: PreviewManifest,
    pr?: PullRequestReceipt,
  ): Promise<CodingWorkflowResult> {
    const escalation = EscalationSchema.parse({
      reason,
      diagnosisOnly: true,
      detail,
    });
    const record: CodingRunRecord = {
      input,
      rca,
      validation,
      ...(manifest === undefined ? {} : { manifest }),
      ...(pr === undefined ? {} : { pr }),
      escalation,
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
    };
  }
}
