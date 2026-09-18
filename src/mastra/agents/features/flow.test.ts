import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Agent } from "@mastra/core/agent";

import { createAllRounderMastra } from "../../mastra.js";
import type { PatchFile, PreviewManifest, PullRequestReceipt } from "../programming/contracts.js";
import {
  FakeGitHubTransport,
  GitHubRepositoryTools,
  computePatchHash,
  type GitHubPolicy,
} from "../programming/tools/github.js";
import {
  FEATURES_FLOW_STEPS,
  FeatureCompletionArtifactSchema,
  FeatureImplementationArtifactSchema,
  FeatureSelectionArtifactSchema,
  FeaturesRunStateSchema,
  ScopeDesignArtifactSchema,
  type FeatureImplementationOutput,
  type FeaturePlanOutput,
  type FeaturesFlowStepId,
  type FeaturesRunState,
} from "./contracts.js";
import {
  computeLineDiff,
  createFeaturesAgentModel,
  type FeatureImplementationModelContext,
  type FeaturePlanModelContext,
  type FeaturesModel,
} from "./flow.js";
import type { FeatureReader, FeatureWriter } from "./tools/github-features.js";

const SOURCE_SHA = "a".repeat(40);
const PROCEED_HASH = "0".repeat(64);

const POLICY: GitHubPolicy = {
  repositories: ["acme/app", "acme/lib", "acme/cli"],
  baseBranch: "main",
  allowPaths: ["src/**", "tests/**", "config/**", "docs/**"],
  denyPaths: [".github/workflows/**"],
  destructivePaths: ["migrations/**"],
  maxFiles: 10,
  maxPatchBytes: 250_000,
  timeoutMs: 5_000,
};

const TICKET_CANDIDATES = [
  {
    key: "FEAT-7",
    summary: "Add status filters to the orders search page",
    status: "To Do",
  },
  { key: "FEAT-12", summary: "Expose the audit log as a CSV download", status: "To Do" },
];

function planOutput(overrides: Partial<FeaturePlanOutput> = {}): FeaturePlanOutput {
  return {
    targetSummary:
      "The orders search page gains a status filter whose selection is persisted across reloads.",
    confidence: 0.84,
    areas: ["ui", "state-logic", "tests"],
    ...overrides,
  };
}

function implementationOutput(
  overrides: Partial<FeatureImplementationOutput> = {},
): FeatureImplementationOutput {
  return {
    summary: "Added the status filter and persisted its selection.",
    verdict: "ready",
    confidence: 0.82,
    strengths: ["Reuses the existing query key so cache invalidation stays correct."],
    risksOpenQuestions: ["The empty-filter copy is a placeholder."],
    crossCuttingNotes: ["The persisted key must be versioned if the filter shape changes."],
    files: [
      {
        path: "src/orders/SearchPage.tsx",
        content: 'export function SearchPage() {\n  return <OrderTable status={status} />;\n}\n',
        changeDescription: "Render the status filter bound to the persisted hook.",
        criteriaIds: ["ac-1"],
        area: "ui",
      },
      {
        path: "src/orders/useOrderFilter.ts",
        content: 'export function useOrderFilter() {\n  return "all";\n}\n',
        changeDescription: "Persist the selected filter for reloads.",
        criteriaIds: ["ac-2"],
        area: "state-logic",
      },
    ],
    ...overrides,
  };
}

class FakeFeatureReader implements FeatureReader {
  tree = [
    "src/orders/SearchPage.tsx",
    "src/orders/useOrders.ts",
    "src/config/app.json",
    "assets/logo.png",
  ];
  files: Record<string, string> = {
    "src/orders/SearchPage.tsx": "export function SearchPage() {\n  return <OrderTable />;\n}\n",
    "src/orders/useOrders.ts":
      "export function useOrders() {\n  return useQuery(ordersKey, fetchOrders);\n}\n",
    "src/config/app.json": '{ "filters": false }\n',
  };
  readonly sourceShaCalls: string[] = [];
  readonly listCalls: string[] = [];
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

  async listFiles(
    owner: string,
    repo: string,
    sourceSha: string,
    limit: number,
  ): Promise<string[]> {
    this.listCalls.push(`${owner}/${repo}@${sourceSha.slice(0, 7)}:${limit}`);
    return this.tree.slice(0, limit);
  }

  /** Paths the fake pretends the repository policy denies. */
  readonly deniedPaths = new Set<string>();

  allowsPath(path: string): boolean {
    return !this.deniedPaths.has(path);
  }
}

class FakeModel implements FeaturesModel {
  readonly planCalls: FeaturePlanModelContext[] = [];
  readonly implementCalls: FeatureImplementationModelContext[] = [];
  private readonly planOutputs: FeaturePlanOutput[];
  private readonly implementOutputs: FeatureImplementationOutput[];

