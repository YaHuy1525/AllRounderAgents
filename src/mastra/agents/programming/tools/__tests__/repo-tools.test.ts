import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepositoryPolicyError } from "../github.js";
import {
  getGitHubBackend,
  listRepoDir,
  readRepoFile,
  searchRepoCode,
  setGitHubBackend,
  validatePatchDraft,
  type RepoReadBackend,
  listDirTool,
  readFileTool,
  searchCodeTool,
  validatePatchTool,
} from "../repo-tools.js";
import type { CodeHit, DirEntry } from "../mcp.js";

/** Scripted read backend: canned file, listing, and search hits, no network. */
class FakeRepoBackend implements RepoReadBackend {
  readonly calls: Array<{ op: string; args: unknown[] }> = [];

  constructor(
    private readonly fixture: {
      file?: { content: string; sha: string };
      entries?: DirEntry[];
      hits?: CodeHit[];
      failure?: Error;
    } = {},
  ) {}

  async fileContent(owner: string, repo: string, path: string, ref: string) {
    this.calls.push({ op: "fileContent", args: [owner, repo, path, ref] });
    if (this.fixture.failure !== undefined) throw this.fixture.failure;
    return this.fixture.file ?? { content: "line1\nline2\nline3", sha: "f".repeat(40) };
  }

  async dirEntries(owner: string, repo: string, path: string, ref: string) {
    this.calls.push({ op: "dirEntries", args: [owner, repo, path, ref] });
    if (this.fixture.failure !== undefined) throw this.fixture.failure;
    return this.fixture.entries ?? [{ name: "src", kind: "dir" }, { name: "README.md", kind: "file" }];
  }

  async searchCode(owner: string, repo: string, query: string) {
    this.calls.push({ op: "searchCode", args: [owner, repo, query] });
    if (this.fixture.failure !== undefined) throw this.fixture.failure;
    return this.fixture.hits ?? [{ path: "src/login.ts", preview: "if (!user) throw" }];
  }
}

const ALLOWED = { owner: "acme", repo: "widget" };

