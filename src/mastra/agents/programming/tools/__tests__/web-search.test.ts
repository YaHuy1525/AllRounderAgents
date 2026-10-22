import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runTavilySearch,
  webSearchEnabled,
  webSearchTool,
} from "../web-search.js";

/** A minimal fetch double: records the last request and returns a canned JSON body. */
function fakeFetch(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  const calls: Array<{ url: string; requestInit: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), requestInit });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? "OK",
      async json() {
        return body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("coding-agent web search tool", () => {
  const originalKey = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    delete process.env.TAVILY_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  });

  describe("webSearchEnabled", () => {
    it("is false with no key and true with a key", () => {
      expect(webSearchEnabled()).toBe(false);
      process.env.TAVILY_API_KEY = "  ";
      expect(webSearchEnabled()).toBe(false);
      process.env.TAVILY_API_KEY = "tvly-test";
      expect(webSearchEnabled()).toBe(true);
    });
  });

  describe("runTavilySearch", () => {
    it("throws when no key is configured", async () => {
      const { fetchImpl } = fakeFetch({ results: [] });
      await expect(runTavilySearch("x", undefined, undefined, fetchImpl)).rejects.toThrow(
        /TAVILY_API_KEY is not set/,
      );
    });

    it("POSTs to Tavily with bearer auth and maps normalized results", async () => {
      process.env.TAVILY_API_KEY = "tvly-test";
      const { fetchImpl, calls } = fakeFetch({
        results: [
          { title: "Docs", url: "https://x.test/docs", content: "short snippet", score: 0.9 },
          { title: "Issue", url: "https://x.test/issue", content: "another", score: "bad" },
        ],
      });
      const out = await runTavilySearch("why does fastify 4 crash", 3, undefined, fetchImpl);

      expect(calls[0]?.url).toBe("https://api.tavily.com/search");
      const request = calls[0]?.requestInit;
      expect(request?.method).toBe("POST");
      expect((request?.headers as Record<string, string>).Authorization).toBe("Bearer tvly-test");
      expect(JSON.parse(String(request?.body))).toMatchObject({
        query: "why does fastify 4 crash",
        max_results: 3,
        search_depth: "advanced",
      });

      expect(out.query).toBe("why does fastify 4 crash");
      expect(out.results).toHaveLength(2);
      expect(out.results[0]).toEqual({
        title: "Docs",
        url: "https://x.test/docs",
        content: "short snippet",
        score: 0.9,
      });
      // A non-numeric score normalizes to 0, missing fields default to "".
      expect(out.results[1]?.score).toBe(0);
    });

    it("defaults max_results to 5 when the model omits it", async () => {
      process.env.TAVILY_API_KEY = "tvly-test";
      const { fetchImpl, calls } = fakeFetch({ results: [] });
      await runTavilySearch("q", undefined, undefined, fetchImpl);
      expect(JSON.parse(String(calls[0]?.requestInit?.body)).max_results).toBe(5);
    });

    it("truncates an oversized snippet", async () => {
      process.env.TAVILY_API_KEY = "tvly-test";
      const long = "a".repeat(2_000);
      const { fetchImpl } = fakeFetch({ results: [{ title: "t", url: "u", content: long, score: 1 }] });
      const out = await runTavilySearch("q", undefined, undefined, fetchImpl);
      const content = out.results[0]?.content ?? "";
      expect(content.length).toBeLessThanOrEqual(1_201); // 1200 chars + ellipsis
      expect(content.endsWith("…")).toBe(true);
    });

    it("throws on a non-OK response", async () => {
      process.env.TAVILY_API_KEY = "tvly-test";
      const { fetchImpl } = fakeFetch({}, { ok: false, status: 429, statusText: "Too Many Requests" });
      await expect(runTavilySearch("q", undefined, undefined, fetchImpl)).rejects.toThrow(
        /Tavily search failed: 429/,
      );
    });
  });

  it("registers the tool with the expected id", () => {
    expect(webSearchTool.id).toBe("web_search");
  });
});
