import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import type { PatchFile, PreviewManifest, PullRequestReceipt } from "../programming/contracts.js";
import {
  FakeGitHubTransport,
  GitHubRepositoryTools,
  computePatchHash,
  type GitHubPolicy,
} from "../programming/tools/github.js";
import {
  ACCESSIBILITY_FLOW_STEPS,
  AccessibilityRunStateSchema,
  CrawlArtifactSchema,
  FixArtifactSchema,
  ReScanArtifactSchema,
  ViolationsArtifactSchema,
  impactTotals,
  type AccessibilityFlowStepId,
  type AccessibilityRunState,
  type AuditModelOutput,
  type FixModelOutput,
} from "./contracts.js";
import {
  accessibilityBranch,
  type AccessibilityModel,
  type AuditModelContext,
  type FixModelContext,
} from "./flow.js";
import {
  AxeCrawlerClient,
  wcagRefFromTags,
  type AccessibilityCrawler,
  type AuditRequest,
  type AxeViolation,
  type CrawlRoute,
  type CrawlTransport,
} from "./tools/axe-crawler.js";
import type { AccessibilityReader, AccessibilityWriter } from "./tools/github-accessibility.js";

const SOURCE_SHA = "a".repeat(40);
const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-12T09:00:00.000Z");

const POLICY: GitHubPolicy = {
  repositories: ["acme/app-web", "acme/site"],
  baseBranch: "main",
  allowPaths: ["src/**", "app/**", "package.json"],
  denyPaths: [".github/workflows/**"],
  destructivePaths: ["migrations/**"],
  maxFiles: 10,
  maxPatchBytes: 250_000,
  timeoutMs: 5_000,
};

const ROUTES: CrawlRoute[] = [
  { path: "/checkout", component: "src/app/checkout/CheckoutButton.tsx", checks: 42 },
  { path: "/checkout/payment", component: "src/app/checkout/PaymentModal.tsx", checks: 30 },
  { path: "/pricing", component: "src/app/pricing/PricingTable.tsx", checks: 24 },
];

const CHECKOUT_BUTTON = [
  "export function CheckoutButton() {",
  '  return <button className="cta-primary">Pay now</button>;',
  "}",
  "",
].join("\n");

const CHECKOUT_BUTTON_FIXED = CHECKOUT_BUTTON.replace("cta-primary", "cta-primary cta-primary-dark");

const PAYMENT_MODAL = [
  "export function PaymentModal({ children }: { children: ReactNode }) {",
  '  return <div className="modal-overlay">{children}</div>;',
  "}",
  "",
].join("\n");

const PAYMENT_MODAL_FIXED = PAYMENT_MODAL.replace("div className", "footer className");

const PRICING_TABLE = [
  "export function PricingTable() {",
  '  return <img className="hero-illustration" src="/hero.png" />;',
  "}",
  "",
].join("\n");

function violation(overrides: Partial<AxeViolation> & { rule: string }): AxeViolation {
  return {
    impact: "minor",
    wcagRef: "WCAG 2.2 · 1.3.6",
    elementPath: "(body)",
    routePath: "/checkout",
    occurrences: 1,
    description: "Audit finding.",
    screenshotUrl: null,
    ...overrides,
  };
}

const BEFORE_VIOLATIONS: AxeViolation[] = [
  violation({
    rule: "color-contrast",
    impact: "critical",
    wcagRef: "WCAG 2.2 · 1.4.3",
    elementPath: ".cta-primary",
    routePath: "/checkout",
    occurrences: 3,
    description: "Elements must meet minimum color contrast ratio thresholds.",
    screenshotUrl: "https://axe.example/shots/color-contrast.png",
  }),
  violation({
    rule: "image-alt",
    impact: "serious",
    wcagRef: "WCAG 2.2 · 1.1.1",
    elementPath: "img.hero-illustration",
    routePath: "/pricing",
    occurrences: 2,
    description: "Images must have alternate text.",
  }),
  violation({
    rule: "region",
    elementPath: "body > footer",
    routePath: "/checkout/payment",
    occurrences: 1,
    description: "All page content should be contained by landmarks.",
  }),
];

/** What the audit service reports after the applied fixes. */
const AFTER_VIOLATIONS: AxeViolation[] = [BEFORE_VIOLATIONS[1]!];

function auditOutput(overrides: Partial<AuditModelOutput> = {}): AuditModelOutput {
  return {
    summary:
      "One contrast failure blocks the checkout flow; the payment step misses a footer landmark and the pricing hero needs alt text.",
    confidence: 0.82,
    ...overrides,
  };
}

function fixOutput(overrides: Partial<FixModelOutput> = {}): FixModelOutput {
  return {
    summary:
      "Fixes the checkout contrast and the missing footer landmark; the hero image needs a content decision.",
    confidence: 0.79,
    fixes: [
      {
        violationId: "violation-1",
        explanation:
          "The CTA misses 4.5:1 by a wide margin; a darker shade of the same hue passes without shifting the layout.",
        manualRedesign: false,
        before: '<button className="cta-primary">',
        after: '<button className="cta-primary cta-primary-dark">',
        files: [
          {
            path: "src/app/checkout/CheckoutButton.tsx",
            content: CHECKOUT_BUTTON_FIXED,
            validators: ["basic-syntax"],
          },
        ],
      },
      {
        violationId: "violation-2",
        explanation:
          "The hero illustration carries meaning; picking the alt copy is a content decision, so it is flagged for manual redesign.",
        manualRedesign: true,
        before: "",
        after: "",
        files: [],
      },
      {
        violationId: "violation-3",
        explanation:
          "The payment footer sits outside every landmark; rendering it as a footer element restores the region.",
        manualRedesign: false,
        before: '<div className="modal-overlay">',
        after: '<footer className="modal-overlay">',
        files: [
          {
            path: "src/app/checkout/PaymentModal.tsx",
            content: PAYMENT_MODAL_FIXED,
            validators: ["basic-syntax"],
          },
        ],
      },
    ],
    ...overrides,
  };
}

