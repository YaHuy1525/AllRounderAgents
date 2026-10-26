import type {
  FeatureCompletionArtifact,
  FeatureImplementationArtifact,
  FeatureSelectionArtifact,
} from "../../agents/features/contracts.ts";

/**
 * Snapshot of a recorded features-lane run, in the exact shape the coding-quality
 * judge and deterministic gates consume. This is the single per-lane data mapping
 * that replaces the hand-written Python state builder
 * (`allrounder_api.judging.coding_output_from_artifacts` + `coding_state`).
 *
 * A task-target experiment hands this object to every scorer as `run.output`, so
 * no live lane and no model are needed to grade a pre-recorded candidate.
 */

/** A step-keyed map of recorded artifacts, mirroring `FeaturesRunState.artifacts`. */
export type FeaturesArtifacts = {
  "feature-selection"?: FeatureSelectionArtifact;
  "scope-design"?: Record<string, unknown>;
  implementation?: FeatureImplementationArtifact;
  complete?: FeatureCompletionArtifact;
  [step: string]: unknown;
};

/** The ticket the run was driven from (the case `input`). */
export interface CodingTicket {
  ticketKey?: string;
  ticketSummary?: string;
  summary?: string;
  acceptanceCriteria?: string[];
}

/** One normalized acceptance-criterion checklist row from `feature-selection`. */
export interface AcceptanceCriterionRow {
  id: string;
  text: string;
  included: boolean;
}

/** One normalized per-criterion coverage row from `implementation`. */
export interface CoverageRow {
  id: string;
  text: string;
  covered: boolean;
  evidence: string | null;
}

/** One normalized changed-file row (raw, as recorded on the artifact). */
export interface RawFileRow {
  path: string;
  status: string;
  area: string;
  additions: number | null;
  deletions: number | null;
  changeDescription: string;
  criteriaIds: string[];
  diff: string;
  included: boolean;
}

/** Normalized view of the implementation artifact (ported from `coding_output_from_artifacts`). */
export interface CodingOutput {
  verdict: string;
  confidence: number | null;
  summary: string;
  strengths: string[];
  risksOpenQuestions: string[];
  files: RawFileRow[];
  criteriaCoverage: CoverageRow[];
  validation: { passed?: boolean; attempts?: number | null; ciStatus?: unknown };
  acceptanceCriteria: AcceptanceCriterionRow[];
  criteriaTotal: number | null;
  criteriaCovered: number | null;
}

/** The judge's view of the run (ported from `coding_state`). */
export interface CodingState {
  ticket: { ticketKey: string; summary: string };
  selfReport: {
    verdict: string;
    confidence: number | null;
    summary: string;
    strengths: string[];
    risksOpenQuestions: string[];
  };
  criteria: Array<{
    id: string;
    text: string;
    included?: boolean;
    covered: boolean | null;
    evidence: string | null;
  }>;
  files: Array<{
    path: string;
    status: string;
    area: string;
    additions: number | null;
    deletions: number | null;
    changeDescription: string;
    criteriaIds: string[];
    diffExcerpt: string;
  }>;
  validation: { passed: boolean | null; attempts: number | null; ciStatus: unknown };
}

/** The complete snapshot object a scorer receives as `run.output`. */
export interface CodingSnapshot {
  output: CodingOutput;
  state: CodingState;
}

const DIFF_EXCERPT_CHARS = 1_200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dictRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => str(item)) : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function diffExcerpt(value: unknown): string {
  const text = str(value);
  return text.length <= DIFF_EXCERPT_CHARS ? text : `${text.slice(0, DIFF_EXCERPT_CHARS)}\n...[truncated]`;
}

/**
 * Normalize the features-lane artifacts the judge and gates read. A missing
 * `implementation` step degrades to an empty output so a partially-recorded run
 * still scores whatever it produced (mirrors the Python behaviour).
 */
