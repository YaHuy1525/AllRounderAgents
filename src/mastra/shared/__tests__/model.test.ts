import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_MODEL_PRICE,
  estimateCostMicro,
  modelPrice,
} from "../model.js";

const ENV_KEY = "LLM_PRICING_JSON";

describe("estimateCostMicro", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("multiplies tokens by the per-million price (the /1e6 and *1e6 cancel)", () => {
    // DEFAULT_AGENT_MODEL is priced at the default: 0.1 in, 0.3 out per 1M.
    const cost = estimateCostMicro(
      { inputTokens: 1_000, outputTokens: 500 },
      DEFAULT_AGENT_MODEL,
    );
    expect(cost).toBe(1_000 * 0.1 + 500 * 0.3);
  });

  it("falls back to the default price for an unknown model id", () => {
    expect(modelPrice("openrouter/unknown/model")).toBe(DEFAULT_MODEL_PRICE);
    const cost = estimateCostMicro(
      { inputTokens: 10, outputTokens: 10 },
      "openrouter/unknown/model",
    );
    expect(cost).toBe(10 * DEFAULT_MODEL_PRICE.inputPerMillionUsd + 10 * DEFAULT_MODEL_PRICE.outputPerMillionUsd);
  });

  it("rounds to a whole micro-USD and never returns a negative", () => {
    expect(estimateCostMicro({ inputTokens: 0, outputTokens: 0 }, DEFAULT_AGENT_MODEL)).toBe(0);
    // Fractional micro-USD rounds to the nearest whole: 0.3 -> 0, 0.5 -> 1.
    expect(estimateCostMicro({ inputTokens: 0, outputTokens: 1 }, DEFAULT_AGENT_MODEL)).toBe(0);
    expect(estimateCostMicro({ inputTokens: 5, outputTokens: 0 }, DEFAULT_AGENT_MODEL)).toBe(1);
  });

  it("honours an LLM_PRICING_JSON override for the matched model id", () => {
    process.env[ENV_KEY] = JSON.stringify({
      [DEFAULT_AGENT_MODEL]: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
    });
    expect(estimateCostMicro({ inputTokens: 100, outputTokens: 100 }, DEFAULT_AGENT_MODEL)).toBe(
      100 * 2 + 100 * 4,
    );
  });

  it("ignores a malformed pricing override rather than throwing", () => {
    process.env[ENV_KEY] = "{not valid json";
    expect(() => modelPrice(DEFAULT_AGENT_MODEL)).not.toThrow();
    expect(modelPrice(DEFAULT_AGENT_MODEL)).toEqual(DEFAULT_MODEL_PRICE);
  });

  it("drops malformed per-model entries but keeps valid ones", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "good/model": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      "bad/model": { inputPerMillionUsd: "free" },
    });
    expect(modelPrice("good/model")).toEqual({ inputPerMillionUsd: 1, outputPerMillionUsd: 2 });
    expect(modelPrice("bad/model")).toBe(DEFAULT_MODEL_PRICE);
  });
});
