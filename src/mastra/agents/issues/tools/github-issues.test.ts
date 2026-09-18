import { describe, expect, it } from "vitest";

import {
  FakeGitHubTransport,
  GitHubRepositoryTools,
  RepositoryPolicyError,
  type GitHubPolicy,
  type GitHubResponse,
  type GitHubTransport,
} from "../../programming/tools/github.js";
import { GitHubIssueReader } from "./github-issues.js";

const SOURCE_SHA = "a".repeat(40);

const POLICY: GitHubPolicy = {
  repositories: ["acme/app"],
  baseBranch: "main",
  allowPaths: ["src/**", "tests/**"],
  denyPaths: [".github/workflows/**"],
  destructivePaths: ["migrations/**"],
  maxFiles: 10,
  maxPatchBytes: 250_000,
  timeoutMs: 5_000,
};

/** Minimal tree endpoint; the coding-lane fake does not serve `/git/trees`. */
class TreeTransport {
  readonly calls: string[] = [];

  constructor(
    private readonly body: unknown,
    private readonly status = 200,
  ) {}

  async request(method: "GET" | "POST", path: string): Promise<GitHubResponse> {
    this.calls.push(`${method} ${path}`);
    return { status: this.status, body: this.body };
  }
}

function readerFor(transport: GitHubTransport): {
  reader: GitHubIssueReader;
  github: FakeGitHubTransport;
} {
  const github = new FakeGitHubTransport({
    sourceSha: SOURCE_SHA,
    treeSha: "b".repeat(40),
    commitSha: "c".repeat(40),
    checks: "success",
  });
  const tools = new GitHubRepositoryTools(github, POLICY);
  return { reader: new GitHubIssueReader(tools.reader, transport, POLICY), github };
}

describe("GitHubIssueReader", () => {
  it("lists only blobs, drops vendor paths, and applies the limit", async () => {
    const transport = new TreeTransport({
      tree: [
        { type: "blob", path: "src/profile/loader.ts" },
        { type: "tree", path: "src/profile" },
        { type: "blob", path: "node_modules/lib/index.js" },
        { type: "blob", path: "src/profile/settings.ts" },
        { type: "blob", path: ".git/config" },
        { type: "blob", path: "dist/bundle.js" },
        { type: "blob", path: "src/config/app.json" },
        { type: "blob", path: "src/extra/one.ts" },
        { type: "blob" },
        "not-an-entry",
        null,
      ],
    });
    const { reader } = readerFor(transport);
    const files = await reader.listFiles("acme", "app", SOURCE_SHA, 2);
    expect(files).toEqual(["src/profile/loader.ts", "src/profile/settings.ts"]);
    expect(transport.calls).toEqual([`GET /repos/acme/app/git/trees/${SOURCE_SHA}?recursive=1`]);
  });

  it("returns every allowlisted blob when under the limit", async () => {
    const transport = new TreeTransport({
      tree: [
        { type: "blob", path: "src/a.ts" },
        { type: "blob", path: "tests/a.test.ts" },
        { type: "blob", path: "src/nested/b.ts" },
      ],
    });
    const { reader } = readerFor(transport);
    await expect(reader.listFiles("acme", "app", SOURCE_SHA, 10)).resolves.toEqual([
      "src/a.ts",
      "tests/a.test.ts",
      "src/nested/b.ts",
    ]);
  });

  it("drops tree paths outside the policy so every listed file can be served", async () => {
    const transport = new TreeTransport({
      tree: [
        { type: "blob", path: "README.md" },
        { type: "blob", path: "package.json" },
        { type: "blob", path: "docs/guide.md" },
        { type: "blob", path: ".github/workflows/ci.yml" },
        { type: "blob", path: "src/profile/loader.ts" },
        { type: "blob", path: "tests/loader.test.ts" },
      ],
    });
    const { reader } = readerFor(transport);
    await expect(reader.listFiles("acme", "app", SOURCE_SHA, 10)).resolves.toEqual([
      "src/profile/loader.ts",
      "tests/loader.test.ts",
    ]);
    expect(reader.allowsPath("README.md")).toBe(false);
    expect(reader.allowsPath("tests/loader.test.ts")).toBe(true);
  });

  it("rejects repositories outside the allowlist before requesting", async () => {
    const transport = new TreeTransport({ tree: [] });
    const { reader } = readerFor(transport);
    await expect(reader.listFiles("acme", "other", SOURCE_SHA, 10)).rejects.toThrow(
      RepositoryPolicyError,
    );
    expect(transport.calls).toEqual([]);
  });

  it("throws on non-2xx tree responses and tolerates a missing tree", async () => {
    const failing = new TreeTransport({ tree: [] }, 404);
    await expect(readerFor(failing).reader.listFiles("acme", "app", SOURCE_SHA, 10)).rejects.toThrow(
      "GitHub request failed (404)",
    );

    const empty = new TreeTransport({});
    await expect(readerFor(empty).reader.listFiles("acme", "app", SOURCE_SHA, 10)).resolves.toEqual(
      [],
    );
  });

  it("delegates source SHA and allowlisted file reads to the coding-lane reader", async () => {
    const { reader, github } = readerFor(new TreeTransport({ tree: [] }));
    await expect(reader.sourceSha("acme", "app", "main")).resolves.toBe(SOURCE_SHA);
    await expect(
      reader.content("acme", "app", "src/profile/loader.ts", SOURCE_SHA),
    ).resolves.toEqual({ content: "fixture", sha: "1".repeat(40) });
    expect(github.logs).toEqual([
      "GET /repos/acme/app/git/ref/heads/main",
      `GET /repos/acme/app/contents/src/profile/loader.ts?ref=${SOURCE_SHA}`,
    ]);

    await expect(
      reader.content("acme", "app", "infra/secret.env", SOURCE_SHA),
    ).rejects.toThrow(RepositoryPolicyError);
  });
});
