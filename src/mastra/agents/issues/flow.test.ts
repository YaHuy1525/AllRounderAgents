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
  ISSUES_FLOW_STEPS,
  IssueAnalysisArtifactSchema,
  IssueCompletionArtifactSchema,
  IssueImplementationArtifactSchema,
  IssuesRunStateSchema,
  IssueSelectionArtifactSchema,
  type IssueAnalysisOutput,
  type IssueImplementationOutput,
  type IssuesRunState,
  type IssuesFlowStepId,
} from "./contracts.js";
import {
  computeLineDiff,
  createIssuesAgentModel,
  type IssueAnalysisModelContext,
  type IssueImplementationModelContext,
  type IssuesModel,
} from "./flow.js";
import type { IssueReader, IssueWriter } from "./tools/github-issues.js";

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
  { key: "ABC-42", summary: "Profile page crashes when the address is missing", status: "In review" },
  { key: "ABC-99", summary: "Avatar upload ignores the size limit", status: "To Do" },
];

function analysisOutput(overrides: Partial<IssueAnalysisOutput> = {}): IssueAnalysisOutput {
  return {
    summary: "loadProfile dereferences raw.address without a guard.",
    confidence: 0.86,
    similarUpdates: [
      { reference: "src/profile/settings.ts", note: "Sibling loader guards the same raw shape." },
    ],
    affectedFiles: [
      {
        path: "src/profile/loader.ts",
        startLine: 2,
        endLine: 2,
        changeDescription: "Guard the address access and default the city.",
        validators: ["basic-syntax"],
      },
    ],
    regressionTest: {
      path: "tests/profile/loader.test.ts",
      description: "Add a case for a missing address and assert no throw.",
    },
    ...overrides,
  };
}

function implementationOutput(
  overrides: Partial<IssueImplementationOutput> = {},
): IssueImplementationOutput {
  return {
    summary: "Guarded the address access and defaulted the city.",
    files: [
      {
        path: "src/profile/loader.ts",
        content:
          'export function loadProfile(raw) {\n  return raw.address?.city ?? "Unknown";\n}\n',
        validators: ["basic-syntax"],
      },
    ],
    regressionTest: {
      path: "tests/profile/loader.test.ts",
      content:
        'test("missing address does not throw", () => {\n  expect(true).toBe(true);\n});\n',
    },
    ...overrides,
  };
}

