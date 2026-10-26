import { afterEach, describe, expect, it } from "vitest";

import { createKnowledgeTool } from "../knowledge-tool.js";

/**
 * The knowledge tool factory is pure configuration: it either builds a
 * vector-query tool from the environment wiring or declines, so the tests
 * manipulate env blocks and assert the gate, never a database connection.
 * PgVector construction is lazy, so a fake connection string is safe.
 */

const ENV_KEYS = [
  "DATABASE_URL",
  "MASTRA_PG_SSL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_DIMENSIONS",
  "MODEL_API_KEY",
  "MODEL_NAME",
  "MODEL_BASE_URL",
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const baseOptions = {
  id: "search_company_knowledge",
  description: "Search the company handbook.",
  indexName: "hr_policy",
};

describe("createKnowledgeTool", () => {
  it("declines without DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    process.env.EMBEDDING_API_KEY = "test-key";
    process.env.EMBEDDING_MODEL = "test-model";
    expect(createKnowledgeTool(baseOptions)).toBeUndefined();
  });

  it("declines without the embedding block", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.MODEL_API_KEY;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.MODEL_NAME;
    expect(createKnowledgeTool(baseOptions)).toBeUndefined();
  });

  it("builds the vector-query tool when store and embedder are wired", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.MASTRA_PG_SSL = "false";
    process.env.EMBEDDING_API_KEY = "test-key";
    process.env.EMBEDDING_MODEL = "test-model";
    process.env.EMBEDDING_BASE_URL = "https://embed.test/v1";
    const tool = createKnowledgeTool(baseOptions);
    expect(tool).toBeDefined();
    expect(tool?.id).toBe("search_company_knowledge");
    // Tutorial practice baked into the prompt-facing description.
    expect(String(tool?.description)).toContain("Ask for 3-4 results");
  });
});
