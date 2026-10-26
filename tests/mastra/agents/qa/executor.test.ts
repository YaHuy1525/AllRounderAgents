import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent } from "@mastra/core/agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type QaCase, resolveQaTarget } from "../../../../src/mastra/agents/qa/contracts.js";
import { createQaExecutor, executionProblem, type QaExecuteBrief } from "../../../../src/mastra/agents/qa/executor.js";

/**
 * Availability is the fact the whole lane turns on: with no browser or no
 * stored session there is nothing to observe, so every case is `blocked`
 * instead of guessed. These tests exercise that decision and the two guards
 * behind it — an executor crash and an evidence-free "passed" — with no
 * Playwright, no model key and no server.
 */

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionFile(name = "storage-state.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-state-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, "{}", "utf8");
  return path;
}

function qaCase(id = "QA-OPS-001"): QaCase {
  return {
    id,
    requirementIds: ["R1"],
    title: "The queue lists pending requests",
    kind: "ui",
    preconditions: ["A pending leave request exists"],
    steps: [{ action: "Open the approvals queue", target: "/approvals" }],
    expected: "The queue shows the pending request with an Approve action.",
    tags: ["leave"],
    target: "local-console",
  };
}

function brief(cases: QaCase[] = [qaCase()]): QaExecuteBrief {
  return {
    runId: "run-qa-1",
    storyKey: "OPS-123",
    target: resolveQaTarget("local-console"),
    cases,
  };
}

/** Stands in for the browser child: answers whatever the contract check sees. */
function agentThat(answer: () => Promise<unknown>): Agent {
  return { generate: answer } as unknown as Agent;
}

describe("qa execution availability", () => {
  it("names the browser switch when the browser is off", () => {
    vi.stubEnv("AGENT_BROWSER_ENABLED", "");
    const reason = executionProblem(resolveQaTarget("local-console"));
    expect(reason).toContain("the browser is not enabled");
    expect(reason).toContain("AGENT_BROWSER_ENABLED=true");
    expect(reason).toContain("npx playwright install chromium");
  });

  it("names the missing session file when the browser is on", () => {
    vi.stubEnv("AGENT_BROWSER_ENABLED", "true");
    const target = resolveQaTarget("local-console");
    const reason = executionProblem({ ...target, storageState: ".qa/auth/absent.json" });
    expect(reason).toBe(
      "no stored session at .qa/auth/absent.json: log in to http://localhost:3000 once "
        + "and save the storage state there",
    );
  });

  it("clears the target once the browser is on and the session exists", () => {
    vi.stubEnv("AGENT_BROWSER_ENABLED", "true");
    const target = resolveQaTarget("local-console");
    expect(executionProblem({ ...target, storageState: sessionFile() })).toBeUndefined();
  });

  it("does not require a session from a profile that never declares one", () => {
    vi.stubEnv("AGENT_BROWSER_ENABLED", "true");
    const { storageState: _unused, ...anonymous } = resolveQaTarget("local-console");
    expect(executionProblem(anonymous)).toBeUndefined();
  });
});

describe("qa executor", () => {
  it("blocks every case with the reason instead of pretending it ran", async () => {
    const reason = "the browser is not enabled: set AGENT_BROWSER_ENABLED=true";
    const executor = createQaExecutor({ problem: () => reason });
    expect(executor.problem(brief().target)).toBe(reason);

    const execution = await executor.run(brief([qaCase("QA-OPS-001"), qaCase("QA-OPS-002")]));
    expect(execution.available).toBe(false);
    expect(execution.blockedReason).toBe(reason);
    expect(execution.results.map((item) => [item.caseId, item.status, item.observed])).toEqual([
      ["QA-OPS-001", "blocked", reason],
      ["QA-OPS-002", "blocked", reason],
    ]);
  });

  it("turns an executor crash into a blocked case, never a failure", async () => {
    const executor = createQaExecutor({
      problem: () => undefined,
      agent: agentThat(async () => {
        throw new Error("401 no model key");
      }),
    });
    const execution = await executor.run(brief());
    expect(execution.available).toBe(true);
    expect(execution.results[0]).toMatchObject({
      caseId: "QA-OPS-001",
      status: "blocked",
      observed: "the executor could not complete this case: 401 no model key",
    });
  });

  it("downgrades a pass that carried no observation", async () => {
    const executor = createQaExecutor({
      problem: () => undefined,
      agent: agentThat(async () => ({
        object: { status: "passed", observed: "looks fine", console: [], network: [], transcript: [] },
      })),
    });
    const execution = await executor.run(brief());
    expect(execution.results[0]).toMatchObject({
      status: "blocked",
      observed: "reported passed with no observation attached",
    });
  });

  it("keeps the evidence a real answer carried", async () => {
    const executor = createQaExecutor({
      problem: () => undefined,
      agent: agentThat(async () => ({
        object: {
          status: "failed",
          observed: "the queue renders `No pending requests`",
          console: ["GET /api/runs 500"],
          network: [{ url: "http://localhost:8000/api/runs", status: 500, ok: false }],
          transcript: ["clicked Approvals"],
        },
      })),
    });
    const execution = await executor.run(brief());
    expect(execution.results[0]).toMatchObject({
      status: "failed",
      observed: "the queue renders `No pending requests`",
      evidence: {
        console: ["GET /api/runs 500"],
        network: [{ url: "http://localhost:8000/api/runs", status: 500, ok: false }],
        transcript: ["clicked Approvals"],
      },
    });
  });
});
