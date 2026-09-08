import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import type { PatchPlan, RootCauseAnalysis } from "./contracts.js";
import {
  CODING_FLOW_STEPS,
  createCodingFlow,
  type CodingApprovalSuspendPayload,
} from "./flow.js";
import {
  computePatchHash,
  FakeGitHubTransport,
  GitHubRepositoryTools,
  type CheckStatus,
} from "./tools/github.js";
import { ValidatorRegistry } from "./tools/validators.js";
import {
  type CodingModel,
  type CodingWorkflowInput,
  MemoryCodingRunStore,
} from "./workflow.js";

const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);

const POLICY = {
  repositories: ["acme/widget"],
  baseBranch: "main",
  allowPaths: ["src/**", "config/**", "migrations/**"],
  denyPaths: [".github/workflows/**", "infra/prod/**"],
  destructivePaths: ["migrations/**", "infra/**"],
  maxFiles: 5,
  maxPatchBytes: 10_000,
  timeoutMs: 2_000,
};

interface CodingFixture {
  id: string;
  evidence: RootCauseAnalysis["evidence"];
  patch: PatchPlan["files"];
}

const FIXTURES = [
  {
    id: "json-comma",
    evidence: [{ path: "config/app.json", startLine: 2, endLine: 2, excerpt: "\"ok\": true," }],
    patch: [{ path: "config/app.json", content: "{\"ok\":true}\n", validators: ["json"] }],
  },
  {
    id: "yaml-tab",
    evidence: [{ path: "config/app.yaml", startLine: 1, endLine: 1, excerpt: "\tname: app" }],
    patch: [{ path: "config/app.yaml", content: "name: app\n", validators: ["yaml"] }],
  },
  {
    id: "xml-close",
    evidence: [{ path: "config/app.xml", startLine: 1, endLine: 1, excerpt: "<app>" }],
    patch: [{ path: "config/app.xml", content: "<app></app>\n", validators: ["xml"] }],
  },
  {
    id: "js-brace",
    evidence: [{ path: "src/app.ts", startLine: 1, endLine: 1, excerpt: "export const x = {" }],
    patch: [{ path: "src/app.ts", content: "export const x = {};\n", validators: ["basic-syntax"] }],
  },
  {
    id: "python-bracket",
    evidence: [{ path: "src/app.py", startLine: 1, endLine: 1, excerpt: "x = [" }],
    patch: [{ path: "src/app.py", content: "x = []\n", validators: ["basic-syntax"] }],
  },
] satisfies CodingFixture[];

function input(id = "json-comma"): CodingWorkflowInput {
  return {
    runId: `run-${id}`,
    tenantId: "tenant-a",
    ticketKey: "ENG-42",
    owner: "acme",
    repo: "widget",
    baseBranch: "main",
    sourceSha: SOURCE_SHA,
    branch: `agent/ENG-42-${id}`,
    problem: `Fix ${id}`,
    approvedDestructivePaths: [],
  };
}

function modelFor(fixture: CodingFixture = FIXTURES[0]!): CodingModel {
  return {
    investigate: async () => ({
      summary: `Root cause for ${fixture.id}`,
      confidence: 0.95,
      evidence: [...fixture.evidence],
      fixable: true,
    }),
    planPatch: async () => ({
      summary: `Surgical fix for ${fixture.id}`,
      files: [...fixture.patch],
    }),
    repairPatch: async (_context, patch) => patch,
  };
}

function harness(
  model: CodingModel = modelFor(),
  checks: CheckStatus = "success",
  transport = new FakeGitHubTransport({
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    commitSha: COMMIT_SHA,
    checks,
  }),
) {
  const github = new GitHubRepositoryTools(transport, POLICY, "github_pat_TEST_SECRET");
  const store = new MemoryCodingRunStore();
  // Resume needs the workflow hosted on a Mastra instance: suspended snapshots
  // are persisted to the instance storage, not to the bare flow.
  const mastra = createAllRounderMastra({
    coding: {
      github,
      model,
      store,
      validators: new ValidatorRegistry(),
      confidenceFloor: 0.8,
    },
  });
  const flow = mastra.getWorkflow("codingFlow");
  if (flow === undefined) throw new Error("codingFlow is not registered");
  return { transport, github, store, flow };
}

function destructiveModel(): CodingModel {
  const model = modelFor();
  model.planPatch = async () => ({
    summary: "migration",
    files: [{
      path: "migrations/001.sql",
      content: "alter table users add column active boolean;\n",
      validators: ["basic-syntax"],
    }],
  });
  return model;
}