  constructor(
    planOutputs: FeaturePlanOutput[] = [planOutput()],
    implementOutputs: FeatureImplementationOutput[] = [implementationOutput()],
  ) {
    this.planOutputs = planOutputs;
    this.implementOutputs = implementOutputs;
  }

  async plan(context: FeaturePlanModelContext): Promise<FeaturePlanOutput> {
    this.planCalls.push(context);
    const index = Math.min(this.planCalls.length - 1, this.planOutputs.length - 1);
    return this.planOutputs[index]!;
  }

  async implement(context: FeatureImplementationModelContext): Promise<FeatureImplementationOutput> {
    this.implementCalls.push(context);
    const index = Math.min(this.implementCalls.length - 1, this.implementOutputs.length - 1);
    return this.implementOutputs[index]!;
  }
}

/**
 * Branch-scoped stand-in for the authoring side of `GitHubWriter`. The suite's
 * shared `FakeGitHubTransport` keeps one branch head for every branch, so three
 * concurrent runs would trip its durable-replay check; this fake mirrors the
 * same repository/branch/patch idempotency without that global.
 */
class ScopedFeatureWriter implements FeatureWriter {
  readonly applied: Array<{ repository: string; branch: string; title: string; body: string }> = [];
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
    _files: PatchFile[],
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
    this.applied.push({ repository: manifest.repository, branch: manifest.branch, title, body });
    this.receipts.set(key, receipt);
    return receipt;
  }
}

function harness(
  options: {
    reader?: FakeFeatureReader;
    model?: FeaturesModel;
    transport?: FakeGitHubTransport;
    writer?: FeatureWriter;
  } = {},
) {
  const reader = options.reader ?? new FakeFeatureReader();
  const transport =
    options.transport ??
    new FakeGitHubTransport({
      sourceSha: SOURCE_SHA,
      treeSha: "f".repeat(40),
      commitSha: "c".repeat(40),
      checks: "success",
    });
  const tools = new GitHubRepositoryTools(transport, POLICY);
  const writer = options.writer ?? tools.writer;
  const mastra = createAllRounderMastra({
    features: {
      github: { reader, writer },
      repositories: POLICY.repositories,
      baseBranch: POLICY.baseBranch,
      model: options.model ?? new FakeModel(),
      analysisFileLimit: 8,
    },
  });
  const flow = mastra.getWorkflow("featuresFlow");
  if (flow === undefined) throw new Error("featuresFlow is not registered");
  return { reader, transport, writer, flow, mastra };
}

type FeaturesFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<FeaturesFlowHandle["createRun"]>>;

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
    ticketKey: "FEAT-7",
    ticketSummary: "Add status filters to the orders search page",
    repository: "acme/app",
    candidates: TICKET_CANDIDATES,
    acceptanceCriteria: [
      "Users can filter orders by status",
      "The selected filter survives a page reload",
    ],
  };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "FEAT-7";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): FeaturesRunState {
    return FeaturesRunStateSchema.parse({
      runId: this.runId,
      workflow: "features",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): FeaturesRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return FeaturesRunStateSchema.parse({ ...this.envelope(), decision });
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
  stopAt: FeaturesFlowStepId,
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < FEATURES_FLOW_STEPS.length; index += 1) {
    const stepId = FEATURES_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, FEATURES_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: FeaturesFlowHandle,
  walk: Walk,
  stopAt: FeaturesFlowStepId,
): Promise<{ run: WorkflowRunHandle; payload: SuspendView; payloads: Record<string, SuspendView> }> {
  const payloads: Record<string, SuspendView> = {};
  const run = await flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), FEATURES_FLOW_STEPS[0]);
  payloads[FEATURES_FLOW_STEPS[0]] = first;
  const payload = await runForward(run, walk, 0, first, stopAt);
  payloads[stopAt] = payload;
  return { run, payload, payloads };
}

/** Proceed from the suspension at `startIndex` through `complete`; returns the receipt. */
async function driveToCompletion(
  run: WorkflowRunHandle,
  walk: Walk,
  startIndex: number,
  currentPayload: SuspendView,
  actionHash: string,
): Promise<Record<string, unknown>> {
  let payload = currentPayload;
  for (let index = startIndex; index < FEATURES_FLOW_STEPS.length; index += 1) {
    const stepId = FEATURES_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    const outcome = await run.resume({ resumeData: walk.resume(stepId, "proceed", { actionHash }) });
    if (stepId === "complete") {
      const done = outcome as {
        status?: string;
        result?: { receipt?: Record<string, unknown> };
      };
      if (done.status !== "success" || done.result?.receipt === undefined) {
        throw new Error("run did not complete");
      }
      return done.result.receipt;
    }
    payload = suspendView(outcome, FEATURES_FLOW_STEPS[index + 1]!);
  }
  throw new Error("unreachable");
}

