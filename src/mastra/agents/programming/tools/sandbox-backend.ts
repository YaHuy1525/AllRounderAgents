/**
 * Sandbox-backed GitHubBackend: reads come from the per-run container's git
 * working tree, the commit is a real `git add/commit`, and the push is a real
 * `git push` authenticated by the ephemeral credential overlay (never in the
 * URL, config, argv, or logs). Branch-level API facts that the container
 * cannot answer authoritatively — remote head, open-PR replay detection,
 * check runs, PR opening — delegate to the MCP backend, exactly as before.
 */
import { createHash } from "node:crypto";

import type { CommandResult } from "@mastra/core/workspace";

import type { ChangeManifestEntry, PatchFile, ValidatorResult } from "../contracts.js";
import { ValidatorResultSchema } from "../contracts.js";
import type { GitHubBackend, CheckStatus } from "./github.js";
import { readManifestFromDisk, redactSecrets } from "./sandbox.js";
import type { SandboxHandle, SandboxProvisioner, SandboxRepoContext } from "./sandbox.js";
import type { RepoCheckContext, RepoChecks } from "./validators.js";

export type { SandboxHandle } from "./sandbox.js";

/**
 * Lane-shared landing point: provision the run's container with the full
 * context, write the proposed bodies onto its disk, and return the manifest
 * read back from disk (byte-verified). Preflight, the approval hash and the
 * working-tree commit all consume these entries, so what a run approves and
 * what gets committed are the same bytes on the same disk.
 */
export async function landPatchInSandbox(
  sandbox: LaneSandbox,
  ctx: SandboxRepoContext,
  files: readonly PatchFile[],
  options: { resetWorkingTree?: boolean } = {},
): Promise<ChangeManifestEntry[]> {
  const handle = await sandbox.provisioner.acquire(ctx);
  sandbox.backend.track(handle);
  if (options.resetWorkingTree === true) {
    // Multi-PR lanes (dependency groups) land several change sets on one
    // checkout: reset to the pinned source so each commit carries only its
    // own group's files.
    await sandbox.backend.resetToSource(handle);
  }
  await sandbox.backend.writePatchFiles(handle, files);
  return sandbox.backend.readDiskManifest(handle, files);
}

const MISSING_SENTINEL = "__MASTRA_MISSING__";

/**
 * How instance.ts hands a lane its sandbox plumbing: the flow provisions the
 * per-run container through `provisioner.acquire` with the full run context
 * and `backend.track`s the handle so working-tree reads and the working-tree
 * commit find it.
 */
export interface LaneSandbox {
  /** Discriminator so lanes can branch on the sandbox path from deps alone. */
  mode: "sandbox";
  provisioner: SandboxProvisioner;
  backend: SandboxGitHubBackend;
}

export class SandboxGitHubBackend implements GitHubBackend {
  constructor(
    private readonly handleProvider: (branch: string) => Promise<SandboxHandle>,
    /** API-side delegate for head reads, PRs and check runs. */
    private readonly mcpBackend: GitHubBackend,
  ) {}

  private async handle(branch: string): Promise<SandboxHandle> {
    const tracked = this.handlesByBranch.get(branch);
    if (tracked !== undefined) return tracked;
    const provisioned = await this.handleProvider(branch);
    this.handlesByBranch.set(branch, provisioned);
    return provisioned;
  }

  private async run(handle: SandboxHandle, script: string): Promise<CommandResult> {
    const result = await handle.sandbox.executeCommand!(
      "sh",
      ["-c", `cd ${JSON.stringify(handle.repoPath)} && ${script}`],
    );
    if (!result.success) {
      throw new Error(
        `Sandbox git operation failed (exit ${result.exitCode}):`
        + ` ${redactSecrets(result.stderr.trim() || result.stdout.trim())}`,
      );
    }
    return result;
  }

  // --- Remote facts: delegated to the API backend ---------------------------

  headSha(owner: string, repo: string, branch: string): Promise<string> {
    return this.mcpBackend.headSha(owner, repo, branch);
  }

  branchHead(owner: string, repo: string, branch: string): Promise<string | undefined> {
    return this.mcpBackend.branchHead(owner, repo, branch);
  }

  openDraftPull(
    owner: string,
    repo: string,
    branch: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }> {
    return this.mcpBackend.openDraftPull(owner, repo, branch, baseBranch, title, body);
  }