describe("Mastra codingFlow", () => {
  it("registers named coding steps in order", () => {
    const { flow } = harness();
    expect(flow.id).toBe("codingFlow");
    expect(Object.keys(flow.steps)).toEqual([...CODING_FLOW_STEPS]);
  });

  it("is registered on the AllRounder Mastra instance when coding deps are injected", () => {
    const { github } = harness();
    const mastra = createAllRounderMastra({ coding: { github } });
    expect(mastra.getWorkflow("codingFlow")?.id).toBe("codingFlow");
  });

  it.each(FIXTURES)("produces evidence and a Draft PR for fixable fixture $id", async (fixture) => {
    const { flow, transport, store } = harness(modelFor(fixture));
    const run = await flow.createRun();
    const started = await run.start({ inputData: input(fixture.id) });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.status).toBe("draft_pr_opened");
    expect(started.result.rca.evidence).toEqual(fixture.evidence);
    expect(started.result.validation.passed).toBe(true);
    expect(started.result.pr?.draft).toBe(true);
    expect(started.result.pr?.replayed).toBe(false);
    expect(transport.commitCreates).toBe(1);
    expect(transport.pullRequests).toHaveLength(1);
    expect(transport.pullRequests[0]?.body).toContain("Ticket: ENG-42");
    expect(transport.pullRequests[0]?.body).toContain("Validation");
    expect(store.records.has(input(fixture.id).runId)).toBe(true);
    expect(store.records.get(input(fixture.id).runId)?.escalation).toBeUndefined();
  });

  it("refuses stale source SHA before any write", async () => {
    const { flow, transport } = harness();
    transport.sourceSha = "d".repeat(40);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.status).toBe("escalated");
    expect(started.result.escalation?.reason).toBe("stale_source");
    expect(transport.writeCalls).toBe(0);
    expect(transport.pullRequests).toHaveLength(0);
  });

  it("escalates a repository outside policy before any write", async () => {
    // Mastra runs cannot reject mid-flight, so repository denial surfaces as
    // an escalated path_denied run instead of a thrown error (the
    // deterministic CodingWorkflow class still throws).
    const request = input();
    request.repo = "other";
    const { flow, transport } = harness();
    const run = await flow.createRun();
    const started = await run.start({ inputData: request });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.status).toBe("escalated");
    expect(started.result.escalation?.reason).toBe("path_denied");
    expect(started.result.escalation?.detail).toContain("Repository not allowed");
    expect(transport.writeCalls).toBe(0);
  });

  it.each([
    "src/../../.github/workflows/deploy.yml",
    "src\\..\\secrets.env",
    "/src/app.ts",
    "src/app.ts?ref=attacker",
  ])("rejects non-canonical patch path %s without writing", async (path) => {
    const model = modelFor();
    model.planPatch = async () => ({
      summary: "unsafe path",
      files: [{ path, content: "export {};\n", validators: ["basic-syntax"] }],
    });
    const { flow, transport } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.escalation?.reason).toBe("path_denied");
    expect(transport.writeCalls).toBe(0);
  });

  it("rejects a non-canonical Git branch before any write", async () => {
    const request = input();
    request.branch = "../main";
    const { flow, transport } = harness();
    const run = await flow.createRun();
    const started = await run.start({ inputData: request });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.escalation?.reason).toBe("path_denied");
    expect(started.result.escalation?.detail).toContain("Branch name");
    expect(transport.writeCalls).toBe(0);
  });

  it("suspends at preflight for destructive paths and writes only after an approved receipt", async () => {
    const model = destructiveModel();
    const { flow, transport, store } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("migration") });
    expect(started.status).toBe("suspended");
    expect(transport.writeCalls).toBe(0);
    expect(store.records.size).toBe(0);
    if (started.status !== "suspended") throw new Error("expected suspend");
    const payload = (started.suspendPayload as unknown as {
      preflight: CodingApprovalSuspendPayload;
    }).preflight;
    expect(payload).toMatchObject({
      runId: "run-migration",
      ticketKey: "ENG-42",
      repository: "acme/widget",
      branch: "agent/ENG-42-migration",
      summary: "migration",
    });
    expect(payload.actionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.actionHash).toBe(
      computePatchHash([{
        path: "migrations/001.sql",
        content: "alter table users add column active boolean;\n",
        validators: ["basic-syntax"],
      }]),
    );
    expect(payload.destructivePaths).toEqual(["migrations/001.sql"]);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toMatchObject({
      path: "migrations/001.sql",
      bytes: "alter table users add column active boolean;\n".length,
      validators: ["basic-syntax"],
    });
    expect(payload.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);

    const resumed = await run.resume({
      resumeData: { decision: "approved", receipt: `ok:${payload.actionHash}` },
    });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") throw new Error("expected success");
    expect(resumed.result.status).toBe("draft_pr_opened");
    expect(resumed.result.pr?.draft).toBe(true);
    expect(resumed.result.pr?.replayed).toBe(false);
    expect(resumed.result.validation.passed).toBe(true);
    expect(transport.commitCreates).toBe(1);
    expect(transport.pullRequests).toHaveLength(1);
    expect(store.records.size).toBe(1);
    expect(store.records.get("run-migration")?.pr?.draft).toBe(true);
  });

  it("escalates approval_rejected when the approval resume is rejected", async () => {
    const { flow, transport, store } = harness(destructiveModel());
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("migration") });
    expect(started.status).toBe("suspended");
    const resumed = await run.resume({ resumeData: { decision: "rejected" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") throw new Error("expected success");
    expect(resumed.result.status).toBe("escalated");
    expect(resumed.result.escalation?.reason).toBe("approval_rejected");
    expect(resumed.result.escalation?.diagnosisOnly).toBe(true);
    expect(resumed.result.pr).toBeUndefined();
    expect(transport.writeCalls).toBe(0);
    expect(store.records.get("run-migration")?.escalation?.reason).toBe("approval_rejected");
  });

  it("never posts when the approval resume expires", async () => {
    const { flow, transport } = harness(destructiveModel());
    const run = await flow.createRun();
    await run.start({ inputData: input("migration") });
    const resumed = await run.resume({ resumeData: { decision: "expired" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") throw new Error("expected success");
    expect(resumed.result.status).toBe("escalated");
    expect(resumed.result.escalation?.reason).toBe("approval_rejected");
    expect(transport.writeCalls).toBe(0);
  });

  it("requires a signed receipt even on an approved resume", async () => {
    const { flow, transport } = harness(destructiveModel());
    const run = await flow.createRun();
    await run.start({ inputData: input("migration") });
    const resumed = await run.resume({ resumeData: { decision: "approved" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") throw new Error("expected success");
    expect(resumed.result.status).toBe("escalated");
    expect(resumed.result.escalation?.reason).toBe("approval_rejected");
    expect(transport.writeCalls).toBe(0);
  });

  it("replays identical branch and patch idempotently across flows", async () => {
    const shared = new FakeGitHubTransport({
      sourceSha: SOURCE_SHA,
      treeSha: TREE_SHA,
      commitSha: COMMIT_SHA,
      checks: "success",
    });
    const { flow, transport } = harness(modelFor(), "success", shared);
    const firstRun = await flow.createRun();
    const first = await firstRun.start({ inputData: input() });
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("expected success");

    // A second flow over the same transport (fresh writer receipts) must find
    // the durable Draft PR instead of creating a second commit.
    const second = harness(modelFor(), "success", shared);
    const secondRun = await second.flow.createRun();
    const replayed = await secondRun.start({ inputData: input() });
    expect(replayed.status).toBe("success");
    if (replayed.status !== "success") throw new Error("expected success");
    expect(replayed.result.pr?.url).toBe(first.result.pr?.url);
    expect(replayed.result.pr?.replayed).toBe(true);
    expect(transport.commitCreates).toBe(1);
    expect(transport.pullRequests).toHaveLength(1);
  });

  it("returns diagnosis only for an unfixable evidence-backed defect", async () => {
    const model = modelFor();
    model.investigate = async () => ({
      summary: "Failure is in a closed third-party service",
      confidence: 0.92,
      evidence: [{ path: "src/client.ts", startLine: 8, endLine: 12, excerpt: "upstream.call()" }],
      fixable: false,
    });
    const { flow, transport } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("unfixable") });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.status).toBe("escalated");
    expect(started.result.escalation?.diagnosisOnly).toBe(true);
    expect(started.result.escalation?.reason).toBe("unfixable");
    expect(transport.writeCalls).toBe(0);
  });

  it("escalates weak or absent evidence without planning a bad patch", async () => {
    let planned = 0;
    const model = modelFor();
    model.investigate = async () => ({
      summary: "Guess",
      confidence: 0.4,
      evidence: [],
      fixable: true,
    });
    model.planPatch = async () => {
      planned += 1;
      throw new Error("must not run");
    };
    const { flow, transport } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("no-evidence") });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.escalation?.reason).toBe("insufficient_evidence");
    expect(planned).toBe(0);
    expect(transport.writeCalls).toBe(0);
  });

  it("escalates a failed model investigation without planning", async () => {
    let planned = 0;
    const model = modelFor();
    model.investigate = async () => {
      throw new Error("provider timeout");
    };
    model.planPatch = async () => {
      planned += 1;
      throw new Error("must not run");
    };
    const { flow, transport } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("provider-timeout") });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.escalation?.reason).toBe("insufficient_evidence");
    expect(started.result.escalation?.detail).toContain("provider timeout");
    expect(planned).toBe(0);
    expect(transport.writeCalls).toBe(0);
  });

  it("escalates when the model violates the safe patch contract", async () => {
    const model = modelFor();
    model.planPatch = async () => {
      throw new Error("did not return a JSON object");
    };
    const { flow, transport } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("bad-contract") });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.escalation?.reason).toBe("path_denied");
    expect(started.result.escalation?.detail).toContain("safe patch contract");
    expect(transport.writeCalls).toBe(0);
  });

  it("keeps a Draft PR non-terminal while CI is pending", async () => {
    const { flow, transport } = harness(modelFor(), "pending");
    const run = await flow.createRun();
    const started = await run.start({ inputData: input() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.status).toBe("awaiting_ci");
    expect(started.result.validation.ciStatus).toBe("pending");
    expect(started.result.pr?.draft).toBe(true);
    expect(transport.pullRequests).toHaveLength(1);
  });

  it("escalates failed CI with the validation evidence attached", async () => {
    const { flow } = harness(modelFor(), "failure");
    const run = await flow.createRun();
    const started = await run.start({ inputData: input() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.status).toBe("escalated");
    expect(started.result.escalation?.reason).toBe("ci_failed");
    expect(started.result.validation.passed).toBe(true);
    expect(started.result.validation.ciStatus).toBe("failure");
    expect(started.result.pr?.draft).toBe(true);
  });

  it("repairs invalid content exactly once", async () => {
    let repairs = 0;
    const model = modelFor();
    model.planPatch = async () => ({
      summary: "bad json",
      files: [{ path: "config/app.json", content: "{", validators: ["json"] }],
    });
    model.repairPatch = async (_context, patch) => {
      repairs += 1;
      return {
        summary: patch.summary,
        files: [{ path: "config/app.json", content: "{\"ok\":true}\n", validators: ["json"] }],
      };
    };
    const { flow, transport } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("repaired") });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(repairs).toBe(1);
    expect(started.result.status).toBe("draft_pr_opened");
    expect(started.result.validation.passed).toBe(true);
    expect(started.result.validation.attempts).toBe(2);
    expect(started.result.manifest?.patchHash).toBe(
      computePatchHash([{ path: "config/app.json", content: "{\"ok\":true}\n", validators: ["json"] }]),
    );
    expect(transport.pullRequests).toHaveLength(1);
  });

  it("allows one repair only and escalates a failed repair", async () => {
    let repairs = 0;
    const model = modelFor();
    model.planPatch = async () => ({
      summary: "bad",
      files: [{ path: "config/app.json", content: "{", validators: ["json"] }],
    });
    model.repairPatch = async (_context, patch) => {
      repairs += 1;
      return patch;
    };
    const { flow, transport } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("repair-failed") });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(repairs).toBe(1);
    expect(started.result.status).toBe("escalated");
    expect(started.result.escalation?.reason).toBe("validation_failed_after_repair");
    expect(started.result.validation.passed).toBe(false);
    expect(transport.pullRequests).toHaveLength(0);
    expect(transport.writeCalls).toBe(0);
  });

  it("fails closed when a repair introduces a destructive path instead of re-suspending", async () => {
    const model = modelFor();
    model.planPatch = async () => ({
      summary: "invalid config",
      files: [{ path: "config/app.json", content: "{", validators: ["json"] }],
    });
    model.repairPatch = async () => ({
      summary: "destructive repair",
      files: [{
        path: "migrations/001.sql",
        content: "alter table users add column active boolean;\n",
        validators: ["basic-syntax"],
      }],
    });
    const { flow, transport } = harness(model);
    const run = await flow.createRun();
    const started = await run.start({ inputData: input("destructive-repair") });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.status).toBe("escalated");
    expect(started.result.escalation?.reason).toBe("approval_required");
    expect(started.result.escalation?.detail).toContain("repair introduced");
    expect(started.result.pr).toBeUndefined();
    expect(transport.writeCalls).toBe(0);
  });

  it("never exposes a token in outputs or transport logs", async () => {
    const { flow, transport } = harness();
    const run = await flow.createRun();
    const started = await run.start({ inputData: input() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(JSON.stringify(started.result)).not.toContain("TEST_SECRET");
    expect(JSON.stringify(transport.logs)).not.toContain("TEST_SECRET");
  });

  it("rejects malformed input before any step runs", async () => {
    const { flow, store } = harness();
    const run = await flow.createRun();
    await expect(
      run.start({ inputData: { ...input(), sourceSha: "not-a-sha" } }),
    ).rejects.toThrow();
    expect(store.records.size).toBe(0);
  });
});
