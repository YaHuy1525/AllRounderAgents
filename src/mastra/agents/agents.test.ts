import { describe, expect, it } from "vitest";

import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";

import { createAllRounderMastra } from "../mastra.js";
import { DEEPSEEK_FLASH_MODEL } from "../shared/model.js";
import { MemorySandboxLedger } from "./finance/workflow.js";
import { allRounderAgents } from "./registry.js";
import { createScriptedAgent, formatAgentScript } from "./script.js";
import { dispatcherPreflightScenarios, dispatcherTriageScenarios } from "./dispatcher/agents/scripts.js";
import { financeAuditScenarios, financeGlScenarios } from "./finance/agents/scripts.js";
import { programmingInvestigatorScenarios } from "./programming/agents/scripts.js";
import { actorAgent, investigatorAgent, validatorAgent } from "./programming/agents/index.js";
import { marketingBrandScenarios } from "./marketing/agents/scripts.js";
import { supportDrafterScenarios } from "./support/agents/scripts.js";
import { SpecialistFindingSchema } from "./finance/contracts.js";
import { TriageVerdictSchema } from "../shared/contracts.js";
import { RootCauseAnalysisSchema } from "./programming/contracts.js";

/** Resolve an agent's instructions to plain text (SystemMessage is a wide union). */
async function agentInstructions(agent: Agent): Promise<string> {
  const message = await agent.getInstructions();
  return typeof message === "string" ? message : JSON.stringify(message);
}

describe("Mastra scripted agents", () => {
  it("pins every agent to deepseek-v4-flash", () => {
    const agents = Object.values(allRounderAgents());
    expect(agents.length).toBeGreaterThanOrEqual(14);
    for (const agent of agents) {
      expect(agent.model).toMatchObject({ id: DEEPSEEK_FLASH_MODEL });
    }
  });

  it("embeds scenario expected outputs in the agent scripts", async () => {
    const gl = allRounderAgents().financeGl;
    const instructions = await gl.getInstructions();
    expect(instructions).toContain("unmatched ledger PAY-1");
    expect(instructions).toContain('"specialist": "gl"');
    expect(instructions).toContain("Expected output:");
  });

  it("keeps scenario expected outputs on-contract", () => {
    expect(TriageVerdictSchema.parse(dispatcherTriageScenarios[0]!.expectedOutput).domain).toBe("finance");
    expect(SpecialistFindingSchema.parse(financeGlScenarios[0]!.expectedOutput).exceptionRef).toBe("PAY-1");
    expect(RootCauseAnalysisSchema.parse(programmingInvestigatorScenarios[0]!.expectedOutput).fixable).toBe(true);
    const audit = financeAuditScenarios[0]!.expectedOutput as {
      checks: Array<{ passed: boolean }>;
    };
    expect(audit.checks.every((check) => check.passed)).toBe(true);
    const preflight = dispatcherPreflightScenarios[0]!.expectedOutput as { gate: string };
    expect(preflight.gate).toBe("approval");
    const brand = marketingBrandScenarios[0]!.expectedOutput as { allowed: boolean };
    expect(brand.allowed).toBe(false);
    const draft = supportDrafterScenarios[0]!.expectedOutput as {
      citations: Array<{ sourceId: string }>;
    };
    expect(draft.citations[0]?.sourceId).toBe("kb-refunds");
  });

  it("registers the agents on the Mastra instance", () => {
    const mastra = createAllRounderMastra({ ledger: new MemorySandboxLedger() });
    expect(mastra.getAgent("financeGl").id).toBe("finance-gl");
    expect(mastra.getAgent("dispatcherTriage").id).toBe("dispatcher-triage");
    expect(mastra.getAgent("programmingInvestigator").id).toBe("programming-investigator");
  });

  it("formats a followable script from scenarios", () => {
    const agent = createScriptedAgent({
      id: "demo",
      name: "Demo",
      role: "You are a demo agent.",
      rules: ["Never invent facts."],
      outputShape: "{ ok: boolean }",
      scenarios: [{ name: "yes", input: { q: 1 }, expectedOutput: { ok: true } }],
    });
    const script = formatAgentScript({
      role: "You are a demo agent.",
      rules: ["Never invent facts."],
      outputShape: "{ ok: boolean }",
      scenarios: [{ name: "yes", input: { q: 1 }, expectedOutput: { ok: true } }],
    });
    expect(script).toContain("Expected output:");
    expect(script).toContain('"ok": true');
    expect(agent.id).toBe("demo");
  });
});

describe("Structured coding-lane prompts", () => {
  it.each([
    {
      name: "investigator",
      agent: investigatorAgent,
      frameworkTag: "rca_analysis",
      shape: "{ summary, confidence, evidence[], fixable }",
    },
    {
      name: "actor",
      agent: actorAgent,
      frameworkTag: "patch_design",
      shape: "{ summary, files: [{ path, content, validators }] }",
    },
    {
      name: "validator",
      agent: validatorAgent,
      frameworkTag: "validation_scope",
      shape: "{ passed, attempts, results[] }",
    },
  ])("segments the $name prompt into the XML block set", async ({ agent, frameworkTag, shape }) => {
    const instructions = await agentInstructions(agent);
    expect(instructions.startsWith("<identity>")).toBe(true);
    for (const tag of [
      "identity",
      "primary_directive",
      frameworkTag,
      "output_format",
      "constraints",
      "examples",
      "verification",
    ]) {
      expect(instructions).toContain(`<${tag}>`);
      expect(instructions).toContain(`</${tag}>`);
    }
    expect(instructions).toContain(`Return JSON only, matching: ${shape}`);
  });

  it("keeps empty-state and omit-when rules in the output format", async () => {
    const investigator = await agentInstructions(investigatorAgent);
    expect(investigator).toContain("fixable false");
    expect(investigator).toContain("below 0.4");
    const validator = await agentInstructions(validatorAgent);
    expect(validator).toContain("omit ciStatus");
  });

  it("embeds the on-contract few-shot scenarios in the investigator prompt", async () => {
    const instructions = await agentInstructions(investigatorAgent);
    expect(instructions).toContain("### null check on login handler");
    expect(instructions).toContain('"fixable": true');
    expect(instructions).toContain("Expected output:");
  });

  it("honors a runtime prompt override through the RequestContext", async () => {
    const context = new RequestContext();
    context.set("promptOverride", "You are the overridden test agent.");
    const overridden = await investigatorAgent.getInstructions({ requestContext: context });
    expect(overridden).toBe("You are the overridden test agent.");
    const defaults = await agentInstructions(investigatorAgent);
    expect(defaults).toContain("<identity>");
    expect(defaults).not.toContain("overridden test agent");
  });
});
