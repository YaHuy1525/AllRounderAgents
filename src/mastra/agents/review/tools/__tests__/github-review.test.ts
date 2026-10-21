import { describe, expect, it } from "vitest";

import {
  RepositoryPolicyError,
  type GitHubResponse,
  type GitHubTransport,
} from "../../../programming/tools/github.js";
import type {
  ReviewBackend,
  ReviewSubmission,
} from "../../../programming/tools/mcp.js";
import { GitHubReviewTools } from "../github-review.js";

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

/**
 * Structural fake for the shared MCP review backend. The reader's candidate /
 * pull / file reads and the writer's identity lookup + review posting all run
 * through it, so this file exercises the review lane's mapping and policy gates;
 * the MCP payload-normalization and the pending-review write sequence live with
 * the backend itself in mcp.test.ts.
 */
class FakeReviewBackend implements ReviewBackend {
  readonly calls: string[] = [];
  pullRequests: Record<string, unknown>[] = [];
  files: Record<string, unknown>[] = [];
  login: string | undefined = undefined;
  submitError: Error | undefined;
  readonly submissions: ReviewSubmission[] = [];

  async listPullRequests(owner: string, repo: string, limit: number) {
    this.calls.push(`list ${owner}/${repo} ${limit}`);
    return this.pullRequests;
  }

  async getPullRequest(owner: string, repo: string, number: number) {
    this.calls.push(`pull ${owner}/${repo} ${number}`);
    return this.pullRequests[0] ?? {};
  }

  async getPullRequestFiles(owner: string, repo: string, number: number) {
    this.calls.push(`files ${owner}/${repo} ${number}`);
    return this.files;
  }

  async authenticatedLogin() {
    this.calls.push("login");
    return this.login;
  }

  async submitReview(submission: ReviewSubmission) {
    this.calls.push("submit");
    if (this.submitError !== undefined) throw this.submitError;
    this.submissions.push(submission);
    return {
      reviewId: "99",
      url: "https://github.com/acme/app/pull/7#pullrequestreview-99",
    };
  }
}

/** Raw REST seam retained only for the commit-range `compare` diff. */
class RecordingTransport implements GitHubTransport {
  readonly calls: Array<{ method: string; path: string; body: unknown }> = [];
  handler: (method: string, path: string) => GitHubResponse = () => ({ status: 500, body: {} });

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<GitHubResponse> {
    this.calls.push({ method, path, body });
    return this.handler(method, path);
  }
}

function harness(
  configure: (backend: FakeReviewBackend, transport: RecordingTransport) => void = () => {},
) {
  const backend = new FakeReviewBackend();
  const transport = new RecordingTransport();
  configure(backend, transport);
  return { backend, transport, tools: new GitHubReviewTools(backend, transport, POLICY) };
}

