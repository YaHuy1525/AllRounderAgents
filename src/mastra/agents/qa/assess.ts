import {
  QaVerdictSchema,
  type QaAnalysis,
  type QaCase,
  type QaCaseResult,
  type QaCaseStatus,
  type QaDefect,
  type QaDefectSetArtifact,
  type QaDefectSeverity,
  type QaEvidence,
  type QaExecutionArtifact,
  type QaGap,
  type QaRunCounts,
  type QaVerdict,
} from "./contracts.js";
import { coverageGaps } from "./coverage.js";

/**
 * The verdict, computed from what the executor observed: pure and model-free, so
 * the same artifact always yields the same verdict and a report can be re-derived
 * and argued with. A requirement is verified only by a case that passed, and only
 * `failed` becomes a defect — `blocked` and `not_run` must not file a ticket.
 */

/** Evidence references are capped so a ticket body stays readable. */
const MAX_EVIDENCE_REFS = 8;

/** One defect per case per story, and this is the key that enforces it. */
export function correlationIdOf(storyKey: string, caseId: string): string {
  return `${storyKey}:${caseId}`;
}

function emptyEvidence(): QaEvidence {
  return { console: [], network: [], transcript: [] };
}

/**
 * One result per approved case, in case-set order. A case the executor never
 * reported is `not_run` when execution was available and `blocked` when it was
 * not, so a short result list can never read as a clean pass.
 */
export function orderedResults(
  execution: Pick<QaExecutionArtifact, "available" | "blockedReason" | "results">,
  cases: readonly QaCase[],
): QaCaseResult[] {
  const byCase = new Map(execution.results.map((result) => [result.caseId, result]));
  return cases.map((item) => {
    const found = byCase.get(item.id);
    if (found !== undefined) return found;
    return {
      caseId: item.id,
      status: execution.available ? "not_run" : "blocked",
      observed:
        execution.available
          ? "the executor returned no result for this case"
          : (execution.blockedReason ?? "execution was unavailable"),
      evidence: emptyEvidence(),
      durationMs: 0,
    } satisfies QaCaseResult;
  });
}

/**
 * Requirements that are still not verified after execution. A requirement no
 * case asserts keeps the design-time reason; a requirement whose cases all
 * failed or were blocked is reported with what each case said, because "we
 * never saw it work" is the answer the reader needs.
 */
function verifiedGaps(
  analysis: QaAnalysis,
  cases: readonly QaCase[],
  results: readonly QaCaseResult[],
): QaGap[] {
  const unasserted = new Map(
    coverageGaps(analysis, cases).map((gap) => [gap.requirementId, gap]),
  );
  const statusById = new Map(results.map((result) => [result.caseId, result.status]));
  const passed = new Set(
    results.filter((result) => result.status === "passed").map((result) => result.caseId),
  );
  const gaps: QaGap[] = [];
  for (const requirement of analysis.requirements) {
    const unassertedGap = unasserted.get(requirement.id);
    if (unassertedGap !== undefined) {
      gaps.push(unassertedGap);
      continue;
    }
    const asserting = cases.filter((item) => item.requirementIds.includes(requirement.id));
    if (asserting.some((item) => passed.has(item.id))) continue;
    const reported = asserting
      .map((item) => `${item.id} ${statusById.get(item.id) ?? "not_run"}`)
      .join(", ");
    gaps.push({
      requirementId: requirement.id,
      reason: `no case covering this requirement passed: ${reported}`,
    });
  }
  return gaps;
}

/**
 * Severity by blast radius, not by wording: a failure is `high` when no other
 * passing case covers any requirement it asserts, because that requirement is
 * now unverified; otherwise `medium`, since the failure is a regression in a
 * behaviour something else still proves.
 */
function severityOf(
  item: QaCase,
  cases: readonly QaCase[],
  passed: ReadonlySet<string>,
): QaDefectSeverity {
  const covered = new Set<string>();
  for (const other of cases) {
    if (other.id === item.id || !passed.has(other.id)) continue;
    for (const requirementId of other.requirementIds) covered.add(requirementId);
  }
  return item.requirementIds.some((requirementId) => covered.has(requirementId))
    ? "medium"
    : "high";
}

/** Stable references into the evidence a result carries. */
function evidenceRefsOf(runId: string, result: QaCaseResult): string[] {
  const prefix = `qa:${runId}:${result.caseId}`;
  const refs: string[] = [];
  if (result.evidence.screenshot !== undefined) refs.push(`${prefix}:screenshot`);
  for (let index = 0; index < result.evidence.console.length; index += 1) {
    refs.push(`${prefix}:console:${index + 1}`);
  }
  for (let index = 0; index < result.evidence.network.length; index += 1) {
    const entry = result.evidence.network[index];
    refs.push(`${prefix}:network:${index + 1}:${entry?.status ?? 0}`);
  }
  for (let index = 0; index < result.evidence.transcript.length; index += 1) {
    refs.push(`${prefix}:transcript:${index + 1}`);
  }
  // A failed case with no captured evidence still cites its observation: the
  // observed text is evidence, a rumour is not.
  if (refs.length === 0) refs.push(`${prefix}:observed`);
  return refs.slice(0, MAX_EVIDENCE_REFS);
}

