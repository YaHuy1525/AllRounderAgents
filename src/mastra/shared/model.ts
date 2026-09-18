export const DEFAULT_AGENT_MODEL = "openrouter/nex-agi/nex-n2.5-pro:free" as const;

/**
 * Router id only: @mastra/core's provider registry pins OpenRouter's base URL
 * and reads the key from OPENROUTER_API_KEY per request. An explicit `url`
 * here flips the router onto its openai-compatible branch, which ignores that
 * variable and authenticates with other keys instead.
 */
export const DEFAULT_AGENT_MODEL_CONFIG = {
  id: DEFAULT_AGENT_MODEL,
} as const;
