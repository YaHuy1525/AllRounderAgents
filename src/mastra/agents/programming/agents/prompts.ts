import {
  formatScenarioExamples,
  type AgentScenario,
} from "../../script.js";

export interface PromptDimension {
  readonly name: string;
  readonly guidance: string;
}

export interface PromptFramework {
  /** XML tag name, e.g. "rca_analysis". */
  readonly tag: string;
  readonly title: string;
  readonly dimensions: readonly PromptDimension[];
}

export interface StructuredPromptConfig {
  /** <identity>: who the agent is and its specialized scope. */
  readonly identity: string;
  /** <primary_directive>: numbered high-level steps the agent must execute. */
  readonly directives: readonly string[];
  /** Baseline standard for output quality, appended to the directive. */
  readonly qualityBar: string;
  /** <framework_tag>: systematic analysis dimensions so nothing is missed. */
  readonly framework?: PromptFramework;
  /** <output_format>: exact JSON structure the agent must return. */
  readonly outputShape: string;
  readonly outputFields: readonly string[];
  /** IMPORTANT conditional rules (empty states, omit-when rules). */
  readonly conditionalRules: readonly string[];
  /** <constraints>: guardrails the agent cannot break. */
  readonly constraints: readonly string[];
  /** <verification>: pre-flight checklist before the final answer. */
  readonly verification: readonly string[];
  /** <examples>: few-shot scenarios with expected outputs. */
  readonly scenarios: readonly AgentScenario[];
}

function bulletLines(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Assembles the XML-block instruction script described by the structured
 * prompting architecture: <identity>, <primary_directive>, a domain
 * framework, <output_format>, <constraints>, <examples>, and
 * <verification>. Keep the JSON-shape line short so every model call ends
 * on the few-shot examples, not on free-form prose.
 */
export function structuredAgentPrompt(config: StructuredPromptConfig): string {
  const directive = config.directives
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  const framework = config.framework === undefined
    ? ""
    : [
        "",
        `<${config.framework.tag}>`,
        config.framework.title,
        "Dimensions:",
        ...config.framework.dimensions.map(
          (dimension) => `- ${dimension.name}: ${dimension.guidance}`,
        ),
        `</${config.framework.tag}>`,
      ].join("\n");
  return [
    "<identity>",
    config.identity,
    "</identity>",
    "",
    "<primary_directive>",
    directive,
    `Quality bar: ${config.qualityBar}`,
    "</primary_directive>",
    framework,
    "",
    "<output_format>",
    `Return JSON only, matching: ${config.outputShape}`,
    ...config.outputFields.map((field) => `- ${field}`),
    "IMPORTANT:",
    ...config.conditionalRules.map((rule) => `- ${rule}`),
    "</output_format>",
    "",
    "<constraints>",
    bulletLines(config.constraints),
    "</constraints>",
    "",
    "<examples>",
    "Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.",
    formatScenarioExamples(config.scenarios),
    "</examples>",
    "",
    "<verification>",
    "Before returning, review your draft against this checklist:",
    bulletLines(config.verification),
    "</verification>",
  ].join("\n");
}
