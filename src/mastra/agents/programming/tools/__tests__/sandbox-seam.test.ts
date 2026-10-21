/**
 * Sandbox-git migration seam tests (no Docker required).
 *
 * These lock the invariants the migration depends on:
 *  - the change manifest fingerprints identically to the whole-file bodies it
 *    replaces, so the byte-exact approval gate is preserved;
 *  - `GitHubWriter.apply` prefers a working-tree commit when the backend can
 *    do it and falls back to `commitFiles` otherwise (fakes stay valid);
 *  - `redactSecrets` scrubs every credential shape from an error surface;
 *  - `SandboxGitHubBackend.commitWorkingTree` runs the real git choreography
 *    and reveals/clears the push credential around the push only.
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandResult } from "@mastra/core/workspace";

import type { ChangeManifestEntry, PatchFile } from "../../contracts.js";
import type { DockerSandbox } from "@mastra/docker";
import {
  GitHubRepositoryTools,
  GitHubSourceReader,
  GitHubWriter,
  computePatchHash,
  supportsWorkingTreeCommit,
  type GitHubBackend,
  type GitHubPolicy,
} from "../github.js";
import { SandboxGitHubBackend } from "../sandbox-backend.js";
import {
  SandboxHandle,
  SandboxProvisioner,
  attachSandboxLifecycle,
  readManifestFromDisk,
  redactSecrets,
  sweepOrphanedSandboxes,
  type SandboxRepoContext,
} from "../sandbox.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const POLICY: GitHubPolicy = {
  repositories: ["acme/widgets"],
  baseBranch: "main",
  allowPaths: ["**"],
  denyPaths: [],
  destructivePaths: [],
  maxFiles: 10,
  maxPatchBytes: 250_000,
  timeoutMs: 10_000,
};

/** Minimal GitHubBackend; individual tests override the methods they care about. */
function baseBackend(overrides: Partial<GitHubBackend> = {}): GitHubBackend {
  return {
    headSha: async () => "0".repeat(40),
    branchHead: async () => undefined,
    fileContent: async () => ({ content: "", sha: "" }),
    commitFiles: async () => ({ commitSha: "1".repeat(40) }),
    openDraftPull: async () => ({ number: 7, url: "https://github.com/acme/widgets/pull/7" }),
    listOpenPulls: async () => [],
    checkRuns: async () => "pending",
    listFiles: async () => [],
    ...overrides,
  };
}

describe("computePatchHash manifest parity", () => {
  it("hashes a disk manifest identically to the whole-file bodies it replaces", () => {
    const content = "line one\nline two\n";
    const files: PatchFile[] = [{ path: "src/a.ts", content, validators: ["basic-syntax"] }];
    const manifest: ChangeManifestEntry[] = [{
      path: "src/a.ts",
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
      validators: ["basic-syntax"],
    }];
    expect(computePatchHash(manifest)).toBe(computePatchHash(files));
  });

  it("is order-sensitive across multiple files but byte-stable", () => {
    const a: ChangeManifestEntry = { path: "a", sha256: sha256("a"), bytes: 1, validators: ["json"] };
    const b: ChangeManifestEntry = { path: "b", sha256: sha256("b"), bytes: 1, validators: ["json"] };
    expect(computePatchHash([a, b])).toBe(computePatchHash([a, b]));
    expect(computePatchHash([a, b])).not.toBe(computePatchHash([b, a]));
  });
});

