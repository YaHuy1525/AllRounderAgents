import { api } from "./api";

/**
 * Browser-side model for the Knowledge page (upgrade U5). The API owns the
 * corpus and retrieval; this module mirrors its response shapes, validates
 * them defensively (mirroring `parseSearchResponse`), derives the
 * presentation facts the page needs — latest version per source, stale
 * "since" dates, superseded and missing reference flags — and keeps upload
 * drafts in one validated shape. It never executes anything: the only write
 * is the admin-gated document upload, which reuses the store's ingest path.
 */

export type KbDomain = {
  domain: string;
  documents: number;
  stale: number;
  canonical: number;
  updatedAt: string | null;
};

export type KbDocument = {
  sourceId: string;
  title: string;
  sourceVersion: string;
  sourceUri: string;
  stale: boolean;
  staleAfter: string | null;
  canonical: boolean;
  chunks: number;
  createdAt: string | null;
};

export type KbPassage = {
  sourceId: string;
  span: string;
  title: string;
  text: string;
  score: number;
  stale: boolean;
  sourceVersion: string;
  domain: string;
};

export type KbDomainsResult = { domains: KbDomain[]; configured: boolean };
export type KbDocumentsResult = { documents: KbDocument[]; configured: boolean };
export type KbSearchResult = {
  passages: KbPassage[];
  degraded: boolean;
  configured: boolean;
};

export type KbUploadInput = {
  domain: string;
  sourceId: string;
  title: string;
  content: string;
  sourceVersion: string;
  staleAfter: string | null;
  canonical: boolean;
};

export type KbUploadResult = {
  sourceId: string;
  domain: string;
  sourceVersion: string;
  chunks: number;
};

/** Domain suggestions for the picker; the API re-validates every value. */
export const SUGGESTED_KB_DOMAINS = ["support", "hr:policy"] as const;

/** Mirrors the API's `_DOMAIN_PATTERN` (kb_api.py) and the DB check. */
const KB_DOMAIN_PATTERN =
  /^(?:code|finance|marketing|support)$|^(?:msp|hr|tac):[a-z0-9][a-z0-9._-]*$/;

const KB_SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const KB_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parallels the API's 200,000 character upload cap. */
export const KB_MAX_CONTENT_CHARS = 200_000;

/** Parallels the API's default review horizon for uploads (kb_api.py). */
export const KB_STALE_WINDOW_DAYS = 365;

export const KB_UPLOAD_HINT = "Uploading knowledge requires the admin role.";

export function validKbDomain(domain: string): boolean {
  return KB_DOMAIN_PATTERN.test(domain);
}

/** Existing partitions first (API order), then suggestions not yet present. */
export function kbDomainOptions(domains: readonly KbDomain[]): string[] {
  const options = domains.map((item) => item.domain);
  for (const suggestion of SUGGESTED_KB_DOMAINS) {
    if (!options.includes(suggestion)) options.push(suggestion);
  }
  return options;
}

/** The domain selected after load: the first partition, else first suggestion. */
export function defaultKbDomain(domains: readonly KbDomain[]): string {
  return kbDomainOptions(domains)[0] ?? "";
}

// ------------------------------------------------------------------ parsing

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDomain(value: unknown): KbDomain | null {
  const record = asRecord(value);
  if (record === null) return null;
  const domain = asString(record.domain);
  if (domain === null || domain === "") return null;
  return {
    domain,
    documents: asNumber(record.documents) ?? 0,
    stale: asNumber(record.stale) ?? 0,
    canonical: asNumber(record.canonical) ?? 0,
    updatedAt: asString(record.updatedAt),
  };
}

function parseDocument(value: unknown): KbDocument | null {
  const record = asRecord(value);
  if (record === null) return null;
  const sourceId = asString(record.sourceId);
  if (sourceId === null || sourceId === "") return null;
  return {
    sourceId,
    title: asString(record.title) ?? sourceId,
    sourceVersion: asString(record.sourceVersion) ?? "",
    sourceUri: asString(record.sourceUri) ?? "",
    stale: record.stale === true,
    staleAfter: asString(record.staleAfter),
    canonical: record.canonical === true,
    chunks: asNumber(record.chunks) ?? 0,
    createdAt: asString(record.createdAt),
  };
}

function parsePassage(value: unknown): KbPassage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const sourceId = asString(record.sourceId);
  const text = asString(record.text);
  if (sourceId === null || text === null) return null;
  return {
    sourceId,
    span: asString(record.span) ?? "",
    title: asString(record.title) ?? sourceId,
    text,
    score: asNumber(record.score) ?? 0,
    stale: record.stale === true,
    sourceVersion: asString(record.sourceVersion) ?? "",
    domain: asString(record.domain) ?? "",
  };
}