  listOpenPulls(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<Array<{ number: number; url: string; body: string; draft: boolean }>> {
    return this.mcpBackend.listOpenPulls(owner, repo, branch);
  }

  checkRuns(
    owner: string,
    repo: string,
    commitSha: string,
    pullNumber?: number,
  ): Promise<CheckStatus> {
    return this.mcpBackend.checkRuns(owner, repo, commitSha, pullNumber);
  }

  // --- Working-tree facts: answered by the container ------------------------

  async listFiles(owner: string, repo: string, refSha: string): Promise<string[]> {
    const handle = this.findHandle(refSha);
    if (handle === undefined) {
      return this.mcpBackend.listFiles(owner, repo, refSha);
    }
    const result = await this.run(handle, `git ls-tree -r --name-only ${JSON.stringify(refSha)}`);
    return result.stdout.split("\n").filter((line) => line.length > 0);
  }

  async fileContent(
    owner: string,
    repo: string,
    path: string,
    refSha: string,
  ): Promise<{ content: string; sha: string }> {
    // The checkout is pinned at the run's sourceSha and then edited in place:
    // the working tree IS the content for that SHA. Any other SHA falls back
    // to the API so historical reads stay correct.
    const handle = this.findHandle(refSha);
    if (handle === undefined) {
      return this.mcpBackend.fileContent(owner, repo, path, refSha);
    }
    const quoted = JSON.stringify(path);
    const result = await this.run(
      handle,
      `if [ -f ${quoted} ]; then cat ${quoted}; else printf '%s' ${JSON.stringify(MISSING_SENTINEL)}; fi`,
    );
    if (result.stdout === MISSING_SENTINEL) {
      throw new Error(`File not found in sandbox working tree: ${owner}/${repo}/${path}@${refSha}`);
    }
    // Git blob hash when git can see the object; sha256 of the bytes otherwise
    // (the reader only forwards this value, the gates hash content themselves).
    let sha = "";
    try {
      const hashed = await handle.sandbox.executeCommand!(
        "sh",
        ["-c", `cd ${JSON.stringify(handle.repoPath)} && git hash-object ${quoted}`],
      );
      sha = hashed.success ? hashed.stdout.trim() : "";
    } catch {
      sha = "";
    }
    return { content: result.stdout, sha };
  }

  /**
   * The sandbox-path commit: everything the actor left in the working tree
   * becomes one commit on top of the pinned source, then the branch is
   * pushed. `files` is not consulted — the disk is the truth.
   */
  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    baseSha: string,
    _files: PatchFile[],
  ): Promise<{ commitSha: string }> {
    const { commitSha } = await this.commitWorkingTree(owner, repo, branch, message, baseSha);
    return { commitSha };
  }

  /** Optional WorkingTreeBackend capability; prefers this over commitFiles. */
  async commitWorkingTree(
    _owner: string,
    _repo: string,
    branch: string,
    message: string,
    baseSha: string,
  ): Promise<{ commitSha: string }> {
    const handle = await this.handle(branch);
    const head = await this.run(handle, "git rev-parse HEAD");
    if (head.stdout.trim() !== baseSha) {
      throw new Error(
        `Sandbox HEAD ${head.stdout.trim()} does not match expected source SHA ${baseSha}`,
      );
    }
    await this.run(handle, "git add -A");
    const staged = await this.run(handle, "git diff --cached --quiet; echo $?");
    // exit 0 => nothing staged; the flow only calls apply after a real change.
    if (staged.stdout.trim() === "0") {
      throw new Error("Sandbox working tree has no staged changes to commit");
    }
    const safeMessage = message.replace(/[\r\n]+/g, " ").slice(0, 500);
    await this.run(handle, `git commit -m ${JSON.stringify(safeMessage)}`);
    const commitSha = (await this.run(handle, "git rev-parse HEAD")).stdout.trim();
    handle.activatePushCredential();
    try {
      await this.run(handle, `git push --force-with-lease origin HEAD:refs/heads/${branch}`);
    } finally {
      handle.clearPushCredential();
    }
    return { commitSha };
  }

  /**
   * Handles registered by the lanes' provision calls, keyed by branch. A
   * read for a SHA matches a live handle's sourceSha only when the working
   * tree genuinely reflects those bytes.
   */
  private readonly handlesByBranch = new Map<string, SandboxHandle>();

  /** Register a provisioned handle so working-tree reads can find it. */
  track(handle: SandboxHandle): void {
    this.handlesByBranch.set(handle.ctx.branch, handle);
  }

  untrack(branch: string): void {
    this.handlesByBranch.delete(branch);
  }

  private findHandle(refSha: string): SandboxHandle | undefined {
    for (const handle of this.handlesByBranch.values()) {
      if (handle.ctx.sourceSha === refSha) return handle;
    }
    return undefined;
  }

