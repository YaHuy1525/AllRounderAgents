import { describe, expect, it } from "vitest";

import { FakeGitHubBackend } from "../../../../../src/mastra/testing/github-fakes.js";
import {
  GitHubRepositoryTools,
  RepositoryPolicyError,
  type GitHubPolicy,
} from "../../../../../src/mastra/agents/programming/tools/github.js";
import { GitHubIssueReader } from "../../../../../src/mastra/agents/issues/tools/github-issues.js";

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

// The reader now receives an already-flattened blob list from the shared
// GitHubBackend (whose MCP implementation walks directory listings); this test
// covers the reader's own vendor + allowlist + limit filtering. Directory-list
// parsing lives with the backend in mcp.test.ts.
function readerFor(backend: FakeGitHubBackend): {
  reader: GitHubIssueReader;
  github: FakeGitHubBackend;
} {
  const tools = new GitHubRepositoryTools(backend, POLICY);
  return { reader: new GitHubIssueReader(tools.reader, backend, POLICY), github: backend };
}

function backend(): FakeGitHubBackend {
  return new FakeGitHubBackend({
    sourceSha: SOURCE_SHA,
    commitSha: "c".repeat(40),
    checks: "success",
  });
}

describe("GitHubIssueReader", () => {
  it("drops vendor paths and applies the limit", async () => {
    const github = backend();
    github.files = [
      "src/profile/loader.ts",
      "src/profile/settings.ts",
      "node_modules/lib/index.js",
      ".git/config",
      "dist/bundle.js",
      "src/config/app.json",
      "src/extra/one.ts",
    ];
    const { reader } = readerFor(github);
    const files = await reader.listFiles("acme", "app", SOURCE_SHA, 2);
    expect(files).toEqual(["src/profile/loader.ts", "src/profile/settings.ts"]);
  });

  it("returns every allowlisted file when under the limit", async () => {
    const github = backend();
    github.files = ["src/a.ts", "tests/a.test.ts", "src/nested/b.ts"];
    const { reader } = readerFor(github);
    await expect(reader.listFiles("acme", "app", SOURCE_SHA, 10)).resolves.toEqual([
      "src/a.ts",
      "tests/a.test.ts",
      "src/nested/b.ts",
    ]);
  });

  it("drops paths outside the policy so every listed file can be served", async () => {
    const github = backend();
    github.files = [
      "README.md",
      "package.json",
      "docs/guide.md",
      ".github/workflows/ci.yml",
      "src/profile/loader.ts",
      "tests/loader.test.ts",
    ];
    const { reader } = readerFor(github);
    await expect(reader.listFiles("acme", "app", SOURCE_SHA, 10)).resolves.toEqual([
      "src/profile/loader.ts",
      "tests/loader.test.ts",
    ]);
    expect(reader.allowsPath("README.md")).toBe(false);
    expect(reader.allowsPath("tests/loader.test.ts")).toBe(true);
  });

  it("rejects repositories outside the allowlist before requesting the listing", async () => {
    const github = backend();
    github.files = ["src/a.ts"];
    const { reader } = readerFor(github);
    await expect(reader.listFiles("acme", "other", SOURCE_SHA, 10)).rejects.toThrow(
      RepositoryPolicyError,
    );
  });

  it("delegates source SHA and allowlisted file reads to the coding-lane reader", async () => {
    const { reader, github } = readerFor(backend());
    await expect(reader.sourceSha("acme", "app", "main")).resolves.toBe(SOURCE_SHA);
    await expect(
      reader.content("acme", "app", "src/profile/loader.ts", SOURCE_SHA),
    ).resolves.toEqual({ content: "fixture", sha: "1".repeat(40) });
    expect(github.logs).toEqual(["headSha main", "fileContent src/profile/loader.ts"]);

    await expect(
      reader.content("acme", "app", "infra/secret.env", SOURCE_SHA),
    ).rejects.toThrow(RepositoryPolicyError);
  });
});