/** Extract the failure message from a step failure the way the API would see it. */
async function failureMessage(outcomePromise: Promise<unknown>): Promise<string> {
  try {
    const outcome = (await outcomePromise) as { status?: string; error?: unknown };
    if (outcome.status === "failed") {
      // Mastra serializes step failures as a plain { message, name } record.
      const failure = outcome.error as { message?: unknown };
      return typeof failure?.message === "string" ? failure.message : String(outcome.error);
    }
    return `status ${outcome.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Mastra featuresFlow", () => {
  it("registers named feature steps in order", () => {
    const { flow } = harness();
    expect(flow.id).toBe("featuresFlow");
    expect(Object.keys(flow.steps)).toEqual([...FEATURES_FLOW_STEPS]);
  });

  it("suspends at feature-selection with ticket chips, criteria checklist and advanced defaults", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "feature-selection",
    );
    const artifact = FeatureSelectionArtifactSchema.parse(payload.artifact);
    expect(artifact.ticket.key).toBe("FEAT-7");
    expect(artifact.candidates.map((candidate) => candidate.key)).toEqual(["FEAT-7", "FEAT-12"]);
    expect(artifact.repository).toBe("acme/app");
    expect(artifact.repositories).toEqual(["acme/app", "acme/lib", "acme/cli"]);
    expect(artifact.branches).toEqual(["main"]);
    expect(artifact.baseBranch).toBe("main");
    expect(artifact.acceptanceCriteria).toEqual([
      { id: "ac-1", text: "Users can filter orders by status", included: true },
      { id: "ac-2", text: "The selected filter survives a page reload", included: true },
    ]);
    expect(artifact.advanced).toEqual({ maxChangedFiles: 10, guidance: "" });
    expect(payload.target).toBe("branch:acme/app#feat/feat-7");
  });

  it("falls back to the ticket summary and deduplicates repeated criteria", async () => {
    const { flow } = harness();
    const fallback = new Walk({
      input: {
        ticketKey: "FEAT-7",
        ticketSummary: "Add status filters to the orders search page",
        repository: "acme/app",
        candidates: TICKET_CANDIDATES,
      },
    });
    const run = await flow.createRun();
    const payload = suspendView(
      await run.start({ inputData: fallback.envelope() }),
      "feature-selection",
    );
    expect(payload.artifact.acceptanceCriteria).toEqual([
      { id: "ac-1", text: "Add status filters to the orders search page", included: true },
    ]);

    const duplicated = new Walk({
      input: {
        ticketKey: "FEAT-7",
        ticketSummary: "Add status filters to the orders search page",
        repository: "acme/app",
        candidates: TICKET_CANDIDATES,
        acceptanceCriteria: ["Filters apply", " Filters apply ", "  ", "Reload keeps the filter"],
      },
    });
    const second = suspendView(
      await (await flow.createRun()).start({ inputData: duplicated.envelope() }),
      "feature-selection",
    );
    expect(second.artifact.acceptanceCriteria).toEqual([
      { id: "ac-1", text: "Filters apply", included: true },
      { id: "ac-2", text: "Reload keeps the filter", included: true },
    ]);
  });

  it("plans the scope against inspected files with all five area cards", async () => {
    const reader = new FakeFeatureReader();
    const model = new FakeModel();
    const { flow } = harness({ reader, model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "scope-design");
    expect(payload.target).toBe("branch:acme/app#feat/feat-7");
    const scope = ScopeDesignArtifactSchema.parse(payload.artifact);
    expect(scope.sourceSha).toBe(SOURCE_SHA);
    expect(scope.targetSummary).toContain("status filter");
    expect(scope.confidence).toBe(0.84);
    expect(scope.areas).toEqual([
      { id: "ui", label: "UI", enabled: true },
      { id: "api-data", label: "API & Data", enabled: false },
      { id: "state-logic", label: "State & Logic", enabled: true },
      { id: "tests", label: "Tests", enabled: true },
      { id: "docs-flags", label: "Docs & Flags", enabled: false },
    ]);
    expect(scope.guidance).toBe("");
    // Only text files inside the tree were read; the asset was skipped.
    expect(reader.contentCalls.map((call) => call.split(":")[1]?.split("@")[0])).toEqual([
      "src/orders/SearchPage.tsx",
      "src/orders/useOrders.ts",
      "src/config/app.json",
    ]);
    const context = model.planCalls[0]!;
    expect(context.files.map((file) => file.path)).toEqual([
      "src/orders/SearchPage.tsx",
      "src/orders/useOrders.ts",
      "src/config/app.json",
    ]);
    expect(
      context.selection.acceptanceCriteria.map((criterion) => criterion.id),
    ).toEqual(["ac-1", "ac-2"]);
  });

  it("produces the planned-changes list with per-file diffs, coverage and the review summary", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "implementation");
    expect(payload.target).toBe("branch:acme/app#feat/feat-7");
    const implementation = FeatureImplementationArtifactSchema.parse(payload.artifact);
    expect(implementation.verdict).toBe("ready");
    expect(implementation.files).toHaveLength(2);
    expect(implementation.files[0]).toMatchObject({
      path: "src/orders/SearchPage.tsx",
      status: "modified",
      area: "ui",
      additions: 1,
      deletions: 1,
    });
    expect(implementation.files[0]!.diff).toContain("-  return <OrderTable />;");
    expect(implementation.files[0]!.diff).toContain("+  return <OrderTable status={status} />;");
    expect(implementation.files[1]).toMatchObject({
      path: "src/orders/useOrderFilter.ts",
      status: "added",
      area: "state-logic",
      additions: 4,
      deletions: 0,
    });
    expect(implementation.files[1]!.diff.split("\n").every((line) => line.startsWith("+"))).toBe(
      true,
    );
    expect(implementation.criteriaCoverage).toEqual([
      {
        id: "ac-1",
        text: "Users can filter orders by status",
        covered: true,
        evidence: "src/orders/SearchPage.tsx",
      },
      {
        id: "ac-2",
        text: "The selected filter survives a page reload",
        covered: true,
        evidence: "src/orders/useOrderFilter.ts",
      },
    ]);
    expect(implementation.validation).toMatchObject({ passed: true, attempts: 1 });
    expect(implementation.repair).toEqual({ attempted: false, applied: false });
    expect(implementation.strengths).toHaveLength(1);
    expect(implementation.crossCuttingNotes).toHaveLength(1);
    // The review summary and cross-cutting callout are echoed on the artifact.
    expect(implementation.risksOpenQuestions).toHaveLength(1);
  });

  it("stops the engineer when a proposal falls outside the repository path policy", async () => {
    const reader = new FakeFeatureReader();
    reader.deniedPaths.add("package.json");
    const model = new FakeModel(
      [planOutput()],
      [
        implementationOutput({
          files: [
            {
              path: "src/orders/SearchPage.tsx",
              content: "export function SearchPage() {\n  return <OrderTable />;\n}\n",
              changeDescription: "Touch the page.",
              criteriaIds: ["ac-1"],
              area: "ui",
            },
            {
              path: "package.json",
              content: '{ "dependencies": {} }\n',
              changeDescription: "Declare a new dependency.",
              criteriaIds: ["ac-2"],
              area: "ui",
            },
          ],
        }),
      ],
    );
    const { flow } = harness({ reader, model });
    const walk = new Walk();
    await expect(walkTo(flow, walk, "implementation")).rejects.toThrow(
      "The engineer proposed files outside the repository policy: package.json",
    );
  });

  it("drops planned files outside the enabled areas and flags the uncovered criteria", async () => {
    const model = new FakeModel(
      [planOutput({ areas: ["ui", "docs-flags"] })],
      [
        implementationOutput({
          summary: "Filter plus docs.",
          files: [
            {
              path: "src/orders/SearchPage.tsx",
              content:
                'export function SearchPage() {\n  return <OrderTable status={status} />;\n}\n',
              changeDescription: "Render the status filter.",
              criteriaIds: ["ac-1"],
              area: "ui",
            },
            {
              path: "docs/orders.md",
              content: "Filters: use the status dropdown.\n",
              changeDescription: "Document the filter.",
              criteriaIds: ["ac-2"],
              area: "docs-flags",
            },
          ],
        }),
      ],
    );
    const { flow } = harness({ model });
    const walk = new Walk();
    const run = await flow.createRun();
    const selection = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "feature-selection",
    );
    walk.artifacts["feature-selection"] = selection.artifact;
    const scope = suspendView(
      await run.resume({
        resumeData: walk.resume("feature-selection", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "scope-design",
    );
    walk.artifacts["scope-design"] = scope.artifact;
    // Disable the docs area through the edit decision exactly like the scope surface does.
    const areas = (
      scope.artifact.areas as Array<{ id: string; label: string; enabled: boolean }>
    ).map((area) => (area.id === "docs-flags" ? { ...area, enabled: false } : area));
    const impl = suspendView(
      await run.resume({
        resumeData: walk.resume("scope-design", "edit", { edits: { areas }, actionHash: PROCEED_HASH }),
      }),
      "implementation",
    );
    const implementation = FeatureImplementationArtifactSchema.parse(impl.artifact);
    expect(implementation.files.map((file) => file.path)).toEqual(["src/orders/SearchPage.tsx"]);
    expect(implementation.criteriaCoverage).toEqual([
      {
        id: "ac-1",
        text: "Users can filter orders by status",
        covered: true,
        evidence: "src/orders/SearchPage.tsx",
      },
      {
        id: "ac-2",
        text: "The selected filter survives a page reload",
        covered: false,
        evidence: null,
      },
    ]);
  });

  it("keeps only included acceptance criteria in the coverage checklist", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const run = await flow.createRun();
    const selection = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "feature-selection",
    );
    walk.artifacts["feature-selection"] = selection.artifact;
    const scope = suspendView(
      await run.resume({
        resumeData: walk.resume("feature-selection", "edit", {
          edits: {
            acceptanceCriteria: [
              { id: "ac-1", text: "Users can filter orders by status", included: false },
              { id: "ac-2", text: "The selected filter survives a page reload", included: true },
            ],
          },
          actionHash: PROCEED_HASH,
        }),
      }),
      "scope-design",
    );
    expect(
      model.planCalls[0]?.selection.acceptanceCriteria.map((criterion) => [
        criterion.id,
        criterion.included,
      ]),
    ).toEqual([
      ["ac-1", false],
      ["ac-2", true],
    ]);
    walk.artifacts["scope-design"] = scope.artifact;
    const impl = suspendView(
      await run.resume({
        resumeData: walk.resume("scope-design", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "implementation",
    );
    const implementation = FeatureImplementationArtifactSchema.parse(impl.artifact);
    expect(implementation.criteriaCoverage).toEqual([
      {
        id: "ac-2",
        text: "The selected filter survives a page reload",
        covered: true,
        evidence: "src/orders/useOrderFilter.ts",
      },
    ]);
  });

  it("repairs once when validators fail and records the repair", async () => {
    const model = new FakeModel(
      [planOutput({ areas: ["api-data"] })],
      [
        implementationOutput({
          files: [
            {
              path: "src/config/app.json",
              content: "not json",
              changeDescription: "Persist the filter default.",
              criteriaIds: ["ac-1"],
              area: "api-data",
            },
          ],
        }),
        implementationOutput({
          summary: "Repaired the JSON.",
          files: [
            {
              path: "src/config/app.json",
              content: '{ "filters": true }\n',
              changeDescription: "Persist the filter default.",
              criteriaIds: ["ac-1"],
              area: "api-data",
            },
          ],
        }),
      ],
    );
    const { flow } = harness({ model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "implementation");
    expect(model.implementCalls).toHaveLength(2);
    expect(model.implementCalls[1]!.repairFeedback).toContain("json");
    expect(payload.artifact.validation).toMatchObject({ passed: true, attempts: 2 });
    expect(payload.artifact.repair).toEqual({ attempted: true, applied: true });
  });

  it("stops after one failed repair and lets the human decide", async () => {
    const badOutput = implementationOutput({
      files: [
        {
          path: "src/config/app.json",
          content: "still not json",
          changeDescription: "Persist the filter default.",
          criteriaIds: ["ac-1"],
          area: "api-data",
        },
      ],
    });
    const model = new FakeModel([planOutput({ areas: ["api-data"] })], [badOutput, badOutput]);
    const { flow } = harness({ model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "implementation");
    expect(model.implementCalls).toHaveLength(2);
    expect(payload.artifact.validation).toMatchObject({ passed: false, attempts: 2 });
    expect(payload.artifact.repair).toEqual({ attempted: true, applied: false });
  });

  it("opens the Draft PR with a bound receipt and the criteria checklist", async () => {
    const { flow, transport } = harness();
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "complete");
    expect(payload.artifact.branch).toBe("feat/feat-7");
    expect(payload.artifact.criteriaTotal).toBe(2);
    expect(payload.artifact.criteriaCovered).toBe(2);
    walk.artifacts["complete"] = payload.artifact;
    const receipt = await driveToCompletion(run, walk, 3, payload, "4".repeat(64));
    expect(receipt).toMatchObject({
      caseId: "case-1",
      ticketKey: "FEAT-7",
      branch: "feat/feat-7",
      ticketTransition: { ticketKey: "FEAT-7", targetStatus: "In Review" },
      validation: { passed: true, attempts: 1 },
      criteriaTotal: 2,
      criteriaCovered: 2,
    });
    expect(receipt.pr).toMatchObject({ draft: true, replayed: false });
    expect(transport.commitCreates).toBe(1);
    const pull = transport.pullRequests[0];
    expect(pull?.draft).toBe(true);
    expect(pull?.body).toContain("Patch hash:");
    expect(pull?.body).toContain("Acceptance criteria: 2/2 covered");
    expect(pull?.body).toContain("Ticket: FEAT-7");
    expect(pull?.body).toContain("- [x] ac-1: Users can filter orders by status");
  });

  it("replays an identical completed action from the recorded effect without applying", async () => {
    const model: FeaturesModel = {
      plan: async () => {
        throw new Error("the model must not run on a fully decided replay");
      },
      implement: async () => {
        throw new Error("the model must not run on a fully decided replay");
      },
    };
    const { flow, reader, transport } = harness({ model });
    const walk = new Walk();
    const actionHash = "9".repeat(64);
    walk.decisions["feature-selection"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["scope-design"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["implementation"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["complete"] = { action: "proceed", actionHash };
    walk.artifacts["feature-selection"] = FeatureSelectionArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      candidates: TICKET_CANDIDATES,
      repositories: [...POLICY.repositories],
      repository: "acme/app",
      branches: ["main"],
      baseBranch: "main",
      acceptanceCriteria: [
        { id: "ac-1", text: "Users can filter orders by status", included: true },
      ],
      advanced: { maxChangedFiles: 10, guidance: "" },
    });
    walk.artifacts["scope-design"] = ScopeDesignArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      repository: "acme/app",
      baseBranch: "main",
      sourceSha: SOURCE_SHA,
      targetSummary: "The orders search page gains a status filter.",
      confidence: 0.84,
      areas: [
        { id: "ui", label: "UI", enabled: true },
        { id: "api-data", label: "API & Data", enabled: false },
        { id: "state-logic", label: "State & Logic", enabled: true },
        { id: "tests", label: "Tests", enabled: false },
        { id: "docs-flags", label: "Docs & Flags", enabled: false },
      ],
      guidance: "",
    });
    walk.artifacts["implementation"] = FeatureImplementationArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      repository: "acme/app",
      baseBranch: "main",
      sourceSha: SOURCE_SHA,
      summary: "Added the status filter.",
      verdict: "ready",
      confidence: 0.82,
      strengths: [],
      risksOpenQuestions: [],
      crossCuttingNotes: [],
      areas: [
        { id: "ui", label: "UI", enabled: true },
        { id: "api-data", label: "API & Data", enabled: false },
        { id: "state-logic", label: "State & Logic", enabled: true },
        { id: "tests", label: "Tests", enabled: false },
        { id: "docs-flags", label: "Docs & Flags", enabled: false },
      ],
      files: [
        {
          path: "src/orders/SearchPage.tsx",
          status: "modified",
          area: "ui",
          changeDescription: "Render the status filter.",
          criteriaIds: ["ac-1"],
          additions: 1,
          deletions: 1,
          diff: "-  return <OrderTable />;\n+  return <OrderTable status={status} />;",
          content:
            'export function SearchPage() {\n  return <OrderTable status={status} />;\n}\n',
          validators: ["basic-syntax"],
        },
      ],
      criteriaCoverage: [
        {
          id: "ac-1",
          text: "Users can filter orders by status",
          covered: true,
          evidence: "src/orders/SearchPage.tsx",
        },
      ],
      validation: { passed: true, attempts: 1, results: [] },
      repair: { attempted: false, applied: false },
    });
    walk.artifacts["complete"] = FeatureCompletionArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      repository: "acme/app",
      baseBranch: "main",
      branch: "feat/feat-7",
      sourceSha: SOURCE_SHA,
      summary: "Added the status filter.",
      files: [
        {
          path: "src/orders/SearchPage.tsx",
          status: "modified",
          area: "ui",
          additions: 1,
          deletions: 1,
        },
      ],
      validation: { passed: true, attempts: 1, results: [] },
      criteriaCoverage: [
        {
          id: "ac-1",
          text: "Users can filter orders by status",
          covered: true,
          evidence: "src/orders/SearchPage.tsx",
        },
      ],
      criteriaTotal: 1,
      criteriaCovered: 1,
      ticketTransition: { ticketKey: "FEAT-7", targetStatus: "In Review" },
    });
    walk.effects["complete"] = {
      actionHash,
      receipt: {
        pr: {
          url: "https://github.example/acme/app/pull/1",
          number: 1,
          draft: true,
          branch: "feat/feat-7",
          baseBranch: "main",
          sourceSha: SOURCE_SHA,
          commitSha: "c".repeat(40),
          patchHash: "d".repeat(64),
          replayed: false,
        },
        caseId: "case-1",
        ticketKey: "FEAT-7",
        branch: "feat/feat-7",
        ticketTransition: { ticketKey: "FEAT-7", targetStatus: "In Review" },
        validation: { passed: true, attempts: 1 },
        criteriaTotal: 1,
        criteriaCovered: 1,
      },
    };
    const run = await flow.createRun();
    const started = await run.start({ inputData: walk.envelope() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.receipt).toMatchObject({ ticketKey: "FEAT-7", branch: "feat/feat-7" });
    expect(started.result.effects["complete"]?.actionHash).toBe(actionHash);
    expect(transport.writeCalls).toBe(0);
    expect(reader.sourceShaCalls).toHaveLength(0);
  });

  it("re-derives the scope from an edited selection before proceeding", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const run = await flow.createRun();
    const selection = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "feature-selection",
    );
    walk.artifacts["feature-selection"] = selection.artifact;
    const scope = suspendView(
      await run.resume({
        resumeData: walk.resume("feature-selection", "edit", {
          edits: {
            ticket: {
              key: "FEAT-12",
              summary: TICKET_CANDIDATES[1]!.summary,
              status: "To Do",
            },
          },
          actionHash: PROCEED_HASH,
        }),
      }),
      "scope-design",
    );
    expect(scope.target).toBe("branch:acme/app#feat/feat-12");
    expect(model.planCalls[0]?.selection.ticket.key).toBe("FEAT-12");
  });

  it("recomputes the scope with custom guidance on regenerate, then advances on proceed", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "scope-design");
    expect(model.planCalls.map((call) => call.guidance)).toEqual([undefined]);
    const regenerated = suspendView(
      await run.resume({
        resumeData: walk.resume("scope-design", "regenerate", {
          guidance: "Focus the plan on the filters module only.",
          regenerations: 1,
        }),
      }),
      "scope-design",
    );
    expect(model.planCalls.map((call) => call.guidance)).toEqual([
      undefined,
      "Focus the plan on the filters module only.",
    ]);
    walk.artifacts["scope-design"] = regenerated.artifact;
    const next = suspendView(
      await run.resume({
        resumeData: walk.resume("scope-design", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "implementation",
    );
    expect(next.target).toBe("branch:acme/app#feat/feat-7");
  });

  it("re-derives from the re-opened step when a back decision restarts the run", async () => {
    const { flow } = harness();
    const first = new Walk();
    const { payloads } = await walkTo(flow, first, "complete");

    // Back from implementation invalidates scope-design onward: a fresh attempt
    // carries only the earlier decisions/artifacts.
    const second = new Walk();
    second.attempt = 2;
    second.decisions["feature-selection"] = { action: "proceed", actionHash: PROCEED_HASH };
    second.artifacts["feature-selection"] = payloads["feature-selection"]!.artifact;
    const restarted = await flow.createRun();
    const payload = suspendView(
      await restarted.start({ inputData: second.envelope() }),
      "scope-design",
    );
    expect(payload.target).toBe("branch:acme/app#feat/feat-7");
  });

  it("fails when no acceptance criterion is included", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const selection = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "feature-selection",
    );
    walk.artifacts["feature-selection"] = selection.artifact;
    const scope = suspendView(
      await run.resume({
        resumeData: walk.resume("feature-selection", "edit", {
          edits: {
            acceptanceCriteria: [
              { id: "ac-1", text: "Users can filter orders by status", included: false },
              { id: "ac-2", text: "The selected filter survives a page reload", included: false },
            ],
          },
          actionHash: PROCEED_HASH,
        }),
      }),
      "scope-design",
    );
    walk.artifacts["scope-design"] = scope.artifact;
    const message = await failureMessage(
      run.resume({
        resumeData: walk.resume("scope-design", "proceed", { actionHash: PROCEED_HASH }),
      }),
    );
    expect(message).toContain("acceptance criterion");
  });

  it("keeps three concurrent feature runs on disjoint state", async () => {
    const repos = ["acme/app", "acme/lib", "acme/cli"] as const;
    const model: FeaturesModel = {
      plan: async (context) =>
        planOutput({ targetSummary: `Plan for ${context.selection.ticket.key}` }),
      implement: async (context) =>
        implementationOutput({
          summary: `Feature for ${context.input.ticketKey}`,
          files: [
            {
              path: "src/orders/SearchPage.tsx",
              content: `// ${context.input.ticketKey}\nexport function SearchPage() {\n  return <OrderTable status={status} />;\n}\n`,
              changeDescription: `Implement ${context.input.ticketKey}.`,
              criteriaIds: ["ac-1"],
              area: "ui",
            },
          ],
        }),
    };
    const scoped = new ScopedFeatureWriter();
    const { flow } = harness({ model, writer: scoped });
    const walks = repos.map(
      (repository, index) =>
        new Walk({
          runId: `run-${index + 1}`,
          ticketKey: `FEAT-${index + 1}`,
          input: {
            ticketKey: `FEAT-${index + 1}`,
            ticketSummary: `Feature ${index + 1}`,
            repository,
            candidates: [{ key: `FEAT-${index + 1}`, summary: `Feature ${index + 1}`, status: "To Do" }],
            acceptanceCriteria: ["Deliver the feature"],
          },
        }),
    );
    const starts = await Promise.all(
      walks.map(async (walk) => {
        const run = await flow.createRun();
        const payload = suspendView(
          await run.start({ inputData: walk.envelope() }),
          "feature-selection",
        );
        return { run, payload };
      }),
    );
    // Every selection stayed scoped to its own run's repository.
    starts.forEach((start, index) => {
      expect(start.payload.artifact.repository).toBe(repos[index]);
      expect(start.payload.target).toBe(`branch:${repos[index]}#feat/feat-${index + 1}`);
    });

    // Run 3 races ahead while runs 1 and 2 sit at their own checkpoints.
    const third = starts[2]!;
    const thirdScope = await runForward(third.run, walks[2]!, 0, third.payload, "scope-design");
    expect(thirdScope.artifact.targetSummary).toBe("Plan for FEAT-3");

    const receipts = await Promise.all([
      driveToCompletion(starts[0]!.run, walks[0]!, 0, starts[0]!.payload, "1".repeat(64)),
      driveToCompletion(starts[1]!.run, walks[1]!, 0, starts[1]!.payload, "2".repeat(64)),
      driveToCompletion(third.run, walks[2]!, 1, thirdScope, "3".repeat(64)),
    ]);

    // Each run shipped its own change; no cross-run state leaked into any receipt.
    expect(receipts.map((receipt) => receipt.branch).sort()).toEqual([
      "feat/feat-1",
      "feat/feat-2",
      "feat/feat-3",
    ]);
    expect(new Set(receipts.map((receipt) => receipt.ticketKey))).toEqual(
      new Set(["FEAT-1", "FEAT-2", "FEAT-3"]),
    );
    expect(scoped.applied.map((entry) => `${entry.repository}#${entry.branch}`).sort()).toEqual([
      "acme/app#feat/feat-1",
      "acme/cli#feat/feat-3",
      "acme/lib#feat/feat-2",
    ]);
    expect(scoped.applied.every((entry) => entry.body.includes("Patch hash:"))).toBe(true);
  });
});

