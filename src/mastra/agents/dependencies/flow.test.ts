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
  ApplyArtifactSchema,
  DEPENDENCIES_FLOW_STEPS,
  DependenciesRunStateSchema,
  GroupArtifactSchema,
  MergeArtifactSchema,
  ScanArtifactSchema,
  ValidateArtifactSchema,
  type DependencyAssessmentOutput,
  type DependencyRepairSuggestion,
  type DependenciesFlowStepId,
  type DependenciesRunState,
} from "./contracts.js";
import {
  bumpRange,
  computeLineDiff,
  dependencyBranch,
  jumpFor,
  replaceLockfileRanges,
  type DependencyAssessmentModelContext,
  type DependencyRepairModelContext,
  type DependenciesModel,
} from "./flow.js";
import type { DependencyReader, DependencyWriter } from "./tools/github-dependencies.js";
import type {
  DependencyQuery,
  DependencyRegistry,
  DependencyStatus,
} from "./tools/npm-registry.js";

const SOURCE_SHA = "a".repeat(40);
const PROCEED_HASH = "0".repeat(64);

const POLICY: GitHubPolicy = {
  repositories: ["acme/app", "acme/lib", "acme/cli"],
  baseBranch: "main",
  allowPaths: [
    "package.json",
    "package-lock.json",
    "src/**",
    "tests/**",
    "config/**",
    "docs/**",
  ],
  denyPaths: [".github/workflows/**"],
  destructivePaths: ["migrations/**"],
  maxFiles: 10,
  maxPatchBytes: 250_000,
  timeoutMs: 5_000,
};

const MANIFEST = [
  "{",
  '  "name": "acme-app",',
  '  "version": "1.0.0",',
  '  "dependencies": {',
  '    "express": "^4.18.2",',
  '    "react-router": "^5.3.4",',
  '    "zod": "^3.22.1"',
  "  },",
  '  "devDependencies": {',
  '    "typescript": "^5.4.0",',
  '    "vitest": "~1.2.0"',
  "  }",
  "}",
  "",
].join("\n");

/** Canonical formatting so the only lockfile diff is the bumped pins. */
const LOCKFILE =
  JSON.stringify(
    {
      name: "acme-app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "acme-app",
          version: "1.0.0",
          dependencies: { express: "^4.18.2", "react-router": "^5.3.4", zod: "^3.22.1" },
          devDependencies: { typescript: "^5.4.0", vitest: "~1.2.0" },
        },
        "node_modules/express": {
          version: "4.18.2",
          resolved: "https://registry.npmjs.org/express/-/express-4.18.2.tgz",
          integrity: "sha512-old-express",
        },
        "node_modules/react-router": {
          version: "5.3.4",
          resolved: "https://registry.npmjs.org/react-router/-/react-router-5.3.4.tgz",
          integrity: "sha512-old-router",
        },
        "node_modules/zod": {
          version: "3.22.1",
          resolved: "https://registry.npmjs.org/zod/-/zod-3.22.1.tgz",
          integrity: "sha512-old-zod",
        },
        "node_modules/vitest": {
          version: "1.2.0",
          resolved: "https://registry.npmjs.org/vitest/-/vitest-1.2.0.tgz",
          integrity: "sha512-old-vitest",
        },
      },
    },
    null,
    2,
  ) + "\n";

function status(overrides: Partial<DependencyStatus> & { name: string }): DependencyStatus {
  return {
    latest: "1.0.0",
    daysOutdated: 0,
    changelogExcerpt: "",
    resolved: null,
    integrity: null,
    vulnerabilities: [],
    ...overrides,
  };
}

const STATUSES: DependencyStatus[] = [
  status({
    name: "express",
    latest: "4.19.2",
    daysOutdated: 300,
    changelogExcerpt: "Adds res.sendFile coverage checks and hardens the query parser.",
    resolved: "https://registry.npmjs.org/express/-/express-4.19.2.tgz",
    integrity: "sha512-new-express",
    vulnerabilities: [
      {
        cve: "CVE-2024-29041",
        cvss: 6.1,
        severity: "moderate",
        summary: "Open redirect in express before 4.19.2.",
      },
    ],
  }),
  status({
    name: "react-router",
    latest: "6.26.0",
    daysOutdated: 900,
    changelogExcerpt: "Removes the v5 component APIs in favour of the data router.",
    resolved: "https://registry.npmjs.org/react-router/-/react-router-6.26.0.tgz",
    integrity: "sha512-new-router",
  }),
  status({ name: "typescript", latest: "5.4.0" }),
  status({
    name: "vitest",
    latest: "1.2.5",
    daysOutdated: 60,
    changelogExcerpt: "Fixes the watch-mode flake.",
    resolved: "https://registry.npmjs.org/vitest/-/vitest-1.2.5.tgz",
    integrity: "sha512-new-vitest",
  }),
  status({
    name: "zod",
    latest: "3.22.4",
    daysOutdated: 120,
    changelogExcerpt: "Fixes refine() inference.",
    resolved: "https://registry.npmjs.org/zod/-/zod-3.22.4.tgz",
    integrity: "sha512-new-zod",
  }),
];

