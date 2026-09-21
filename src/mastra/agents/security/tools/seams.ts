import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { fixtureFile } from "../../../shared/fixtures.js";
import {
  ClassificationSchema,
  ContainOutcomeSchema,
  type ContainOutcome,
  type DecideAction,
} from "../contracts.js";

/**
 * Tool seams for the security lane. Every seam is a protocol with a
 * fixture-backed in-memory implementation (the HR-lane `EmployeeDirectory`
 * pattern): the lane makes no network calls, and a later SIEM / CMDB / intel /
 * EDR adapter only swaps the implementation behind the same interface.
 *
 * The one exception in production is `CaseHistory`: the host may back it with
 * Mastra Memory over persistent storage (`tools/mastra-case-history.ts`,
 * plan §5.1) while tests and CI stay on the fixture implementation below.
 */

/* ----------------------------------------------------------------- telemetry */

export const TELEMETRY_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export const TelemetryEventSchema = z
  .object({
    eventId: z.string().min(1).max(120),
    alertId: z.string().min(1).max(200),
    at: z.string().datetime({ offset: true }),
    host: z.string().min(1).max(200),
    user: z.string().max(200).nullable(),
    source: z.string().min(1).max(60),
    action: z.string().min(1).max(300),
    detail: z.string().min(1).max(2_000),
    severity: z.enum(TELEMETRY_SEVERITIES),
  })
  .strict();

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export interface TelemetryQuery {
  readonly alertId: string;
  readonly host?: string | undefined;
  readonly user?: string | undefined;
}

/** Read-only SIEM/EDR history search. */
export interface SecurityTelemetry {
  search(query: TelemetryQuery): Promise<readonly TelemetryEvent[]>;
}

/* -------------------------------------------------------------------- assets */

export const ENVIRONMENTS = ["production", "corporate", "staging"] as const;

export const EnvironmentSchema = z.enum(ENVIRONMENTS);

export type Environment = z.infer<typeof EnvironmentSchema>;

export const AssetSchema = z
  .object({
    host: z.string().min(1).max(200),
    owner: z.string().min(1).max(200),
    criticality: z.enum(["low", "medium", "high", "critical"]),
    environment: EnvironmentSchema,
    services: z.array(z.string().min(1).max(120)).max(30),
  })
  .strict();

export type Asset = z.infer<typeof AssetSchema>;

/** Read-only CMDB subset: host facts the risk policy reads. */
export interface AssetDirectory {
  get(host: string): Promise<Asset | null>;
}

/* --------------------------------------------------------------------- ATT&CK */

export const AttackTechniqueSchema = z
  .object({
    techniqueId: z.string().regex(/^T\d{4}(\.\d{3})?$/),
    name: z.string().min(1).max(200),
    tactic: z.string().min(1).max(120),
    indicatorPatterns: z.array(z.string().min(1).max(120)).min(1).max(20),
  })
  .strict();

export type AttackTechnique = z.infer<typeof AttackTechniqueSchema>;

const AttackFileSchema = z
  .object({ techniques: z.array(AttackTechniqueSchema).min(1).max(200) })
  .strict();

let attackTechniquesCache: readonly AttackTechnique[] | null = null;

/** Local STIX subset: no seam needed, the bundle refreshes by fixture swap. */
export function loadAttackTechniques(): readonly AttackTechnique[] {
  if (attackTechniquesCache === null) {
    attackTechniquesCache = AttackFileSchema.parse(readFixtureJson("attack_techniques.json")).techniques;
  }
  return attackTechniquesCache;
}

/* --------------------------------------------------------------------- intel */

export const INTEL_VERDICTS = ["malicious", "suspicious", "benign"] as const;

export const IntelRecordSchema = z
  .object({
    indicator: z.string().min(1).max(300),
    verdict: z.enum(INTEL_VERDICTS),
    detail: z.string().min(1).max(1_000),
    source: z.string().min(1).max(200),
  })
  .strict();

export type IntelRecord = z.infer<typeof IntelRecordSchema>;

/** IOC resolution: the only seam with an external upgrade path (intel API). */
export interface ThreatIntel {
  resolve(indicator: string): Promise<IntelRecord | null>;
}

/* -------------------------------------------------------------- containment */