  /** Deterministic fingerprint helper shared with the manifest reader. */
  static hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  // --- Lane-flow surface (sandboxed coding lanes) ---------------------------

  /**
   * Land the actor's proposed file bodies in the container's working tree.
   * From this point the disk is the truth: run state only keeps the manifest
   * fingerprint read back from it, never the bodies.
   */
  async writePatchFiles(handle: SandboxHandle, files: readonly PatchFile[]): Promise<void> {
    await handle.sandbox.ensureRunning();
    await handle.sandbox.writeFiles!(
      files.map((file) => ({
        path: `${handle.repoPath}/${file.path}`,
        content: file.content,
      })),
    );
  }

  /**
   * Read the change manifest straight off the sandbox disk and verify it
   * byte-for-byte against the fingerprints of the bodies just written, so the
   * approval hash provably covers the exact bytes on disk.
   */
  async readDiskManifest(
    handle: SandboxHandle,
    files: readonly PatchFile[],
  ): Promise<ChangeManifestEntry[]> {
    const rows = await readManifestFromDisk(handle.sandbox, handle.repoPath, files);
    return rows.map((row) => {
      if ("missing" in row) {
        throw new Error(`Sandbox working tree is missing proposed file ${row.path}`);
      }
      const expected = files.find((file) => file.path === row.path);
      if (expected === undefined
        || row.sha256 !== SandboxGitHubBackend.hashContent(expected.content)) {
        throw new Error(
          `Sandbox disk bytes for ${row.path} do not match the approved patch bytes`,
        );
      }
      return row;
    });
  }

  /** Return the working tree and HEAD to the pinned source state. */
  async resetToSource(handle: SandboxHandle): Promise<void> {
    await this.run(handle, `git reset --hard ${JSON.stringify(handle.ctx.sourceSha)} && git clean -fd`);
  }

  /** Bounded unified diff of the working tree for the evidence archive. */
  async diffExcerpt(handle: SandboxHandle, maxBytes = 4_000): Promise<string> {
    const untracked = await this.run(handle, "git add -A --intent-to-add -- .").then(
      () => true,
      () => false,
    );
    const result = await handle.sandbox.executeCommand!(
      "sh",
      ["-c", `cd ${JSON.stringify(handle.repoPath)} && git diff --stat && echo --- && git diff | head -c ${maxBytes}`],
    );
    void untracked;
    return result.success ? result.stdout.slice(0, maxBytes * 2) : "(diff unavailable)";
  }
}

/**
 * Real test/build execution inside the per-run container, wired as the
 * `RepoChecks` seam of the ValidatorRegistry: the repository's own commands
 * (SANDBOX_TEST_COMMANDS, e.g. `npm test`) run against the edited working
 * tree instead of against transported file bodies.
 */
export class SandboxRepoChecks implements RepoChecks {
  constructor(
    private readonly provisioner: SandboxProvisioner,
    private readonly commands: readonly string[],
  ) {}

  affords(_context: RepoCheckContext): boolean {
    return this.commands.length > 0;
  }

  async run(context: RepoCheckContext): Promise<ValidatorResult[]> {
    const handle = this.provisioner.peek(this.branchOf(context));
    if (handle === undefined) {
      throw new Error(`No live sandbox for check run on ${context.repository}`);
    }
    const results: ValidatorResult[] = [];
    for (const command of this.commands) {
      const result = await handle.sandbox.executeCommand!(
        "sh",
        ["-c", `cd ${JSON.stringify(handle.repoPath)} && ${command}`],
        { timeout: 10 * 60 * 1000 },
      );
      const tail = redactSecrets(
        (result.stderr.trim() === "" ? result.stdout : result.stderr)
          .split("\n")
          .slice(-12)
          .join("\n")
          .slice(0, 1_900),
      );
      results.push(ValidatorResultSchema.parse({
        validator: `sandbox:${command.slice(0, 60)}`,
        // ValidatorResult.path must be a repository path; attribute the run
        // to the repository's manifest files at the check root.
        path: context.files[0]?.path ?? ".",
        passed: result.success,
        message: result.success ? "Passed" : (tail === "" ? `exit ${result.exitCode}` : tail),
      }));
    }
    return results;
  }

  private branchOf(context: RepoCheckContext): string {
    // The flow builds the context from its own run; recover the branch from
    // the live handle whose checkout belongs to this repository.
    for (const branch of this.provisioner.liveBranches()) {
      const handle = this.provisioner.peek(branch);
      if (handle !== undefined && `${handle.ctx.owner}/${handle.ctx.repo}` === context.repository) {
        return branch;
      }
    }
    return context.repository;
  }
}
