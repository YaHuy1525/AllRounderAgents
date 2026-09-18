import { Agent } from "@mastra/core/agent";

import { DEFAULT_AGENT_MODEL_CONFIG } from "../shared/model.js";

export interface AgentScenario<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly input: TInput;
  readonly expectedOutput: TOutput;
}

/** Render a scenario pool as few-shot examples ("### name / Input: / Expected output:"). */
export function formatScenarioExamples(scenarios: readonly AgentScenario[]): string {
  return scenarios
    .map(
      (scenario) =>
        `### ${scenario.name}\nInput:\n${JSON.stringify(scenario.input, null, 2)}\nExpected output:\n${JSON.stringify(scenario.expectedOutput, null, 2)}`,
    )
    .join("\n\n");
}

export function formatAgentScript(config: {
  role: string;
  rules: readonly string[];
  outputShape: string;
  scenarios: readonly AgentScenario[];
}): string {
  return [
    config.role,
    "Rules:",
    ...config.rules.map((rule) => `- ${rule}`),
    `Return JSON only, matching: ${config.outputShape}`,
    "Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.",
    formatScenarioExamples(config.scenarios),
  ].join("\n");
}

interface LaneAgentConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly script: string;
}

/**
 * Shared agent wiring for every AllRounder lane:
 * - OpenRouter `nex-agi/nex-n2.5-pro:free` model (single source of truth in
 *   shared/model.ts).
 * - Zero-temperature generate/stream options for deterministic, analytical
 *   output (v1.64 names these `*Legacy`; `generate()` merges them).
 * - Instructions resolved at run time so hosts can inject a `promptOverride`
 *   via the Mastra RequestContext; otherwise the prebuilt script is used.
 */
function createLaneAgent(config: LaneAgentConfig): Agent {
  return new Agent({
    id: config.id,
    name: config.name,
    ...(config.description === undefined ? {} : { description: config.description }),
    model: DEFAULT_AGENT_MODEL_CONFIG,
    defaultGenerateOptionsLegacy: { temperature: 0 },
    defaultStreamOptionsLegacy: { temperature: 0 },
    instructions: async ({ requestContext }) => {
      const override = requestContext?.get("promptOverride");
      if (typeof override === "string" && override.length > 0) return override;
      return config.script;
    },
  });
}

/**
 * Scripted agent assembled from role/rules/outputShape plus few-shot
 * scenarios (legacy flat script; kept for lanes that do not need the
 * structured prompt architecture).
 */
export function createScriptedAgent(config: {
  id: string;
  name: string;
  description?: string;
  role: string;
  rules: readonly string[];
  outputShape: string;
  scenarios: readonly AgentScenario[];
}): Agent {
  return createLaneAgent({
    id: config.id,
    name: config.name,
    description: config.description,
    script: formatAgentScript(config),
  });
}

/**
 * Structured agent backed by a fully prebuilt instruction script (e.g. the
 * XML-block prompts from `structuredAgentPrompt`): identity, primary
 * directive, analysis framework, output format, constraints, examples, and a
 * verification checklist live in the script itself.
 */
export function createStructuredAgent(config: {
  id: string;
  name: string;
  description?: string;
  prompt: string;
}): Agent {
  return createLaneAgent({
    id: config.id,
    name: config.name,
    description: config.description,
    script: config.prompt,
  });
}
