export const DEFAULT_AGENT_MODEL = "openrouter/deepseek/deepseek-v4-flash" as const;

/**
 * Router id only: @mastra/core's provider registry pins OpenRouter's base URL
 * and reads the key from OPENROUTER_API_KEY per request. An explicit `url`
 * here flips the router onto its openai-compatible branch, which ignores that
 * variable and authenticates with other keys instead.
 */
export const DEFAULT_AGENT_MODEL_CONFIG = {
  id: DEFAULT_AGENT_MODEL,
} as const;

export type ModelTier = "reasoning" | "mechanical";

/**
 * A provider model ref as the Mastra agent config expects it: a `provider/model`
 * id. Env overrides are widened from `string` to this shape at the seam so the
 * routing stays type-safe while any `openrouter/...` id is allowed.
 */
export type ModelRef = { readonly id: `${string}/${string}` };

/**
 * Per-agent model configuration seam (A6): the reasoning sandwich. Planning,
 * investigation, and the spec critic want the higher reasoning budget; the
 * mechanical patch repair wants the cheaper tier. Each resolves from an env
 * override and falls back to the shared default, so routing is real but the
 * lane never breaks when a stronger model is not configured.
 */
export const REASONING_AGENT_MODEL_CONFIG: ModelRef = {
  id: (process.env.CODING_REASONING_MODEL ?? DEFAULT_AGENT_MODEL) as `${string}/${string}`,
};

export const MECHANICAL_AGENT_MODEL_CONFIG: ModelRef = {
  id: (process.env.CODING_MECHANICAL_MODEL ?? DEFAULT_AGENT_MODEL) as `${string}/${string}`,
};

/**
 * Console chat seam: `CHAT_MODEL` swaps the conversational model by env edit
 * with no code change, exactly like the coding tiers. Router id only — an
 * explicit `url` would move authentication off `OPENROUTER_API_KEY`.
 */
export const CONSOLE_ASSISTANT_MODEL_CONFIG: ModelRef = {
  id: (process.env.CHAT_MODEL ?? DEFAULT_AGENT_MODEL) as `${string}/${string}`,
};

export function modelTierConfig(tier: ModelTier): ModelRef {
  return tier === "reasoning" ? REASONING_AGENT_MODEL_CONFIG : MECHANICAL_AGENT_MODEL_CONFIG;
}

/** The model id a tier resolves to, for recording cost attribution per stage. */
export function modelTierId(tier: ModelTier): string {
  return modelTierConfig(tier).id;
}

/**
 * Token counts for a single model call, normalized to the naming the current
 * AiSDK/Mastra generate path reports (`inputTokens`/`outputTokens`). The older
 * `promptTokens`/`completionTokens` naming is accepted at the seam so a provider
 * swap never silently drops a run's cost to zero.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** USD price per one million tokens, split by direction. */
export interface ModelPrice {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

/**
 * Fallback price for any model not in the table. Deliberately conservative so an
 * unmodeled id still yields a plausible, non-zero cost rather than hiding spend.
 */
export const DEFAULT_MODEL_PRICE: ModelPrice = {
  inputPerMillionUsd: 0.1,
  outputPerMillionUsd: 0.3,
};

// Built-in prices for the ids this lane actually routes to; keyed by the full
// `provider/model` id. `LLM_PRICING_JSON` (a `{ [modelId]: { inputPerMillionUsd,
// outputPerMillionUsd } }` map) overrides this whole table at runtime so ops can
// correct prices without a code change.
const BUILTIN_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  [DEFAULT_AGENT_MODEL]: DEFAULT_MODEL_PRICE,
};

function isPrice(value: unknown): value is ModelPrice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.inputPerMillionUsd === "number" &&
    typeof record.outputPerMillionUsd === "number"
  );
}

function pricingTable(): Readonly<Record<string, ModelPrice>> {
  const raw = process.env.LLM_PRICING_JSON;
  if (raw === undefined || raw.trim() === "") return BUILTIN_MODEL_PRICES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return BUILTIN_MODEL_PRICES;
    const table: Record<string, ModelPrice> = {};
    for (const [modelId, price] of Object.entries(parsed)) {
      if (isPrice(price)) table[modelId] = price;
    }
    return table;
  } catch {
    return BUILTIN_MODEL_PRICES;
  }
}

/** Resolve the price for a model id, falling back to the default. */
export function modelPrice(modelId: string): ModelPrice {
  return pricingTable()[modelId] ?? DEFAULT_MODEL_PRICE;
}

/**
 * Micro-USD cost for one model call. Cost in USD is tokens/1e6 * price-per-1M;
 * expressing it in micro-USD (USD * 1e6) cancels the two factors, leaving
 * `tokens * pricePerMillionUsd`. Clamped to a non-negative integer so a
 * malformed usage object can never drive the archived cost negative.
 */
export function estimateCostMicro(usage: TokenUsage, modelId: string): number {
  const price = modelPrice(modelId);
  const usd =
    usage.inputTokens * price.inputPerMillionUsd +
    usage.outputTokens * price.outputPerMillionUsd;
  return Math.max(0, Math.round(usd));
}
