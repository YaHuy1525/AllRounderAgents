import { describe, expect, it, vi } from "vitest";

import type {
  DelegationCompleteContext,
  DelegationConfig,
  DelegationStartContext,
  DelegationStartResult,
} from "@mastra/core/agent";

import { createAllRounderMastra } from "../../../../src/mastra/mastra.js";
import {
  caseDesignerAgent,
  coverageAuditorAgent,
  qaLeadAgent,
  qaSquadChildren,
  requirementAnalystAgent,
  webExecutorAgent,
} from "../../../../src/mastra/agents/qa/agents/index.js";
import { QA_PHASE_CHILDREN, qaDelegation } from "../../../../src/mastra/agents/qa/squad.js";

/** A start context carrying only the field the gate reads. */
function startContext(primitiveId: string): DelegationStartContext {
  return {
    primitiveId,
    primitiveType: "agent",
    prompt: "check the console",
    params: {},
    iteration: 1,
    runId: "run-1",
    parentAgentId: qaLeadAgent.id,
    parentAgentName: "QA Lead",
  } as unknown as DelegationStartContext;
}

async function ask(
  gate: DelegationConfig,
  primitiveId: string,
): Promise<DelegationStartResult | void> {
  const hook = gate.onDelegationStart;
  if (hook === undefined) throw new Error("the gate has no onDelegationStart hook");
  return await hook(startContext(primitiveId));
}

interface CompleteCall {
  primitiveId: string;
  success: boolean;
  error?: unknown;
  bail: () => void;
}

function finish(gate: DelegationConfig, call: CompleteCall) {
  const hook = gate.onDelegationComplete;
  if (hook === undefined) throw new Error("the gate has no onDelegationComplete hook");
  return hook({
    primitiveId: call.primitiveId,
    primitiveType: "agent",
    prompt: "check the console",
    result: { text: "done" },
    duration: 12,
    success: call.success,
    ...(call.error === undefined ? {} : { error: call.error }),
    iteration: 1,
    runId: "run-1",
    toolCallId: "call-1",
    parentAgentId: qaLeadAgent.id,
    parentAgentName: "QA Lead",
    messages: [],
    bail: call.bail,
  } as unknown as DelegationCompleteContext);
}

describe("qa delegation gate", () => {
  it("refuses the executor before any case set is approved", async () => {
    const gate = qaDelegation({ phase: "execute", approvedCaseIds: [] });
    const result = await ask(gate, webExecutorAgent.id);
    expect(result).toMatchObject({ proceed: false });
    expect((result as DelegationStartResult).rejectionReason).toContain(
      "Approve the cases first",
    );
  });

  it("lets the executor run once a case set is approved", async () => {
    const gate = qaDelegation({ phase: "execute", approvedCaseIds: ["QA-OPS-001"] });
    expect(await ask(gate, webExecutorAgent.id)).toEqual({ proceed: true });
  });

  it("refuses a child that belongs to another phase", async () => {
    const gate = qaDelegation({ phase: "analyse", approvedCaseIds: [] });
    const result = await ask(gate, caseDesignerAgent.id);
    expect(result).toMatchObject({ proceed: false });
    expect((result as DelegationStartResult).rejectionReason).toContain(
      "the analyse phase may only delegate to qa-requirement-analyst",
    );
  });

  it("fails closed when a hook throws instead of warning and continuing", () => {
    // Mastra defaults `hookErrorStrategy` to "warn", which would let a broken
    // gate through; the lane opts into the throwing mode explicitly.
    for (const phase of ["analyse", "design", "audit", "execute"] as const) {
      expect(qaDelegation({ phase, approvedCaseIds: [] }).hookErrorStrategy).toBe("throw");
    }
  });

  it("bails a failed delegation and never forwards the provider message", async () => {
    const gate = qaDelegation({ phase: "execute", approvedCaseIds: ["QA-OPS-001"] });
    const bail = vi.fn();
    const result = await finish(gate, {
      primitiveId: webExecutorAgent.id,
      success: false,
      error: new Error("401 Unauthorized for key sk-live-abcdef"),
      bail,
    });
    expect(bail).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ feedback: expect.stringContaining(webExecutorAgent.id) });
    expect((result as { resultText: string }).resultText).toBe(
      `${webExecutorAgent.id} did not return a usable result.`,
    );
    expect(JSON.stringify(result)).not.toContain("sk-live");
  });

  it("leaves a successful delegation alone", async () => {
    const gate = qaDelegation({ phase: "analyse", approvedCaseIds: [] });
    const bail = vi.fn();
    expect(
      await finish(gate, { primitiveId: requirementAnalystAgent.id, success: true, bail }),
    ).toBeUndefined();
    expect(bail).not.toHaveBeenCalled();
  });

  it("matches on agent ids, because primitiveId is the child's id", () => {
    const ids = new Set<string>([
      requirementAnalystAgent.id,
      caseDesignerAgent.id,
      coverageAuditorAgent.id,
      webExecutorAgent.id,
    ]);
    for (const allowed of Object.values(QA_PHASE_CHILDREN).flat()) {
      expect(ids.has(allowed)).toBe(true);
    }
    // The map keys are what the model sees as tool names; they are not what
    // the hook receives, so a gate written against them would never match.
    expect(QA_PHASE_CHILDREN.execute).toEqual([webExecutorAgent.id]);
    expect(webExecutorAgent.id).not.toBe("webExecutor");
  });
});

describe("qa squad composition", () => {
  it("gives the lead four specialists and no tools of its own", async () => {
    const subagents = await qaLeadAgent.listAgents();
    expect(Object.keys(subagents)).toEqual([
      "requirementAnalyst",
      "caseDesigner",
      "webExecutor",
      "coverageAuditor",
    ]);
    expect(subagents.requirementAnalyst).toBe(requirementAnalystAgent);
    expect(subagents.caseDesigner).toBe(caseDesignerAgent);
    expect(subagents.webExecutor).toBe(webExecutorAgent);
    expect(subagents.coverageAuditor).toBe(coverageAuditorAgent);
    expect(Object.keys(qaSquadChildren)).toEqual(Object.keys(subagents));
  });

  it("describes every child, which is what makes it delegable", async () => {
    for (const child of Object.values(qaSquadChildren)) {
      const description = await child.getDescription();
      expect(description.length).toBeGreaterThan(20);
    }
  });

  it("registers the lead and the flow on the AllRounder instance", () => {
    const mastra = createAllRounderMastra();
    expect(mastra.getAgent("qaLead").id).toBe("qa-lead");
    expect(mastra.getWorkflow("qaFlow").id).toBe("qaFlow");
  });
});
