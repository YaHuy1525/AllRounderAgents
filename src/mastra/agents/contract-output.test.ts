import { describe, expect, it } from "vitest";

import type { Agent } from "@mastra/core/agent";

import { z } from "zod";

import { extractJson, generateContractOutput, parseJsonObject } from "./contract-output.js";

const AREAS_SCHEMA = z.object({ areas: z.array(z.string()).min(1) }).strict();

/** Agent stub replaying the answers in order and recording each prompt. */
function stubAgent(replies: ReadonlyArray<string | Error>): { agent: Agent; prompts: string[] } {
  const prompts: string[] = [];
  const agent = {
    async generate(prompt: string) {
      prompts.push(prompt);
      const reply = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return { text: reply };
    },
  } as unknown as Agent;
  return { agent, prompts };
}

describe("extractJson", () => {
  it("pulls the JSON object out of a fenced block", () => {
    expect(extractJson('Here is the plan:\n```json\n{"areas": ["ui"]}\n```\n')).toEqual({
      areas: ["ui"],
    });
  });

  it("pulls the JSON object out of prose-wrapped text", () => {
    expect(extractJson('Sure! {"areas": {"nested": true}} Hope that helps.')).toEqual({
      areas: { nested: true },
    });
  });

  it("throws when the reply contains no JSON object", () => {
    expect(() => extractJson("no object here")).toThrow(
      "Agent output did not contain a JSON object",
    );
  });
});

describe("parseJsonObject", () => {
  it("returns the parsed data when the reply is on-contract", () => {
    expect(parseJsonObject(AREAS_SCHEMA, '{"areas": ["ui"]}', "Planner")).toEqual({
      areas: ["ui"],
    });
  });

  it("names the label and the issue when the reply is off-contract", () => {
    expect(() => parseJsonObject(AREAS_SCHEMA, '{"areas": []}', "Planner")).toThrow(
      "Planner contract violation: areas: Array must contain at least 1 element(s)",
    );
  });
});

describe("generateContractOutput", () => {
  it("returns the first answer when it is already on-contract", async () => {
    const { agent, prompts } = stubAgent(['{"areas": ["ui"]}']);
    await expect(generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner")).resolves.toEqual({
      areas: ["ui"],
    });
    expect(prompts).toHaveLength(1);
  });

  it("re-asks exactly once with the violation detail", async () => {
    const { agent, prompts } = stubAgent(['{"areas": []}', '{"areas": ["ui"]}']);
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
    const { agent, prompts } = stubAgent(['{"areas": []}']);
    await expect(generateContractOutput(agent, "Plan it.", AREAS_SCHEMA, "Planner")).rejects.toThrow(
      "Planner contract violation: areas: Array must contain at least 1 element(s)",
    );
    expect(prompts).toHaveLength(2);
  });
});