describe("GitHubWriter with a working-tree backend", () => {
  it("supportsWorkingTreeCommit detects the optional capability", () => {
    expect(supportsWorkingTreeCommit(baseBackend())).toBe(false);
    const withTree = { ...baseBackend(), commitWorkingTree: async () => ({ commitSha: "x" }) };
    expect(supportsWorkingTreeCommit(withTree)).toBe(true);
  });

  it("prefers commitWorkingTree over commitFiles when the backend exposes it", async () => {
    const calls: string[] = [];
    const backend = Object.assign(
      baseBackend({
        headSha: async () => "0".repeat(40),
        commitFiles: async () => {
          calls.push("commitFiles");
          return { commitSha: "2".repeat(40) };
        },
      }),
      {
        commitWorkingTree: async () => {
          calls.push("commitWorkingTree");
          return { commitSha: "3".repeat(40) };
        },
      },
    ) as GitHubBackend;
    const reader = new GitHubSourceReader(backend, POLICY);
    const writer = new GitHubWriter(backend, POLICY, reader);
    const files: ChangeManifestEntry[] = [{
      path: "src/a.ts", sha256: sha256("hello"), bytes: 5, validators: ["basic-syntax"],
    }];
    const manifest = writer.preflight("acme", "widgets", "main", "fix/branch", "0".repeat(40), files, [
      { path: "src/a.ts", startLine: 1, endLine: 1, excerpt: "edits a" },
    ], []);
    const receipt = await writer.apply(manifest, files, "Title", "Body");
    expect(calls).toEqual(["commitWorkingTree"]);
    expect(receipt.commitSha).toBe("3".repeat(40));
    expect(receipt.patchHash).toBe(manifest.patchHash);
  });

  it("falls back to commitFiles for a non-working-tree backend", async () => {
    const calls: string[] = [];
    const backend = baseBackend({
      headSha: async () => "0".repeat(40),
      commitFiles: async (_owner, _repo, _branch, _message, _base, files: PatchFile[]) => {
        calls.push(`commitFiles:${files.length}`);
        return { commitSha: "4".repeat(40) };
      },
    });
    const tools = new GitHubRepositoryTools(backend, POLICY);
    const content = "hello";
    const files: PatchFile[] = [{ path: "src/a.ts", content, validators: ["basic-syntax"] }];
    const manifest = tools.writer.preflight("acme", "widgets", "main", "fix/branch", "0".repeat(40), files, [
      { path: "src/a.ts", startLine: 1, endLine: 1, excerpt: "edits a" },
    ], []);
    const receipt = await tools.writer.apply(manifest, files, "Title", "Body");
    expect(calls).toEqual(["commitFiles:1"]);
    expect(receipt.commitSha).toBe("4".repeat(40));
  });

  it("bounds the sandbox patch by disk bytes, not transported bodies", () => {
    const backend = baseBackend();
    const tools = new GitHubRepositoryTools(backend, { ...POLICY, sandboxMode: true, maxPatchBytes: 10 });
    const big = "x".repeat(5_000);
    // A manifest entry only reports its true bytes (5000), which the reader
    // never had to transport; the cap is checked against those bytes.
    const manifest: ChangeManifestEntry[] = [{
      path: "src/a.ts", sha256: sha256(big), bytes: 5_000, validators: ["basic-syntax"],
    }];
    expect(() => tools.writer.preflight(
      "acme", "widgets", "main", "fix/branch", "0".repeat(40), manifest,
      [{ path: "src/a.ts", startLine: 1, endLine: 1, excerpt: "e" }], [],
    )).toThrow(/limits_exceeded|Patch limits exceeded/);
  });
});