/** Validate one `/kb/domains` payload; malformed rows are dropped, not fatal. */
export function parseKbDomains(value: unknown): KbDomainsResult {
  const record = asRecord(value);
  if (record === null) return { domains: [], configured: true };
  const domains: KbDomain[] = [];
  for (const item of Array.isArray(record.domains) ? record.domains : []) {
    const domain = parseDomain(item);
    if (domain !== null) domains.push(domain);
  }
  return { domains, configured: record.configured !== false };
}

/** Validate one `/kb/documents` payload; malformed rows are dropped, not fatal. */
export function parseKbDocuments(value: unknown): KbDocumentsResult {
  const record = asRecord(value);
  if (record === null) return { documents: [], configured: true };
  const documents: KbDocument[] = [];
  for (const item of Array.isArray(record.documents) ? record.documents : []) {
    const document = parseDocument(item);
    if (document !== null) documents.push(document);
  }
  return { documents, configured: record.configured !== false };
}

/** Validate one `/kb/search` payload; malformed rows are dropped, not fatal. */
export function parseKbSearch(value: unknown): KbSearchResult {
  const record = asRecord(value);
  if (record === null) return { passages: [], degraded: false, configured: true };
  const passages: KbPassage[] = [];
  for (const item of Array.isArray(record.passages) ? record.passages : []) {
    const passage = parsePassage(item);
    if (passage !== null) passages.push(passage);
  }
  return {
    passages,
    degraded: record.degraded === true,
    configured: record.configured !== false,
  };
}

// --------------------------------------------------------------------- api

export async function listKbDomains(): Promise<KbDomainsResult> {
  return parseKbDomains(await api<unknown>("/kb/domains"));
}

export async function listKbDocuments(domain: string): Promise<KbDocumentsResult> {
  if (!validKbDomain(domain)) return { documents: [], configured: true };
  const params = new URLSearchParams({ domain });
  return parseKbDocuments(await api<unknown>(`/kb/documents?${params.toString()}`));
}

export type KbSearchInput = {
  query: string;
  domain: string;
  canonical: boolean;
  k?: number;
};

export async function searchKb(input: KbSearchInput): Promise<KbSearchResult> {
  const trimmed = input.query.trim();
  if (trimmed === "" || !validKbDomain(input.domain)) {
    return { passages: [], degraded: false, configured: true };
  }
  const params = new URLSearchParams({
    q: trimmed,
    domain: input.domain,
    canonical: String(input.canonical),
  });
  if (input.k !== undefined) params.set("k", String(input.k));
  return parseKbSearch(await api<unknown>(`/kb/search?${params.toString()}`));
}

