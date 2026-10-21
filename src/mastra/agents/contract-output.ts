import type { Agent } from "@mastra/core/agent";
import type { z } from "zod";

import { DEFAULT_AGENT_MODEL, estimateCostMicro } from "../shared/model.js";

/**
 * Shared plumbing every lane's model factory uses to turn an agent reply into
 * a contract-valid output object. Phase 7.1 moved this onto Mastra's native
 * structured output: `agent.generate(prompt, { structuredOutput: { schema } })`
 * runs the tool loop and returns a schema-shaped `result.object`, so the
 * hand-rolled fence/balance regex JSON scraping (`extractJson`) and the
 * text-parse helper are gone. We still validate `result.object` through the
 * lane's own zod schema with `safeParse`, because the runtime contract is
 * stricter than the JSON schema the model is steered with — `.strict()` extra
 * keys, `.min(1)` non-empty arrays, and empty-string paths are exactly what
 * free-tier models trip when the inspected context is thin, and the AI-SDK
 * schema conversion does not carry those bounds. A first violation earns the
 * model exactly one bounded re-ask with the aggregated detail fed back; a
 * second violation still surfaces loudly (mirrors the implementation
 * validators' single-repair philosophy).
 */

/**
 * Validate the native structured object through the contract schema; every
 * violation is aggregated into one `${label} contract violation: ...` error
 * naming each offending path. Returns the parsed (coerced) data on success.
 */
function checkContract<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} contract violation: ${detail}`);
  }
  return parsed.data;
}

/**
 * Per-call generation overrides for reasoning-tier routing (A6). Only the
 * model id is forwarded to `agent.generate`; the budget is the model choice
 * itself, so we never pass an option key the Mastra generate overload rejects.
 */
export interface ContractGenerateOptions {
  readonly model?: { readonly id: `${string}/${string}` };
  /**
   * Per-call trace decoration forwarded verbatim to `agent.generate` (Mastra
   * tracing docs): `tags` land on the trace's root span for filtering and
   * `metadata` carries call-scoped fields (agent role, ticket key). Ignored
   * when observability is off, so it costs nothing on default deployments.
   */
  readonly tracingOptions?: { tags?: string[]; metadata?: Record<string, unknown> };
  /**
   * Optional usage telemetry: called with the micro-USD cost of each model
   * call this helper makes (so a re-ask reports both). Kept best-effort and
   * never allowed to throw into the parse path — a cost-reporting bug must not
   * fail an otherwise-valid contract output.
   */
  readonly onUsage?: (costMicro: number) => void;
}

/**
 * Normalize a Mastra/AiSDK generate result's usage into token counts, tolerating
 * both the current (`inputTokens`/`outputTokens`) and legacy
 * (`promptTokens`/`completionTokens`) naming. Any non-number becomes 0.
 */
function readTokens(usage: unknown): { inputTokens: number; outputTokens: number } {
  if (typeof usage !== "object" || usage === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const record = usage as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    inputTokens: num(record.inputTokens) || num(record.promptTokens),
    outputTokens: num(record.outputTokens) || num(record.completionTokens),
  };
}

/**
 * Report one generate result's cost through `onUsage`, if wired. Guarded so a
 * telemetry failure can never disturb the contract output.
 */
function reportUsage(
  usage: unknown,
  modelId: string,
  onUsage: ((costMicro: number) => void) | undefined,
): void {
  if (onUsage === undefined) return;
  try {
    const cost = estimateCostMicro(readTokens(usage), modelId);
    if (cost > 0) onUsage(cost);
  } catch {
    // Cost is best-effort; swallow so the parsed output still returns.
  }
}

/**
 * Generate through the agent's native structured output and validate the
 * returned object against the contract schema, re-asking once with the
 * violation detail fed back when the first answer breaks the contract.
 * `options` carries the per-call reasoning tier (model id) so planning,
 * investigation, and the critic can spend the higher tier while mechanical
 * repair spends less. The absent-option discipline is unchanged: conditional
 * spreads keep absent keys genuinely absent, which `exactOptionalPropertyTypes`
 * requires of Mastra's generate-options shape.
 */
export async function generateContractOutput<T extends object>(
  agent: Agent,
  prompt: string,
  schema: z.ZodType<T>,
  label: string,
  options?: ContractGenerateOptions,
): Promise<T> {
  const tierModel = options?.model;
  const tracingOptions = options?.tracingOptions;
  const generateOptions = {
    ...(tierModel !== undefined ? { model: tierModel } : {}),
    ...(tracingOptions !== undefined ? { tracingOptions } : {}),
    structuredOutput: { schema },
  };
  const modelId = tierModel?.id ?? DEFAULT_AGENT_MODEL;
  const first = await agent.generate(prompt, generateOptions);
  reportUsage(first.usage, modelId, options?.onUsage);
  try {
    return checkContract(schema, first.object, label);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const repair = [
      prompt,
      "",
      `Your previous answer failed the output contract: ${detail}`,
      "Return only the corrected JSON object.",
    ].join("\n");
    const second = await agent.generate(repair, generateOptions);
    reportUsage(second.usage, modelId, options?.onUsage);
    return checkContract(schema, second.object, label);
  }
}