export interface ContainmentRequest {
  readonly containmentId: string;
  readonly alertId: string;
  readonly host: string | null;
  readonly action: DecideAction;
  readonly outcome: ContainOutcome;
  readonly requestedAt: string;
}

export interface ContainmentResult {
  readonly registryRef: string;
  /** false when the same containment id already executed (replay). */
  readonly executed: boolean;
}

/**
 * The single side-effecting seam: every terminal disposition is recorded here
 * idempotently by `containmentId` — an EDR isolation adapter replaces the
 * in-memory registry without changing the flow.
 */
export interface ContainmentRegistry {
  execute(request: ContainmentRequest): Promise<ContainmentResult>;
}

/* -------------------------------------------------------------- case history */

export const CaseHistoryRecordSchema = z
  .object({
    caseId: z.string().min(1).max(200),
    alertId: z.string().min(1).max(200),
    host: z.string().min(1).max(200),
    classification: ClassificationSchema,
    disposition: ContainOutcomeSchema,
    techniqueIds: z
      .array(z.string().regex(/^T\d{4}(\.\d{3})?$/))
      .max(12)
      .default([]),
    summary: z.string().min(1).max(2_000),
    closedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CaseHistoryRecord = z.infer<typeof CaseHistoryRecordSchema>;

export interface CaseRecallQuery {
  readonly host?: string | undefined;
  readonly text: string;
  readonly techniqueIds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

/** Past dispositions: exact lookup by alert id plus similar-case recall. */
export interface CaseHistory {
  lookup(alertId: string): Promise<CaseHistoryRecord | null>;
  recall(query: CaseRecallQuery): Promise<readonly CaseHistoryRecord[]>;
  /** Idempotent by caseId: re-recording the same case is a no-op. */
  remember(record: CaseHistoryRecord): Promise<void>;
}

/* ------------------------------------------------------------ fixture loading */

/** Fixture path lookup: repo-root `fixtures/security/` first, source fallback. */
function securityFixturePath(name: string): string {
  const direct = resolve(process.cwd(), "fixtures", "security", name);
  if (existsSync(direct)) return direct;
  return fixtureFile(`security/${name}`);
}

function readFixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(securityFixturePath(name), "utf8")) as unknown;
}

const AssetFileSchema = z.object({ assets: z.array(AssetSchema).min(1).max(200) }).strict();

const TelemetryFileSchema = z
  .object({
    alertId: z.string().min(1).max(200),
    events: z.array(TelemetryEventSchema).min(1).max(500),
  })
  .strict();

const IntelFileSchema = z.object({ records: z.array(IntelRecordSchema).min(1).max(200) }).strict();

const CaseHistoryFileSchema = z
  .object({ cases: z.array(CaseHistoryRecordSchema).min(1).max(200) })
  .strict();

export function loadAssetsFile(): readonly Asset[] {
  return AssetFileSchema.parse(readFixtureJson("assets.json")).assets;
}

export function loadIntelFile(): readonly IntelRecord[] {
  return IntelFileSchema.parse(readFixtureJson("intel.json")).records;
}

export function loadCaseHistoryFile(): readonly CaseHistoryRecord[] {
  return CaseHistoryFileSchema.parse(readFixtureJson("case_history.json")).cases;
}

/** All canned event sets under `fixtures/security/telemetry/*.json`, merged. */
export function loadTelemetryFiles(): readonly TelemetryEvent[] {
  const directory = securityFixturePath("telemetry");
  const events: TelemetryEvent[] = [];
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of names) {
    const file = TelemetryFileSchema.parse(
      JSON.parse(readFileSync(resolve(directory, name), "utf8")) as unknown,
    );
    events.push(...file.events);
  }
  return events;
}

/* ----------------------------------------------------- in-memory implementors */

/** Fixture-backed telemetry: the canned event set keyed by alert id. */
export class MemoryTelemetrySearch implements SecurityTelemetry {
  private readonly events: readonly TelemetryEvent[];

  constructor(seed?: readonly TelemetryEvent[]) {
    this.events = seed ?? loadTelemetryFiles();
  }

  async search(query: TelemetryQuery): Promise<readonly TelemetryEvent[]> {
    return this.events
      .filter((event) => event.alertId === query.alertId)
      .sort((left, right) => left.at.localeCompare(right.at) || left.eventId.localeCompare(right.eventId));
  }
}