describe("createFeaturesAgentModel", () => {
  const planContext: FeaturePlanModelContext = {
    input: { ticketKey: "FEAT-7", ticketSummary: "Task 2" },
    selection: FeatureSelectionArtifactSchema.parse({
      ticket: { key: "FEAT-7", summary: "Task 2", status: "In Progress" },
      candidates: [{ key: "FEAT-7", summary: "Task 2", status: "In Progress" }],
      repositories: ["acme/app"],
      repository: "acme/app",
      branches: ["main"],
      baseBranch: "main",
      acceptanceCriteria: [{ id: "ac-1", text: "Task 2", included: true }],
      advanced: { maxChangedFiles: 10, guidance: "" },
    }),
    sourceSha: SOURCE_SHA,
    files: [],
    guidance: undefined,
  };

  /** Planner stub replaying the answers in order and recording each prompt. */
  function stubPlanner(replies: ReadonlyArray<string | Error>): {
    agent: Agent;
    prompts: string[];
  } {
    const prompts: string[] = [];
    const agent = {
      async generate(prompt: string) {
        prompts.push(prompt);
        const reply = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
        if (reply instanceof Error) throw reply;
        return { text: reply };
      },
    } as unknown as Agent;
    return { agent, prompts };
  }

  it("re-asks the planner once when the first answer breaks the contract", async () => {
    const { agent, prompts } = stubPlanner([
      '{"targetSummary": "Unclear.", "confidence": 0.1, "areas": []}',
      '{"targetSummary": "Task 2 scoped.", "confidence": 0.1, "areas": ["state-logic"]}',
    ]);
    const model = createFeaturesAgentModel({ planner: agent });
    const output = await model.plan(planContext);
    expect(output.areas).toEqual(["state-logic"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("areas: Array must contain at least 1 element(s)");
    expect(prompts[1]).toContain("Return only the corrected JSON object.");
  });

  it("surfaces the violation when the repaired answer is still off-contract", async () => {
    const { agent, prompts } = stubPlanner([
      '{"targetSummary": "Unclear.", "confidence": 0.1, "areas": []}',
    ]);
    const model = createFeaturesAgentModel({ planner: agent });
    await expect(model.plan(planContext)).rejects.toThrow(
      "Planner contract violation: areas: Array must contain at least 1 element(s)",
    );
    expect(prompts).toHaveLength(2);
  });
});

describe("computeLineDiff", () => {
  it("marks added and removed lines for an edit", () => {
    const delta = computeLineDiff("one\ntwo\nthree", "one\nTWO\nthree");
    expect(delta).toEqual({
      diff: " one\n-two\n+TWO\n three",
      additions: 1,
      deletions: 1,
    });
  });

  it("treats an empty original as an all-added file", () => {
    const delta = computeLineDiff("", "a\nb");
    expect(delta).toEqual({ diff: "+a\n+b", additions: 2, deletions: 0 });
  });

  it("falls back to a whole-file replacement beyond the line cap", () => {
    const original = Array.from({ length: 1_600 }, (_, index) => `line ${index}`).join("\n");
    const modified = `${original}\nextra`;
    const delta = computeLineDiff(original, modified);
    expect(delta.additions).toBe(1_601);
    expect(delta.deletions).toBe(1_600);
    expect(delta.diff.split("\n")[0]).toBe("-line 0");
  });
});