class FakeAccessibilityReader implements AccessibilityReader {
  files: Record<string, string> = {
    "src/app/checkout/CheckoutButton.tsx": CHECKOUT_BUTTON,
    "src/app/checkout/PaymentModal.tsx": PAYMENT_MODAL,
    "src/app/pricing/PricingTable.tsx": PRICING_TABLE,
  };
  readonly sourceShaCalls: string[] = [];
  readonly contentCalls: string[] = [];

  async sourceSha(owner: string, repo: string, baseBranch: string): Promise<string> {
    this.sourceShaCalls.push(`${owner}/${repo}@${baseBranch}`);
    return SOURCE_SHA;
  }

  async content(
    owner: string,
    repo: string,
    path: string,
    sourceSha: string,
  ): Promise<{ content: string; sha: string }> {
    this.contentCalls.push(`${owner}/${repo}:${path}@${sourceSha.slice(0, 7)}`);
    const content = this.files[path];
    if (content === undefined) throw new Error(`missing fixture for ${path}`);
    return { content, sha: SOURCE_SHA };
  }
}

class FakeCrawler implements AccessibilityCrawler {
  readonly routeCalls: Array<{ targetUrl: string; limit: number }> = [];
  readonly auditCalls: AuditRequest[] = [];
  private readonly routeList: CrawlRoute[];
  private readonly before: AxeViolation[];
  private readonly after: AxeViolation[];

  constructor(
    options: { routes?: CrawlRoute[]; before?: AxeViolation[]; after?: AxeViolation[] } = {},
  ) {
    this.routeList = options.routes ?? ROUTES;
    this.before = options.before ?? BEFORE_VIOLATIONS;
    this.after = options.after ?? AFTER_VIOLATIONS;
  }

  async routes(targetUrl: string, limit: number): Promise<readonly CrawlRoute[]> {
    this.routeCalls.push({ targetUrl, limit });
    return this.routeList;
  }

  async audit(request: AuditRequest): Promise<{
    analyzer: string;
    ruleset: string;
    violations: readonly AxeViolation[];
  }> {
    this.auditCalls.push(request);
    return {
      analyzer: "axe-core 4.10.2",
      ruleset: "wcag22aa",
      violations: request.fixedViolationIds === undefined ? this.before : this.after,
    };
  }
}

class FakeModel implements AccessibilityModel {
  readonly auditCalls: AuditModelContext[] = [];
  readonly fixCalls: FixModelContext[] = [];
  private readonly auditOutputs: AuditModelOutput[];
  private readonly fixOutputs: FixModelOutput[];

  constructor(
    auditOutputs: AuditModelOutput[] = [auditOutput()],
    fixOutputs: FixModelOutput[] = [fixOutput()],
  ) {
    this.auditOutputs = auditOutputs;
    this.fixOutputs = fixOutputs;
  }

  async audit(context: AuditModelContext): Promise<AuditModelOutput> {
    this.auditCalls.push(context);
    const index = Math.min(this.auditCalls.length - 1, this.auditOutputs.length - 1);
    return this.auditOutputs[index]!;
  }

  async fix(context: FixModelContext): Promise<FixModelOutput> {
    this.fixCalls.push(context);
    const index = Math.min(this.fixCalls.length - 1, this.fixOutputs.length - 1);
    return this.fixOutputs[index]!;
  }
}

/** Branch-scoped stand-in for the authoring side of `GitHubWriter`. */
class ScopedAccessibilityWriter implements AccessibilityWriter {
  readonly applied: Array<{
    repository: string;
    branch: string;
    title: string;
    body: string;
    files: string[];
  }> = [];
  private readonly receipts = new Map<string, PullRequestReceipt>();

  preflight(
    owner: string,
    repo: string,
    baseBranch: string,
    branch: string,
    sourceSha: string,
    files: PatchFile[],
    evidence: PreviewManifest["evidence"],
    _approvedDestructivePaths: string[],
  ): PreviewManifest {
    return {
      repository: `${owner}/${repo}`,
      baseBranch,
      sourceSha,
      branch,
      patchHash: computePatchHash(files),
      files: files.map((file) => ({
        path: file.path,
        sha256: createHash("sha256").update(file.content).digest("hex"),
        bytes: Buffer.byteLength(file.content),
        validators: file.validators,
      })),
      risk: "low",
      evidence,
    };
  }