function assessmentOutput(
  overrides: Partial<DependencyAssessmentOutput> = {},
): DependencyAssessmentOutput {
  return {
    summary:
      "Bumps zod and vitest within patch range, express across a minor upgrade, and react-router across a major upgrade.",
    confidence: 0.81,
    groups: [
      { id: "patch", breakingNotes: [] },
      {
        id: "minor",
        breakingNotes: ["express 4.19 deprecates res.sendfile in favour of res.sendFile."],
      },
      {
        id: "major",
        breakingNotes: [
          "react-router v6 removes the v5 route-component props — migrate the route table to the data router.",
        ],
      },
    ],
    ...overrides,
  };
}

function repairOutput(
  overrides: Partial<DependencyRepairSuggestion> = {},
): DependencyRepairSuggestion {
  return {
    suggestion: "Re-run the zod bump from the unedited manifest; the edited range cannot be written as JSON.",
    confidence: 0.64,
    ...overrides,
  };
}

class FakeDependencyReader implements DependencyReader {
  files: Record<string, string> = {
    "package.json": MANIFEST,
    "package-lock.json": LOCKFILE,
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

class FakeRegistry implements DependencyRegistry {
  readonly calls: DependencyQuery[][] = [];
  private readonly statuses: DependencyStatus[];

  constructor(statuses: DependencyStatus[] = STATUSES) {
    this.statuses = statuses;
  }

  async lookup(queries: readonly DependencyQuery[]): Promise<readonly DependencyStatus[]> {
    this.calls.push([...queries]);
    return queries.map((query) => {
      const match = this.statuses.find((entry) => entry.name === query.name);
      if (match === undefined) throw new Error(`missing fixture status for ${query.name}`);
      return match;
    });
  }
}

class FakeModel implements DependenciesModel {
  readonly assessCalls: DependencyAssessmentModelContext[] = [];
  readonly repairCalls: DependencyRepairModelContext[] = [];
  private readonly assessOutputs: DependencyAssessmentOutput[];
  private readonly repairOutputs: DependencyRepairSuggestion[];

  constructor(
    assessOutputs: DependencyAssessmentOutput[] = [assessmentOutput()],
    repairOutputs: DependencyRepairSuggestion[] = [repairOutput()],
  ) {
    this.assessOutputs = assessOutputs;
    this.repairOutputs = repairOutputs;
  }

  async assess(context: DependencyAssessmentModelContext): Promise<DependencyAssessmentOutput> {
    this.assessCalls.push(context);
    const index = Math.min(this.assessCalls.length - 1, this.assessOutputs.length - 1);
    return this.assessOutputs[index]!;
  }

  async suggestRepair(
    context: DependencyRepairModelContext,
  ): Promise<DependencyRepairSuggestion> {
    this.repairCalls.push(context);
    const index = Math.min(this.repairCalls.length - 1, this.repairOutputs.length - 1);
    return this.repairOutputs[index]!;
  }
}

/**
 * Branch-scoped stand-in for the authoring side of `GitHubWriter`. The suite's
 * shared `FakeGitHubTransport` keeps one branch head for every branch, so one
 * run opening three bump PRs would trip its durable-replay check; this fake
 * mirrors the same repository/branch/patch idempotency without that global.
 */
class ScopedDependencyWriter implements DependencyWriter {
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
    reader?: FakeDependencyReader;
    registry?: DependencyRegistry;
    model?: DependenciesModel;
    transport?: FakeGitHubTransport;
    writer?: DependencyWriter;
    liveWriter?: boolean;
  } = {},
) {
  const reader = options.reader ?? new FakeDependencyReader();
  const registry = options.registry ?? new FakeRegistry();
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
    (options.liveWriter === true ? tools.writer : new ScopedDependencyWriter());
  const model = options.model ?? new FakeModel();
  const mastra = createAllRounderMastra({
    dependencies: {
      github: { reader, writer },
      registry,
      repositories: POLICY.repositories,
      baseBranch: POLICY.baseBranch,
      model,
    },
  });
  const flow = mastra.getWorkflow("dependenciesFlow");
  if (flow === undefined) throw new Error("dependenciesFlow is not registered");
  return { reader, registry, transport, tools, writer, model, flow, mastra };
}

type DependenciesFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<DependenciesFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = { repository: "acme/app", baseBranch: "main" };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "acme-app";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): DependenciesRunState {
    return DependenciesRunStateSchema.parse({
      runId: this.runId,
      workflow: "dependencies",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): DependenciesRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return DependenciesRunStateSchema.parse({ ...this.envelope(), decision });
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
  stopAt: DependenciesFlowStepId,
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < DEPENDENCIES_FLOW_STEPS.length; index += 1) {
    const stepId = DEPENDENCIES_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, DEPENDENCIES_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: DependenciesFlowHandle,
  walk: Walk,
  stopAt: DependenciesFlowStepId,
): Promise<{ run: WorkflowRunHandle; payload: SuspendView }> {
  const run = await flow.createRun();
  const first = suspendView(
    await run.start({ inputData: walk.envelope() }),
    DEPENDENCIES_FLOW_STEPS[0],
  );
  const payload = await runForward(run, walk, 0, first, stopAt);
  return { run, payload };
}

/** Proceed from the suspension at `startIndex` through `merge`; returns the receipt. */
async function driveToCompletion(
  run: WorkflowRunHandle,
  walk: Walk,
  startIndex: number,
  currentPayload: SuspendView,
  actionHash: string,
): Promise<Record<string, unknown>> {
  let payload = currentPayload;
  for (let index = startIndex; index < DEPENDENCIES_FLOW_STEPS.length; index += 1) {
    const stepId = DEPENDENCIES_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    const outcome = await run.resume({ resumeData: walk.resume(stepId, "proceed", { actionHash }) });
    if (stepId === "merge") {
      const done = outcome as {
        status?: string;
        result?: { receipt?: Record<string, unknown> };
      };
      if (done.status !== "success" || done.result?.receipt === undefined) {
        throw new Error("run did not complete");
      }
      return done.result.receipt;
    }
    payload = suspendView(outcome, DEPENDENCIES_FLOW_STEPS[index + 1]!);
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

type LooseGroup = Record<string, unknown> & { id: string; packages: Array<Record<string, unknown>> };

/** Clone the apply groups so one can be mutated without touching the stored artifact. */
function editApplyGroups(
  artifact: Record<string, unknown>,
  mutate: (groups: LooseGroup[]) => LooseGroup[],
): { groups: LooseGroup[] } {
  const groups = (artifact.groups as LooseGroup[]).map((group) => ({
    ...group,
    packages: group.packages.map((pkg) => ({ ...pkg })),
  }));
  return { groups: mutate(groups) };
}

describe("Mastra dependenciesFlow", () => {
  it("registers named dependency steps in order", () => {
    const { flow } = harness();
    expect(flow.id).toBe("dependenciesFlow");
    expect(Object.keys(flow.steps)).toEqual([...DEPENDENCIES_FLOW_STEPS]);
  });

  it("suspends at scan with the inventory table, jump badges, CVE tags and totals", async () => {
    const registry = new FakeRegistry();
    const { flow } = harness({ registry });
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "scan");
    const artifact = ScanArtifactSchema.parse(payload.artifact);
    expect(payload.target).toBe("manifest:acme/app#package.json");
    expect(artifact.repository).toBe("acme/app");
    expect(artifact.baseBranch).toBe("main");
    expect(artifact.manifestPath).toBe("package.json");
    expect(artifact.sourceSha).toBe(SOURCE_SHA);
    // Vulnerable rows first, then by jump severity, then by name.
    expect(artifact.packages.map((pkg) => pkg.name)).toEqual([
      "express",
      "react-router",
      "vitest",
      "zod",
      "typescript",
    ]);
    expect(artifact.packages[0]).toMatchObject({
      name: "express",
      kind: "dependency",
      current: "^4.18.2",
      latest: "4.19.2",
      jump: "minor",
      daysOutdated: 300,
    });
    expect(artifact.packages[0]!.vulnerabilities).toEqual([
      {
        cve: "CVE-2024-29041",
        cvss: 6.1,
        severity: "moderate",
        summary: "Open redirect in express before 4.19.2.",
      },
    ]);
    expect(artifact.packages[2]).toMatchObject({ name: "vitest", kind: "devDependency", jump: "patch" });
    expect(artifact.packages[4]).toMatchObject({ name: "typescript", jump: "up_to_date" });
    expect(artifact.totals).toEqual({ packages: 5, outdated: 4, vulnerable: 1, major: 1 });
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0]!.map((query) => query.name)).toEqual([
      "express",
      "react-router",
      "zod",
      "typescript",
      "vitest",
    ]);
  });

  it("groups the outdated packages into patch/minor/major cards with risk notes", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "group");
    expect(payload.target).toBe("manifest:acme/app#package.json");
    const artifact = GroupArtifactSchema.parse(payload.artifact);
    expect(artifact.groups.map((group) => group.id)).toEqual(["patch", "minor", "major"]);
    expect(artifact.groups.map((group) => group.label)).toEqual(["Patch batch", "Minor", "Major"]);
    expect(artifact.groups.map((group) => group.riskNote)).toEqual([
      "Patch releases only — safe to auto-batch.",
      "Check deprecations before merging.",
      "Breaking-change assessment required — review each package.",
    ]);
    expect(artifact.groups[0]!.packages.map((pkg) => pkg.name)).toEqual(["vitest", "zod"]);
    expect(artifact.groups[1]!.packages.map((pkg) => pkg.name)).toEqual(["express"]);
    expect(artifact.groups[2]!.packages.map((pkg) => pkg.name)).toEqual(["react-router"]);
    // The up-to-date packages never enter a card.
    expect(
      artifact.groups.flatMap((group) => group.packages.map((pkg) => pkg.name)),
    ).not.toContain("typescript");
    expect(artifact.groups[2]!.packages[0]).toMatchObject({
      from: "^5.3.4",
      to: "6.26.0",
      excluded: false,
      excludeReason: "",
    });
  });

  it("applies deterministic manifest and lockfile bumps with per-group accept toggles", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "apply");
    const artifact = ApplyArtifactSchema.parse(payload.artifact);
    expect(artifact.manifestPath).toBe("package.json");
    expect(artifact.lockfilePath).toBe("package-lock.json");
    expect(artifact.summary).toBe(assessmentOutput().summary);
    expect(artifact.groups.map((group) => group.id)).toEqual(["patch", "minor", "major"]);
    expect(artifact.groups.every((group) => group.accepted)).toBe(true);
    expect(artifact.groups.every((group) => group.packages.every((pkg) => pkg.included))).toBe(true);
    // The minor group carries the CVE it fixes and its breaking notes.
    expect(artifact.groups[1]!.packages[0]!.vulnerabilities.map((vulnerability) => vulnerability.cve))
      .toEqual(["CVE-2024-29041"]);
    expect(artifact.groups[2]!.breakingNotes).toEqual([
      "react-router v6 removes the v5 route-component props — migrate the route table to the data router.",
    ]);
    // Manifest formatting survives: only the two patch ranges move.
    const patch = artifact.groups[0]!;
    expect(patch.manifest.content).toContain('"vitest": "~1.2.5"');
    expect(patch.manifest.content).toContain('"zod": "^3.22.4"');
    expect(patch.manifest.content).not.toContain("~1.2.0");
    expect(patch.manifest.diff).toContain('-    "zod": "^3.22.1"');
    expect(patch.manifest.diff).toContain('+    "zod": "^3.22.4"');
    expect(patch.manifest.additions).toBe(2);
    expect(patch.manifest.deletions).toBe(2);
    // The lockfile pins move too, resolved + integrity included.
    expect(patch.lockfile?.content).toContain('"version": "1.2.5"');
    expect(patch.lockfile?.content).toContain('"integrity": "sha512-new-zod"');
    expect(patch.lockfile?.content).toContain('"resolved": "https://registry.npmjs.org/zod/-/zod-3.22.4.tgz"');
    expect(artifact.groups[1]!.manifest.content).toContain('"express": "^4.19.2"');
    expect(artifact.groups[2]!.manifest.content).toContain('"react-router": "^6.26.0"');
    expect(model.assessCalls).toHaveLength(1);
    expect(model.assessCalls[0]!.guidance).toBeUndefined();
  });

  it("moves an excluded package out of the bundle and demands an exclude reason", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "group");
    walk.artifacts["group"] = payload.artifact;
    const edited = editApplyGroups(payload.artifact, (groups) =>
      groups.map((group) =>
        group.id === "patch"
          ? {
              ...group,
              packages: group.packages.map((pkg) =>
                pkg.name === "zod"
                  ? { ...pkg, excluded: true, excludeReason: "Pinned: the metrics migration still reads the 3.x API." }
                  : pkg,
              ),
            }
          : group,
      ),
    );
    const apply = suspendView(
      await run.resume({
        resumeData: walk.resume("group", "edit", { edits: edited, actionHash: PROCEED_HASH }),
      }),
      "apply",
    );
    const artifact = ApplyArtifactSchema.parse(apply.artifact);
    expect(artifact.groups[0]!.packages.map((pkg) => pkg.name)).toEqual(["vitest"]);
    // The excluded package keeps its pinned range untouched.
    expect(artifact.groups[0]!.manifest.content).toContain('"zod": "^3.22.1"');
    expect(artifact.groups[0]!.manifest.content).not.toContain('"zod": "^3.22.4"');
    expect(model.assessCalls[0]!.groups[0]!.packages.map((pkg) => pkg.name)).toEqual(["vitest"]);

    // A reasonless exclude is rejected before anything is bumped.
    const second = new Walk();
    const { run: secondRun, payload: secondGroup } = await walkTo(flow, second, "group");
    second.artifacts["group"] = secondGroup.artifact;
    const badEdit = editApplyGroups(secondGroup.artifact, (groups) =>
      groups.map((group) =>
        group.id === "patch"
          ? {
              ...group,
              packages: group.packages.map((pkg) =>
                pkg.name === "zod" ? { ...pkg, excluded: true, excludeReason: "" } : pkg,
              ),
            }
          : group,
      ),
    );
    const message = await failureMessage(
      secondRun.resume({
        resumeData: second.resume("group", "edit", { edits: badEdit, actionHash: PROCEED_HASH }),
      }),
    );
    expect(message).toContain("An exclude reason is required for zod");
  });

  it("recomputes validate from the include toggles and reports green installs", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "validate");
    const artifact = ValidateArtifactSchema.parse(payload.artifact);
    expect(artifact.groups.map((group) => group.id)).toEqual(["patch", "minor", "major"]);
    for (const group of artifact.groups) {
      expect(group.skipped).toBe(false);
      expect(group.status).toBe("green");
      expect(group.install).toEqual({
        passed: true,
        message: "Manifest and lockfile parse and pin the bumped versions.",
      });
      expect(group.tests).toMatchObject({ passed: 2, total: 2, failures: [] });
      expect(group.log).toContain("✓ json · package.json");
      expect(group.log).toContain("✓ json · package-lock.json");
      expect(group.suggestion).toBeNull();
    }
  });

  it("skips the groups the reviewer deselected and merges only the rest", async () => {
    const scoped = new ScopedDependencyWriter();
    const model = new FakeModel();
    const { flow } = harness({ writer: scoped, model });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "apply");
    walk.artifacts["apply"] = payload.artifact;
    const edited = editApplyGroups(payload.artifact, (groups) =>
      groups.map((group) => {
        if (group.id === "patch") return { ...group, accepted: false };
        if (group.id === "minor") {
          return {
            ...group,
            packages: group.packages.map((pkg) => ({ ...pkg, included: false })),
          };
        }
        return group;
      }),
    );
    const validate = suspendView(
      await run.resume({
        resumeData: walk.resume("apply", "edit", { edits: edited, actionHash: PROCEED_HASH }),
      }),
      "validate",
    );
    const artifact = ValidateArtifactSchema.parse(validate.artifact);
    expect(artifact.groups.map((group) => [group.id, group.skipped, group.status])).toEqual([
      ["patch", true, "skipped"],
      ["minor", true, "skipped"],
      ["major", false, "green"],
    ]);
    expect(artifact.groups[0]!.install).toEqual({
      passed: true,
      message: "Not included in this update.",
    });
    expect(model.repairCalls).toHaveLength(0);
    walk.artifacts["validate"] = validate.artifact;
    const merge = suspendView(
      await run.resume({
        resumeData: walk.resume("validate", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "merge",
    );
    const preview = MergeArtifactSchema.parse(merge.artifact);
    expect(preview.groups.map((group) => group.id)).toEqual(["major"]);
    expect(preview.groups[0]!.branch).toBe("deps/acme-app-major");
    const receipt = await driveToCompletion(run, walk, 4, merge, "4".repeat(64));
    expect((receipt.prs as Array<{ groupId: string }>).map((entry) => entry.groupId)).toEqual(["major"]);
    expect(scoped.applied).toHaveLength(1);
    expect(scoped.applied[0]!.branch).toBe("deps/acme-app-major");
    expect(scoped.applied[0]!.body).toContain("- react-router: ^5.3.4 → 6.26.0");
    expect(scoped.applied[0]!.body).not.toContain("- express:");
  });

  it("surfaces a failed group with one repair suggestion and gates the merge on it", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "apply");
    walk.artifacts["apply"] = payload.artifact;
    // An edited appliable range that cannot be written back as JSON.
    const broken = editApplyGroups(payload.artifact, (groups) =>
      groups.map((group) =>
        group.id === "patch"
          ? {
              ...group,
              packages: group.packages.map((pkg) =>
                pkg.name === "zod" ? { ...pkg, to: '3.22.4"broken' } : pkg,
              ),
            }
          : group,
      ),
    );
    const validate = suspendView(
      await run.resume({
        resumeData: walk.resume("apply", "edit", { edits: broken, actionHash: PROCEED_HASH }),
      }),
      "validate",
    );
    const artifact = ValidateArtifactSchema.parse(validate.artifact);
    const patch = artifact.groups.find((group) => group.id === "patch")!;
    expect(patch.status).toBe("failed");
    expect(patch.skipped).toBe(false);
    expect(patch.install.passed).toBe(false);
    expect(patch.tests.failures).toHaveLength(1);
    expect(patch.tests.failures[0]).toMatchObject({
      path: "package.json",
      validator: "json",
      message: "Invalid JSON",
      isNew: true,
    });
    expect(patch.log).toContain("✗ json · package.json");
    expect(patch.log).toContain("✓ json · package-lock.json");
    expect(patch.suggestion).toBe(repairOutput().suggestion);
    expect(model.repairCalls).toHaveLength(1);
    expect(model.repairCalls[0]!.groups.map((group) => group.id)).toEqual(["patch"]);
    expect(
      artifact.groups.filter((group) => group.status === "green").map((group) => group.id),
    ).toEqual(["minor", "major"]);

    // The merge gate refuses to open anything while the group is red.
    walk.artifacts["validate"] = validate.artifact;
    const message = await failureMessage(
      run.resume({
        resumeData: walk.resume("validate", "proceed", { actionHash: PROCEED_HASH }),
      }),
    );
    expect(message).toContain("still has failures");

    // Skipping the red group lets the healthy groups merge.
    const skipped = new Walk();
    const { run: skipRun, payload: skipApply } = await walkTo(flow, skipped, "apply");
    skipped.artifacts["apply"] = skipApply.artifact;
    const skipBroken = editApplyGroups(skipApply.artifact, (groups) =>
      groups.map((group) =>
        group.id === "patch"
          ? {
              ...group,
              packages: group.packages.map((pkg) =>
                pkg.name === "zod" ? { ...pkg, to: '3.22.4"broken' } : pkg,
              ),
            }
          : group,
      ),
    );
    const skipValidate = suspendView(
      await skipRun.resume({
        resumeData: skipped.resume("apply", "edit", {
          edits: skipBroken,
          actionHash: PROCEED_HASH,
        }),
      }),
      "validate",
    );
    const skipArtifact = ValidateArtifactSchema.parse(skipValidate.artifact);
    skipped.artifacts["validate"] = skipValidate.artifact;
    const skipEdit = {
      groups: skipArtifact.groups.map((group) =>
        group.id === "patch"
          ? { ...group, skipped: true, status: "skipped" as const, suggestion: null }
          : group,
      ),
    };
    const merge = suspendView(
      await skipRun.resume({
        resumeData: skipped.resume("validate", "edit", {
          edits: skipEdit,
          actionHash: PROCEED_HASH,
        }),
      }),
      "merge",
    );
    const preview = MergeArtifactSchema.parse(merge.artifact);
    expect(preview.groups.map((group) => group.id)).toEqual(["minor", "major"]);
    expect(preview.groups[0]!.cveFixes).toEqual(["CVE-2024-29041"]);
    const receipt = await driveToCompletion(skipRun, skipped, 4, merge, "9".repeat(64));
    expect(
      (receipt.prs as Array<{ groupId: string }>).map((entry) => entry.groupId),
    ).toEqual(["minor", "major"]);
    expect(receipt.cveFixes).toEqual(["CVE-2024-29041"]);
  });

  it("opens one Draft PR per surviving group through the live writer", async () => {
    const { flow, transport } = harness({ liveWriter: true });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "apply");
    walk.artifacts["apply"] = payload.artifact;
    const edited = editApplyGroups(payload.artifact, (groups) =>
      groups.map((group) => (group.id === "patch" ? group : { ...group, accepted: false })),
    );
    const validate = suspendView(
      await run.resume({
        resumeData: walk.resume("apply", "edit", { edits: edited, actionHash: PROCEED_HASH }),
      }),
      "validate",
    );
    walk.artifacts["validate"] = validate.artifact;
    const merge = suspendView(
      await run.resume({
        resumeData: walk.resume("validate", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "merge",
    );
    const receipt = await driveToCompletion(run, walk, 4, merge, "5".repeat(64));
    expect(receipt).toMatchObject({
      caseId: "case-1",
      repository: "acme/app",
      baseBranch: "main",
      cveFixes: [],
    });
    const prs = receipt.prs as Array<{ groupId: string; pr: { branch: string; draft: boolean } }>;
    expect(prs).toHaveLength(1);
    expect(prs[0]!.groupId).toBe("patch");
    expect(prs[0]!.pr).toMatchObject({ branch: "deps/acme-app-patch", draft: true, replayed: false });
    expect(transport.commitCreates).toBe(1);
    expect(transport.pullRequests).toHaveLength(1);
    const pull = transport.pullRequests[0]!;
    expect(pull.body).toContain("Patch hash:");
    expect(pull.body).toContain("- vitest: ~1.2.0 → 1.2.5");
    expect(pull.body).toContain("- zod: ^3.22.1 → 3.22.4");
    expect(pull.body).toContain("Validation");
    expect(pull.body).toContain("A human merges this pull request; CI runs on the branch.");
  });

  it("opens a Draft PR per group with CVE fixes called out and bound receipts", async () => {
    const scoped = new ScopedDependencyWriter();
    const { flow } = harness({ writer: scoped });
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "merge");
    walk.artifacts["merge"] = payload.artifact;
    const preview = MergeArtifactSchema.parse(payload.artifact);
    expect(preview.groups.map((group) => group.id)).toEqual(["patch", "minor", "major"]);
    expect(preview.groups.map((group) => group.branch)).toEqual([
      "deps/acme-app-patch",
      "deps/acme-app-minor",
      "deps/acme-app-major",
    ]);
    expect(preview.groups.map((group) => group.title)).toEqual([
      "Update patch dependencies (2)",
      "Update minor dependencies (1)",
      "Update major dependencies (1)",
    ]);
    expect(preview.groups[1]!.cveFixes).toEqual(["CVE-2024-29041"]);
    expect(preview.groups[1]!.packages).toEqual([{ name: "express", from: "^4.18.2", to: "4.19.2" }]);
    expect(preview.groups.every((group) => group.files.length === 2)).toBe(true);
    expect(preview.groups[0]!.files[0]).toMatchObject({
      path: "package.json",
      status: "modified",
      additions: 2,
      deletions: 2,
    });

    const receipt = await driveToCompletion(run, walk, 4, payload, "6".repeat(64));
    expect(
      (receipt.prs as Array<{ groupId: string }>).map((entry) => entry.groupId),
    ).toEqual(["patch", "minor", "major"]);
    expect(receipt.cveFixes).toEqual(["CVE-2024-29041"]);
    expect(scoped.applied).toHaveLength(3);
    const minor = scoped.applied.find((entry) => entry.branch === "deps/acme-app-minor")!;
    expect(minor.title).toBe("Update minor dependencies (1)");
    expect(minor.body).toContain("- express: ^4.18.2 → 4.19.2");
    expect(minor.body).toContain("CVE-2024-29041");
    expect(minor.files).toEqual(["package.json", "package-lock.json"]);
  });

  it("replays a completed action from the recorded effect without reading or writing", async () => {
    const scoped = new ScopedDependencyWriter();
    const { flow, reader } = harness({ writer: scoped });
    const first = new Walk();
    const { run: firstRun, payload: mergeView } = await walkTo(flow, first, "merge");
    first.artifacts["merge"] = mergeView.artifact;
    const receipt = await driveToCompletion(firstRun, first, 4, mergeView, "7".repeat(64));
    expect(scoped.applied).toHaveLength(3);
    const readerCalls = reader.sourceShaCalls.length;

    const replay = new Walk();
    replay.artifacts["scan"] = first.artifacts["scan"]!;
    replay.artifacts["group"] = first.artifacts["group"]!;
    replay.artifacts["apply"] = first.artifacts["apply"]!;
    replay.artifacts["validate"] = first.artifacts["validate"]!;
    replay.artifacts["merge"] = mergeView.artifact;
    replay.decisions["scan"] = { action: "proceed", actionHash: PROCEED_HASH };
    replay.decisions["group"] = { action: "proceed", actionHash: PROCEED_HASH };
    replay.decisions["apply"] = { action: "proceed", actionHash: PROCEED_HASH };
    replay.decisions["validate"] = { action: "proceed", actionHash: PROCEED_HASH };
    const actionHash = "8".repeat(64);
    replay.decisions["merge"] = { action: "proceed", actionHash };
    replay.effects["merge"] = { actionHash, receipt };

    const started = await (await flow.createRun()).start({ inputData: replay.envelope() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.receipt).toMatchObject({ repository: "acme/app", cveFixes: ["CVE-2024-29041"] });
    expect(started.result.effects["merge"]?.actionHash).toBe(actionHash);
    expect(scoped.applied).toHaveLength(3);
    expect(reader.sourceShaCalls).toHaveLength(readerCalls);
  });

  it("recomputes the apply artifacts with custom guidance on regenerate, then advances", async () => {
    const model = new FakeModel([
      assessmentOutput(),
      assessmentOutput({ summary: "Regenerated with the smallest possible bumps." }),
    ]);
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "apply");
    expect(model.assessCalls.map((call) => call.guidance)).toEqual([undefined]);
    const regenerated = suspendView(
      await run.resume({
        resumeData: walk.resume("apply", "regenerate", {
          guidance: "Prefer the smallest possible bumps and name the deprecations.",
          regenerations: 1,
        }),
      }),
      "apply",
    );
    expect(model.assessCalls.map((call) => call.guidance)).toEqual([
      undefined,
      "Prefer the smallest possible bumps and name the deprecations.",
    ]);
    const artifact = ApplyArtifactSchema.parse(regenerated.artifact);
    expect(artifact.summary).toBe("Regenerated with the smallest possible bumps.");
    walk.artifacts["apply"] = regenerated.artifact;
    const next = suspendView(
      await run.resume({
        resumeData: walk.resume("apply", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "validate",
    );
    expect(next.target).toBe("manifest:acme/app#package.json");
  });

  it("rejects unlisted repositories, unknown registry records and fully up-to-date manifests", async () => {
    const { flow } = harness();
    const unlisted = new Walk({ input: { repository: "acme/other", baseBranch: "main" } });
    const message = await failureMessage(
      flow.createRun().then((run) => run.start({ inputData: unlisted.envelope() })),
    );
    expect(message).toContain("acme/other is not allowlisted");

    const empty: DependencyRegistry = { lookup: async () => [] };
    const { flow: bareFlow } = harness({ registry: empty });
    const bare = new Walk();
    const unknown = await failureMessage(
      bareFlow.createRun().then((run) => run.start({ inputData: bare.envelope() })),
    );
    expect(unknown).toContain("The registry returned no record for express");

    const fresh: DependencyRegistry = {
      lookup: async (queries) =>
        queries.map((query) =>
          status({ name: query.name, latest: query.current.replace(/^[\^~]/, "") }),
        ),
    };
    const { flow: freshFlow } = harness({ registry: fresh });
    const current = new Walk();
    const run = await freshFlow.createRun();
    const scan = suspendView(await run.start({ inputData: current.envelope() }), "scan");
    current.artifacts["scan"] = scan.artifact;
    const outdated = await failureMessage(
      run.resume({
        resumeData: current.resume("scan", "proceed", { actionHash: PROCEED_HASH }),
      }),
    );
    expect(outdated).toContain("No outdated dependencies to group");
  });

  it("keeps three concurrent dependency runs on disjoint state", async () => {
    const repos = ["acme/app", "acme/lib", "acme/cli"] as const;
    const scoped = new ScopedDependencyWriter();
    const { flow } = harness({ writer: scoped });
    const walks = repos.map(
      (repository, index) =>
        new Walk({
          runId: `run-${index + 1}`,
          ticketKey: `dep-bump-${index + 1}`,
          input: { repository, baseBranch: "main" },
        }),
    );
    const starts = await Promise.all(
      walks.map(async (walk) => {
        const run = await flow.createRun();
        const payload = suspendView(await run.start({ inputData: walk.envelope() }), "scan");
        return { run, payload };
      }),
    );
    // Every scan stayed scoped to its own run's repository.
    starts.forEach((start, index) => {
      expect(start.payload.artifact.repository).toBe(repos[index]);
      expect(start.payload.target).toBe(`manifest:${repos[index]}#package.json`);
    });

    // Run 3 races ahead while runs 1 and 2 sit at their own checkpoints.
    const third = starts[2]!;
    const thirdValidate = await runForward(third.run, walks[2]!, 0, third.payload, "validate");
    const thirdArtifact = ValidateArtifactSchema.parse(thirdValidate.artifact);
    expect(thirdArtifact.repository).toBe("acme/cli");

    const receipts = await Promise.all([
      driveToCompletion(starts[0]!.run, walks[0]!, 0, starts[0]!.payload, "1".repeat(64)),
      driveToCompletion(starts[1]!.run, walks[1]!, 0, starts[1]!.payload, "2".repeat(64)),
      driveToCompletion(third.run, walks[2]!, 3, thirdValidate, "3".repeat(64)),
    ]);

    // Each run shipped its own bumps; no cross-run state leaked into any receipt.
    expect(receipts.map((receipt) => receipt.repository).sort()).toEqual([...repos].sort());
    receipts.forEach((receipt, index) => {
      const slug = repos[index]!.replace("/", "-");
      expect(
        (receipt.prs as Array<{ pr: { branch: string } }>)
          .map((entry) => entry.pr.branch)
          .sort(),
      ).toEqual([`deps/${slug}-major`, `deps/${slug}-minor`, `deps/${slug}-patch`]);
    });
    expect(scoped.applied).toHaveLength(9);
    expect(new Set(scoped.applied.map((entry) => entry.repository))).toEqual(new Set(repos));
  });
});

describe("dependency version helpers", () => {
  it("classifies the semver jump from the pinned range", () => {
    expect(jumpFor("^1.2.3", "2.0.0")).toBe("major");
    expect(jumpFor("~1.2.3", "1.3.0")).toBe("minor");
    expect(jumpFor("1.2.3", "1.2.4")).toBe("patch");
    expect(jumpFor("^1.2.3", "1.2.3")).toBe("up_to_date");
    expect(jumpFor("^2.0.0", "1.9.9")).toBe("up_to_date");
    expect(jumpFor("workspace:*", "1.2.3")).toBe("up_to_date");
  });

  it("keeps the range style while bumping", () => {
    expect(bumpRange("^1.2.3", "2.0.0")).toBe("^2.0.0");
    expect(bumpRange("~1.2.3", "1.3.0")).toBe("~1.3.0");
    expect(bumpRange("1.2.3", "1.2.4")).toBe("1.2.4");
  });

  it("derives deterministic branch names", () => {
    expect(dependencyBranch("acme/app", "patch")).toBe("deps/acme-app-patch");
    expect(dependencyBranch("Acme/App ", "major")).toBe("deps/acme-app-major");
  });

  it("degrades an unreadable lockfile to a manifest-only update", () => {
    expect(replaceLockfileRanges("not json", [])).toBeNull();
  });

  it("marks added and removed lines for an edit", () => {
    const delta = computeLineDiff("one\ntwo\nthree", "one\nTWO\nthree");
    expect(delta).toEqual({
      diff: " one\n-two\n+TWO\n three",
      additions: 1,
      deletions: 1,
    });
  });
});
