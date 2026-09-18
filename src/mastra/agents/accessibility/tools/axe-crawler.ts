import type { ImpactLevel } from "../contracts.js";

/** One discovered route with the component that renders it. */
export interface CrawlRoute {
  readonly path: string;
  readonly component: string;
  readonly checks: number;
}

/** One axe violation row as the audit service reports it. */
export interface AxeViolation {
  readonly rule: string;
  readonly impact: ImpactLevel;
  readonly wcagRef: string;
  readonly elementPath: string;
  readonly routePath: string;
  readonly occurrences: number;
  readonly description: string;
  readonly screenshotUrl: string | null;
}

export interface AxeAuditResult {
  readonly analyzer: string;
  readonly ruleset: string;
  readonly violations: readonly AxeViolation[];
}

/**
 * One audit request. `fixedViolationIds` powers the re-scan: the service
 * re-runs axe on the fixed preview and reports what remains after those
 * violations were addressed.
 */
export interface AuditRequest {
  readonly targetUrl: string;
  readonly routes: readonly string[];
  readonly authenticatedRoutes: readonly string[];
  readonly fixedViolationIds?: readonly string[];
  readonly branch?: string;
}

/**
 * Crawl/audit surface the flow needs (fake-friendly structural interface;
 * `AxeCrawlerClient` is the live implementation over the self-hosted
 * axe-runner service, see the call register in docs/).
 */
export interface AccessibilityCrawler {
  routes(targetUrl: string, limit: number): Promise<readonly CrawlRoute[]>;
  audit(request: AuditRequest): Promise<AxeAuditResult>;
}

/** Minimal request surface so tests can fake the audit service without network. */
export interface CrawlTransport {
  json(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyObject(
  response: { status: number; body: unknown },
  label: string,
): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300 || !isRecord(response.body)) {
    throw new Error(`axe service request failed for ${label} (${response.status})`);
  }
  return response.body;
}

/** axe reports null impact for uncategorized rules; they fold into minor. */
function normalizeImpact(value: unknown): ImpactLevel {
  return value === "critical" || value === "serious" || value === "moderate" || value === "minor"
    ? value
    : "minor";
}

/**
 * Derive a readable WCAG reference from axe tags (`wcag143` -> 1.4.3,
 * `wcag2411` -> 2.4.11); level tags (`wcag22aa`) are ignored.
 */
export function wcagRefFromTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  const refs = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const match = tag.match(/^wcag(\d{3,4})$/);
    if (match === null) continue;
    const digits = match[1]!;
    const principle = digits.slice(0, 1);
    const rest = digits.slice(1);
    const criteria =
      rest.length === 2
        ? `${rest.slice(0, 1)}.${rest.slice(1)}`
        : `${rest.slice(0, 1)}.${rest.slice(1)}`;
    refs.add(`${principle}.${criteria}`);
  }
  if (refs.size === 0) return null;
  return `WCAG 2.2 · ${[...refs].slice(0, 2).join(" · ")}`;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : null;
}

function screenshotUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value.slice(0, 500) : null;
}

function elementPath(entry: Record<string, unknown>, fallback: string): string {
  if (typeof entry.elementPath === "string" && entry.elementPath !== "") {
    return entry.elementPath.slice(0, 500);
  }
  if (Array.isArray(entry.target)) {
    const joined = entry.target.filter((part): part is string => typeof part === "string").join(" ");
    if (joined !== "") return joined.slice(0, 500);
  }
  return fallback;
}

/** Live audit-service transport over `fetch` with a bounded timeout. */
export class FetchCrawlTransport implements CrawlTransport {
  constructor(
    private readonly baseUrl = "http://127.0.0.1:8848",
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
 * Read-only client for the self-hosted axe-runner service: `GET /routes`
 * discovers the route/component tree for the crawl checkpoint and
 * `POST /audit` runs axe (optionally re-running it on the fixed preview for
 * the re-scan). Malformed rows are dropped rather than failing the run; an
 * audit with no usable rows returns an empty violation list.
 */
export class AxeCrawlerClient implements AccessibilityCrawler {
  constructor(private readonly transport: CrawlTransport) {}

  async routes(targetUrl: string, limit: number): Promise<readonly CrawlRoute[]> {
    const response = await this.transport.json(
      "GET",
      `/routes?url=${encodeURIComponent(targetUrl)}&limit=${limit}`,
    );
    const body = bodyObject(response, "routes");
    const entries = Array.isArray(body.routes) ? body.routes : [];
    const routes: CrawlRoute[] = [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const path = text(entry.path, 300);
      if (path === null) continue;
      const checks = entry.checks;
      routes.push({
        path,
        component: text(entry.component, 300) ?? path,
        checks:
          typeof checks === "number" && Number.isInteger(checks) && checks >= 0
            ? Math.min(checks, 10_000)
            : 0,
      });
    }
    return routes;
  }

  async audit(request: AuditRequest): Promise<AxeAuditResult> {
    const response = await this.transport.json("POST", "/audit", {
      url: request.targetUrl,
      routes: [...request.routes],
      authenticated: [...request.authenticatedRoutes],
      ...(request.fixedViolationIds === undefined
        ? {}
        : { fixed: [...request.fixedViolationIds] }),
      ...(request.branch === undefined ? {} : { branch: request.branch }),
    });
    const body = bodyObject(response, "audit");
    const entries = Array.isArray(body.violations) ? body.violations : [];
    const violations: AxeViolation[] = [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const rule = text(entry.rule, 200);
      if (rule === null) continue;
      const occurrences = entry.occurrences;
      violations.push({
        rule,
        impact: normalizeImpact(entry.impact),
        wcagRef:
          text(entry.wcagRef, 300) ?? wcagRefFromTags(entry.tags) ?? "WCAG 2.2",
        elementPath: elementPath(entry, "(unknown element)"),
        routePath: text(entry.routePath, 300) ?? "(unknown route)",
        occurrences:
          typeof occurrences === "number" &&
          Number.isInteger(occurrences) &&
          occurrences >= 1
            ? Math.min(occurrences, 10_000)
            : 1,
        description: text(entry.description, 2_000) ?? text(entry.help, 2_000) ?? rule,
        screenshotUrl: screenshotUrl(entry.screenshotUrl),
      });
    }
    return {
      analyzer: text(body.analyzer, 200) ?? "axe-core",
      ruleset: text(body.ruleset, 200) ?? "wcag22aa",
      violations,
    };
  }
}