class FakeIssueReader implements IssueReader {
  tree = [
    "src/profile/loader.ts",
    "src/profile/settings.ts",
    "src/config/app.json",
    "assets/logo.png",
  ];
  files: Record<string, string> = {
    "src/profile/loader.ts":
      "export function loadProfile(raw) {\n  return raw.address.city;\n}\n",
    "src/profile/settings.ts": "export function saveSettings(raw) {\n  return raw.settings;\n}\n",
    "src/config/app.json": '{ "retries": "three" }\n',
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

class FakeModel implements IssuesModel {
  readonly analyseCalls: IssueAnalysisModelContext[] = [];
  readonly implementCalls: IssueImplementationModelContext[] = [];
  private readonly analyseOutputs: IssueAnalysisOutput[];
  private readonly implementOutputs: IssueImplementationOutput[];

  constructor(
    analyseOutputs: IssueAnalysisOutput[] = [analysisOutput()],
    implementOutputs: IssueImplementationOutput[] = [implementationOutput()],
  ) {
    this.analyseOutputs = analyseOutputs;
    this.implementOutputs = implementOutputs;
  }

  async analyse(context: IssueAnalysisModelContext): Promise<IssueAnalysisOutput> {
    this.analyseCalls.push(context);
    const index = Math.min(this.analyseCalls.length - 1, this.analyseOutputs.length - 1);
    return this.analyseOutputs[index]!;
  }

  async implement(context: IssueImplementationModelContext): Promise<IssueImplementationOutput> {
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
class ScopedIssueWriter implements IssueWriter {
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
    reader?: FakeIssueReader;
    model?: IssuesModel;
    transport?: FakeGitHubTransport;
    writer?: IssueWriter;
  } = {},
) {
  const reader = options.reader ?? new FakeIssueReader();
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
    issues: {
      github: { reader, writer },
      repositories: POLICY.repositories,
      baseBranch: POLICY.baseBranch,
      model: options.model ?? new FakeModel(),
      analysisFileLimit: 8,
    },
  });
  const flow = mastra.getWorkflow("issuesFlow");
  if (flow === undefined) throw new Error("issuesFlow is not registered");
  return { reader, transport, writer, flow, mastra };
}

type IssuesFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<IssuesFlowHandle["createRun"]>>;

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
    ticketKey: "ABC-42",
    ticketSummary: "Profile page crashes when the address is missing",
    repository: "acme/app",
    candidates: TICKET_CANDIDATES,
  };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "ABC-42";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): IssuesRunState {
    return IssuesRunStateSchema.parse({
      runId: this.runId,
      workflow: "issues",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): IssuesRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return IssuesRunStateSchema.parse({ ...this.envelope(), decision });
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
  stopAt: IssuesFlowStepId,
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < ISSUES_FLOW_STEPS.length; index += 1) {
    const stepId = ISSUES_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, ISSUES_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkTo(
  flow: IssuesFlowHandle,
  walk: Walk,
  stopAt: IssuesFlowStepId,
): Promise<{ run: WorkflowRunHandle; payload: SuspendView; payloads: Record<string, SuspendView> }> {
  const payloads: Record<string, SuspendView> = {};
  const run = await flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), ISSUES_FLOW_STEPS[0]);
  payloads[ISSUES_FLOW_STEPS[0]] = first;
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
  for (let index = startIndex; index < ISSUES_FLOW_STEPS.length; index += 1) {
    const stepId = ISSUES_FLOW_STEPS[index]!;
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
    payload = suspendView(outcome, ISSUES_FLOW_STEPS[index + 1]!);
  }
  throw new Error("unreachable");
}

