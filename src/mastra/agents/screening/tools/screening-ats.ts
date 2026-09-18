import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { fixtureFile } from "../../../shared/fixtures.js";

/**
 * Applicant-tracking seam for the screening lane. Fixture-backed on purpose:
 * the plan's ATS seam (`ScreeningAts`) is the interface, and the in-memory
 * implementation reads `fixtures/hr_candidates.json` so the lane makes no
 * network calls. A later MCP-first integration only swaps this
 * implementation. `schedule` is idempotent by `(requisitionId, candidateId)`:
 * re-scheduling a candidate returns the stored invite with `created: false`,
 * and seeded `failures` make a candidate fail deterministically so the lane's
 * "failures are listed, never swallowed" path can be exercised.
 */

export const EVIDENCE_STRENGTHS = ["strong", "weak"] as const;

export const EvidenceStrengthSchema = z.enum(EVIDENCE_STRENGTHS);

export type EvidenceStrength = z.infer<typeof EvidenceStrengthSchema>;

export const CriterionFileSchema = z
  .object({
    id: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    weight: z.number().int().min(0).max(100),
    mustHave: z.boolean(),
    detail: z.string().min(1).max(500),
  })
  .strict();

export const RequisitionFileSchema = z
  .object({
    requisitionId: z.string().min(2).max(40),
    roleTitle: z.string().min(2).max(200),
    department: z.string().min(2).max(120),
    location: z.string().min(2).max(120),
    seniority: z.string().min(2).max(60),
    interviewers: z.array(z.string().min(2).max(40)).min(1).max(10),
    criteria: z.array(CriterionFileSchema).min(1).max(12),
  })
  .strict();

export const CandidateEvidenceFileSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    span: z.string().min(1).max(40),
    criterionId: z.string().min(1).max(60),
    strength: EvidenceStrengthSchema,
    text: z.string().min(1).max(500),
  })
  .strict();

export const CandidateFileSchema = z
  .object({
    candidateId: z.string().min(1).max(40),
    fullName: z.string().min(2).max(200),
    requisitionId: z.string().min(2).max(40),
    headline: z.string().min(1).max(200),
    evidence: z.array(CandidateEvidenceFileSchema).min(1).max(30),
    notes: z.array(z.string().min(1).max(500)).max(10),
  })
  .strict();

export const CandidatesFileSchema = z
  .object({
    requisitions: z.array(RequisitionFileSchema).min(1).max(50),
    candidates: z.array(CandidateFileSchema).min(1).max(200),
  })
  .strict();

export type CandidatesFile = z.infer<typeof CandidatesFileSchema>;
export type RequisitionRecord = z.infer<typeof RequisitionFileSchema>;
export type CandidateRecord = z.infer<typeof CandidateFileSchema>;
export type CandidateEvidence = z.infer<typeof CandidateEvidenceFileSchema>;

/** Fixture path lookup: repo-root `fixtures/` first, source-tree fallback. */
function resolveFixturePath(name: string): string {
  const direct = resolve(process.cwd(), "fixtures", name);
  if (existsSync(direct)) return direct;
  return fixtureFile(name);
}

export function loadCandidatesFile(): CandidatesFile {
  return CandidatesFileSchema.parse(
    JSON.parse(readFileSync(resolveFixturePath("hr_candidates.json"), "utf8")),
  );
}

export interface ScheduledInvite {
  readonly requisitionId: string;
  readonly candidateId: string;
  readonly slot: string;
  readonly interviewer: string;
  readonly status: "scheduled";
  readonly scheduledAt: string;
}

export interface ScheduleResult {
  readonly invite: ScheduledInvite;
  /** false when the candidate already had an invite (idempotent replay). */
  readonly created: boolean;
}

export interface ScreeningAts {
  requisition(requisitionId: string): Promise<RequisitionRecord | null>;
  candidates(requisitionId: string): Promise<readonly CandidateRecord[]>;
  /** Candidates already invited for the requisition, sorted. */
  scheduledInvites(requisitionId: string): Promise<readonly { candidateId: string; slot: string }[]>;
  /**
   * Idempotent by `(requisitionId, candidateId)`. A seeded failure throws the
   * configured reason before anything is written.
   */
  schedule(request: {
    requisitionId: string;
    candidateId: string;
    slot: string;
    interviewer: string;
    scheduledAt: string;
  }): Promise<ScheduleResult>;
}

export class MemoryScreeningAts implements ScreeningAts {
  private readonly requisitions = new Map<string, RequisitionRecord>();
  private readonly candidateList: CandidateRecord[];
  private readonly invites = new Map<string, Map<string, ScheduledInvite>>();
  private readonly failures: ReadonlyMap<string, string>;

  constructor(
    input: {
      file?: CandidatesFile;
      failures?: ReadonlyMap<string, string> | Record<string, string>;
    } = {},
  ) {
    const file = input.file ?? loadCandidatesFile();
    for (const requisition of file.requisitions) {
      this.requisitions.set(requisition.requisitionId, requisition);
    }
    this.candidateList = [...file.candidates];
    const failures = input.failures ?? {};
    this.failures = failures instanceof Map ? failures : new Map(Object.entries(failures));
  }

  async requisition(requisitionId: string): Promise<RequisitionRecord | null> {
    return this.requisitions.get(requisitionId) ?? null;
  }

  async candidates(requisitionId: string): Promise<readonly CandidateRecord[]> {
    return this.candidateList.filter((candidate) => candidate.requisitionId === requisitionId);
  }

  async scheduledInvites(
    requisitionId: string,
  ): Promise<readonly { candidateId: string; slot: string }[]> {
    return [...(this.invites.get(requisitionId)?.values() ?? [])]
      .map((invite) => ({ candidateId: invite.candidateId, slot: invite.slot }))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  }

  async schedule(request: {
    requisitionId: string;
    candidateId: string;
    slot: string;
    interviewer: string;
    scheduledAt: string;
  }): Promise<ScheduleResult> {
    const reason = this.failures.get(request.candidateId);
    if (reason !== undefined) {
      throw new Error(reason);
    }
    const byCandidate =
      this.invites.get(request.requisitionId) ?? new Map<string, ScheduledInvite>();
    const existing = byCandidate.get(request.candidateId);
    if (existing !== undefined) {
      return { invite: existing, created: false };
    }
    const invite: ScheduledInvite = {
      requisitionId: request.requisitionId,
      candidateId: request.candidateId,
      slot: request.slot,
      interviewer: request.interviewer,
      status: "scheduled",
      scheduledAt: request.scheduledAt,
    };
    byCandidate.set(request.candidateId, invite);
    this.invites.set(request.requisitionId, byCandidate);
    return { invite, created: true };
  }
}