  async apply(
    manifest: PreviewManifest,
    files: PatchFile[],
    title: string,
    body: string,
  ): Promise<PullRequestReceipt> {
    const key = `${manifest.repository}:${manifest.branch}:${manifest.patchHash}`;
    const prior = this.receipts.get(key);
    if (prior !== undefined) return { ...prior, replayed: true };
    const receipt: PullRequestReceipt = {
      url: `https://github.example/${manifest.repository}/pull/${this.receipts.size + 1}`,
      number: this.receipts.size + 1,
      draft: true,
      branch: manifest.branch,
      baseBranch: manifest.baseBranch,
      sourceSha: manifest.sourceSha,
      commitSha: "c".repeat(40),
      patchHash: manifest.patchHash,
      replayed: false,
    };
    this.applied.push({
      repository: manifest.repository,
      branch: manifest.branch,
      title,
      body,
      files: files.map((file) => file.path),
    });
    this.receipts.set(key, receipt);
    return receipt;
  }
}

function harness(
  options: {
    reader?: FakeAccessibilityReader;
    crawler?: AccessibilityCrawler;
    model?: AccessibilityModel;
    transport?: FakeGitHubTransport;
    writer?: AccessibilityWriter;
    liveWriter?: boolean;
  } = {},
) {
  const reader = options.reader ?? new FakeAccessibilityReader();
  const crawler = options.crawler ?? new FakeCrawler();
  const transport =
    options.transport ??
    new FakeGitHubTransport({
      sourceSha: SOURCE_SHA,
      treeSha: "f".repeat(40),
      commitSha: "c".repeat(40),
      checks: "success",
    });
  const tools = new GitHubRepositoryTools(transport, POLICY);
  const writer =
    options.writer ??
    (options.liveWriter === true ? tools.writer : new ScopedAccessibilityWriter());
  const model = options.model ?? new FakeModel();
  const mastra = createAllRounderMastra({
    accessibility: {
      github: { reader, writer },
      crawler,
      repositories: POLICY.repositories,
      baseBranch: POLICY.baseBranch,
      model,
      now: () => FIXED_NOW,
    },
  });
  const flow = mastra.getWorkflow("accessibilityFlow");
  if (flow === undefined) throw new Error("accessibilityFlow is not registered");
  return { reader, crawler, transport, tools, writer, model, flow, mastra };
}

type AccessibilityFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<AccessibilityFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = {
    repository: "acme/app-web",
    baseBranch: "main",
    targetUrl: "https://preview.acme.test",
  };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "acme-app-web";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): AccessibilityRunState {
    return AccessibilityRunStateSchema.parse({
      runId: this.runId,
      workflow: "accessibility",
      ticketKey: this.ticketKey,
      caseId: "case-1",
      attempt: this.attempt,
      input: this.input,
      decisions: this.decisions,
      artifacts: this.artifacts,
      effects: this.effects,
    });
  }

  /** Record a decision the way `RunService.decide()` does, then build resume data. */
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): AccessibilityRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return AccessibilityRunStateSchema.parse({ ...this.envelope(), decision });
  }
}

interface SuspendView {
  artifact: Record<string, unknown>;
  target?: string;
}

function suspendView(outcome: unknown, stepId: string): SuspendView {
  const view = outcome as {
    status?: string;
    error?: unknown;
    suspendPayload?: Record<string, SuspendView | undefined>;
  };
  if (view.status !== "suspended") {
    const failure = view.error;
    const detail =
      typeof failure === "object" && failure !== null && "message" in failure
        ? String((failure as { message: unknown }).message)
        : String(view.error ?? view.status);
    throw new Error(`expected suspension at ${stepId}, got ${detail}`);
  }
  const payload = view.suspendPayload?.[stepId];
  if (payload?.artifact === undefined) {
    throw new Error(`no suspend payload for ${stepId}`);
  }
  return payload;
}

/**
 * From the suspension at `startIndex`, store each artifact and proceed until
 * the flow suspends at `stopAt`.
 */
async function runForward(
  run: WorkflowRunHandle,
  walk: Walk,
  startIndex: number,
  currentPayload: SuspendView,
  stopAt: AccessibilityFlowStepId,
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < ACCESSIBILITY_FLOW_STEPS.length; index += 1) {
    const stepId = ACCESSIBILITY_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, ACCESSIBILITY_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: AccessibilityFlowHandle,
  walk: Walk,
  stopAt: AccessibilityFlowStepId,
): Promise<{ run: WorkflowRunHandle; walk: Walk; payload: SuspendView }> {
  const run = await flow.createRun();
  const first = suspendView(
    await run.start({ inputData: walk.envelope() }),
    ACCESSIBILITY_FLOW_STEPS[0],
  );
  const payload = await runForward(run, walk, 0, first, stopAt);
  return { run, walk, payload };
}

/**
 * Proceed from the suspension at `startIndex` through `re-scan`; returns the
 * receipt. The final resume can carry a custom action/extra (waiver edits).
 */
async function driveToCompletion(
  run: WorkflowRunHandle,
  walk: Walk,
  startIndex: number,
  currentPayload: SuspendView,
  actionHash: string,
  options: { action?: string; extra?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  let payload = currentPayload;
  for (let index = startIndex; index < ACCESSIBILITY_FLOW_STEPS.length; index += 1) {
    const stepId = ACCESSIBILITY_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, options.action ?? "proceed", {
        ...options.extra,
        actionHash,
      }),
    });
    if (stepId === "re-scan") {
      const done = outcome as {
        status?: string;
        result?: { receipt?: Record<string, unknown> };
      };
      if (done.status !== "success" || done.result?.receipt === undefined) {
        throw new Error("run did not complete");
      }
      return done.result.receipt;
    }
    payload = suspendView(outcome, ACCESSIBILITY_FLOW_STEPS[index + 1]!);
  }
  throw new Error("unreachable");
}

