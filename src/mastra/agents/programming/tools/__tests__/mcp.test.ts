import { describe, expect, it } from "vitest";

import { StaleSourceError } from "../github.js";
import type { CheckStatus } from "../github.js";
import type { GitHubToolMap } from "../mcp-client.js";
import { GitHubMcpError, McpClientGitHubBackend } from "../mcp.js";

// The new backend drives the discovered GitHub MCP tools through their
// `execute()` seam, so the fake here is a tool map (github_<name> keys) whose
// execute delegates to a scripted handler — mirroring @mastra/mcp, where a tool
// that errors throws (default onToolError = "throw") and a success returns the
// structured content (or an MCP content envelope).

const REQUIRED_TOOLS = [
  "get_commit",
  "get_file_contents",
  "push_files",
  "create_pull_request",
  "list_pull_requests",
];

class FakeToolError extends Error {}

class FakeMcpToolMap {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private readonly map: Record<string, { execute: (input: Record<string, unknown>) => Promise<unknown> }>;

  constructor(
    names: string[],
    private readonly handler: (name: string, args: Record<string, unknown>) => unknown,
  ) {
    this.map = {};
    for (const name of names) {
      this.map[`github_${name}`] = {
        execute: async (input) => {
          this.calls.push({ name, args: input });
          return this.handler(name, input);
        },
      };
    }
  }

  asMap(): GitHubToolMap {
    return this.map as unknown as GitHubToolMap;
  }
}

function backendWith(
  names: string[],
  handler: (name: string, args: Record<string, unknown>) => unknown,
): { backend: McpClientGitHubBackend; map: FakeMcpToolMap } {
  const map = new FakeMcpToolMap(names, handler);
  return { backend: new McpClientGitHubBackend({ tools: async () => map.asMap() }), map };
}

function defaultTools(extra: string[] = []): string[] {
  return [...REQUIRED_TOOLS, ...extra];
}

