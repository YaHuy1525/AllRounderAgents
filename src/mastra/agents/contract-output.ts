import type { Agent, DelegationConfig } from "@mastra/core/agent";
import type { z } from "zod";

import { DEFAULT_AGENT_MODEL, estimateCostMicro } from "../shared/model.js";

/**
 * Shared plumbing every lane's model factory uses to get a contract-valid output
 * object from Mastra's native `structuredOutput`. The lane's zod schema is still
 * enforced with `safeParse`, because the AI-SDK conversion drops `.strict()`
 * extra keys, `.min(1)` arrays and empty-string paths, which thin context trips
 * on. One violation earns a bounded re-ask, a second surfaces loudly.
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
  /**
   * Sub-agent delegation hooks. Passed straight through to `generate`, which
   * is where Mastra reads them: they are an execution option, not a
   * constructor key. A supervisor needs this to gate which child runs.
   */
  readonly delegation?: DelegationConfig;
  /**
   * Iteration ceiling for one generate pass. A supervisor spends a step on each
   * delegation, so the default of one would never reach a child.
   */
  readonly maxSteps?: number;
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
 * Generates through the agent's native structured output and validates the object
 * against the contract schema, re-asking once with the violation detail fed back.
 * `options` carries the per-call reasoning tier; conditional spreads keep absent
 * keys genuinely absent, as `exactOptionalPropertyTypes` requires.
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
  const delegation = options?.delegation;
  const maxSteps = options?.maxSteps;
  const generateOptions = {
    ...(tierModel !== undefined ? { model: tierModel } : {}),
    ...(tracingOptions !== undefined ? { tracingOptions } : {}),
    ...(delegation !== undefined ? { delegation } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
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