/** Extract the failure message from a step failure the way the API would see it. */
async function failureMessage(outcomePromise: Promise<unknown>): Promise<string> {
  try {
    const outcome = (await outcomePromise) as { status?: string; error?: unknown };
    if (outcome.status === "failed") {
      const failure = outcome.error as { message?: unknown };
      return typeof failure?.message === "string" ? failure.message : String(outcome.error);
    }
    return `status ${outcome.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type LooseRoute = Record<string, unknown> & { path: string; selected: boolean };

/** Clone the crawl routes so one can be mutated without touching the stored artifact. */
function editCrawlRoutes(
  artifact: Record<string, unknown>,
  mutate: (routes: LooseRoute[]) => LooseRoute[],
): { routes: LooseRoute[] } {
  const routes = (artifact.routes as LooseRoute[]).map((route) => ({ ...route }));
  return { routes: mutate(routes) };
}

describe("Mastra accessibilityFlow", () => {
  it("registers named accessibility steps in order", () => {
    const { flow } = harness();
    expect(flow.id).toBe("accessibilityFlow");
    expect(Object.keys(flow.steps)).toEqual([...ACCESSIBILITY_FLOW_STEPS]);
  });

  it("suspends at crawl with the route tree, selection totals and lock target", async () => {
    const crawler = new FakeCrawler();
    const reader = new FakeAccessibilityReader();
    const { flow } = harness({ crawler, reader });
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "crawl");
    const artifact = CrawlArtifactSchema.parse(payload.artifact);
    expect(payload.target).toBe("site:acme/app-web@preview.acme.test");
    expect(artifact.repository).toBe("acme/app-web");
    expect(artifact.baseBranch).toBe("main");
    expect(artifact.sourceSha).toBe(SOURCE_SHA);
    expect(artifact.targetUrl).toBe("https://preview.acme.test");
    expect(artifact.routes.map((route) => route.path)).toEqual([
      "/checkout",
      "/checkout/payment",
      "/pricing",
    ]);
    expect(artifact.routes.map((route) => route.component)).toEqual([
      "src/app/checkout/CheckoutButton.tsx",
      "src/app/checkout/PaymentModal.tsx",
      "src/app/pricing/PricingTable.tsx",
    ]);
    expect(artifact.routes.every((route) => route.selected && !route.authenticated)).toBe(true);
    expect(artifact.routes.map((route) => route.checks)).toEqual([42, 30, 24]);
    expect(artifact.totals).toEqual({ routes: 3, selected: 3, authenticated: 0, checks: 96 });
    expect(crawler.routeCalls).toEqual([{ targetUrl: "https://preview.acme.test", limit: 50 }]);
    expect(reader.sourceShaCalls).toEqual(["acme/app-web@main"]);
  });

  it("audits only the selected routes and folds the findings into impact totals", async () => {
    const model = new FakeModel();
    const crawler = new FakeCrawler();
    const { flow } = harness({ crawler, model });
    const walk = new Walk();
    const { run, payload: crawl } = await walkTo(flow, walk, "crawl");
    walk.artifacts["crawl"] = crawl.artifact;
    const edited = editCrawlRoutes(crawl.artifact, (routes) =>
      routes.map((route) => {
        if (route.path === "/pricing") return { ...route, selected: false };
        if (route.path === "/checkout/payment") return { ...route, authenticated: true };
        return route;
      }),
    );
    const payload = suspendView(
      await run.resume({
        resumeData: walk.resume("crawl", "edit", { edits: edited, actionHash: PROCEED_HASH }),
      }),
      "violations",
    );
    // Only the selected routes were audited; the toggle marked the payment step.
    expect(crawler.auditCalls).toHaveLength(1);
    expect(crawler.auditCalls[0]!.routes).toEqual(["/checkout", "/checkout/payment"]);
    expect(crawler.auditCalls[0]!.authenticatedRoutes).toEqual(["/checkout/payment"]);
    expect(crawler.auditCalls[0]!.fixedViolationIds).toBeUndefined();
    const artifact = ViolationsArtifactSchema.parse(payload.artifact);
    expect(artifact.analyzer).toBe("axe-core 4.10.2");
    expect(artifact.ruleset).toBe("wcag22aa");
    expect(artifact.violations.map((entry) => entry.id)).toEqual([
      "violation-1",
      "violation-2",
      "violation-3",
    ]);
    expect(artifact.violations[0]).toMatchObject({
      rule: "color-contrast",
      wcagRef: "WCAG 2.2 · 1.4.3",
      impact: "critical",
      elementPath: ".cta-primary",
      routePath: "/checkout",
      occurrences: 3,
      screenshotUrl: "https://axe.example/shots/color-contrast.png",
    });
    expect(artifact.violations[1]!.screenshotUrl).toBeNull();
    expect(artifact.totals).toEqual({ critical: 1, serious: 1, moderate: 0, minor: 1, total: 3 });
    expect(artifact.summary).toBe(auditOutput().summary);
    expect(artifact.confidence).toBe(0.82);
    expect(model.auditCalls).toHaveLength(1);
    expect(model.auditCalls[0]!.routes).toEqual(["/checkout", "/checkout/payment"]);
  });

  it("recomputes the audit with custom guidance on regenerate", async () => {
    const model = new FakeModel([
      auditOutput(),
      auditOutput({ summary: "Regenerated: prioritized the critical contrast failure." }),
    ]);
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "violations");
    expect(model.auditCalls.map((call) => call.guidance)).toEqual([undefined]);
    const payload = suspendView(
      await run.resume({
        resumeData: walk.resume("violations", "regenerate", {
          guidance: "Prioritize the critical findings and name the affected routes.",
          regenerations: 1,
        }),
      }),
      "violations",
    );
    expect(model.auditCalls.map((call) => call.guidance)).toEqual([
      undefined,
      "Prioritize the critical findings and name the affected routes.",
    ]);
    const artifact = ViolationsArtifactSchema.parse(payload.artifact);
    expect(artifact.summary).toBe("Regenerated: prioritized the critical contrast failure.");
  });

  it("writes one fix per violation and flags the manual-redesign ones apart", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "fix");
    const artifact = FixArtifactSchema.parse(payload.artifact);
    expect(artifact.fixes.map((fix) => [fix.violationId, fix.applied, fix.manualRedesign])).toEqual([
      ["violation-1", true, false],
      ["violation-2", false, true],
      ["violation-3", true, false],
    ]);
    expect(artifact.totals).toEqual({ fixes: 3, applied: 2, manualRedesign: 1, files: 2 });
    expect(artifact.fixes[0]).toMatchObject({
      rule: "color-contrast",
      wcagRef: "WCAG 2.2 · 1.4.3",
      impact: "critical",
      routePath: "/checkout",
      applied: true,
    });
    expect(artifact.fixes[0]!.files[0]!.path).toBe("src/app/checkout/CheckoutButton.tsx");
    expect(artifact.fixes[0]!.files[0]!.content).toContain("cta-primary-dark");
    expect(model.fixCalls).toHaveLength(1);
    expect(model.fixCalls[0]!.files.map((file) => file.path)).toEqual([
      "src/app/checkout/CheckoutButton.tsx",
      "src/app/checkout/PaymentModal.tsx",
      "src/app/pricing/PricingTable.tsx",
    ]);
    expect(model.fixCalls[0]!.violations.map((entry) => entry.id)).toEqual([
      "violation-1",
      "violation-2",
      "violation-3",
    ]);
    expect(model.fixCalls[0]!.guidance).toBeUndefined();
  });

  it("turns a fix that references an unreadable file into a manual-redesign card", async () => {
    const model = new FakeModel(
      [auditOutput()],
      [
        fixOutput({
          fixes: [
            {
              violationId: "violation-1",
              explanation: "Edits a file the flow never supplied.",
              manualRedesign: false,
              before: "",
              after: "",
              files: [
                {
                  path: "src/app/checkout/NotSupplied.tsx",
                  content: "export {};\n",
                  validators: ["basic-syntax"],
                },
              ],
            },
          ],
        }),
      ],
    );
    const { flow } = harness({ model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "fix");
    const artifact = FixArtifactSchema.parse(payload.artifact);
    expect(artifact.fixes).toHaveLength(1);
    expect(artifact.fixes[0]).toMatchObject({
      violationId: "violation-1",
      applied: false,
      manualRedesign: true,
      files: [],
    });
    expect(artifact.totals).toEqual({ fixes: 1, applied: 0, manualRedesign: 1, files: 0 });
  });

  it("rejects a fixer that invents a violation id", async () => {
    const model = new FakeModel(
      [auditOutput()],
      [
        fixOutput({
          fixes: [
            {
              violationId: "violation-9",
              explanation: "Fixes a finding the audit never reported.",
              manualRedesign: false,
              before: "",
              after: "",
              files: [],
            },
          ],
        }),
      ],
    );
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "violations");
    walk.artifacts["violations"] = payload.artifact;
    const message = await failureMessage(
      run.resume({
        resumeData: walk.resume("violations", "proceed", { actionHash: PROCEED_HASH }),
      }),
    );
    expect(message).toContain("The fixer invented violation violation-9");
  });

  it("compares the before/after audits and opens the fix Draft PR on proceed", async () => {
    const scoped = new ScopedAccessibilityWriter();
    const crawler = new FakeCrawler();
    const { flow } = harness({ crawler, writer: scoped });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "re-scan");
    const artifact = ReScanArtifactSchema.parse(payload.artifact);
    expect(artifact.branch).toBe("a11y/acme-app-web-case-1");
    expect(crawler.auditCalls.at(-1)).toMatchObject({
      fixedViolationIds: ["violation-1", "violation-3"],
      branch: "a11y/acme-app-web-case-1",
    });
    expect(artifact.before).toEqual({ critical: 1, serious: 1, moderate: 0, minor: 1, total: 3 });
    expect(artifact.after).toEqual({ critical: 0, serious: 1, moderate: 0, minor: 0, total: 1 });
    expect(artifact.delta).toEqual({ critical: 1, serious: 0, moderate: 0, minor: 1 });
    expect(artifact.resolvedIds).toEqual(["violation-1", "violation-3"]);
    expect(artifact.remaining.map((entry) => entry.rule)).toEqual(["image-alt"]);
    expect(artifact.introduced).toEqual([]);
    expect(artifact.waivers).toEqual([]);
    expect(artifact.gate).toEqual({ criticalsOpen: 0, criticalsWaived: 0, passing: true });
    expect(artifact.summary).toBe("Re-scan: 3 → 1 violations; 2 resolved, 0 new.");

    walk.artifacts["re-scan"] = payload.artifact;
    const receipt = await driveToCompletion(run, walk, 3, payload, "4".repeat(64));
    expect(receipt).toMatchObject({
      caseId: "case-1",
      repository: "acme/app-web",
      branch: "a11y/acme-app-web-case-1",
      resolvedCount: 2,
      waivedCount: 0,
      remainingCount: 1,
    });
    expect(receipt.gate).toEqual({ criticalsOpen: 0, criticalsWaived: 0, passing: true });
    const pr = receipt.pr as { draft: boolean; branch: string; replayed: boolean };
    expect(pr).toMatchObject({ draft: true, branch: "a11y/acme-app-web-case-1", replayed: false });
    expect(scoped.applied).toHaveLength(1);
    expect(scoped.applied[0]!.title).toBe("Fix 2 accessibility violation(s) on preview.acme.test");
    expect(scoped.applied[0]!.files).toEqual([
      "src/app/checkout/CheckoutButton.tsx",
      "src/app/checkout/PaymentModal.tsx",
    ]);
    expect(scoped.applied[0]!.body).toContain("Applied fixes");
    expect(scoped.applied[0]!.body).toContain("- color-contrast (WCAG 2.2 · 1.4.3) · /checkout · .cta-primary");
    expect(scoped.applied[0]!.body).toContain("Gate: 0 critical open, 0 waived");
  });

  it("blocks the fix PR while a critical stays open and accepts a signed waiver", async () => {
    // The re-scan keeps reporting the critical contrast failure.
    const crawler = new FakeCrawler({ after: [BEFORE_VIOLATIONS[0]!] });
    const scoped = new ScopedAccessibilityWriter();
    const { flow } = harness({ crawler, writer: scoped });

    // 1) Proceeding without a waiver is refused.
    const blocked = await walkTo(flow, await new Walk(), "re-scan");
    const blockedArtifact = ReScanArtifactSchema.parse(blocked.payload.artifact);
    expect(blockedArtifact.gate).toEqual({ criticalsOpen: 1, criticalsWaived: 0, passing: false });
    blocked.walk.artifacts["re-scan"] = blocked.payload.artifact;
    const message = await failureMessage(
      blocked.run.resume({
        resumeData: blocked.walk.resume("re-scan", "proceed", { actionHash: PROCEED_HASH }),
      }),
    );
    expect(message).toContain("Critical violations remain open (1)");

    // 2) An expired waiver is refused.
    const expired = await walkTo(flow, new Walk(), "re-scan");
    expired.walk.artifacts["re-scan"] = expired.payload.artifact;
    const expiredMessage = await failureMessage(
      expired.run.resume({
        resumeData: expired.walk.resume("re-scan", "edit", {
          edits: {
            waivers: [
              {
                violationId: "remaining-1",
                reason: "Tracked in the design-system backlog.",
                expiresAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
          approver: "dana@acme.test",
          actionHash: PROCEED_HASH,
        }),
      }),
    );
    expect(expiredMessage).toContain("must expire in the future");

    // 3) A waiver without a recorded approver is refused.
    const anonymous = await walkTo(flow, new Walk(), "re-scan");
    anonymous.walk.artifacts["re-scan"] = anonymous.payload.artifact;
    const anonymousMessage = await failureMessage(
      anonymous.run.resume({
        resumeData: anonymous.walk.resume("re-scan", "edit", {
          edits: {
            waivers: [
              {
                violationId: "remaining-1",
                reason: "Tracked in the design-system backlog.",
                expiresAt: "2026-12-31T00:00:00.000Z",
              },
            ],
          },
          actionHash: PROCEED_HASH,
        }),
      }),
    );
    expect(anonymousMessage).toContain("A waiver needs a recorded approver");

    // 4) The signed, unexpired waiver closes the gate and the PR opens.
    const waived = await walkTo(flow, new Walk(), "re-scan");
    const receipt = await driveToCompletion(waived.run, waived.walk, 3, waived.payload, PROCEED_HASH, {
      action: "edit",
      extra: {
        approver: "dana@acme.test",
        edits: {
          waivers: [
            {
              violationId: "remaining-1",
              reason: "Tracked in the design-system backlog; the contrast token ships next sprint.",
              expiresAt: "2026-12-31T00:00:00.000Z",
            },
          ],
        },
      },
    });
    expect(receipt.waivedCount).toBe(1);
    expect(receipt.gate).toEqual({ criticalsOpen: 0, criticalsWaived: 1, passing: true });
    expect(scoped.applied).toHaveLength(1);
    expect(scoped.applied[0]!.body).toContain("Waivers");
    expect(scoped.applied[0]!.body).toContain("dana@acme.test");
    expect(scoped.applied[0]!.body).toContain("expires 2026-12-31T00:00:00.000Z");
  });

  it("opens the fix Draft PR through the live writer with policy-checked patches", async () => {
    const { flow, transport } = harness({ liveWriter: true });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "re-scan");
    walk.artifacts["re-scan"] = payload.artifact;
    const receipt = await driveToCompletion(run, walk, 3, payload, "5".repeat(64));
    expect(receipt).toMatchObject({ repository: "acme/app-web", branch: "a11y/acme-app-web-case-1" });
    expect(transport.commitCreates).toBe(1);
    expect(transport.pullRequests).toHaveLength(1);
    const pull = transport.pullRequests[0]!;
    expect(pull.body).toContain("Patch hash:");
    expect(pull.body).toContain("Applied fixes");
    expect(pull.body).toContain("region (WCAG 2.2 · 1.3.6) · /checkout/payment · body > footer");
    expect(pull.draft).toBe(true);
  });

  it("replays a completed action from the recorded effect without auditing again", async () => {
    const scoped = new ScopedAccessibilityWriter();
    const reader = new FakeAccessibilityReader();
    const crawler = new FakeCrawler();
    const { flow } = harness({ reader, crawler, writer: scoped });
    const first = new Walk();
    const { run: firstRun, payload: reScan } = await walkTo(flow, first, "re-scan");
    first.artifacts["re-scan"] = reScan.artifact;
    const actionHash = "7".repeat(64);
    const receipt = await driveToCompletion(firstRun, first, 3, reScan, actionHash);
    expect(scoped.applied).toHaveLength(1);
    const readerCalls = reader.sourceShaCalls.length;
    const auditCalls = crawler.auditCalls.length;

    const replay = new Walk();
    replay.artifacts["crawl"] = first.artifacts["crawl"]!;
    replay.artifacts["violations"] = first.artifacts["violations"]!;
    replay.artifacts["fix"] = first.artifacts["fix"]!;
    replay.artifacts["re-scan"] = reScan.artifact;
    replay.decisions["crawl"] = { action: "proceed", actionHash: PROCEED_HASH };
    replay.decisions["violations"] = { action: "proceed", actionHash: PROCEED_HASH };
    replay.decisions["fix"] = { action: "proceed", actionHash: PROCEED_HASH };
    replay.decisions["re-scan"] = { action: "proceed", actionHash };
    replay.effects["re-scan"] = { actionHash, receipt };

    const started = await (await flow.createRun()).start({ inputData: replay.envelope() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.receipt).toMatchObject({
      repository: "acme/app-web",
      resolvedCount: 2,
    });
    expect(started.result.effects["re-scan"]?.actionHash).toBe(actionHash);
    expect(scoped.applied).toHaveLength(1);
    expect(reader.sourceShaCalls).toHaveLength(readerCalls);
    expect(crawler.auditCalls).toHaveLength(auditCalls);
  });

  it("rejects unlisted repositories and a fully deselected route tree", async () => {
    const { flow } = harness();
    const unlisted = new Walk({
      input: {
        repository: "acme/other",
        baseBranch: "main",
        targetUrl: "https://preview.acme.test",
      },
    });
    const message = await failureMessage(
      flow.createRun().then((run) => run.start({ inputData: unlisted.envelope() })),
    );
    expect(message).toContain("Repository not allowed: acme/other");

    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "crawl");
    walk.artifacts["crawl"] = payload.artifact;
    const edited = editCrawlRoutes(payload.artifact, (routes) =>
      routes.map((route) => ({ ...route, selected: false })),
    );
    const deselected = await failureMessage(
      run.resume({
        resumeData: walk.resume("crawl", "edit", { edits: edited, actionHash: PROCEED_HASH }),
      }),
    );
    expect(deselected).toContain("Select at least one route before proceeding");
  });

  it("keeps two concurrent accessibility runs on disjoint state", async () => {
    const repos = ["acme/app-web", "acme/site"] as const;
    const scoped = new ScopedAccessibilityWriter();
    const { flow } = harness({ writer: scoped });
    const walks = repos.map(
      (repository, index) =>
        new Walk({
          runId: `run-${index + 1}`,
          ticketKey: `a11y-${index + 1}`,
          input: {
            repository,
            baseBranch: "main",
            targetUrl: "https://preview.acme.test",
          },
        }),
    );
    const starts = await Promise.all(
      walks.map(async (walk) => {
        const run = await flow.createRun();
        const payload = suspendView(await run.start({ inputData: walk.envelope() }), "crawl");
        return { run, payload };
      }),
    );
    starts.forEach((start, index) => {
      expect(start.payload.artifact.repository).toBe(repos[index]);
      expect(start.payload.target).toBe(`site:${repos[index]}@preview.acme.test`);
    });

    const receipts = await Promise.all(
      starts.map((start, index) =>
        driveToCompletion(start.run, walks[index]!, 0, start.payload, `${index + 1}`.repeat(64)),
      ),
    );
    expect(receipts.map((receipt) => receipt.repository).sort()).toEqual([...repos].sort());
    receipts.forEach((receipt, index) => {
      expect(receipt.branch).toBe(`a11y/${repos[index]!.replace("/", "-")}-case-1`);
    });
    expect(scoped.applied).toHaveLength(2);
    expect(new Set(scoped.applied.map((entry) => entry.repository))).toEqual(new Set(repos));
  });
});

class FakeCrawlTransport implements CrawlTransport {
  readonly calls: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];
  private readonly responses: Record<string, { status: number; body: unknown }>;

  constructor(responses: Record<string, { status: number; body: unknown }>) {
    this.responses = responses;
  }

  async json(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    this.calls.push(body === undefined ? { method, path } : { method, path, body });
    const key = `${method} ${path.split("?")[0]}`;
    const response = this.responses[key];
    if (response === undefined) throw new Error(`no fixture for ${key}`);
    return response;
  }
}

describe("AxeCrawlerClient", () => {
  it("parses the route tree and skips malformed entries", async () => {
    const transport = new FakeCrawlTransport({
      "GET /routes": {
        status: 200,
        body: {
          routes: [
            { path: "/checkout", component: "src/app/checkout/page.tsx", checks: 12 },
            { path: "/settings" },
            { checks: 5 },
            "junk",
          ],
        },
      },
    });
    const client = new AxeCrawlerClient(transport);
    const routes = await client.routes("https://preview.acme.test", 25);
    expect(routes).toEqual([
      { path: "/checkout", component: "src/app/checkout/page.tsx", checks: 12 },
      { path: "/settings", component: "/settings", checks: 0 },
    ]);
    expect(transport.calls[0]!.path).toBe(
      "/routes?url=https%3A%2F%2Fpreview.acme.test&limit=25",
    );
  });

  it("normalizes audit rows: derived WCAG refs, null impacts and safe screenshots", async () => {
    const transport = new FakeCrawlTransport({
      "POST /audit": {
        status: 200,
        body: {
          analyzer: "axe-core 4.10.2",
          ruleset: "wcag22aa",
          violations: [
            {
              rule: "color-contrast",
              impact: null,
              tags: ["wcag2aa", "wcag143"],
              target: [".cta-primary"],
              routePath: "/checkout",
              occurrences: 3,
              help: "Elements must meet minimum color contrast ratio thresholds.",
              screenshotUrl: "javascript:alert(1)",
            },
            { rule: "image-alt", impact: "serious", screenshotUrl: "https://axe.example/x.png" },
            { impact: "serious" },
            "junk",
          ],
        },
      },
    });
    const client = new AxeCrawlerClient(transport);
    const result = await client.audit({
      targetUrl: "https://preview.acme.test",
      routes: ["/checkout"],
      authenticatedRoutes: [],
    });
    expect(result.analyzer).toBe("axe-core 4.10.2");
    expect(result.ruleset).toBe("wcag22aa");
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toMatchObject({
      rule: "color-contrast",
      impact: "minor",
      wcagRef: "WCAG 2.2 · 1.4.3",
      elementPath: ".cta-primary",
      routePath: "/checkout",
      occurrences: 3,
      screenshotUrl: null,
    });
    expect(result.violations[1]).toMatchObject({
      rule: "image-alt",
      impact: "serious",
      wcagRef: "WCAG 2.2",
      elementPath: "(unknown element)",
      routePath: "(unknown route)",
      occurrences: 1,
      screenshotUrl: "https://axe.example/x.png",
    });
  });

  it("sends the fixed ids and branch on a re-scan audit", async () => {
    const transport = new FakeCrawlTransport({
      "POST /audit": { status: 200, body: { violations: [] } },
    });
    const client = new AxeCrawlerClient(transport);
    await client.audit({
      targetUrl: "https://preview.acme.test",
      routes: ["/checkout"],
      authenticatedRoutes: ["/checkout/payment"],
      fixedViolationIds: ["violation-1", "violation-3"],
      branch: "a11y/acme-app-web-case-1",
    });
    expect(transport.calls[0]!.body).toEqual({
      url: "https://preview.acme.test",
      routes: ["/checkout"],
      authenticated: ["/checkout/payment"],
      fixed: ["violation-1", "violation-3"],
      branch: "a11y/acme-app-web-case-1",
    });
  });

  it("fails loudly when the audit service errors", async () => {
    const transport = new FakeCrawlTransport({
      "POST /audit": { status: 500, body: { message: "boom" } },
    });
    const client = new AxeCrawlerClient(transport);
    await expect(
      client.audit({ targetUrl: "https://preview.acme.test", routes: [], authenticatedRoutes: [] }),
    ).rejects.toThrow("axe service request failed for audit (500)");
  });
});

describe("accessibility helpers", () => {
  it("derives WCAG refs from axe tags", () => {
    expect(wcagRefFromTags(["wcag2aa", "wcag143"])).toBe("WCAG 2.2 · 1.4.3");
    expect(wcagRefFromTags(["wcag2411"])).toBe("WCAG 2.2 · 2.4.11");
    expect(wcagRefFromTags(["wcag111", "wcag412"])).toBe("WCAG 2.2 · 1.1.1 · 4.1.2");
    expect(wcagRefFromTags(["wcag22aa"])).toBeNull();
    expect(wcagRefFromTags("nope")).toBeNull();
  });

  it("counts violations per impact level", () => {
    expect(
      impactTotals([
        { impact: "critical" },
        { impact: "critical" },
        { impact: "serious" },
        { impact: "minor" },
      ]),
    ).toEqual({ critical: 2, serious: 1, moderate: 0, minor: 1, total: 4 });
    expect(impactTotals([])).toEqual({ critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 });
  });

  it("derives deterministic fix branch names", () => {
    expect(accessibilityBranch("acme/app-web", "case-1")).toBe("a11y/acme-app-web-case-1");
    expect(accessibilityBranch("Acme/App ", "Case/9")).toBe("a11y/acme-app-case-9");
  });
});