describe("redactSecrets", () => {
  const saved = {
    SANDBOX_PUSH_TOKEN: process.env.SANDBOX_PUSH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  afterEach(() => {
    if (saved.SANDBOX_PUSH_TOKEN === undefined) delete process.env.SANDBOX_PUSH_TOKEN;
    else process.env.SANDBOX_PUSH_TOKEN = saved.SANDBOX_PUSH_TOKEN;
    if (saved.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
  });

  it("scrubs an active env token value from a message", () => {
    const token = `secret-${"a".repeat(36)}`;
    process.env.SANDBOX_PUSH_TOKEN = token;
    const out = redactSecrets(`git failed while env had ${token} present`);
    expect(out).not.toContain(token);
    expect(out).toContain("[redacted]");
  });

  it("scrubs structured GitHub tokens and bearer headers even when not from env", () => {
    delete process.env.SANDBOX_PUSH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const classic = `ghp_${"B".repeat(36)}`;
    const fine = `github_pat_${"C".repeat(24)}_D5`;
    const bearer = `Authorization: Bearer ${"D".repeat(30)}`;
    const out = redactSecrets(`${classic} / ${fine} / ${bearer}`);
    expect(out).not.toContain(classic);
    expect(out).not.toContain(fine);
    expect(out).not.toContain("D".repeat(30));
    expect(out.match(/Bearer \[redacted\]/)).not.toBeNull();
  });
});

describe("SandboxGitHubBackend.commitWorkingTree git choreography", () => {
  const SOURCE = "0".repeat(40);
  const NEW_COMMIT = "9".repeat(40);

  interface RecordedCall { script: string; }

  function makeHandle(): { handle: SandboxHandle; calls: RecordedCall[]; envKeys: string[] } {
    const calls: RecordedCall[] = [];
    const envKeys: string[] = [];
    let env: Record<string, string> = { PATH: "/usr/bin" };
    let committed = false;
    const sandbox = {
      setEnv(updater: (e: Record<string, string>) => Record<string, string>): void {
        env = updater(env);
      },
      ensureRunning: async () => {},
      executeCommand: async (
        _cmd: string,
        args?: string[],
      ): Promise<CommandResult> => {
        const script = args?.[1] ?? "";
        calls.push({ script });
        // Snapshot the overlay only across the push, to prove the credential
        // is revealed for that command and cleared right after.
        if (script.includes("git push")) {
          envKeys.push(Object.keys(env).includes("GIT_PUSH_TOKEN") ? "present" : "absent");
        }
        const ok = (stdout: string): CommandResult => ({
          success: true, exitCode: 0, stdout, stderr: "", executionTimeMs: 1,
        });
        if (script.includes("git rev-parse HEAD")) {
          return ok(committed ? `${NEW_COMMIT}\n` : `${SOURCE}\n`);
        }
        if (script.includes("git commit")) {
          committed = true;
          return ok("");
        }
        if (script.includes("git diff --cached --quiet")) {
          return ok("1\n"); // nonzero => there ARE staged changes
        }
        return ok("");
      },
    } as unknown as DockerSandbox;
    const ctx: SandboxRepoContext = {
      owner: "acme", repo: "widgets", baseBranch: "main",
      sourceSha: SOURCE, branch: "fix/branch", runId: "run-1",
    };
    const handle = new SandboxHandle(sandbox, ctx, "/workspace/widgets", {
      token: `ghp_${"S".repeat(36)}`,
    });
    return { handle, calls, envKeys };
  }

  it("commits the working tree, reveals the credential only around the push, and pushes", async () => {
    const { handle, calls, envKeys } = makeHandle();
    const mcp = baseBackend();
    const backend = new SandboxGitHubBackend(async () => handle, mcp);
    backend.track(handle);

    const result = await backend.commitWorkingTree("acme", "widgets", "fix/branch", "Title", SOURCE);
    expect(result.commitSha).toBe(NEW_COMMIT);

    const scripts = calls.map((call) => call.script);
    expect(scripts.some((s) => s.includes("git add -A"))).toBe(true);
    expect(scripts.some((s) => s.includes("git commit"))).toBe(true);
    expect(scripts.some((s) => s.includes("git push --force-with-lease origin HEAD:refs/heads/fix/branch"))).toBe(true);
    // The credential was live only for the push.
    expect(envKeys).toEqual(["present"]);
  });

  it("refuses to commit when HEAD has drifted from the pinned source SHA", async () => {
    const { handle } = makeHandle();
    const backend = new SandboxGitHubBackend(async () => handle, baseBackend());
    backend.track(handle);
    await expect(
      backend.commitWorkingTree("acme", "widgets", "fix/branch", "Title", "f".repeat(40)),
    ).rejects.toThrow(/does not match expected source SHA/);
  });
});

/** A sandbox whose commands are answered from a script->output map (no Docker). */
function stubHandle(
  sourceSha: string,
  branch: string,
  onCommand: (script: string) => { stdout: string; success?: boolean; stderr?: string },
): { handle: SandboxHandle; written: Array<{ path: string; content: string }> } {
  const written: Array<{ path: string; content: string }> = [];
  const sandbox = {
    setEnv: (_u: unknown): void => {},
    ensureRunning: async () => {},
    writeFiles: async (files: Array<{ path: string; content: string }>): Promise<void> => {
      written.push(...files);
    },
    executeCommand: async (_cmd: string, args?: string[]): Promise<CommandResult> => {
      const out = onCommand(args?.[1] ?? "");
      return {
        success: out.success ?? true,
        exitCode: (out.success ?? true) ? 0 : 1,
        stdout: out.stdout,
        stderr: out.stderr ?? "",
        executionTimeMs: 1,
      };
    },
  } as unknown as DockerSandbox;
  const ctx: SandboxRepoContext = {
    owner: "acme", repo: "widgets", baseBranch: "main", sourceSha, branch, runId: "run-x",
  };
  return { handle: new SandboxHandle(sandbox, ctx, "/workspace/widgets", { token: "t" }), written };
}

describe("readManifestFromDisk parser", () => {
  const sandboxOf = (stdout: string): DockerSandbox => ({
    executeCommand: async () => ({
      success: true, exitCode: 0, stdout, stderr: "", executionTimeMs: 1,
    }),
  } as unknown as DockerSandbox);

  it("maps tab-separated path/sha256/bytes rows to manifest entries", async () => {
    const sha = sha256("hello");
    const rows = await readManifestFromDisk(
      sandboxOf(`src/a.ts\t${sha}\t5`),
      "/workspace/widgets",
      [{ path: "src/a.ts", validators: ["basic-syntax"] }],
    );
    expect(rows).toEqual([
      { path: "src/a.ts", sha256: sha, bytes: 5, validators: ["basic-syntax"] },
    ]);
  });

  it("flags a MISSING sentinel as a missing entry", async () => {
    const rows = await readManifestFromDisk(
      sandboxOf("src/gone.ts\tMISSING\t0"),
      "/workspace/widgets",
      [{ path: "src/gone.ts", validators: ["basic-syntax"] }],
    );
    expect(rows[0]).toEqual({ path: "src/gone.ts", missing: true });
  });
});

describe("SandboxGitHubBackend working-tree reads and byte verification", () => {
  it("readDiskManifest returns entries whose disk sha matches the written bytes", async () => {
    const content = "hello";
    const sha = sha256(content);
    const { handle } = stubHandle("0".repeat(40), "fix/branch", (script) => ({
      stdout: script.includes("sha256sum") ? `src/a.ts\t${sha}\t${content.length}` : "",
    }));
    const backend = new SandboxGitHubBackend(async () => handle, baseBackend());
    const files: PatchFile[] = [{ path: "src/a.ts", content, validators: ["basic-syntax"] }];
    const entries = await backend.readDiskManifest(handle, files);
    expect(entries).toEqual([
      { path: "src/a.ts", sha256: sha, bytes: content.length, validators: ["basic-syntax"] },
    ]);
  });

  it("readDiskManifest rejects disk bytes that differ from the approved content", async () => {
    const { handle } = stubHandle("0".repeat(40), "fix/branch", () => ({
      stdout: `src/a.ts\t${sha256("tampered")}\t8`,
    }));
    const backend = new SandboxGitHubBackend(async () => handle, baseBackend());
    const files: PatchFile[] = [{ path: "src/a.ts", content: "hello", validators: ["basic-syntax"] }];
    await expect(backend.readDiskManifest(handle, files)).rejects.toThrow(/do not match the approved patch bytes/);
  });

  it("writePatchFiles lands every proposed body into the container at the repo path", async () => {
    const { handle, written } = stubHandle("0".repeat(40), "fix/branch", () => ({ stdout: "" }));
    const backend = new SandboxGitHubBackend(async () => handle, baseBackend());
    await backend.writePatchFiles(handle, [
      { path: "src/a.ts", content: "a", validators: ["basic-syntax"] },
      { path: "src/b.ts", content: "b", validators: ["basic-syntax"] },
    ]);
    expect(written.map((file) => file.path)).toEqual([
      "/workspace/widgets/src/a.ts",
      "/workspace/widgets/src/b.ts",
    ]);
  });

  it("answers listFiles from the tracked working tree, and delegates unknown SHAs to the API", async () => {
    const source = "0".repeat(40);
    const { handle } = stubHandle(source, "fix/branch", (script) => ({
      stdout: script.includes("git ls-tree") ? "src/a.ts\nsrc/b.ts\n" : "",
    }));
    const mcp = baseBackend({ listFiles: async () => ["from/api"] });
    const backend = new SandboxGitHubBackend(async () => handle, mcp);
    backend.track(handle);
    await expect(backend.listFiles("acme", "widgets", source)).resolves.toEqual(["src/a.ts", "src/b.ts"]);
    // A SHA no live handle is pinned to falls back to the API delegate.
    await expect(backend.listFiles("acme", "widgets", "f".repeat(40))).resolves.toEqual(["from/api"]);
  });
});

describe("sandbox lifecycle hardening", () => {
  it("orphan sweep degrades gracefully when no docker CLI is reachable", () => {
    const saved = process.env.SANDBOX_DOCKER_PATH;
    process.env.SANDBOX_DOCKER_PATH = "definitely-not-a-docker-binary-xyz";
    try {
      expect(sweepOrphanedSandboxes()).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.SANDBOX_DOCKER_PATH;
      else process.env.SANDBOX_DOCKER_PATH = saved;
    }
  });

  it("attachSandboxLifecycle registers and detaches signal handlers without throwing", () => {
    const before = process.listenerCount("SIGTERM");
    const detach = attachSandboxLifecycle(new SandboxProvisioner());
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    detach();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
