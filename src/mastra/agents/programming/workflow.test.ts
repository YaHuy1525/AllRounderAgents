import { describe, expect, it } from "vitest";

import {
  CodingWorkflow,
  type CodingModel,
  type CodingWorkflowInput,
  MemoryCodingRunStore,
} from "./workflow.js";
import type { PatchPlan, RootCauseAnalysis } from "./contracts.js";
import { FakeGitHubTransport, GitHubRepositoryTools } from "./tools/github.js";
import { ValidatorRegistry } from "./tools/validators.js";

const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);

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

function harness(model: CodingModel = modelFor()) {
  const transport = new FakeGitHubTransport({
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    commitSha: COMMIT_SHA,
    checks: "success",
  });
  const github = new GitHubRepositoryTools(
    transport,
    {
      repositories: ["acme/widget"],
      baseBranch: "main",
      allowPaths: ["src/**", "config/**", "migrations/**"],
      denyPaths: [".github/workflows/**", "infra/prod/**"],
      destructivePaths: ["migrations/**", "infra/**"],
      maxFiles: 5,
      maxPatchBytes: 10_000,
      timeoutMs: 2_000,
    },
    "github_pat_TEST_SECRET",
  );
  return {
    transport,
    workflow: new CodingWorkflow(
      github.reader,
      github.writer,
      new ValidatorRegistry(),
      model,
      new MemoryCodingRunStore(),
      0.8,
    ),
  };
}