describe("GitHubReviewTools", () => {
  it("lists open pull requests as on-contract candidates via the MCP backend", async () => {
    const { backend, tools } = harness((b) => {
      b.pullRequests = [
        {
          number: 7,
          title: "Harden refunds",
          user: { login: "dev" },
          base: { ref: "main" },
          head: { sha: "a".repeat(40) },
          draft: false,
        },
      ];
    });
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
    expect(backend.calls[0]).toBe("list acme/app 30");
  });

  it("reads a single pull request through the backend", async () => {
    const { backend, tools } = harness((b) => {
      b.pullRequests = [
        {
          number: 7,
          title: "Refund guard",
          user: { login: "dev" },
          base: { ref: "main" },
          head: { sha: "a".repeat(40) },
        },
      ];
    });
    const pull = await tools.reader.pull("acme/app", 7);
    expect(pull.number).toBe(7);
    expect(backend.calls).toContain("pull acme/app 7");
  });

  it("maps backend pull-request files and REST compare files to review files", async () => {
    const { backend, transport, tools } = harness((b, t) => {
      b.files = [{ filename: "src/b.ts", status: "added", additions: 5, deletions: 0 }];
      t.handler = (_method, path) =>
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
          : { status: 200, body: [] };
    });
    const files = await tools.reader.pullFiles("acme/app", 7);
    expect(files).toEqual([
      { path: "src/b.ts", status: "added", additions: 5, deletions: 0, patch: "" },
    ]);
    expect(backend.calls).toContain("files acme/app 7");

    // `compare` has no MCP tool: it is the one residual REST read.
    const delta = await tools.reader.compare("acme/app", "b".repeat(40), "a".repeat(40));
    expect(delta).toEqual([
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@" },
    ]);
    expect(transport.calls[0]?.path).toBe(
      `/repos/acme/app/compare/${"b".repeat(40)}...${"a".repeat(40)}`,
    );
  });

  it("posts a review with inline RIGHT-side comments via the backend", async () => {
    const { backend, tools } = harness();
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
    expect(backend.submissions[0]).toEqual({
      owner: "acme",
      repo: "app",
      pullNumber: 7,
      commitId: "a".repeat(40),
      event: "REQUEST_CHANGES",
      body: "Please fix",
      comments: [{ path: "src/a.ts", line: 3, body: "Nope" }],
    });
  });

  it.each([
    ["approve", "APPROVE"],
    ["comment", "COMMENT"],
    ["request_changes", "REQUEST_CHANGES"],
  ] as const)("maps verdict %s to GitHub review event %s", async (verdict, event) => {
    const { backend, tools } = harness();
    await tools.writer.postReview({
      repository: "acme/app",
      number: 7,
      commitSha: "a".repeat(40),
      verdict,
      body: "b",
      comments: [],
    });
    expect(backend.submissions[0]?.event).toBe(event);
  });

  it("downgrades approve to a comment review when the author is the token's own user", async () => {
    const { backend, tools } = harness((b) => {
      b.login = "YaHuy1525";
    });
    await tools.writer.postReview({
      repository: "acme/app",
      number: 7,
      commitSha: "a".repeat(40),
      verdict: "approve",
      body: "Looks great",
      comments: [],
      author: "yahuy1525",
    });
    expect(backend.submissions[0]?.event).toBe("COMMENT");
    expect(backend.submissions[0]?.body).toContain("Looks great");
    expect(backend.submissions[0]?.body).toContain("posted as a comment review");

    // The identity lookup is memoized by the writer across reviews.
    await tools.writer.postReview({
      repository: "acme/app",
      number: 7,
      commitSha: "a".repeat(40),
      verdict: "approve",
      body: "Again",
      comments: [],
      author: "YaHuy1525",
    });
    expect(backend.calls.filter((call) => call === "login")).toHaveLength(1);
  });

  it("keeps the verdict event when the author differs from the token's user", async () => {
    const { backend, tools } = harness((b) => {
      b.login = "reviewer-bot";
    });
    await tools.writer.postReview({
      repository: "acme/app",
      number: 7,
      commitSha: "a".repeat(40),
      verdict: "approve",
      body: "Looks great",
      comments: [],
      author: "dev",
    });
    expect(backend.submissions[0]?.event).toBe("APPROVE");
    expect(backend.submissions[0]?.body).toBe("Looks great");
  });

  it("propagates the backend rejection reason on a failed post", async () => {
    const { tools } = harness((b) => {
      b.submitError = new Error("Can not approve your own pull request");
    });
    await expect(
      tools.writer.postReview({
        repository: "acme/app",
        number: 7,
        commitSha: "a".repeat(40),
        verdict: "comment",
        body: "b",
        comments: [],
      }),
    ).rejects.toThrow("Can not approve your own pull request");
  });

  it("denies repositories outside the allowlist before any backend or transport call", async () => {
    const { backend, transport, tools } = harness();
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
    expect(backend.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a non-2xx REST compare response", async () => {
    const { tools } = harness((_b, t) => {
      t.handler = () => ({ status: 404, body: { message: "Not Found" } });
    });
    await expect(tools.reader.compare("acme/app", "b".repeat(40), "a".repeat(40))).rejects.toThrow(
      "GitHub request failed (404)",
    );
  });
});
