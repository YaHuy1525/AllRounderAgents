import { describe, expect, it } from "vitest";

import type { Agent } from "@mastra/core/agent";

import { createAllRounderMastra } from "../../mastra.js";
import { DEFAULT_AGENT_MODEL } from "../../shared/model.js";
import { MemorySandboxLedger } from "../finance/workflow.js";
import { allRounderAgents } from "../registry.js";
import { formatScenarioExamples } from "../script.js";
import { dispatcherPreflightScenarios, dispatcherTriageScenarios } from "../dispatcher/agents/scripts.js";
import { financeAuditScenarios, financeGlScenarios } from "../finance/agents/scripts.js";
import { programmingInvestigatorScenarios } from "../programming/agents/scripts.js";
import { actorAgent, investigatorAgent, validatorAgent } from "../programming/agents/index.js";
import { marketingBrandScenarios } from "../marketing/agents/scripts.js";
import { supportDrafterScenarios } from "../support/agents/scripts.js";
import { featurePlannerScenarios } from "../features/agents/scripts.js";
import { FeaturePlanOutputSchema } from "../features/contracts.js";
import {
  dependencyEngineerScenarios,
  dependencyRepairScenarios,
} from "../dependencies/agents/scripts.js";
import {
  DependencyAssessmentOutputSchema,
  DependencyRepairSuggestionSchema,
} from "../dependencies/contracts.js";
import { SpecialistFindingSchema } from "../finance/contracts.js";
import { hrGuardrailScenarios } from "../screening/agents/scripts.js";
import { GuardrailOutputSchema } from "../screening/contracts.js";
import { TriageVerdictSchema } from "../../shared/contracts.js";
import { RootCauseAnalysisSchema } from "../programming/contracts.js";

/** Resolve an agent's instructions to plain text (SystemMessage is a wide union). */
async function agentInstructions(agent: Agent): Promise<string> {
  const message = await agent.getInstructions();
  return typeof message === "string" ? message : JSON.stringify(message);
}

describe("Mastra scripted agents", () => {
  it("pins every agent to the OpenRouter workflow model", () => {
    const agents = Object.values(allRounderAgents());
    expect(agents.length).toBeGreaterThanOrEqual(14);
    for (const agent of agents) {
      // Agents pin the router by id, declared either as the "provider/model"
      // string or the { id } config object; accept both shapes here so the
      // invariant is the resolved id, not the literal config form.
      const modelId =
        typeof agent.model === "string"
          ? agent.model
          : (agent.model as unknown as { id?: string }).id;
      expect(modelId).toBe(DEFAULT_AGENT_MODEL);
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
    const guardrail = GuardrailOutputSchema.parse(hrGuardrailScenarios[1]!.expectedOutput);
    expect(guardrail.allowed).toBe(false);
    expect(guardrail.flags.map((flag) => flag.candidateId)).toEqual(["C-3003", "C-3002"]);
    const draft = supportDrafterScenarios[0]!.expectedOutput as {
      citations: Array<{ sourceId: string }>;
    };
    expect(draft.citations[0]?.sourceId).toBe("kb-refunds");
    expect(FeaturePlanOutputSchema.parse(featurePlannerScenarios[0]!.expectedOutput).areas).toContain(
      "ui",
    );
    const assessment = DependencyAssessmentOutputSchema.parse(
      dependencyEngineerScenarios[0]!.expectedOutput,
    );
    expect(assessment.groups.map((group) => group.id)).toEqual(["patch", "major"]);
    expect(
      DependencyRepairSuggestionSchema.parse(dependencyRepairScenarios[0]!.expectedOutput).suggestion,
    ).toContain("Regenerate the lockfile");
  });

  it("registers the agents on the Mastra instance", () => {
    const mastra = createAllRounderMastra({ ledger: new MemorySandboxLedger() });
    expect(mastra.getAgent("financeGl").id).toBe("finance-gl");
    expect(mastra.getAgent("dispatcherTriage").id).toBe("dispatcher-triage");
    expect(mastra.getAgent("programmingInvestigator").id).toBe("programming-investigator");
    expect(mastra.getAgent("issuesAnalyst").id).toBe("issue-analyst");
    expect(mastra.getAgent("featuresPlanner").id).toBe("feature-planner");
    expect(mastra.getAgent("featuresEngineer").id).toBe("feature-engineer");
    expect(mastra.getAgent("dependenciesEngineer").id).toBe("dependency-engineer");
    expect(mastra.getAgent("dependenciesRepair").id).toBe("dependency-repair");
    expect(mastra.getAgent("screeningGuardrail").id).toBe("hr-guardrail");
    // Droppy lane — the autonomous AU dropshipping system, eight bots (PLAN §4).
    expect(mastra.getAgent("droppyResearch").id).toBe("droppy-r1-research");
    expect(mastra.getAgent("droppyListing").id).toBe("droppy-l2-listing");
    expect(mastra.getAgent("droppyOrders").id).toBe("droppy-o3-orders");
    expect(mastra.getAgent("droppyTracking").id).toBe("droppy-t4-tracking");
    expect(mastra.getAgent("droppyExceptions").id).toBe("droppy-x5-exceptions");
    expect(mastra.getAgent("droppySupport").id).toBe("droppy-s6-support");
    expect(mastra.getAgent("droppyPricing").id).toBe("droppy-m7-pricing");
    expect(mastra.getAgent("droppyAds").id).toBe("droppy-a8-ads");
  });

  it("renders scenario examples with their expected outputs", () => {
    const examples = formatScenarioExamples([
      { name: "yes", input: { q: 1 }, expectedOutput: { ok: true } },
    ]);
    expect(examples).toContain("### yes");
    expect(examples).toContain("Input:");
    expect(examples).toContain("Expected output:");
    expect(examples).toContain('"ok": true');
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
      frameworkTag: "spec_verification",
      shape: "{ passed, critique, checkedCriteria[] }",
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
    expect(validator).toContain("If no acceptance criteria are provided");
  });

  it("embeds the on-contract few-shot scenarios in the investigator prompt", async () => {
    const instructions = await agentInstructions(investigatorAgent);
    expect(instructions).toContain("### null check on login handler");
    expect(instructions).toContain('"fixable": true');
    expect(instructions).toContain("Expected output:");
  });
});