describe("Phase 2 coding workflow", () => {
  it.each(FIXTURES)("produces evidence and a Draft PR for fixable fixture $id", async (fixture) => {
    const { workflow, transport } = harness(modelFor(fixture));
    const result = await workflow.run(input(fixture.id));

    expect(result.status).toBe("draft_pr_opened");
    expect(result.rca.evidence).toEqual(fixture.evidence);
    expect(result.validation.passed).toBe(true);
    expect(result.pr?.draft).toBe(true);
    expect(transport.pullRequests).toHaveLength(1);
    expect(transport.pullRequests[0]?.body).toContain("Validation");
  });

  it("refuses stale source SHA before any write", async () => {
    const { workflow, transport } = harness();
    transport.sourceSha = "d".repeat(40);
    const result = await workflow.run(input());
    expect(result.status).toBe("escalated");
    expect(result.escalation?.reason).toBe("stale_source");
    expect(transport.writeCalls).toBe(0);
  });

  it("denies repository and path scope", async () => {
    const deniedRepo = input();
    deniedRepo.repo = "other";
    const first = harness();
    await expect(first.workflow.run(deniedRepo)).rejects.toThrow("Repository not allowed");

    const pathModel = modelFor();
    pathModel.planPatch = async () => ({
      summary: "unsafe",
      files: [{ path: ".github/workflows/deploy.yml", content: "name: x\n", validators: ["yaml"] }],
    });
    const second = harness(pathModel);
    const result = await second.workflow.run(input());
    expect(result.escalation?.reason).toBe("path_denied");
    expect(second.transport.writeCalls).toBe(0);
  });

  it.each([
    "src/../../.github/workflows/deploy.yml",
    "src\\..\\secrets.env",
    "/src/app.ts",
    "src/app.ts?ref=attacker",
  ])("rejects non-canonical patch path %s", async (path) => {
    const model = modelFor();
    model.planPatch = async () => ({
      summary: "unsafe path",
      files: [{ path, content: "export {};\n", validators: ["basic-syntax"] }],
    });
    const { workflow, transport } = harness(model);
    const result = await workflow.run(input());
    expect(result.escalation?.reason).toBe("path_denied");
    expect(transport.writeCalls).toBe(0);
  });

  it("rejects a non-canonical Git branch before any write", async () => {
    const request = input();
    request.branch = "../main";
    const { workflow, transport } = harness();
    const result = await workflow.run(request);
    expect(result.escalation?.reason).toBe("path_denied");
    expect(transport.writeCalls).toBe(0);
  });

  it("replays identical branch and patch idempotently", async () => {
    const { workflow, transport } = harness();
    const request = input();
    const first = await workflow.run(request);
    const freshTools = new GitHubRepositoryTools(transport, {
      repositories: ["acme/widget"],
      baseBranch: "main",
      allowPaths: ["src/**", "config/**", "migrations/**"],
      denyPaths: [".github/workflows/**", "infra/prod/**"],
      destructivePaths: ["migrations/**", "infra/**"],
      maxFiles: 5,
      maxPatchBytes: 10_000,
      timeoutMs: 2_000,
    });
    const freshWorkflow = new CodingWorkflow(
      freshTools.reader,
      freshTools.writer,
      new ValidatorRegistry(),
      modelFor(),
      new MemoryCodingRunStore(),
      0.8,
    );
    const second = await freshWorkflow.run(request);
    expect(first.pr?.url).toBe(second.pr?.url);
    expect(second.pr?.replayed).toBe(true);
    expect(transport.commitCreates).toBe(1);
    expect(transport.pullRequests).toHaveLength(1);
  });

  it("gates destructive paths unless exactly approved", async () => {
    const model = modelFor();
    model.planPatch = async () => ({
      summary: "migration",
      files: [{
        path: "migrations/001.sql",
        content: "alter table users add column active boolean;\n",
        validators: ["basic-syntax"],
      }],
    });
    const denied = harness(model);
    expect((await denied.workflow.run(input())).escalation?.reason).toBe("approval_required");

    const approved = harness(model);
    const request = input();
    request.approvedDestructivePaths = ["migrations/001.sql"];
    expect((await approved.workflow.run(request)).status).toBe("draft_pr_opened");
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
    const { workflow, transport } = harness(model);
    const result = await workflow.run(input());
    expect(repairs).toBe(1);
    expect(result.escalation?.reason).toBe("validation_failed_after_repair");
    expect(transport.pullRequests).toHaveLength(0);
  });

  it("escalates failed CI with the validation evidence attached", async () => {
    const { workflow, transport } = harness();
    transport.checks = "failure";
    const result = await workflow.run(input());
    expect(result.escalation?.reason).toBe("ci_failed");
    expect(result.validation.passed).toBe(true);
    expect(result.pr?.draft).toBe(true);
  });

  it("keeps a Draft PR non-terminal while CI is pending", async () => {
    const { workflow, transport } = harness();
    transport.checks = "pending";
    const result = await workflow.run(input());
    expect(result.status).toBe("awaiting_ci");
    expect(result.validation.ciStatus).toBe("pending");
    expect(result.pr?.draft).toBe(true);
  });

  it("returns diagnosis only for an unfixable evidence-backed defect", async () => {
    const model = modelFor();
    model.investigate = async () => ({
      summary: "Failure is in a closed third-party service",
      confidence: 0.92,
      evidence: [{ path: "src/client.ts", startLine: 8, endLine: 12, excerpt: "upstream.call()" }],
      fixable: false,
    });
    const { workflow, transport } = harness(model);
    const result = await workflow.run(input("unfixable"));
    expect(result.escalation?.diagnosisOnly).toBe(true);
    expect(result.escalation?.reason).toBe("unfixable");
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
    const { workflow } = harness(model);
    const result = await workflow.run(input("no-evidence"));
    expect(result.escalation?.reason).toBe("insufficient_evidence");
    expect(planned).toBe(0);
  });

  it("never exposes a token in receipts or transport logs", async () => {
    const { workflow, transport } = harness();
    const result = await workflow.run(input());
    expect(JSON.stringify(result)).not.toContain("TEST_SECRET");
    expect(JSON.stringify(transport.logs)).not.toContain("TEST_SECRET");
  });

  it("exposes all required Mastra-compatible named steps", () => {
    const { workflow } = harness();
    expect(workflow.steps.map((step) => step.id)).toEqual([
      "load-context",
      "investigate",
      "strict-rca",
      "plan-surgical-patch",
      "preflight",
      "patch",
      "validate",
      "draft-pr",
      "evidence-close",
    ]);
  });
});