describe("coding-agent repository tools", () => {
  const saved = {
    allowlist: process.env.GITHUB_REPOSITORY_ALLOWLIST,
    mcpToken: process.env.GITHUB_MCP_TOKEN,
    token: process.env.GITHUB_TOKEN,
  };

  beforeEach(() => {
    process.env.GITHUB_REPOSITORY_ALLOWLIST = "acme/widget";
    delete process.env.GITHUB_MCP_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    setGitHubBackend(undefined);
    if (saved.allowlist === undefined) delete process.env.GITHUB_REPOSITORY_ALLOWLIST;
    else process.env.GITHUB_REPOSITORY_ALLOWLIST = saved.allowlist;
    if (saved.mcpToken === undefined) delete process.env.GITHUB_MCP_TOKEN;
    else process.env.GITHUB_MCP_TOKEN = saved.mcpToken;
    if (saved.token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.token;
  });

  describe("readRepoFile", () => {
    it("returns the whole file with sha and line count when no window is given", async () => {
      const backend = new FakeRepoBackend({ file: { content: "a\nb\nc\nd", sha: "ab" } });
      const out = await readRepoFile({ ...ALLOWED, path: "src/x.ts", ref: "deadbeef" }, backend);
      expect(out).toEqual({
        path: "src/x.ts",
        ref: "deadbeef",
        content: "a\nb\nc\nd",
        sha: "ab",
        totalLines: 4,
        truncated: false,
      });
      expect(backend.calls[0]).toEqual({
        op: "fileContent",
        args: ["acme", "widget", "src/x.ts", "deadbeef"],
      });
    });

    it("slices a 1-based inclusive line window and echoes it back", async () => {
      const backend = new FakeRepoBackend({ file: { content: "a\nb\nc\nd", sha: "" } });
      const out = await readRepoFile(
        { ...ALLOWED, path: "src/x.ts", ref: "main", startLine: 2, endLine: 3 },
        backend,
      );
      expect(out.content).toBe("b\nc");
      expect(out.startLine).toBe(2);
      expect(out.endLine).toBe(3);
      expect(out.totalLines).toBe(4);
    });

    it("clamps an out-of-range window end and returns an empty window past the end", async () => {
      const backend = new FakeRepoBackend({ file: { content: "a\nb", sha: "" } });
      const clamped = await readRepoFile(
        { ...ALLOWED, path: "src/x.ts", ref: "main", startLine: 1, endLine: 99 },
        backend,
      );
      expect(clamped.content).toBe("a\nb");
      expect(clamped.endLine).toBe(2);
      const past = await readRepoFile(
        { ...ALLOWED, path: "src/x.ts", ref: "main", startLine: 10 },
        backend,
      );
      expect(past.content).toBe("");
    });

    it("caps an oversized read at 8 000 chars with the truncated flag", async () => {
      const backend = new FakeRepoBackend({ file: { content: "x".repeat(20_000), sha: "" } });
      const out = await readRepoFile({ ...ALLOWED, path: "big.txt", ref: "main" }, backend);
      expect(out.content.length).toBeLessThanOrEqual(8_001);
      expect(out.content.endsWith("…")).toBe(true);
      expect(out.truncated).toBe(true);
    });

    it("denies a repository outside the allowlist with RepositoryPolicyError", async () => {
      const backend = new FakeRepoBackend();
      await expect(
        readRepoFile({ owner: "evil", repo: "corp", path: "a", ref: "main" }, backend),
      ).rejects.toThrow(RepositoryPolicyError);
      expect(backend.calls).toHaveLength(0);
    });

    it("fails closed when no repository allowlist is configured", async () => {
      delete process.env.GITHUB_REPOSITORY_ALLOWLIST;
      await expect(
        readRepoFile({ ...ALLOWED, path: "a", ref: "main" }, new FakeRepoBackend()),
      ).rejects.toThrow(/not configured/);
    });

    it("propagates an actionable backend error (file path is a directory)", async () => {
      const backend = new FakeRepoBackend({ failure: new Error("no readable text; it may be a directory") });
      await expect(
        readRepoFile({ ...ALLOWED, path: "src", ref: "main" }, backend),
      ).rejects.toThrow(/may be a directory/);
    });
  });

  describe("listRepoDir", () => {
    it("maps entries and caps the listing at 200", async () => {
      const many = Array.from({ length: 250 }, (_, i) => ({ name: `f${i}`, kind: "file" as const }));
      const out = await listRepoDir({ ...ALLOWED, path: "src", ref: "main" }, new FakeRepoBackend({ entries: many }));
      expect(out.entries).toHaveLength(200);
      expect(out.truncated).toBe(true);
    });

    it("enforces the repository allowlist", async () => {
      await expect(
        listRepoDir({ owner: "evil", repo: "corp", path: ".", ref: "main" }, new FakeRepoBackend()),
      ).rejects.toThrow(/Repository not allowed/);
    });
  });

  describe("searchRepoCode", () => {
    it("delegates to the backend with the repository scope enforced", async () => {
      const backend = new FakeRepoBackend();
      const out = await searchRepoCode({ ...ALLOWED, query: "parseAmount" }, backend);
      expect(out.results).toEqual([{ path: "src/login.ts", preview: "if (!user) throw" }]);
      expect(backend.calls[0]?.args).toEqual(["acme", "widget", "parseAmount"]);
    });

    it("returns an empty hit list when the server build lacks code search", async () => {
      const backend = new FakeRepoBackend({ hits: [] });
      const out = await searchRepoCode({ ...ALLOWED, query: "anything" }, backend);
      expect(out.results).toEqual([]);
    });

    it("enforces the repository allowlist", async () => {
      await expect(
        searchRepoCode({ owner: "evil", repo: "corp", query: "x" }, new FakeRepoBackend()),
      ).rejects.toThrow(RepositoryPolicyError);
    });
  });

  describe("validatePatchDraft", () => {
    it("reports per-file failures for invalid content", () => {
      const out = validatePatchDraft([
        { path: "config/settings.json", content: "{ not json", validators: ["json"] },
      ]);
      expect(out.passed).toBe(false);
      expect(out.results[0]).toMatchObject({
        validator: "json",
        path: "config/settings.json",
        passed: false,
        message: "Invalid JSON",
      });
    });

    it("passes a well-formed draft", () => {
      const out = validatePatchDraft([
        { path: "config/settings.json", content: '{"a": 1}', validators: ["json", "basic-syntax"] },
      ]);
      expect(out.passed).toBe(true);
      expect(out.results).toHaveLength(2);
    });
  });

  describe("backend resolution", () => {
    it("degrades with no token and no injected backend", () => {
      expect(getGitHubBackend()).toBeUndefined();
    });

    it("prefers the injected backend", () => {
      const fake = new FakeRepoBackend();
      setGitHubBackend(fake);
      expect(getGitHubBackend()).toBe(fake);
    });

    it("lazily builds the MCP backend when a token is configured", () => {
      process.env.GITHUB_MCP_TOKEN = "ghp_test";
      expect(getGitHubBackend()).toBeDefined();
    });
  });

  it("registers the tools with ids matching their agent tools keys", () => {
    // Mastra exposes the tools-record KEY to the model as toolName, so the id
    // is kept identical (snake_case, like Mastra's built-in tool ids) to keep
    // prompts, streams, and traces on one name.
    expect(readFileTool.id).toBe("read_file");
    expect(listDirTool.id).toBe("list_dir");
    expect(searchCodeTool.id).toBe("search_code");
    expect(validatePatchTool.id).toBe("validate_patch");
  });
});
