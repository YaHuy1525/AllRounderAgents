import type { DependencyKind, Vulnerability } from "../contracts.js";

/** One package the flow asks the registry about. */
export interface DependencyQuery {
  readonly name: string;
  readonly current: string;
  readonly kind: DependencyKind;
}

/** One registry answer per queried package. */
export interface DependencyStatus {
  readonly name: string;
  readonly latest: string;
  readonly daysOutdated: number;
  readonly changelogExcerpt: string;
  readonly resolved: string | null;
  readonly integrity: string | null;
  readonly vulnerabilities: readonly Vulnerability[];
}

/**
 * Version/advisory surface the scan step needs (fake-friendly structural
 * interface; `NpmRegistryClient` is the live implementation).
 */
export interface DependencyRegistry {
  lookup(queries: readonly DependencyQuery[]): Promise<readonly DependencyStatus[]>;
}

/** Minimal request surface so tests can fake the registry without network. */
export interface RegistryTransport {
  json(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const LOOKUP_GROUP = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyObject(response: { status: number; body: unknown }, label: string): Record<string, unknown> {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !isRecord(response.body)
  ) {
    throw new Error(`npm registry request failed for ${label} (${response.status})`);
  }
  return response.body;
}

/** Live registry transport over `fetch` with a bounded timeout. */
export class FetchRegistryTransport implements RegistryTransport {
  constructor(
    private readonly baseUrl = "https://registry.npmjs.org",
    private readonly timeoutMs = 10_000,
  ) {}

  async json(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      return { status: response.status, body: await response.json() };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Read-only npm registry client for the scan step: the packument supplies the
 * latest version, its publish date, and the tarball pin the lockfile bump
 * writes; the bulk advisory endpoint supplies the CVE tags. Advisory lookups
 * are additive — when they fail the inventory still returns, without tags.
 */
export class NpmRegistryClient implements DependencyRegistry {
  constructor(private readonly transport: RegistryTransport) {}

  async lookup(queries: readonly DependencyQuery[]): Promise<readonly DependencyStatus[]> {
    const advisories = await this.advisories(queries);
    const statuses: DependencyStatus[] = [];
    for (let index = 0; index < queries.length; index += LOOKUP_GROUP) {
      const group = queries.slice(index, index + LOOKUP_GROUP);
      statuses.push(
        ...(await Promise.all(
          group.map(async (query) => this.lookupOne(query, advisories)),
        )),
      );
    }
    return statuses;
  }

  private async lookupOne(
    query: DependencyQuery,
    advisories: Map<string, Vulnerability[]>,
  ): Promise<DependencyStatus> {
    const response = await this.transport.json("GET", `/${encodeURIComponent(query.name)}`);
    const body = bodyObject(response, query.name);
    const distTags = isRecord(body["dist-tags"]) ? body["dist-tags"] : {};
    const latest = typeof distTags.latest === "string" ? distTags.latest : query.current;
    const time = isRecord(body.time) ? body.time : {};
    const published = typeof time[latest] === "string" ? Date.parse(time[latest]) : Number.NaN;
    const versions = isRecord(body.versions) ? body.versions : {};
    const version = isRecord(versions[latest]) ? versions[latest] : {};
    const dist = isRecord(version.dist) ? version.dist : {};
    return {
      name: query.name,
      latest,
      daysOutdated: Number.isNaN(published)
        ? 0
        : Math.max(0, Math.floor((Date.now() - published) / DAY_MS)),
      changelogExcerpt:
        typeof body.description === "string" ? body.description.slice(0, 1_000) : "",
      resolved: typeof dist.tarball === "string" ? dist.tarball : null,
      integrity: typeof dist.integrity === "string" ? dist.integrity : null,
      vulnerabilities: advisories.get(query.name) ?? [],
    };
  }

  /** One bulk advisory call for every queried package. */
  private async advisories(
    queries: readonly DependencyQuery[],
  ): Promise<Map<string, Vulnerability[]>> {
    const byName = new Map<string, Vulnerability[]>();
    if (queries.length === 0) return byName;
    const payload = Object.fromEntries(queries.map((query) => [query.name, [query.current]]));
    let body: Record<string, unknown>;
    try {
      const response = await this.transport.json(
        "POST",
        "/-/npm/v1/security/advisories/bulk",
        payload,
      );
      body = bodyObject(response, "advisories");
    } catch {
      // Advisory data is enrichment; the inventory still ships without tags.
      return byName;
    }
    for (const [name, entries] of Object.entries(body)) {
      if (!Array.isArray(entries)) continue;
      const tags: Vulnerability[] = [];
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const cves = Array.isArray(entry.cves)
          ? entry.cves.filter((cve): cve is string => typeof cve === "string")
          : [];
        const severity = entry.severity;
        if (
          cves.length === 0 ||
          (severity !== "low" &&
            severity !== "moderate" &&
            severity !== "high" &&
            severity !== "critical")
        ) {
          continue;
        }
        tags.push({
          cve: cves[0]!,
          cvss: null,
          severity,
          summary: typeof entry.title === "string" ? entry.title.slice(0, 500) : cves[0]!,
        });
      }
      if (tags.length > 0) byName.set(name, tags.slice(0, 20));
    }
    return byName;
  }
}
