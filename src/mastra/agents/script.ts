export interface AgentScenario<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly input: TInput;
  readonly expectedOutput: TOutput;
}

/**
 * Render a scenario pool as few-shot examples ("### name / Input: / Expected
 * output:"). Every AllRounder agent embeds its scenario set in the
 * `<examples>` block of its inline instruction string with this helper, so
 * the expected-output shape stays verbatim and on-contract.
 */
export function formatScenarioExamples(scenarios: readonly AgentScenario[]): string {
  return scenarios
    .map(
      (scenario) =>
        `### ${scenario.name}\nInput:\n${JSON.stringify(scenario.input, null, 2)}\nExpected output:\n${JSON.stringify(scenario.expectedOutput, null, 2)}`,
    )
    .join("\n\n");
}