export function codingOutputFromArtifacts(artifacts: FeaturesArtifacts | undefined): CodingOutput {
  const source = artifacts ?? {};
  const implementation = asRecord(source.implementation);
  if (implementation === null) {
    return {
      verdict: "",
      confidence: null,
      summary: "",
      strengths: [],
      risksOpenQuestions: [],
      files: [],
      criteriaCoverage: [],
      validation: {},
      acceptanceCriteria: [],
      criteriaTotal: null,
      criteriaCovered: null,
    };
  }
  const selection = asRecord(source["feature-selection"]) ?? {};
  const completion = asRecord(source.complete) ?? {};
  const validation = asRecord(implementation.validation) ?? {};

  const files: RawFileRow[] = dictRows(implementation.files).map((file) => ({
    path: str(file.path),
    status: str(file.status),
    area: str(file.area),
    additions: numberOrNull(file.additions),
    deletions: numberOrNull(file.deletions),
    changeDescription: str(file.changeDescription),
    criteriaIds: Array.isArray(file.criteriaIds) ? file.criteriaIds.map((id) => str(id)) : [],
    diff: str(file.diff),
    included: file.included !== false,
  }));

  const criteriaCoverage: CoverageRow[] = dictRows(implementation.criteriaCoverage).map((row) => ({
    id: str(row.id),
    text: str(row.text),
    covered: row.covered === true,
    evidence: row.evidence === null || row.evidence === undefined ? null : str(row.evidence),
  }));

  const acceptanceCriteria: AcceptanceCriterionRow[] = dictRows(selection.acceptanceCriteria).map((row) => ({
    id: str(row.id),
    text: str(row.text),
    included: row.included === true,
  }));

  return {
    verdict: str(implementation.verdict),
    confidence: numberOrNull(implementation.confidence),
    summary: str(implementation.summary),
    strengths: strList(implementation.strengths),
    risksOpenQuestions: strList(implementation.risksOpenQuestions),
    files,
    criteriaCoverage,
    validation,
    acceptanceCriteria,
    criteriaTotal: numberOrNull(completion.criteriaTotal),
    criteriaCovered: numberOrNull(completion.criteriaCovered),
  };
}

/**
 * Assemble the judge's view of a coding run: the diff, the criteria, and the
 * engineer's own claims about it. Calibration reads the gap between `selfReport`
 * and what `files`/`criteria` actually show, so an inflated self-report on a thin
 * patch is scored rather than trusted.
 */
export function codingState(ticket: CodingTicket, output: CodingOutput): CodingState {
  const criteria: CodingState["criteria"] = output.criteriaCoverage.map((row) => ({
    id: row.id,
    text: row.text,
    covered: row.covered,
    evidence: row.evidence,
  }));
  const coveredIds = new Set(criteria.map((item) => item.id));
  for (const item of output.acceptanceCriteria) {
    if (coveredIds.has(item.id)) continue;
    criteria.push({
      id: item.id,
      text: item.text,
      included: item.included,
      covered: false,
      evidence: null,
    });
  }
  const files = output.files.map((item) => ({
    path: item.path,
    status: item.status,
    area: item.area,
    additions: item.additions,
    deletions: item.deletions,
    changeDescription: item.changeDescription,
    criteriaIds: item.criteriaIds,
    diffExcerpt: diffExcerpt(item.diff),
  }));
  return {
    ticket: {
      ticketKey: str(ticket.ticketKey),
      summary: str(ticket.ticketSummary ?? ticket.summary ?? ""),
    },
    selfReport: {
      verdict: output.verdict,
      confidence: output.confidence,
      summary: output.summary,
      strengths: [...output.strengths],
      risksOpenQuestions: [...output.risksOpenQuestions],
    },
    criteria,
    files,
    validation: {
      passed: output.validation.passed ?? null,
      attempts: numberOrNull(output.validation.attempts),
      ciStatus: output.validation.ciStatus ?? null,
    },
  };
}

/** Build the full snapshot a scorer grades. */
export function codingSnapshot(artifacts: FeaturesArtifacts | undefined, ticket: CodingTicket): CodingSnapshot {
  const output = codingOutputFromArtifacts(artifacts);
  return { output, state: codingState(ticket, output) };
}