function defectBody(input: {
  readonly runId: string;
  readonly storyKey: string;
  readonly targetKey: string;
  readonly item: QaCase;
  readonly result: QaCaseResult;
  readonly refs: readonly string[];
}): string {
  const observed = input.result.observed.trim();
  return [
    `Case ${input.item.id} failed against ${input.targetKey} for story ${input.storyKey} (run ${input.runId}).`,
    "",
    `Expected: ${input.item.expected}`,
    `Observed: ${observed === "" ? "(no observation recorded)" : observed}`,
    "",
    `Requirements: ${input.item.requirementIds.join(", ")}`,
    ...(input.item.preconditions.length === 0
      ? []
      : [`Preconditions: ${input.item.preconditions.join("; ")}`]),
    "",
    "Evidence:",
    ...input.refs.map((ref) => `- ${ref}`),
  ]
    .join("\n")
    .slice(0, 4_000);
}

/** One defect per failed case. */
export function defectsFrom(input: {
  readonly runId: string;
  readonly storyKey: string;
  readonly targetKey: string;
  readonly cases: readonly QaCase[];
  readonly results: readonly QaCaseResult[];
}): QaDefect[] {
  const passed = new Set(
    input.results.filter((result) => result.status === "passed").map((result) => result.caseId),
  );
  const byCase = new Map(input.cases.map((item) => [item.id, item]));
  const defects: QaDefect[] = [];
  for (const result of input.results) {
    if (result.status !== "failed") continue;
    const item = byCase.get(result.caseId);
    if (item === undefined) continue;
    const refs = evidenceRefsOf(input.runId, result);
    defects.push({
      caseId: item.id,
      title: `[QA] ${item.id}: ${item.title}`.slice(0, 200),
      body: defectBody({
        runId: input.runId,
        storyKey: input.storyKey,
        targetKey: input.targetKey,
        item,
        result,
        refs,
      }),
      severity: severityOf(item, input.cases, passed),
      evidenceRefs: refs,
      correlationId: correlationIdOf(input.storyKey, item.id),
    });
  }
  return defects;
}

export interface QaAssessInput {
  readonly storyKey: string;
  readonly targetKey: string;
  readonly analysis: QaAnalysis;
  readonly cases: readonly QaCase[];
  readonly execution: QaExecutionArtifact;
}

/** `assessQa()`: the verdict for one executed run. */
export function assessQa(input: QaAssessInput): QaVerdict {
  const results = orderedResults(input.execution, input.cases);
  const gaps = verifiedGaps(input.analysis, input.cases, results);
  const defects = input.execution.available
    ? defectsFrom({
        runId: input.execution.runId,
        storyKey: input.storyKey,
        targetKey: input.targetKey,
        cases: input.cases,
        results,
      })
    : [];
  return QaVerdictSchema.parse({
    runId: input.execution.runId,
    executionAvailable: input.execution.available,
    ...(input.execution.blockedReason === undefined
      ? {}
      : { blockedReason: input.execution.blockedReason }),
    results,
    gaps,
    defects,
  });
}

/**
 * The findings a human approved for filing, in the order they approved them.
 * Ids are case ids because a defect is keyed by its case, and an id that names
 * no finding is refused here rather than posted as an empty ticket.
 */
export function selectDefects(artifact: QaDefectSetArtifact): QaDefect[] {
  const byCase = new Map(artifact.defects.map((defect) => [defect.caseId, defect]));
  const unknown = artifact.approvedDefectIds.filter((caseId) => !byCase.has(caseId));
  if (unknown.length > 0) {
    throw new Error(
      "QA flow: cannot file findings for cases that reported none: " + unknown.join(", "),
    );
  }
  return artifact.approvedDefectIds.map((caseId) => byCase.get(caseId) as QaDefect);
}

/** Totals for the close step. */
export function countResults(
  results: readonly QaCaseResult[],
  defectCount: number,
  filedCount: number,
): QaRunCounts {
  const countOf = (status: QaCaseStatus): number =>
    results.filter((result) => result.status === status).length;
  return {
    cases: results.length,
    passed: countOf("passed"),
    failed: countOf("failed"),
    blocked: countOf("blocked"),
    notRun: countOf("not_run"),
    defects: defectCount,
    filed: filedCount,
  };
}
