import { afterEach, describe, expect, it, vi } from "vitest";

import { consoleAssistantAgent } from "../agents/consoleAssistantAgent.js";
import { DEFAULT_AGENT_MODEL } from "../../../shared/model.js";

/**
 * The console assistant is asserted as configuration: identity, model pin,
 * citation discipline and the PgVector filter reference in its instructions,
 * plus the knowledge tools it carries when the plane is wired. The model is
 * never called and no database is contacted.
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
  "KNOWLEDGE_API_URL",
  "KNOWLEDGE_SERVICE_TOKEN",
  "CHAT_MODEL",
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

async function loadAgentWithPlane() {
  process.env.MASTRA_RAG_PILOT = "true";
  process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
  process.env.MASTRA_PG_SSL = "false";
  process.env.EMBEDDING_API_KEY = "test-key";
  process.env.EMBEDDING_MODEL = "test-model";
  process.env.EMBEDDING_BASE_URL = "https://embed.test/v1";
  // The console bridge is a separate wiring; keep the two families apart.
  delete process.env.KNOWLEDGE_API_URL;
  delete process.env.KNOWLEDGE_SERVICE_TOKEN;
  vi.resetModules();
  const module = await import("../agents/consoleAssistantAgent.js");
  return module.consoleAssistantAgent;
}

async function loadAgentWithConsoleBridge() {
  process.env.KNOWLEDGE_API_URL = "https://api.example";
  process.env.KNOWLEDGE_SERVICE_TOKEN = "service-token";
  for (const key of ["MASTRA_RAG_PILOT", "DATABASE_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL"]) {
    delete process.env[key];
  }
  vi.resetModules();
  const module = await import("../agents/consoleAssistantAgent.js");
  return module.consoleAssistantAgent;
}

async function instructionsText(): Promise<string> {
  const instructions = await consoleAssistantAgent.getInstructions();
  return typeof instructions === "string" ? instructions : JSON.stringify(instructions);
}

describe("console assistant agent", () => {
  it("is registered as the conversational console agent", () => {
    expect(consoleAssistantAgent.id).toBe("console-assistant");
    expect(consoleAssistantAgent.name).toBe("Console assistant");
  });

  it("instructs grounded answers with sourceId:span citations", async () => {
    const text = await instructionsText();
    expect(text.startsWith("<identity>")).toBe(true);
    for (const tag of [
      "conversation_rules",
      "tool_rules",
      "grounding_rules",
      "output_format",
      "constraints",
      "filter_reference",
    ]) {
      expect(text).toContain(`<${tag}>`);
      expect(text).toContain(`</${tag}>`);
    }
    expect(text).toContain("[sourceId:span]");
    expect(text).toContain("Ask each search for 3-4 results");
    // An ungrounded policy answer must be admitted, not invented.
    expect(text).toContain("Never substitute remembered or generic policy");
    // The filter grammar the vector-query tool needs ships with the prompt.
    expect(text).toContain("When querying PG Vector, you can ONLY use the operators");
  });

  it("carries one knowledge search tool per seeded index when the plane is wired", async () => {
    const agent = await loadAgentWithPlane();
    const tools = await agent.listTools();
    expect(Object.keys(tools)).toEqual(["search_hr_policy"]);
  });

  it("runs without knowledge tools when the plane is not wired", async () => {
    for (const key of [
      "MASTRA_RAG_PILOT",
      "DATABASE_URL",
      "EMBEDDING_API_KEY",
      "EMBEDDING_MODEL",
      "KNOWLEDGE_API_URL",
      "KNOWLEDGE_SERVICE_TOKEN",
    ]) {
      delete process.env[key];
    }
    vi.resetModules();
    const module = await import("../agents/consoleAssistantAgent.js");
    const tools = await module.consoleAssistantAgent.listTools();
    expect(tools).toEqual({});
  });

  it("carries the read-only console tools when the service bridge is wired", async () => {
    const agent = await loadAgentWithConsoleBridge();
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      "list_tickets",
      "lookup_employee",
      "resolve_start_fields",
    ]);
  });

  it("tells the model it cannot start a run", async () => {
    const text = await instructionsText();
    expect(text).toContain("Never say a run was started");
    expect(text).toContain("Read-only: no tool here starts");
    expect(text).toContain("resolve_start_fields tool");
    expect(text).toContain("lookup_employee tool");
    expect(text).toContain("list_tickets tool");
  });

  it("answers as one open conversationalist over every lane", async () => {
    const text = await instructionsText();
    // ChatGPT-style behaviour, not a command pad: it must answer what was
    // asked, ask when a value is missing, and keep the thread's context.
    expect(text).toContain("Answer the question that was asked");
    expect(text).toContain("one clarifying question");
    expect(text).toContain("carries over from earlier turns");
    // Coding lanes are in scope for the same single assistant.
    expect(text).toContain("including the coding lanes");
    // The old agent picker is gone; nothing may tell the model it is one of a
    // fixed set of lane assistants.
    expect(text).not.toContain("You are the triage assistant");
  });

  it("keeps the read-only invariant while opening the conversation", async () => {
    const text = await instructionsText();
    expect(text).toContain("Never say a run was started");
    expect(text).toContain("the confirm step");
  });

  it("resolves the model from CHAT_MODEL and falls back to the default", async () => {
    process.env.CHAT_MODEL = "openrouter/deepseek/deepseek-v4-pro";
    vi.resetModules();
    const fresh = (await import("../agents/consoleAssistantAgent.js")).consoleAssistantAgent;
    const model = await fresh.getModel();
    expect(JSON.stringify(model)).toContain("deepseek-v4-pro");
    delete process.env.CHAT_MODEL;
    vi.resetModules();
    const fallback = (await import("../agents/consoleAssistantAgent.js")).consoleAssistantAgent;
    expect(JSON.stringify(await fallback.getModel())).toContain(
      DEFAULT_AGENT_MODEL.split("/").at(-1),
    );
  });

  it("carries no write tool", async () => {
    const agent = await loadAgentWithConsoleBridge();
    const tools = await agent.listTools();
    const writable = Object.entries(tools).filter(
      ([, tool]) =>
        (tool as { readonly metadata?: { readonly writable?: boolean } }).metadata?.writable ===
        true,
    );
    expect(writable).toEqual([]);
    // Every id the console chat depends on, and nothing beyond them.
    expect(Object.keys(tools).sort()).toEqual([
      "list_tickets",
      "lookup_employee",
      "resolve_start_fields",
    ]);
  });
});
