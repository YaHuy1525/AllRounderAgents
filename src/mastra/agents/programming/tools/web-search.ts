import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Read-only web search for the coding agents (Path B tool loop).
 *
 * Mastra's built-in `webSearchTool` is provider-gated to OpenAI/Anthropic/
 * Google/xAI native server-side search, which the OpenRouter DeepSeek model
 * this lane routes to does not expose. So this is a normal callable tool: the
 * model invokes it as a function and it returns ranked snippets backed by the
 * Tavily search API (built for LLM agents). Because it is a plain function
 * tool, it works with any tool-calling model.
 *
 * Web search is optional infrastructure. The coding agents always attach this
 * tool, so each one stays a plain `new Agent({ id, name, instructions, model,
 * tools })` per the Mastra template, and {@link webSearchEnabled} gates only
 * the network call: with no `TAVILY_API_KEY` the tool returns an empty result
 * set instead of reaching Tavily, so an unconfigured deployment degrades to no
 * results rather than breaking on a missing dependency.
 */

/** The Tavily search endpoint (POST, bearer auth). */
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/** Default result count when the model does not ask for a specific number. */
const DEFAULT_MAX_RESULTS = 5;

/** Per-result snippet cap, so a noisy result set cannot flood the coding
 * agent's context window. */
const MAX_SNIPPET_CHARS = 1_200;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilySearchResponse {
  results?: TavilyResult[];
}

/**
 * Clamp a snippet to {@link MAX_SNIPPET_CHARS} so each search hit stays a
 * bounded contribution to the agent's context.
 */
function truncateSnippet(content: string): string {
  return content.length <= MAX_SNIPPET_CHARS ? content : `${content.slice(0, MAX_SNIPPET_CHARS)}…`;
}

/** A single normalized search hit handed back to the model. */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly score: number;
}

/**
 * True when a Tavily key is configured. {@link webSearchTool} reads this at
 * call time: the tool is always attached to the coding agents, but it only
 * reaches the network when a key is present, so an unconfigured deployment
 * degrades to empty results rather than a hard failure.
 */
export function webSearchEnabled(): boolean {
  const key = process.env.TAVILY_API_KEY;
  return key !== undefined && key.trim() !== "";
}

/**
 * Call the Tavily search API and normalize the response. Kept as a standalone
 * function (rather than inlined in `execute`) so it is testable offline with an
 * injected fetch, without driving Mastra's multi-step agent loop.
 */
export async function runTavilySearch(
  query: string,
  maxResults?: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ query: string; results: WebSearchResult[] }> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new Error("TAVILY_API_KEY is not set; web search is unavailable.");
  }
  const response = await fetchImpl(TAVILY_SEARCH_URL, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: maxResults ?? DEFAULT_MAX_RESULTS,
      search_depth: "advanced",
      include_answer: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as TavilySearchResponse;
  const results: WebSearchResult[] = (data.results ?? []).map((result) => ({
    title: result.title ?? "",
    url: result.url ?? "",
    content: truncateSnippet(result.content ?? ""),
    score: typeof result.score === "number" ? result.score : 0,
  }));
  return { query, results };
}

/** The search-result schema the model sees. Snippet content is capped so a
 * noisy result set cannot flood the coding agent's context window. */
const WEB_SEARCH_OUTPUT_SCHEMA = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      score: z.number(),
    }),
  ),
});

export const webSearchTool = createTool({
  id: "web_search",
  description:
    "Search the web for current external context: library docs, API references, changelogs, and known issues. Returns ranked snippets with source URLs. Use it only for behavior you cannot see in the provided source; never cite web results as repository file evidence.",
  inputSchema: z.object({
    query: z.string().min(1).describe("The search query."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many results to return (default 5)."),
  }),
  outputSchema: WEB_SEARCH_OUTPUT_SCHEMA,
  execute: async ({ query, maxResults }, { abortSignal, tracingContext }) => {
    // Trace decoration per the Mastra tracing docs; no-ops when tracing is off.
    const mark = (outcome: string, results?: number): void => {
      tracingContext?.currentSpan?.update({
        metadata: { tool: "web_search", outcome, ...(results === undefined ? {} : { results }) },
      });
    };
    // Attached unconditionally, so degrade to an empty result set when no key
    // is configured rather than throwing into the agent's tool loop.
    if (!webSearchEnabled()) {
      mark("no_key");
      return { query, results: [] };
    }
    const result = await runTavilySearch(query, maxResults, abortSignal);
    mark("ok", result.results.length);
    return result;
  },
});
