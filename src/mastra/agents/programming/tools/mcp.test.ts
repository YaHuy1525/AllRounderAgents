import { describe, expect, it } from "vitest";

import { StaleSourceError } from "./github.js";
import type { CheckStatus } from "./github.js";
import { GitHubMcpError, McpGitHubBackend, type GitHubMcpSession } from "./mcp.js";

const REQUIRED_TOOLS = [
  "get_commit",
  "get_file_contents",
  "push_files",
  "create_pull_request",
  "list_pull_requests",
];

class FakeMcpSession implements GitHubMcpSession {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly tools: Set<string>;

  constructor(
    tools: string[],
    private readonly handler: (name: string, args: Record<string, unknown>) => unknown,
  ) {
    this.tools = new Set(tools);
  }

  async listTools() {
    return [...this.tools].map((name) => ({ name }));
  }

  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    const out = this.handler(name, args);
    if (out instanceof FakeToolError) {
      return { isError: true, content: [{ type: "text", text: out.message }] };
    }
    if (
      typeof out === "object" &&
      out !== null &&
      Array.isArray((out as { content?: unknown }).content)
    ) {
      // Already an MCP-shaped payload (e.g. resource blocks): pass through.
      return out as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    }
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }

  async close() {}
}

class FakeToolError extends Error {}

function backendWith(
  tools: string[],
  handler: (name: string, args: Record<string, unknown>) => unknown,
): { backend: McpGitHubBackend; session: FakeMcpSession } {
  const session = new FakeMcpSession(tools, handler);
  return { backend: new McpGitHubBackend({ session }), session };
}

function defaultTools(extra: string[] = []): string[] {
  return [...REQUIRED_TOOLS, ...extra];
}

describe("McpGitHubBackend tool mapping", () => {
  it("headSha resolves the branch head through get_commit", async () => {
    const { backend, session } = backendWith(defaultTools(), (name, args) => {
      expect(name).toBe("get_commit");
      expect(args).toEqual({ owner: "acme", repo: "widget", sha: "main" });
      return { sha: "s".repeat(40) };
    });
    await expect(backend.headSha("acme", "widget", "main")).resolves.toBe("s".repeat(40));
    expect(session.calls).toHaveLength(1);
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

  it("commitFiles pushes files then verifies the head commit sha", async () => {
    const commitSha = "c".repeat(40);
    let commits = 0;
    const { backend, session } = backendWith(defaultTools(), (name, args) => {
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
    expect(session.calls.map((call) => call.name)).toEqual(["push_files", "get_commit"]);
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
    const { backend, session } = backendWith(defaultTools(), (name, args) => {
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
    expect(session.calls[0]?.name).toBe("create_pull_request");
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
    const { backend, session } = backendWith(defaultTools(), (name, args) => {
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
    expect(session.calls[0]?.name).toBe("list_pull_requests");
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
  ])("checkRuns aggregates granular get_pull_request_status payload %j", async (payload, expected) => {
    const { backend, session } = backendWith(defaultTools(["get_pull_request_status"]), (name, args) => {
      expect(name).toBe("get_pull_request_status");
      expect(args).toEqual({ owner: "acme", repo: "widget", pull_number: 7 });
      return payload;
    });
    await expect(backend.checkRuns("acme", "widget", "c".repeat(40), 7)).resolves.toBe(expected);
    expect(session.calls[0]?.name).toBe("get_pull_request_status");
  });

  it("checkRuns falls back to pull_request_read when granular is absent", async () => {
    const { backend, session } = backendWith(
      defaultTools(["pull_request_read"]).filter((name) => name !== "get_pull_request_status"),
      (name, args) => {
        expect(name).toBe("pull_request_read");
        expect(args).toEqual({
          owner: "acme",
          repo: "widget",
          pullNumber: 7,
          method: "get_check_runs",
        });
        return { check_runs: [{ status: "completed", conclusion: "success" }] };
      },
    );
    await expect(backend.checkRuns("acme", "widget", "c".repeat(40), 7)).resolves.toBe("success");
    expect(session.calls[0]?.name).toBe("pull_request_read");
  });

  it("checkRuns fails loudly when the server exposes no check reader", async () => {
    const { backend } = backendWith(defaultTools(), () => ({}));
    await expect(backend.checkRuns("acme", "widget", "c".repeat(40), 7)).rejects.toMatchObject({
      name: "GitHubMcpError",
    });
  });

  it("asserts the required tool set on first use", async () => {
    const { backend } = backendWith(["get_commit"], () => ({ sha: "s".repeat(40) }));
    await expect(backend.headSha("acme", "widget", "main")).rejects.toMatchObject({
      name: "GitHubMcpError",
      tool: "connect",
      message: expect.stringContaining("missing required tools"),
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

  it("close() releases a session it owns but not an injected one", async () => {
    const owned = backendWith(defaultTools(), () => ({ sha: "s".repeat(40) }));
    await owned.backend.close();
    const shared = backendWith(defaultTools(), () => ({ sha: "s".repeat(40) }));
    let closed = false;
    shared.session.close = async () => {
      closed = true;
    };
    await shared.backend.close();
    expect(closed).toBe(false);
  });
});