describe("McpClientGitHubBackend tool mapping", () => {
  it("headSha resolves the branch head through get_commit", async () => {
    const { backend, map } = backendWith(defaultTools(), (name, args) => {
      expect(name).toBe("get_commit");
      expect(args).toEqual({ owner: "acme", repo: "widget", sha: "main" });
      return { sha: "s".repeat(40) };
    });
    await expect(backend.headSha("acme", "widget", "main")).resolves.toBe("s".repeat(40));
    expect(map.calls).toHaveLength(1);
  });

  it("branchHead maps not-found tool errors to undefined", async () => {
    const { backend } = backendWith(defaultTools(), () => {
      throw new FakeToolError("Not Found");
    });
    await expect(backend.branchHead("acme", "widget", "nope/x")).resolves.toBeUndefined();
  });

  it("branchHead treats payload-style no-commit errors as not found", async () => {
    const { backend } = backendWith(defaultTools(), () => {
      throw new FakeToolError(
        "failed to get commit: codex/nope: No commit found for SHA: codex/nope",
      );
    });
    await expect(backend.branchHead("acme", "widget", "codex/nope")).resolves.toBeUndefined();
  });

  it("branchHead surfaces non-not-found errors", async () => {
    const { backend } = backendWith(defaultTools(), () => {
      throw new FakeToolError("Rate limit exceeded");
    });
    await expect(backend.branchHead("acme", "widget", "nope/x")).rejects.toMatchObject({
      name: "GitHubMcpError",
      tool: "get_commit",
    });
  });

  it("fileContent decodes base64 payloads and passes plain text through", async () => {
    const base64 = Buffer.from("hello world").toString("base64");
    const { backend } = backendWith(defaultTools(), (name, args) => {
      expect(args).toMatchObject({
        owner: "acme",
        repo: "widget",
        path: "src/a.ts",
        sha: "s".repeat(40),
      });
      return name === "get_file_contents" ? { content: base64 } : { sha: "" };
    });
    const file = await backend.fileContent("acme", "widget", "src/a.ts", "s".repeat(40));
    expect(file).toEqual({ content: "hello world", sha: "" });
  });

  it("fileContent reads resource-block payloads from official server builds", async () => {
    const sha = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    const { backend } = backendWith(defaultTools(), (name, args) => {
      expect(args).toEqual({ owner: "acme", repo: "widget", path: "src/a.ts", sha: "s".repeat(40) });
      expect(name).toBe("get_file_contents");
      return {
        content: [
          { type: "text", text: `successfully downloaded text file (SHA: ${sha})` },
          {
            type: "resource",
            resource: {
              uri: "repo://acme/widget/sha/main/contents/src/a.ts",
              mimeType: "text/plain; charset=utf-8",
              text: "export const a = 1;",
            },
          },
        ],
      };
    });
    const file = await backend.fileContent("acme", "widget", "src/a.ts", "s".repeat(40));
    expect(file).toEqual({ content: "export const a = 1;", sha });
  });

  it("dirEntries maps a directory array payload", async () => {
    const { backend, map } = backendWith(defaultTools(), (name, args) => {
      expect(name).toBe("get_file_contents");
      expect(args).toEqual({ owner: "acme", repo: "widget", path: "src", sha: "s".repeat(40) });
      return [
        { name: "components", type: "dir" },
        { name: "login.ts", type: "file" },
        { name: "infra", dir: true },
        { type: "file" },
      ];
    });
    await expect(backend.dirEntries("acme", "widget", "src", "s".repeat(40))).resolves.toEqual([
      { name: "components", kind: "dir" },
      { name: "login.ts", kind: "file" },
      { name: "infra", kind: "dir" },
    ]);
    expect(map.calls[0]?.name).toBe("get_file_contents");
  });

  it("dirEntries reads structuredContent directory payloads from official builds", async () => {
    const { backend } = backendWith(defaultTools(), () => ({
      structuredContent: { content: [{ name: "a.ts", type: "file" }] },
      content: [{ type: "text", text: "successfully got contents of directory" }],
    }));
    await expect(backend.dirEntries("acme", "widget", "src", "s".repeat(40))).resolves.toEqual([
      { name: "a.ts", kind: "file" },
    ]);
  });

  it("dirEntries reports a file path as an actionable error", async () => {
    const { backend } = backendWith(defaultTools(), () => ({ content: "export const a = 1;", sha: "f".repeat(40) }));
    await expect(backend.dirEntries("acme", "widget", "src/a.ts", "s".repeat(40))).rejects.toMatchObject({
      name: "GitHubMcpError",
      tool: "get_file_contents",
      message: expect.stringContaining("likely a file, not a directory"),
    });
  });

  it("searchCode degrades to no hits when the server build lacks the tool", async () => {
    const { map, backend } = backendWith(defaultTools(), () => ({}));
    await expect(backend.searchCode("acme", "widget", "parseAmount")).resolves.toEqual([]);
    // No call was attempted against an absent tool.
    expect(map.calls).toHaveLength(0);
  });

  it("searchCode scopes the query and maps item hits", async () => {
    const { backend, map } = backendWith(defaultTools(["search_code"]), (name, args) => {
      expect(name).toBe("search_code");
      expect(args).toEqual({ query: "parseAmount repo:acme/widget", per_page: 10 });
      return {
        total_count: 2,
        items: [
          { path: "src/money.ts", text_matches: [{ fragment: "  function parseAmount(v) {" }] },
          { name: "broken" },
        ],
      };
    });
    await expect(backend.searchCode("acme", "widget", "parseAmount")).resolves.toEqual([
      { path: "src/money.ts", preview: "  function parseAmount(v) {" },
    ]);
    expect(map.calls.some((call) => call.name === "search_code")).toBe(true);
  });

  it("searchCode swallows rate-limit hiccups into an empty hit list", async () => {
    const { backend } = backendWith(defaultTools(["search_code"]), (name) => {
      if (name === "search_code") throw new FakeToolError("You have exceeded a secondary rate limit");
      return {};
    });
    await expect(backend.searchCode("acme", "widget", "x")).resolves.toEqual([]);
  });

  it("commitFiles pushes files then verifies the head commit sha", async () => {
    const commitSha = "c".repeat(40);
    let commits = 0;
    const { backend, map } = backendWith(defaultTools(), (name, args) => {
      if (name === "push_files") {
        expect(args).toEqual({
          owner: "acme",
          repo: "widget",
          branch: "codex/abc",
          files: [
            { path: "src/a.ts", content: "export const a = 1;" },
            { path: "docs/b.md", content: "# b" },
          ],
          message: "fix: abc",
        });
        return { success: true };
      }
      commits += 1;
      return { sha: commitSha };
    });
    await expect(
      backend.commitFiles("acme", "widget", "codex/abc", "fix: abc", "s".repeat(40), [
        { path: "src/a.ts", content: "export const a = 1;", validators: [] },
        { path: "docs/b.md", content: "# b", validators: [] },
      ]),
    ).resolves.toEqual({ commitSha });
    expect(commits).toBe(1);
    expect(map.calls.map((call) => call.name)).toEqual(["push_files", "get_commit"]);
  });

  it("maps push_files CAS conflicts to StaleSourceError", async () => {
    const { backend } = backendWith(defaultTools(), (name) => {
      if (name === "push_files") throw new FakeToolError("Reference already exists");
      return { sha: "c".repeat(40) };
    });
    await expect(
      backend.commitFiles("acme", "widget", "codex/abc", "m", "s".repeat(40), []),
    ).rejects.toBeInstanceOf(StaleSourceError);
  });

  it("maps create_pull_request existence conflicts to StaleSourceError", async () => {
    const { backend } = backendWith(defaultTools(), (name) => {
      if (name === "create_pull_request") {
        throw new FakeToolError("A pull request already exists for codex/abc");
      }
      return { sha: "c".repeat(40) };
    });
    await expect(
      backend.openDraftPull("acme", "widget", "codex/abc", "main", "t", "b"),
    ).rejects.toBeInstanceOf(StaleSourceError);
  });

  it("openDraftPull requests a draft PR and returns number + url", async () => {
    const { backend, map } = backendWith(defaultTools(), (_name, args) => {
      expect(args).toEqual({
        owner: "acme",
        repo: "widget",
        title: "fix: abc",
        body: "body",
        head: "codex/abc",
        base: "main",
        draft: true,
      });
      return { number: 7, html_url: "https://github.com/acme/widget/pull/7" };
    });
    await expect(
      backend.openDraftPull("acme", "widget", "codex/abc", "main", "fix: abc", "body"),
    ).resolves.toEqual({ number: 7, url: "https://github.com/acme/widget/pull/7" });
    expect(map.calls[0]?.name).toBe("create_pull_request");
  });

  it("openDraftPull derives the number from MinimalResponse urls", async () => {
    const { backend } = backendWith(defaultTools(), () => ({
      id: "PR_kwAEXAMPLE",
      url: "https://github.com/acme/widget/pull/7",
    }));
    await expect(
      backend.openDraftPull("acme", "widget", "codex/abc", "main", "fix: abc", "body"),
    ).resolves.toEqual({ number: 7, url: "https://github.com/acme/widget/pull/7" });
  });

  it("listOpenPulls maps entries tolerantly", async () => {
    const { backend, map } = backendWith(defaultTools(), (_name, args) => {
      expect(args).toEqual({
        owner: "acme",
        repo: "widget",
        state: "open",
        head: "acme:codex/abc",
      });
      return [
        {
          number: 3,
          html_url: "https://github.com/acme/widget/pull/3",
          body: "Patch hash: xyz",
          draft: true,
        },
        { number: 4, html_url: "https://github.com/acme/widget/pull/4" },
      ];
    });
    await expect(backend.listOpenPulls("acme", "widget", "codex/abc")).resolves.toEqual([
      { number: 3, url: "https://github.com/acme/widget/pull/3", body: "Patch hash: xyz", draft: true },
      { number: 4, url: "https://github.com/acme/widget/pull/4", body: "", draft: false },
    ]);
    expect(map.calls[0]?.name).toBe("list_pull_requests");
  });

  it("listOpenPulls rejects malformed entries", async () => {
    const { backend } = backendWith(defaultTools(), () => ["garbage"]);
    await expect(backend.listOpenPulls("acme", "widget", "codex/abc")).rejects.toMatchObject({
      name: "GitHubMcpError",
      tool: "list_pull_requests",
    });
  });

  it("checkRuns requires a pull number", async () => {
    const { backend } = backendWith(defaultTools(), () => ({ state: "SUCCESS" }));
    await expect(backend.checkRuns("acme", "widget", "c".repeat(40))).rejects.toMatchObject({
      name: "GitHubMcpError",
      tool: "checkRuns",
    });
  });

  it.each<[Record<string, unknown>, CheckStatus]>([
    [{ state: "FAILURE" }, "failure"],
    [{ state: "PENDING" }, "pending"],
    [{ state: "SUCCESS" }, "success"],
    [{ check_runs: [{ status: "completed", conclusion: "failure" }] }, "failure"],
    [{ check_runs: [{ status: "in_progress", conclusion: null }] }, "pending"],
    [{ check_runs: [{ status: "completed", conclusion: "success" }] }, "success"],
    [{ runs: [{ status: "completed", conclusion: "neutral" }] }, "success"],
  ])("checkRuns aggregates pull_request_read get_check_runs payload %j", async (payload, expected) => {
    const { backend, map } = backendWith(defaultTools(["pull_request_read"]), (name, args) => {
      expect(name).toBe("pull_request_read");
      expect(args).toEqual({
        owner: "acme",
        repo: "widget",
        pullNumber: 7,
        method: "get_check_runs",
      });
      return payload;
    });
    await expect(backend.checkRuns("acme", "widget", "c".repeat(40), 7)).resolves.toBe(expected);
    expect(map.calls[0]?.name).toBe("pull_request_read");
  });

  it("checkRuns fails loudly when the server exposes no check reader", async () => {
    const { backend } = backendWith(defaultTools(), () => ({}));
    await expect(backend.checkRuns("acme", "widget", "c".repeat(40), 7)).rejects.toMatchObject({
      name: "GitHubMcpError",
    });
  });

  it("a tool the server does not expose raises GitHubMcpError naming it", async () => {
    const { backend } = backendWith(["get_file_contents"], () => ({}));
    await expect(backend.headSha("acme", "widget", "main")).rejects.toMatchObject({
      name: "GitHubMcpError",
      tool: "get_commit",
      message: expect.stringContaining("does not expose the get_commit tool"),
    });
  });

  it("wraps tool errors with the tool name", async () => {
    const { backend } = backendWith(defaultTools(), () => {
      throw new FakeToolError("boom");
    });
    const error: GitHubMcpError = await backend
      .headSha("acme", "widget", "main")
      .then(() => {
        throw new Error("should have thrown");
      })
      .catch((caught: unknown) => caught as GitHubMcpError);
    expect(error.name).toBe("GitHubMcpError");
    expect(error.tool).toBe("get_commit");
    expect(error.message).toContain("boom");
  });

  it("auth failures are typed and carry the server message", async () => {
    const { backend } = backendWith(defaultTools(), () => {
      throw new FakeToolError("401 Unauthorized: token expired");
    });
    const error: GitHubMcpError = await backend
      .headSha("acme", "widget", "main")
      .then(() => {
        throw new Error("should have thrown");
      })
      .catch((caught: unknown) => caught as GitHubMcpError);
    expect(error.name).toBe("GitHubMcpError");
    expect(error.message).toContain("authorization failed");
  });

  it("close() is a no-op on the shared client backend", async () => {
    const { backend } = backendWith(defaultTools(), () => ({ sha: "s".repeat(40) }));
    await expect(backend.close()).resolves.toBeUndefined();
  });

  describe("review reads", () => {
    it("listPullRequests maps a bare array and requests open, recently-updated first", async () => {
      const { backend, map } = backendWith(defaultTools(), (name, args) => {
        expect(name).toBe("list_pull_requests");
        expect(args).toEqual({
          owner: "acme",
          repo: "widget",
          state: "open",
          sort: "updated",
          direction: "desc",
          per_page: 30,
        });
        return [{ number: 7, title: "A" }, "garbage"];
      });
      const pulls = await backend.listPullRequests("acme", "widget", 30);
      expect(pulls).toEqual([{ number: 7, title: "A" }]);
      expect(map.calls[0]?.name).toBe("list_pull_requests");
    });

    it("listPullRequests unwraps a { pulls: [...] } envelope", async () => {
      const { backend } = backendWith(defaultTools(), () => ({ pulls: [{ number: 3 }] }));
      await expect(backend.listPullRequests("acme", "widget", 5)).resolves.toEqual([{ number: 3 }]);
    });

    it("getPullRequest returns the single pull object via pull_request_read get", async () => {
      const { backend, map } = backendWith(defaultTools(["pull_request_read"]), (name, args) => {
        expect(name).toBe("pull_request_read");
        expect(args).toEqual({ owner: "acme", repo: "widget", pullNumber: 7, method: "get" });
        return { number: 7, title: "A" };
      });
      await expect(backend.getPullRequest("acme", "widget", 7)).resolves.toEqual({
        number: 7,
        title: "A",
      });
      expect(map.calls[0]?.name).toBe("pull_request_read");
    });

    it("getPullRequest rejects a malformed (non-object) response", async () => {
      const { backend } = backendWith(defaultTools(["pull_request_read"]), () => []);
      await expect(backend.getPullRequest("acme", "widget", 7)).rejects.toMatchObject({
        name: "GitHubMcpError",
        tool: "pull_request_read",
      });
    });

    it("getPullRequestFiles unwraps a { files: [...] } payload", async () => {
      const { backend } = backendWith(defaultTools(["pull_request_read"]), () => ({
        files: [{ filename: "src/a.ts" }],
      }));
      await expect(backend.getPullRequestFiles("acme", "widget", 7)).resolves.toEqual([
        { filename: "src/a.ts" },
      ]);
    });

    it("authenticatedLogin reads get_me, degrading to undefined on failure", async () => {
      const ok = backendWith(defaultTools(["get_me"]), () => ({ login: "reviewer-bot" }));
      await expect(ok.backend.authenticatedLogin()).resolves.toBe("reviewer-bot");
      const bad = backendWith(defaultTools(["get_me"]), () => {
        throw new FakeToolError("401 Unauthorized");
      });
      await expect(bad.backend.authenticatedLogin()).resolves.toBeUndefined();
    });
  });

  describe("review posting via the pending-review flow", () => {
    const REVIEW_TOOLS = ["pull_request_review_write", "add_comment_to_pending_review"];

    it("creates, comments, then submits with the verdict event and body", async () => {
      const { backend, map } = backendWith(defaultTools(REVIEW_TOOLS), (name, args) => {
        if (name === "pull_request_review_write" && args.method === "submit_pending") {
          return { id: 55, html_url: "https://github.com/acme/widget/pull/7#r55" };
        }
        return { ok: true };
      });
      const posted = await backend.submitReview({
        owner: "acme",
        repo: "widget",
        pullNumber: 7,
        commitId: "a".repeat(40),
        event: "REQUEST_CHANGES",
        body: "Please fix",
        comments: [{ path: "src/a.ts", line: 3, body: "Nope" }],
      });
      expect(posted).toEqual({
        reviewId: "55",
        url: "https://github.com/acme/widget/pull/7#r55",
      });
      expect(map.calls.map((call) => call.name)).toEqual([
        "pull_request_review_write",
        "add_comment_to_pending_review",
        "pull_request_review_write",
      ]);
      expect(map.calls[0]?.args).toEqual({
        owner: "acme",
        repo: "widget",
        pullNumber: 7,
        method: "create",
        commitID: "a".repeat(40),
      });
      expect(map.calls[1]?.args).toEqual({
        owner: "acme",
        repo: "widget",
        pullNumber: 7,
        path: "src/a.ts",
        line: 3,
        side: "RIGHT",
        subjectType: "LINE",
        body: "Nope",
      });
      expect(map.calls[2]?.args).toEqual({
        owner: "acme",
        repo: "widget",
        pullNumber: 7,
        method: "submit_pending",
        event: "REQUEST_CHANGES",
        body: "Please fix",
      });
    });

    it("skips the comment call when there are no inline comments", async () => {
      const { backend, map } = backendWith(defaultTools(REVIEW_TOOLS), () => ({ id: 1, html_url: "u" }));
      await backend.submitReview({
        owner: "acme",
        repo: "widget",
        pullNumber: 7,
        commitId: "a".repeat(40),
        event: "APPROVE",
        body: "Ship it",
        comments: [],
      });
      expect(map.calls.map((call) => call.name)).toEqual([
        "pull_request_review_write",
        "pull_request_review_write",
      ]);
    });
  });
});