describe("Mastra issuesFlow", () => {
  it("registers named issue steps in order", () => {
    const { flow } = harness();
    expect(flow.id).toBe("issuesFlow");
    expect(Object.keys(flow.steps)).toEqual([...ISSUES_FLOW_STEPS]);
  });

  it("suspends at issue-selection with ticket chips, pickers and advanced defaults", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "issue-selection",
    );
    const artifact = IssueSelectionArtifactSchema.parse(payload.artifact);
    expect(artifact.ticket.key).toBe("ABC-42");
    expect(artifact.candidates.map((candidate) => candidate.key)).toEqual(["ABC-42", "ABC-99"]);
    expect(artifact.repository).toBe("acme/app");
    expect(artifact.repositories).toEqual(["acme/app", "acme/lib", "acme/cli"]);
    expect(artifact.branches).toEqual(["main"]);
    expect(artifact.baseBranch).toBe("main");
    expect(artifact.advanced).toEqual({
      includeRegressionTest: true,
      maxChangedFiles: 10,
      guidance: "",
    });
    expect(payload.target).toBe("branch:acme/app#fix/abc-42");
  });

  it("analyses only inspected files and carries the regression-test cross-link", async () => {
    const reader = new FakeIssueReader();
    const model = new FakeModel([
      analysisOutput({
        affectedFiles: [
          analysisOutput().affectedFiles[0]!,
          {
            path: "src/legacy/old.ts",
            startLine: 1,
            endLine: 3,
            changeDescription: "Not inspected; must be dropped.",
            validators: ["basic-syntax"],
          },
        ],
      }),
    ]);
    const { flow } = harness({ reader, model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "analysis");
    expect(payload.target).toBe("branch:acme/app#fix/abc-42");
    expect(payload.artifact.affectedFiles).toMatchObject([{ path: "src/profile/loader.ts" }]);
    expect(payload.artifact.regressionTest).toMatchObject({
      path: "tests/profile/loader.test.ts",
    });
    expect(payload.artifact.similarUpdates).toHaveLength(1);
    expect(payload.artifact.sourceSha).toBe(SOURCE_SHA);
    // Only text files inside the tree were read; the asset was skipped.
    expect(reader.contentCalls.map((call) => call.split(":")[1]?.split("@")[0])).toEqual([
      "src/profile/loader.ts",
      "src/profile/settings.ts",
      "src/config/app.json",
    ]);
    const context = model.analyseCalls[0]!;
    expect(context.files.map((file) => file.path)).toEqual([
      "src/profile/loader.ts",
      "src/profile/settings.ts",
      "src/config/app.json",
    ]);
  });

  it("produces per-file diffs, validator results and the regression test", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "implementation");
    expect(payload.target).toBe("branch:acme/app#fix/abc-42");
    const implementation = payload.artifact as {
      files: Array<{ path: string; status: string; additions: number; deletions: number; diff: string }>;
      regressionTest: { path: string; diff: string } | null;
      validation: { passed: boolean; attempts: number };
      repair: { attempted: boolean; applied: boolean };
    };
    expect(implementation.files).toHaveLength(1);
    expect(implementation.files[0]).toMatchObject({
      path: "src/profile/loader.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
    });
    expect(implementation.files[0]!.diff).toContain(
      '-  return raw.address.city;',
    );
    expect(implementation.files[0]!.diff).toContain(
      '+  return raw.address?.city ?? "Unknown";',
    );
    expect(implementation.regressionTest?.path).toBe("tests/profile/loader.test.ts");
    expect(implementation.regressionTest?.diff.split("\n").every((line) => line.startsWith("+"))).toBe(
      true,
    );
    expect(implementation.validation).toMatchObject({ passed: true, attempts: 1 });
    expect(implementation.repair).toEqual({ attempted: false, applied: false });
  });

  it("stops the engineer when a proposal falls outside the repository path policy", async () => {
    const reader = new FakeIssueReader();
    reader.deniedPaths.add("infra/deploy.ts");
    const model = new FakeModel(
      [analysisOutput()],
      [
        implementationOutput({
          files: [
            {
              path: "src/profile/loader.ts",
              content:
                'export function loadProfile(raw) {\n  return raw.address?.city ?? "Unknown";\n}\n',
              validators: ["basic-syntax"],
            },
            {
              path: "infra/deploy.ts",
              content: "export const tier = 1;\n",
              validators: ["basic-syntax"],
            },
          ],
        }),
      ],
    );
    const { flow } = harness({ reader, model });
    const walk = new Walk();
    await expect(walkTo(flow, walk, "implementation")).rejects.toThrow(
      "The engineer proposed files outside the repository policy: infra/deploy.ts",
    );
  });

  it("repairs once when validators fail and records the repair", async () => {
    const model = new FakeModel(
      [
        analysisOutput({
          affectedFiles: [
            {
              path: "src/config/app.json",
              startLine: 1,
              endLine: 1,
              changeDescription: "Fix the retry count type.",
              validators: ["json"],
            },
          ],
        }),
      ],
      [
        implementationOutput({
          files: [
            { path: "src/config/app.json", content: "not json", validators: ["json"] },
          ],
        }),
        implementationOutput({
          summary: "Repaired the JSON.",
          files: [
            { path: "src/config/app.json", content: '{ "retries": 3 }\n', validators: ["json"] },
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
      files: [{ path: "src/config/app.json", content: "still not json", validators: ["json"] }],
    });
    const model = new FakeModel(
      [
        analysisOutput({
          affectedFiles: [
            {
              path: "src/config/app.json",
              startLine: 1,
              endLine: 1,
              changeDescription: "Fix the retry count type.",
              validators: ["json"],
            },
          ],
        }),
      ],
      [badOutput, badOutput],
    );
    const { flow } = harness({ model });
    const walk = new Walk();
    const { payload } = await walkTo(flow, walk, "implementation");
    expect(model.implementCalls).toHaveLength(2);
    expect(payload.artifact.validation).toMatchObject({ passed: false, attempts: 2 });
    expect(payload.artifact.repair).toEqual({ attempted: true, applied: false });
  });

  it("opens the Draft PR with a bound receipt and writes the ticket transition", async () => {
    const { flow, transport } = harness();
    const walk = new Walk();
    const { run, payload } = await walkTo(flow, walk, "complete");
    expect(payload.artifact.branch).toBe("fix/abc-42");
    walk.artifacts["complete"] = payload.artifact;
    const receipt = await driveToCompletion(run, walk, 3, payload, "4".repeat(64));
    expect(receipt).toMatchObject({
      caseId: "case-1",
      ticketKey: "ABC-42",
      branch: "fix/abc-42",
      ticketTransition: { ticketKey: "ABC-42", targetStatus: "In Review" },
      validation: { passed: true, attempts: 1 },
      regressionTestPath: "tests/profile/loader.test.ts",
    });
    expect(receipt.pr).toMatchObject({ draft: true, replayed: false });
    expect(transport.commitCreates).toBe(1);
    const pull = transport.pullRequests[0];
    expect(pull?.draft).toBe(true);
    expect(pull?.body).toContain("Patch hash:");
    expect(pull?.body).toContain("Regression test: tests/profile/loader.test.ts");
    expect(pull?.body).toContain("Ticket: ABC-42");
  });

  it("replays an identical completed action from the recorded effect without applying", async () => {
    const model: IssuesModel = {
      analyse: async () => {
        throw new Error("the model must not run on a fully decided replay");
      },
      implement: async () => {
        throw new Error("the model must not run on a fully decided replay");
      },
    };
    const { flow, transport } = harness({ model });
    const walk = new Walk();
    const actionHash = "9".repeat(64);
    walk.decisions["issue-selection"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["analysis"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["implementation"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["complete"] = { action: "proceed", actionHash };
    walk.artifacts["issue-selection"] = IssueSelectionArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      candidates: TICKET_CANDIDATES,
      repositories: [...POLICY.repositories],
      repository: "acme/app",
      branches: ["main"],
      baseBranch: "main",
      advanced: { includeRegressionTest: true, maxChangedFiles: 10, guidance: "" },
    });
    walk.artifacts["analysis"] = IssueAnalysisArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      repository: "acme/app",
      baseBranch: "main",
      sourceSha: SOURCE_SHA,
      summary: "loadProfile dereferences raw.address without a guard.",
      confidence: 0.86,
      similarUpdates: [],
      affectedFiles: [
        {
          path: "src/profile/loader.ts",
          startLine: 2,
          endLine: 2,
          changeDescription: "Guard the address access and default the city.",
          validators: ["basic-syntax"],
        },
      ],
      regressionTest: {
        path: "tests/profile/loader.test.ts",
        description: "Add a case for a missing address and assert no throw.",
      },
    });
    walk.artifacts["implementation"] = IssueImplementationArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      repository: "acme/app",
      baseBranch: "main",
      sourceSha: SOURCE_SHA,
      summary: "Guarded the address access and defaulted the city.",
      files: [
        {
          path: "src/profile/loader.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          diff: "-  return raw.address.city;\n+  return raw.address?.city;",
          content:
            'export function loadProfile(raw) {\n  return raw.address?.city ?? "Unknown";\n}\n',
          validators: ["basic-syntax"],
        },
      ],
      regressionTest: {
        path: "tests/profile/loader.test.ts",
        content: 'test("missing address does not throw", () => {\n  expect(true).toBe(true);\n});\n',
        additions: 3,
        deletions: 0,
        diff: '+test("missing address does not throw", () => {\n+  expect(true).toBe(true);\n+});',
      },
      validation: { passed: true, attempts: 1, results: [] },
      repair: { attempted: false, applied: false },
    });
    walk.artifacts["complete"] = IssueCompletionArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      repository: "acme/app",
      baseBranch: "main",
      branch: "fix/abc-42",
      sourceSha: SOURCE_SHA,
      summary: "Guarded the address access.",
      files: [
        {
          path: "src/profile/loader.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
        },
      ],
      validation: { passed: true, attempts: 1, results: [] },
      regressionTestPath: "tests/profile/loader.test.ts",
      ticketTransition: { ticketKey: "ABC-42", targetStatus: "In Review" },
    });
    walk.effects["complete"] = {
      actionHash,
      receipt: {
        pr: {
          url: "https://github.example/acme/app/pull/1",
          number: 1,
          draft: true,
          branch: "fix/abc-42",
          baseBranch: "main",
          sourceSha: SOURCE_SHA,
          commitSha: "c".repeat(40),
          patchHash: "d".repeat(64),
          replayed: false,
        },
        caseId: "case-1",
        ticketKey: "ABC-42",
        branch: "fix/abc-42",
        ticketTransition: { ticketKey: "ABC-42", targetStatus: "In Review" },
        validation: { passed: true, attempts: 1 },
        regressionTestPath: "tests/profile/loader.test.ts",
      },
    };
    const run = await flow.createRun();
    const started = await run.start({ inputData: walk.envelope() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.receipt).toMatchObject({ ticketKey: "ABC-42", branch: "fix/abc-42" });
    expect(started.result.effects["complete"]?.actionHash).toBe(actionHash);
    expect(transport.writeCalls).toBe(0);
  });

  it("re-derives the analysis from an edited selection before proceeding", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const run = await flow.createRun();
    const selection = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "issue-selection",
    );
    walk.artifacts["issue-selection"] = selection.artifact;
    const analysis = suspendView(
      await run.resume({
        resumeData: walk.resume("issue-selection", "edit", {
          edits: {
            ticket: { key: "ABC-99", summary: TICKET_CANDIDATES[1]!.summary, status: "To Do" },
          },
          actionHash: PROCEED_HASH,
        }),
      }),
      "analysis",
    );
    expect(analysis.target).toBe("branch:acme/app#fix/abc-99");
    expect(model.analyseCalls[0]?.selection.ticket.key).toBe("ABC-99");
  });

  it("recomputes the analysis with custom guidance on regenerate, then advances on proceed", async () => {
    const model = new FakeModel();
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "analysis");
    expect(model.analyseCalls.map((call) => call.guidance)).toEqual([undefined]);
    const regenerated = suspendView(
      await run.resume({
        resumeData: walk.resume("analysis", "regenerate", {
          guidance: "Cite only files under src/profile.",
          regenerations: 1,
        }),
      }),
      "analysis",
    );
    expect(model.analyseCalls.map((call) => call.guidance)).toEqual([
      undefined,
      "Cite only files under src/profile.",
    ]);
    walk.artifacts["analysis"] = regenerated.artifact;
    const next = suspendView(
      await run.resume({
        resumeData: walk.resume("analysis", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "implementation",
    );
    expect(next.target).toBe("branch:acme/app#fix/abc-42");
  });

  it("re-derives from the re-opened step when a back decision restarts the run", async () => {
    const { flow } = harness();
    const first = new Walk();
    const { payloads } = await walkTo(flow, first, "complete");

    // Back from implementation invalidates analysis onward: a fresh attempt
    // carries only the earlier decisions/artifacts.
    const second = new Walk();
    second.attempt = 2;
    second.decisions["issue-selection"] = { action: "proceed", actionHash: PROCEED_HASH };
    second.artifacts["issue-selection"] = payloads["issue-selection"]!.artifact;
    const restarted = await flow.createRun();
    const payload = suspendView(
      await restarted.start({ inputData: second.envelope() }),
      "analysis",
    );
    expect(payload.target).toBe("branch:acme/app#fix/abc-42");
  });

  it("fails when the engineer omits the required regression test", async () => {
    const model = new FakeModel(
      [analysisOutput()],
      [implementationOutput({ regressionTest: null })],
    );
    const { flow } = harness({ model });
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "analysis");
    let message = "";
    try {
      const outcome = await run.resume({
        resumeData: walk.resume("analysis", "proceed", { actionHash: PROCEED_HASH }),
      });
      if (outcome.status === "failed") {
        // Mastra serializes step failures as a plain { message, name } record.
        const failure = outcome.error as { message?: unknown };
        message = typeof failure.message === "string" ? failure.message : String(outcome.error);
      } else {
        message = `status ${outcome.status}`;
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("regression test");
    expect(model.implementCalls).toHaveLength(1);
  });

  it("skips the regression test when the selection turns it off", async () => {
    const { flow, transport } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const selection = suspendView(
      await run.start({ inputData: walk.envelope() }),
      "issue-selection",
    );
    walk.artifacts["issue-selection"] = selection.artifact;
    const analysis = suspendView(
      await run.resume({
        resumeData: walk.resume("issue-selection", "edit", {
          edits: {
            advanced: { includeRegressionTest: false, maxChangedFiles: 5, guidance: "" },
          },
          actionHash: PROCEED_HASH,
        }),
      }),
      "analysis",
    );
    const complete = await runForward(run, walk, 1, analysis, "complete");
    expect(complete.artifact.regressionTestPath).toBeNull();
    walk.artifacts["complete"] = complete.artifact;
    const receipt = await driveToCompletion(run, walk, 3, complete, "5".repeat(64));
    expect(receipt.regressionTestPath).toBeNull();
    expect(transport.pullRequests[0]?.body).toContain("Regression test: not included");
  });

  it("keeps three concurrent issue runs on disjoint state", async () => {
    const repos = ["acme/app", "acme/lib", "acme/cli"] as const;
    const model: IssuesModel = {
      analyse: async (context) =>
        analysisOutput({
          summary: `Analysis for ${context.selection.ticket.key}`,
          affectedFiles: [
            {
              path: "src/profile/loader.ts",
              startLine: 2,
              endLine: 2,
              changeDescription: `Fix ${context.selection.ticket.key}.`,
              validators: ["basic-syntax"],
            },
          ],
        }),
      implement: async (context) =>
        implementationOutput({
          summary: `Fix for ${context.input.ticketKey}`,
          files: [
            {
              path: "src/profile/loader.ts",
              content: `// ${context.input.ticketKey}\nexport function loadProfile(raw) {\n  return raw.address?.city ?? "Unknown";\n}\n`,
              validators: ["basic-syntax"],
            },
          ],
        }),
    };
    const scoped = new ScopedIssueWriter();
    const { flow } = harness({ model, writer: scoped });
    const walks = repos.map(
      (repository, index) =>
        new Walk({
          runId: `run-${index + 1}`,
          ticketKey: `ABC-${index + 1}`,
          input: {
            ticketKey: `ABC-${index + 1}`,
            ticketSummary: `Bug ${index + 1}`,
            repository,
            candidates: [
              { key: `ABC-${index + 1}`, summary: `Bug ${index + 1}`, status: "To Do" },
            ],
          },
        }),
    );
    const starts = await Promise.all(
      walks.map(async (walk) => {
        const run = await flow.createRun();
        const payload = suspendView(
          await run.start({ inputData: walk.envelope() }),
          "issue-selection",
        );
        return { run, payload };
      }),
    );
    // Every selection stayed scoped to its own run's repository.
    starts.forEach((start, index) => {
      expect(start.payload.artifact.repository).toBe(repos[index]);
      expect(start.payload.target).toBe(`branch:${repos[index]}#fix/abc-${index + 1}`);
    });

    // Run 3 races ahead while runs 1 and 2 sit at their own checkpoints.
    const third = starts[2]!;
    const thirdAnalysis = await runForward(third.run, walks[2]!, 0, third.payload, "analysis");
    expect(thirdAnalysis.artifact.summary).toBe("Analysis for ABC-3");

    const receipts = await Promise.all([
      driveToCompletion(starts[0]!.run, walks[0]!, 0, starts[0]!.payload, "1".repeat(64)),
      driveToCompletion(starts[1]!.run, walks[1]!, 0, starts[1]!.payload, "2".repeat(64)),
      driveToCompletion(third.run, walks[2]!, 1, thirdAnalysis, "3".repeat(64)),
    ]);

    // Each run shipped its own fix; no cross-run state leaked into any receipt.
    expect(receipts.map((receipt) => receipt.branch).sort()).toEqual([
      "fix/abc-1",
      "fix/abc-2",
      "fix/abc-3",
    ]);
    expect(new Set(receipts.map((receipt) => receipt.ticketKey))).toEqual(
      new Set(["ABC-1", "ABC-2", "ABC-3"]),
    );
    expect(scoped.applied.map((entry) => `${entry.repository}#${entry.branch}`).sort()).toEqual([
      "acme/app#fix/abc-1",
      "acme/cli#fix/abc-3",
      "acme/lib#fix/abc-2",
    ]);
    expect(scoped.applied.every((entry) => entry.body.includes("Patch hash:"))).toBe(true);
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

describe("createIssuesAgentModel", () => {
  const analysisContext: IssueAnalysisModelContext = {
    input: {
      ticketKey: "ABC-42",
      ticketSummary: "Profile page crashes when the address is missing",
    },
    selection: IssueSelectionArtifactSchema.parse({
      ticket: TICKET_CANDIDATES[0],
      candidates: TICKET_CANDIDATES,
      repositories: ["acme/app"],
      repository: "acme/app",
      branches: ["main"],
      baseBranch: "main",
      advanced: { includeRegressionTest: true, maxChangedFiles: 10, guidance: "" },
    }),
    sourceSha: SOURCE_SHA,
    files: [],
    guidance: undefined,
  };

  /** Analyst stub replaying the answers in order and recording each prompt. */
  function stubAnalyst(replies: ReadonlyArray<string | Error>): {
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

  it("re-asks the analyst once when the first answer breaks the contract", async () => {
    const { agent, prompts } = stubAnalyst([
      '{"summary": "Unclear.", "confidence": 0.1, "similarUpdates": [], "affectedFiles": [], "regressionTest": null}',
      '{"summary": "Scoped.", "confidence": 0.5, "similarUpdates": [], "affectedFiles": [{"path": "src/profile/loader.ts", "startLine": 2, "endLine": 2, "changeDescription": "Guard the access.", "validators": ["basic-syntax"]}], "regressionTest": null}',
    ]);
    const model = createIssuesAgentModel({ analyst: agent });
    const output = await model.analyse(analysisContext);
    expect(output.affectedFiles).toHaveLength(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("affectedFiles: Array must contain at least 1 element(s)");
    expect(prompts[1]).toContain("Return only the corrected JSON object.");
  });

  it("surfaces the violation when the repaired answer is still off-contract", async () => {
    const { agent, prompts } = stubAnalyst([
      '{"summary": "Unclear.", "confidence": 0.1, "similarUpdates": [], "affectedFiles": [], "regressionTest": null}',
    ]);
    const model = createIssuesAgentModel({ analyst: agent });
    await expect(model.analyse(analysisContext)).rejects.toThrow(
      "Analyst contract violation: affectedFiles: Array must contain at least 1 element(s)",
    );
    expect(prompts).toHaveLength(2);
  });
});