export async function uploadKbDocument(input: KbUploadInput): Promise<KbUploadResult> {
  const payload = await api<unknown>("/kb/documents", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const record = asRecord(payload) ?? {};
  return {
    sourceId: asString(record.sourceId) ?? input.sourceId,
    domain: asString(record.domain) ?? input.domain,
    sourceVersion: asString(record.sourceVersion) ?? input.sourceVersion,
    chunks: asNumber(record.chunks) ?? 0,
  };
}

// --------------------------------------------------------------- annotation

/** Latest (most recently ingested) version per source; ties break by label. */
export function latestVersionMap(
  documents: readonly KbDocument[],
): Map<string, KbDocument> {
  const latest = new Map<string, KbDocument>();
  for (const document of documents) {
    const current = latest.get(document.sourceId);
    if (current === undefined || compareDocumentRecency(document, current) > 0) {
      latest.set(document.sourceId, document);
    }
  }
  return latest;
}

function compareDocumentRecency(left: KbDocument, right: KbDocument): number {
  const leftAt = left.createdAt === null ? NaN : Date.parse(left.createdAt);
  const rightAt = right.createdAt === null ? NaN : Date.parse(right.createdAt);
  const leftStamp = Number.isFinite(leftAt) ? leftAt : -Infinity;
  const rightStamp = Number.isFinite(rightAt) ? rightAt : -Infinity;
  if (leftStamp !== rightStamp) return leftStamp - rightStamp;
  return left.sourceVersion.localeCompare(right.sourceVersion);
}

export type KbPassageNote = {
  /** The version the corpus currently holds for this source, when known. */
  latestVersion: string | null;
  /** Set when the passage cites an older version than the corpus holds. */
  supersededBy: string | null;
  /** True when the cited source is absent from a non-empty corpus listing. */
  missing: boolean;
  /** Set when the passage is stale and its review date is known. */
  staleSince: string | null;
  /** Canonical state of the cited document when the listing knows it. */
  canonical: boolean | null;
};

/**
 * Reference check for one passage: with a non-empty corpus listing, a cite
 * that is absent (missing) or behind the latest version (superseded) renders
 * as an invalid reference. Without a listing, no claims are made.
 */
export function annotatePassage(
  passage: KbPassage,
  latest: Map<string, KbDocument>,
  documents: readonly KbDocument[],
): KbPassageNote {
  if (documents.length === 0) {
    return { latestVersion: null, supersededBy: null, missing: false, staleSince: null, canonical: null };
  }
  const known = latest.get(passage.sourceId) ?? null;
  const exact =
    documents.find(
      (item) =>
        item.sourceId === passage.sourceId &&
        item.sourceVersion === passage.sourceVersion,
    ) ?? null;
  const staleSince =
    passage.stale && exact !== null && exact.staleAfter !== null
      ? formatMonthYear(exact.staleAfter)
      : null;
  return {
    latestVersion: known?.sourceVersion ?? null,
    supersededBy:
      known !== null && known.sourceVersion !== passage.sourceVersion
        ? known.sourceVersion
        : null,
    missing: known === null,
    staleSince,
    canonical: exact?.canonical ?? known?.canonical ?? null,
  };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2025-01-10T…" → "Jan 2025"; empty string when unparseable. */
export function formatMonthYear(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// ------------------------------------------------------------------ upload

export type KbUploadSuggestions = {
  sourceId: string | null;
  title: string | null;
  sourceVersion: string;
  /** Date input value ("YYYY-MM-DD"); empty when the doc carries no review date. */
  staleAfter: string;
};

/**
 * Prefill from the file itself: `# Title` names the document, `Reviewed:
 * YYYY-MM-DD` sets the review horizon (reviewed + 365 days, the fixture
 * corpus's window), and hr:policy uploads cite as `hr_policy/<file>` so the
 * spans read the same as the lane's fixture citations.
 */
export function suggestUploadMeta(
  content: string,
  fileName: string,
  domain: string,
): KbUploadSuggestions {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const reviewed = content.match(/^Reviewed:\s*(\d{4}-\d{2}-\d{2})$/m)?.[1] ?? null;
  const clean = fileName.trim().replace(/\s+/g, "-");
  const prefix = domain === "hr:policy" ? "hr_policy/" : "";
  return {
    sourceId: clean === "" ? null : `${prefix}${clean}`,
    title,
    sourceVersion: "v1",
    staleAfter: reviewed === null ? "" : addDays(reviewed, KB_STALE_WINDOW_DAYS),
  };
}

function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time)) return "";
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

export type KbUploadDraft = {
  domain: string;
  sourceId: string;
  title: string;
  sourceVersion: string;
  /** Date input value ("YYYY-MM-DD") or "" to let the server default apply. */
  staleAfter: string;
  canonical: boolean;
  content: string;
  fileName: string;
};

export function emptyKbUploadDraft(domain = ""): KbUploadDraft {
  return {
    domain,
    sourceId: "",
    title: "",
    sourceVersion: "v1",
    staleAfter: "",
    canonical: true,
    content: "",
    fileName: "",
  };
}

/** Field-level messages; an empty array means the draft can be uploaded. */
export function validateKbUploadDraft(draft: KbUploadDraft): string[] {
  const errors: string[] = [];
  if (!validKbDomain(draft.domain)) {
    errors.push("Pick a supported domain, for example hr:policy.");
  }
  if (!KB_SOURCE_ID_PATTERN.test(draft.sourceId)) {
    errors.push("Source id must start with a letter or digit and use letters, digits, . _ / - only.");
  }
  if (draft.title.trim() === "") errors.push("Title is required.");
  if (!KB_VERSION_PATTERN.test(draft.sourceVersion)) {
    errors.push("Version must start with a letter or digit and use letters, digits, . _ - only.");
  }
  if (draft.staleAfter !== "" && staleAfterIso(draft.staleAfter) === null) {
    errors.push("Stale after must be a valid date.");
  }
  if (draft.content.trim() === "") errors.push("Document content is required.");
  if (draft.content.length > KB_MAX_CONTENT_CHARS) {
    errors.push(`Content exceeds the ${KB_MAX_CONTENT_CHARS.toLocaleString("en-US")} character upload limit.`);
  }
  return errors;
}

/** Date input value → ISO instant; null lets the server's default apply. */
export function staleAfterIso(value: string): string | null {
  if (value === "") return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