export class MemoryAssetDirectory implements AssetDirectory {
  private readonly byHost = new Map<string, Asset>();

  constructor(seed?: readonly Asset[]) {
    for (const asset of seed ?? loadAssetsFile()) {
      this.byHost.set(asset.host.toLowerCase(), asset);
    }
  }

  async get(host: string): Promise<Asset | null> {
    return this.byHost.get(host.toLowerCase()) ?? null;
  }
}

export class MemoryThreatIntel implements ThreatIntel {
  private readonly byIndicator = new Map<string, IntelRecord>();

  constructor(seed?: readonly IntelRecord[]) {
    for (const record of seed ?? loadIntelFile()) {
      this.byIndicator.set(record.indicator.toLowerCase(), record);
    }
  }

  async resolve(indicator: string): Promise<IntelRecord | null> {
    return this.byIndicator.get(indicator.trim().toLowerCase()) ?? null;
  }
}

/** Idempotent by containment id: replay returns the original registry ref. */
export class MemoryContainmentRegistry implements ContainmentRegistry {
  private readonly executions = new Map<string, ContainmentResult>();

  async execute(request: ContainmentRequest): Promise<ContainmentResult> {
    const existing = this.executions.get(request.containmentId);
    if (existing !== undefined) return existing;
    const result: ContainmentResult = {
      registryRef: `containment-registry:${request.containmentId}`,
      executed: true,
    };
    this.executions.set(request.containmentId, result);
    return result;
  }
}

const RECALL_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "alert",
  "case",
]);

function recallTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !RECALL_STOPWORDS.has(token)),
  );
}

/** Recall score: host match 3, technique overlap 2 each, token overlap 1. */
export function caseRecallScore(
  record: CaseHistoryRecord,
  query: Pick<CaseRecallQuery, "host" | "text" | "techniqueIds">,
): number {
  const host = query.host?.toLowerCase();
  let score = 0;
  if (host !== undefined && record.host.toLowerCase() === host) score += 3;
  const techniques = new Set(query.techniqueIds ?? []);
  for (const technique of record.techniqueIds) {
    if (techniques.has(technique)) score += 2;
  }
  const tokens = recallTokens(query.text);
  const recordTokens = recallTokens(record.summary);
  for (const token of tokens) {
    if (recordTokens.has(token)) score += 1;
  }
  return score;
}

/**
 * Fixture-backed case history. Recall scores host match (3), technique
 * overlap (2 each) and summary-token overlap (1 each), then sorts by score,
 * recency, and case id so the eval pins stay stable.
 */
export class MemoryCaseHistory implements CaseHistory {
  private readonly byCaseId = new Map<string, CaseHistoryRecord>();
  private readonly byAlertId = new Map<string, CaseHistoryRecord>();

  constructor(seed?: readonly CaseHistoryRecord[]) {
    for (const record of seed ?? loadCaseHistoryFile()) {
      this.byCaseId.set(record.caseId, record);
      if (!this.byAlertId.has(record.alertId)) this.byAlertId.set(record.alertId, record);
    }
  }

  async lookup(alertId: string): Promise<CaseHistoryRecord | null> {
    return this.byAlertId.get(alertId) ?? null;
  }

  async recall(query: CaseRecallQuery): Promise<readonly CaseHistoryRecord[]> {
    const scored: Array<{ record: CaseHistoryRecord; score: number }> = [];
    for (const record of this.byCaseId.values()) {
      const score = caseRecallScore(record, query);
      if (score === 0) continue;
      scored.push({ record, score });
    }
    scored.sort(
      (left, right) =>
        right.score - left.score ||
        right.record.closedAt.localeCompare(left.record.closedAt) ||
        left.record.caseId.localeCompare(right.record.caseId),
    );
    return scored.slice(0, query.limit ?? 3).map((entry) => entry.record);
  }

  async remember(record: CaseHistoryRecord): Promise<void> {
    if (this.byCaseId.has(record.caseId)) return;
    this.byCaseId.set(record.caseId, record);
    if (!this.byAlertId.has(record.alertId)) this.byAlertId.set(record.alertId, record);
  }
}
