import type { Agent } from "@mastra/core/agent";
import type { z } from "zod";

/**
 * Shared plumbing every lane's model factory uses to turn an agent reply into
 * a contract-valid output object. `parseJsonObject` alone fails hard on the
 * first violation — which free-tier models trip whenever the inspected
 * context is thin (an empty `files`/`areas` array, an empty path string) — so
 * `generateContractOutput` gives the model exactly one bounded re-ask with
 * the violation detail before the failure surfaces.
 */

/** Pull the first JSON object out of an agent reply (fenced or bare). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Agent output did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

/**
 * Parse through the schema; every violation is aggregated into one
 * `${label} contract violation: ...` error naming each offending path.
 */
export function parseJsonObject<T>(schema: z.ZodType<T>, text: string, label: string): T {
  const parsed = schema.safeParse(extractJson(text));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} contract violation: ${detail}`);
  }
  return parsed.data;
}

/**
 * Generate through the agent and parse through the schema, re-asking once with
 * the violation detail fed back when the first answer breaks the output
 * contract. Mirrors the implementation validators' single-repair philosophy:
 * a second violation still surfaces loudly.
 */
export async function generateContractOutput<T>(
  agent: Agent,
  prompt: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const first = await agent.generate(prompt);
  try {
    return parseJsonObject(schema, first.text, label);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const repair = [
      prompt,
      "",
      `Your previous answer failed the output contract: ${detail}`,
      "Return only the corrected JSON object.",
    ].join("\n");
    const second = await agent.generate(repair);
    return parseJsonObject(schema, second.text, label);
  }
}
