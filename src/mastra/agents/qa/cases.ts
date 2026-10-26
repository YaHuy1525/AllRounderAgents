import { createHash } from "node:crypto";

import { QaCaseSchema, type QaCase } from "./contracts.js";

/**
 * The approved case set for one story, as the store keeps it. `caseSetHash`
 * addresses the exact set, so re-approving the same cases is the same record
 * and an edited set is a new one. Q3's defect filing keys on
 * `(storyKey, caseId)`, not on this hash, so a re-run comments rather than
 * filing a twin.
 */
export interface QaCaseRecord {
  readonly storyKey: string;
  readonly caseSetHash: string;
  readonly approvedCaseIds: readonly string[];
  readonly cases: readonly QaCase[];
  /** Stamped by the store, so a flow replay never moves the timestamp. */
  readonly approvedAt: string;
}

/** What a caller supplies; the store owns `approvedAt`. */
export type QaCaseSave = Omit<QaCaseRecord, "approvedAt">;

/**
 * Where approved case sets live. A seam, not an implementation detail: tests
 * use the memory store, and a file-backed store writing under `QA_CASE_DIR`
 * arrives with the eval suite.
 */
export interface QaCaseStore {
  save(input: QaCaseSave): Promise<QaCaseRecord>;
  load(storyKey: string, caseSetHash: string): Promise<QaCaseRecord | undefined>;
  list(storyKey: string): Promise<QaCaseRecord[]>;
}

function recordKey(storyKey: string, caseSetHash: string): string {
  return `${storyKey}:${caseSetHash}`;
}

/**
 * The in-process store: one record per `(storyKey, caseSetHash)`. The first
 * write wins, so a re-driven approval of an unchanged set returns the record
 * it already had — the approval time is a fact about the decision, not about
 * how many times the flow happened to walk over it.
 */
export class MemoryQaCaseStore implements QaCaseStore {
  private readonly records = new Map<string, QaCaseRecord>();

  async save(input: QaCaseSave): Promise<QaCaseRecord> {
    const key = recordKey(input.storyKey, input.caseSetHash);
    const existing = this.records.get(key);
    if (existing !== undefined) return existing;
    const record: QaCaseRecord = { ...input, approvedAt: new Date().toISOString() };
    this.records.set(key, record);
    return record;
  }

  async load(storyKey: string, caseSetHash: string): Promise<QaCaseRecord | undefined> {
    return this.records.get(recordKey(storyKey, caseSetHash));
  }

  async list(storyKey: string): Promise<QaCaseRecord[]> {
    return [...this.records.values()].filter((record) => record.storyKey === storyKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Order-independent JSON so identical case sets always hash alike. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

/**
 * Hash of a case set, insensitive to the order the model emitted. Two runs
 * that produce the same cases get the same key even if the list is shuffled,
 * which is what makes "the set did not change" a fact rather than a guess.
 */
export function caseSetHash(cases: readonly QaCase[]): string {
  const ordered = [...cases]
    .map((item) => stableValue(item))
    .sort((left, right) => {
      const leftId = isRecord(left) ? String(left.id) : "";
      const rightId = isRecord(right) ? String(right.id) : "";
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/**
 * Structural problems with a case set: ids that repeat. Coverage of the
 * requirements is a different question and lives in `coverage.ts`. A repeated
 * id makes the defect correlation id ambiguous, so it fails the step rather
 * than reaching the approval gate.
 */
export function caseSetProblems(cases: readonly QaCase[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const item of cases) {
    if (seen.has(item.id)) {
      problems.push(`case id ${item.id} appears more than once`);
      continue;
    }
    seen.add(item.id);
  }
  return problems;
}

/**
 * The versioned case-file form: one JSON object per line, so a diff shows one
 * changed case instead of a rewritten blob. Blank lines and `#` comments are
 * tolerated on read, which keeps hand-written suites usable.
 */
export function encodeCases(cases: readonly QaCase[]): string {
  if (cases.length === 0) return "";
  return `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

export function decodeCases(text: string): QaCase[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`case file line ${index + 1}: not JSON (${detail})`);
    }
    const result = QaCaseSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`case file line ${index + 1}: contract violation: ${detail}`);
    }
    return result.data;
  });
}
