import { describe, expect, it } from "vitest";

import {
  RepositoryPolicyError,
  type GitHubResponse,
  type GitHubTransport,
} from "../../programming/tools/github.js";
import { GitHubReviewTools } from "./github-review.js";

const POLICY = {
  repositories: ["acme/app"],
  baseBranch: "main",
  allowPaths: ["src/**"],
  denyPaths: [],
  destructivePaths: [],
  maxFiles: 10,
  maxPatchBytes: 10_000,
  timeoutMs: 1_000,
};

class RecordingTransport implements GitHubTransport {
  readonly calls: Array<{ method: string; path: string; body: unknown }> = [];
  handler: (method: string, path: string) => GitHubResponse = () => ({ status: 500, body: {} });

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<GitHubResponse> {
    this.calls.push({ method, path, body });
    return this.handler(method, path);
  }
}

function harness(handler: (method: string, path: string) => GitHubResponse) {
  const transport = new RecordingTransport();
  transport.handler = handler;
  return { transport, tools: new GitHubReviewTools(transport, POLICY) };
}

describe("GitHubReviewTools", () => {
  it("lists open pull requests as on-contract candidates", async () => {
    const { transport, tools } = harness(() => ({
      status: 200,
      body: [
        {
          number: 7,
          title: "Harden refunds",
          user: { login: "dev" },
          base: { ref: "main" },
          head: { sha: "a".repeat(40) },
          draft: false,
        },
      ],
    }));
    const candidates = await tools.reader.listCandidates("acme/app", 30);
    expect(candidates).toEqual([
      {
        number: 7,
        title: "Harden refunds",
        repository: "acme/app",
        author: "dev",
        baseBranch: "main",
        headSha: "a".repeat(40),
        draft: false,
      },
    ]);
    expect(transport.calls[0]).toMatchObject({
      method: "GET",
      path: "/repos/acme/app/pulls?state=open&sort=updated&direction=desc&per_page=30",
    });
  });

  it("maps pull-request files and compare files to review files", async () => {
    const { transport, tools } = harness((_method, path) =>
      path.includes("/compare/")
        ? {
            status: 200,
            body: {
              files: [
                {
                  filename: "src/a.ts",
                  status: "modified",
                  additions: 2,
                  deletions: 1,
                  patch: "@@ -1 +1 @@",
                },
              ],
            },
          }
        : {
            status: 200,
            body: [{ filename: "src/b.ts", status: "added", additions: 5, deletions: 0 }],
          },
    );
    const files = await tools.reader.pullFiles("acme/app", 7);
    expect(files).toEqual([
      { path: "src/b.ts", status: "added", additions: 5, deletions: 0, patch: "" },
    ]);
    expect(transport.calls[0]?.path).toBe("/repos/acme/app/pulls/7/files?per_page=100");

    const delta = await tools.reader.compare("acme/app", "b".repeat(40), "a".repeat(40));
    expect(delta).toEqual([
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@" },
    ]);
    expect(transport.calls[1]?.path).toBe(
      `/repos/acme/app/compare/${"b".repeat(40)}...${"a".repeat(40)}`,
    );
  });

  it("posts reviews with inline RIGHT-side comments", async () => {
    const { transport, tools } = harness(() => ({
      status: 200,
      body: { id: 99, html_url: "https://github.com/acme/app/pull/7#pullrequestreview-99" },
    }));
    const posted = await tools.writer.postReview({
      repository: "acme/app",
      number: 7,
      commitSha: "a".repeat(40),
      verdict: "request_changes",
      body: "Please fix",
      comments: [{ path: "src/a.ts", line: 3, body: "Nope" }],
    });
    expect(posted).toEqual({
      reviewId: "99",
      url: "https://github.com/acme/app/pull/7#pullrequestreview-99",
    });
    expect(transport.calls[0]?.path).toBe("/repos/acme/app/pulls/7/reviews");
    expect(transport.calls[0]?.body).toEqual({
      commit_id: "a".repeat(40),
      event: "REQUEST_CHANGES",
      body: "Please fix",
      comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "Nope" }],
    });
  });

  it.each([
    ["approve", "APPROVE"],
    ["comment", "COMMENT"],
    ["request_changes", "REQUEST_CHANGES"],
  ] as const)("maps verdict %s to GitHub review event %s", async (verdict, event) => {
    const { transport, tools } = harness(() => ({ status: 200, body: { id: 1, html_url: "u" } }));
    await tools.writer.postReview({
      repository: "acme/app",
      number: 7,
      commitSha: "a".repeat(40),
      verdict,
      body: "b",
      comments: [],
    });
    const body = transport.calls[0]?.body as Record<string, unknown>;
    expect(body.event).toBe(event);
    expect(body.comments).toBeUndefined();
  });

  it("denies repositories outside the allowlist before any request", async () => {
    const { transport, tools } = harness(() => ({ status: 200, body: [] }));
    await expect(tools.reader.listCandidates("other/app", 10)).rejects.toBeInstanceOf(
      RepositoryPolicyError,
    );
    await expect(tools.reader.pull("other/app", 1)).rejects.toBeInstanceOf(RepositoryPolicyError);
    await expect(tools.reader.pullFiles("other/app", 1)).rejects.toBeInstanceOf(
      RepositoryPolicyError,
    );
    await expect(
      tools.writer.postReview({
        repository: "other/app",
        number: 1,
        commitSha: "a".repeat(40),
        verdict: "comment",
        body: "b",
        comments: [],
      }),
    ).rejects.toBeInstanceOf(RepositoryPolicyError);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects non-2xx GitHub responses", async () => {
    const { tools } = harness(() => ({ status: 404, body: { message: "Not Found" } }));
    await expect(tools.reader.pull("acme/app", 999)).rejects.toThrow("GitHub request failed (404)");
    await expect(tools.reader.pullFiles("acme/app", 7)).rejects.toThrow(
      "GitHub request failed (404)",
    );
  });
});
