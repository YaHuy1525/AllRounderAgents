import { afterEach, describe, expect, it } from "vitest";

import {
  knowledgeIndexes,
  knowledgePlaneEnabled,
  knowledgeTools,
  seedKnowledgePlane,
  seededKnowledgeIndexes,
} from "../../../src/mastra/shared/knowledge-plane.js";

/**
 * The knowledge plane is pure wiring: one registry drives both the tool set and
 * the seed run, so these tests manipulate the environment blocks and assert the
 * gate. No database is contacted — PgVector construction is lazy, so a fake
 * connection string is safe, and the seed is only exercised in its decline path.
 * Every function reads the environment at call time, so one static import is
 * enough (no module resets, which would re-transform the rag dependency graph).
 */

const ENV_KEYS = [
  "DATABASE_URL",
  "MASTRA_PG_SSL",
  "MASTRA_RAG_PILOT",
  "HR_KB_TENANT",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_NAME",
  "MODEL_BASE_URL",
] as const;

function saveEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return () => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const WIRED = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  MASTRA_PG_SSL: "false",
  MASTRA_RAG_PILOT: "true",
  EMBEDDING_API_KEY: "test-key",
  EMBEDDING_MODEL: "test-model",
  EMBEDDING_BASE_URL: "https://embed.test/v1",
};

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("knowledge plane", () => {
  it("declines tools and seeding while the plane is not wired", async () => {
    restore = saveEnv();
    delete process.env.MASTRA_RAG_PILOT;
    delete process.env.DATABASE_URL;
    expect(knowledgePlaneEnabled()).toBe(false);
    expect(knowledgeTools()).toEqual({});
    await expect(seedKnowledgePlane()).resolves.toEqual([]);
  });

  it("keeps the registry to one entry per Mastra-owned index", async () => {
    restore = saveEnv();
    const indexes = knowledgeIndexes();
    expect(indexes.map((index) => index.indexName)).toEqual(["hr_policy", "msp_runbooks"]);
    expect(indexes.map((index) => index.toolId)).toEqual([
      "search_hr_policy",
      "search_msp_runbooks",
    ]);
    // The msp leg is declared but has no repo corpus, so it must stay off the
    // searchable surface rather than hand the agent an index nothing seeds.
    expect(indexes.find((index) => index.indexName === "msp_runbooks")?.corpus).toBeUndefined();
    expect(seededKnowledgeIndexes().map((index) => index.indexName)).toEqual(["hr_policy"]);
  });

  it("attaches one search tool per seeded index when wired", async () => {
    restore = saveEnv();
    for (const [key, value] of Object.entries(WIRED)) process.env[key] = value;
    expect(knowledgePlaneEnabled()).toBe(true);
    const tools = knowledgeTools();
    expect(Object.keys(tools)).toEqual(["search_hr_policy"]);
    expect(String(tools.search_hr_policy?.description)).toContain("company HR handbook");
    // Tutorial practice carried through to the model-facing description.
    expect(String(tools.search_hr_policy?.description)).toContain("Ask for 3-4 results");
  });

  it("reads the seed tenant from HR_KB_TENANT with the handbook default", async () => {
    restore = saveEnv();
    const corpus = knowledgeIndexes().find((index) => index.indexName === "hr_policy")?.corpus;
    expect(corpus?.domain).toBe("hr:policy");
    expect(corpus?.sourcePrefix).toBe("hr_policy");
    expect(corpus?.tenantId).toBe("omnidewalt");
    process.env.HR_KB_TENANT = "acme-hr";
    expect(
      knowledgeIndexes().find((index) => index.indexName === "hr_policy")?.corpus?.tenantId,
    ).toBe("acme-hr");
  });
});
