import { describe, expect, it } from "vitest";

import type { Agent } from "@mastra/core/agent";

import { z } from "zod";

import { generateContractOutput } from "../contract-output.js";

const AREAS_SCHEMA = z.object({ areas: z.array(z.string()).min(1) }).strict();

/**
 * Agent stub replaying the structured `object` results in order and recording
 * each prompt. Native structured output puts the parsed payload on
 * `result.object`, so the stub carries objects (never raw text) now.
 */
function stubAgent(
  replies: ReadonlyArray<{ object?: unknown; error?: Error }>,
): { agent: Agent; prompts: string[] } {
  const prompts: string[] = [];
  const agent = {
    async generate(prompt: string) {
      prompts.push(prompt);
      const reply = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
      if (reply.error instanceof Error) throw reply.error;
      return { object: reply.object };
    },
  } as unknown as Agent;
  return { agent, prompts };
}

describe("generateContractOutput", () => {
  it("returns the first answer when it is already on-contract", async () => {
    const { agent, prompts } = stubAgent([{ object: { areas: ["ui"] } }]);
    await expect(generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner")).resolves.toEqual({
      areas: ["ui"],
    });
    expect(prompts).toHaveLength(1);
  });

  it("re-asks exactly once with the violation detail", async () => {
    const { agent, prompts } = stubAgent([
      { object: { areas: [] } },
      { object: { areas: ["ui"] } },
    ]);
    await expect(generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner")).resolves.toEqual({
      areas: ["ui"],
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Plan it.");
    expect(prompts[1]).toContain(
      "Planner contract violation: areas: Array must contain at least 1 element(s)",
    );
    expect(prompts[1]).toContain("Return only the corrected JSON object.");
  });

  it("surfaces the violation when the repaired answer is still off-contract", async () => {
    const { agent, prompts } = stubAgent([{ object: { areas: [] } }]);
    await expect(generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner")).rejects.toThrow(
      "Planner contract violation: areas: Array must contain at least 1 element(s)",
    );
    expect(prompts).toHaveLength(2);
  });

  it("rejects an extra key the strict contract forbids", async () => {
    const { agent } = stubAgent([
      { object: { areas: ["ui"], extra: true } },
      { object: { areas: ["ui"] } },
    ]);
    await expect(generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner")).resolves.toEqual({
      areas: ["ui"],
    });
  });

  it("forwards tracingOptions and structuredOutput to agent.generate on every attempt", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const agent = {
      async generate(_prompt: string, options?: Record<string, unknown>) {
        seen.push(options);
        return { object: { areas: [] } };
      },
    } as unknown as Agent;
    const tracingOptions = { tags: ["lane:coding"], metadata: { agent: "planner" } };
    await expect(
      generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner", { tracingOptions }),
    ).rejects.toThrow("Planner contract violation");
    // First answer plus the re-ask: both calls carry the same trace decoration
    // and ask for structured output against the contract schema.
    expect(seen).toHaveLength(2);
    for (const options of seen) {
      expect(options?.tracingOptions).toEqual(tracingOptions);
      expect((options?.structuredOutput as { schema?: unknown })?.schema).toBe(AREAS_SCHEMA);
    }
  });

  it("omits the tracingOptions key when none is given but still sends structuredOutput", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const agent = {
      async generate(_prompt: string, options?: Record<string, unknown>) {
        seen.push(options);
        return { object: { areas: ["ui"] } };
      },
    } as unknown as Agent;
    await generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner");
    expect(seen[0]).not.toHaveProperty("tracingOptions");
    expect(seen[0]).toHaveProperty("structuredOutput");
  });
});

/** Agent stub replaying fixed object answers (with usage) and counting calls. */
function usageAgent(
  answers: ReadonlyArray<{ object?: unknown; usage?: unknown }>,
): { agent: Agent; calls: number[] } {
  const calls: number[] = [];
  const agent = {
    async generate() {
      const index = Math.min(calls.length, answers.length - 1);
      calls.push(index);
      return answers[index];
    },
  } as unknown as Agent;
  return { agent, calls };
}

describe("generateContractOutput usage telemetry", () => {
  it("reports each model call's token cost in micro-USD", async () => {
    // Unpriced model id falls back to the default 0.1 in / 0.3 out per 1M.
    const { agent } = usageAgent([
      { object: { areas: ["ui"] }, usage: { inputTokens: 1_000, outputTokens: 0 } },
    ]);
    const costs: number[] = [];
    await generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner", {
      onUsage: (cost) => costs.push(cost),
    });
    expect(costs).toEqual([100]);
  });

  it("accumulates across the re-ask so a repair reports both calls", async () => {
    const { agent } = usageAgent([
      { object: { areas: [] }, usage: { inputTokens: 1_000, outputTokens: 0 } },
      { object: { areas: ["ui"] }, usage: { inputTokens: 1_000, outputTokens: 0 } },
    ]);
    const costs: number[] = [];
    await generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner", {
      onUsage: (cost) => costs.push(cost),
    });
    expect(costs).toEqual([100, 100]);
  });

  it("accepts the legacy promptTokens/completionTokens naming", async () => {
    const { agent } = usageAgent([
      { object: { areas: ["ui"] }, usage: { promptTokens: 1_000, completionTokens: 0 } },
    ]);
    const costs: number[] = [];
    await generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner", {
      onUsage: (cost) => costs.push(cost),
    });
    expect(costs).toEqual([100]);
  });

  it("stays silent when a reply carries no usage and never breaks the parse", async () => {
    const { agent } = usageAgent([{ object: { areas: ["ui"] } }]);
    const costs: number[] = [];
    await expect(
      generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner", {
        onUsage: (cost) => costs.push(cost),
      }),
    ).resolves.toEqual({ areas: ["ui"] });
    expect(costs).toEqual([]);
  });
});
