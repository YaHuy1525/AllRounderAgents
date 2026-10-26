/**
 * Per-run sandbox provisioner for the sandboxed git lanes, behind one provider
 * flag: `docker` (default) boots a local container, `e2b` boots an E2B cloud
 * VM. Either way one sandbox == one run == one machine holding a real git
 * checkout pinned at the run's `sourceSha` (the Docker template pins it at
 * build time via `ref`; the E2B template tracks the default-branch head, so
 * the checkout is re-pinned at runtime with a fetch/checkout). All editing,
 * validation and committing happens inside this machine; run state only
 * carries the change manifest.
 *
 * Credentials: cloning uses the build-time secret path above; pushing uses a
 * repo-scoped, short-TTL token handed to git through an env-conditional
 * `http.extraheader` (`GIT_PUSH_TOKEN`), which never lands in the remote URL,
 * `.git/config`, argv, or logs. The overlay key is cleared on teardown.
 * Nothing here ever logs a token value.
 */
import { execFileSync } from "node:child_process";

import { DockerSandbox, createDockerRepoTemplate } from "@mastra/docker";
import type { RepositoryAccess } from "@mastra/docker";
import { E2BSandbox, createRepoTemplate } from "@mastra/e2b";
import type {
  CommandResult,
  MastraSandbox,
  SandboxFileInput,
} from "@mastra/core/workspace";

import type { ChangeManifestEntry } from "../contracts.js";

export interface SandboxRepoContext {
  owner: string;
  repo: string;
  /** Base branch the checkout and the eventual PR are against. */
  baseBranch: string;
  /** Commit the checkout is pinned to; preserves the stale-source guarantee. */
  sourceSha: string;
  /** Unique per-run branch; also the sandbox key. */
  branch: string;
  runId: string;
}

/** Short-lived, repo-scoped Contents:write credential for `git push`. */
export interface PushCredential {
  token: string;
  /** Human-readable expiry for receipts/logs; the token value is never logged. */
  expiresAt?: string;
}

export type MintPushCredential = (ctx: SandboxRepoContext) => Promise<PushCredential>;

/**
 * First implementation: a configured scoped token. The seam exists so GitHub
 * App installation-token minting can replace this without touching callers.
 */
export const configuredPushCredential: MintPushCredential = async () => {
  const token =
    process.env.SANDBOX_PUSH_TOKEN?.trim()
    || process.env.GITHUB_MCP_PAT?.trim()
    || process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    throw new Error(
      "No push credential available: set SANDBOX_PUSH_TOKEN (or GITHUB_MCP_PAT /"
      + " GITHUB_TOKEN) to a repo-scoped, short-lived Contents:write token.",
    );
  }
  return { token };
};

export const SANDBOX_LABEL = "mastra.sandbox";
const SANDBOX_BRANCH_LABEL = "mastra.sandbox.branch";
const GIT_USER_NAME = "mastra-sandbox";
const GIT_USER_EMAIL = "mastra-sandbox@local";
/** Container paths are provider homes, not shared: each provider's build user owns its own. */
const DOCKER_WORKING_DIRECTORY = "/workspace";
const E2B_WORKING_DIRECTORY = "/home/user";

/** Env vars whose values are secrets and must never leave the sandbox boundary. */
const SECRET_ENV_NAMES = [
  "SANDBOX_PUSH_TOKEN",
  "GITHUB_MCP_PAT",
  "GITHUB_MCP_TOKEN",
  "GITHUB_TOKEN",
] as const;

/**
 * Recognisable GitHub credential shapes plus `Bearer <token>` headers. Matched
 * structurally so a value that was never read from env (say, one a build step
 * printed) is still scrubbed.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
];

function activeSecretValues(): string[] {
  const values: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value !== "" && value.length >= 8) {
      values.push(value);
    }
  }
  return values;
}

/**
 * Scrub secret material from any string that could reach a log, a run snapshot
 * or a trace. The push token only ever lives in the container env overlay —
 * never in argv, the remote URL or `.git/config` — but a failed command that
 * echoed its environment must not carry a credential out of the sandbox.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const value of activeSecretValues()) {
    out = out.split(value).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) =>
      /Bearer/i.test(match) ? match.replace(/\s.*/, " [redacted]") : "[redacted]");
  }
  return out;
}

/** Git-valid logical id derived from the run branch (ids may not contain every ref character). */
export function sandboxIdFor(branch: string): string {
  const encoded = Buffer.from(branch, "utf8").toString("hex").slice(0, 40);
  return `mastra-sandbox-${encoded}`;
}

export class SandboxHandle {
  constructor(
    readonly sandbox: MastraSandbox,
    readonly ctx: SandboxRepoContext,
    /** Repository root inside the container: `<workingDirectory>/<repo>`. */
    readonly repoPath: string,
    private readonly _credential: PushCredential,
  ) {}

  /** Reveal the push credential to the runtime env overlay for one operation. */
  activatePushCredential(): void {
    this.sandbox.setEnv((env) => ({ ...env, GIT_PUSH_TOKEN: this._credential.token }));
  }

  /** Drop the push credential from the overlay; called after push and on destroy. */
  clearPushCredential(): void {
    this.sandbox.setEnv((env) => {
      const { GIT_PUSH_TOKEN: _cleared, ...rest } = env;
      return rest;
    });
  }
}

/** Sandbox provider selected by the SANDBOX_PROVIDER env flag. */
export type SandboxProvider = "docker" | "e2b";

export interface SandboxProvisionerOptions {
  /** Which provider boots the per-run machine. Defaults to `"docker"`. */
  provider?: SandboxProvider;
  mintPushCredential?: MintPushCredential;
  /** Extra runtime env for the sandbox (lane-level, non-secret). */
  env?: Record<string, string>;
  /** Resource caps applied inside the Docker Desktop VM (Docker-only; E2B sizes come from the account tier). */
  memory?: number | undefined;
  pidsLimit?: number | undefined;
  cpuQuota?: number | undefined;
  cpuPeriod?: number | undefined;
  /** Command timeout handed to DockerSandbox (ms). */
  timeout?: number | undefined;
  /** Image build + boot can take minutes on the first run for a repo (Docker only). */
  startTimeoutMs?: number | undefined;
}

/**
 * Provisions, caches and destroys per-run sandboxes. The cache is keyed by
 * branch so a resumed run reconnects to the same container instead of
 * rebuilding it.
 */
export class SandboxProvisioner {
  private readonly handles = new Map<string, SandboxHandle>();

  constructor(private readonly options: SandboxProvisionerOptions = {}) {}

  async acquire(ctx: SandboxRepoContext): Promise<SandboxHandle> {
    const existing = this.handles.get(ctx.branch);
    if (existing !== undefined) {
      await existing.sandbox.ensureRunning();
      return existing;
    }
    const provider = this.options.provider ?? "docker";
    const mint = this.options.mintPushCredential ?? configuredPushCredential;
    const credential = await mint(ctx);
    const id = sandboxIdFor(ctx.branch);
    const workingDirectory = provider === "e2b" ? E2B_WORKING_DIRECTORY : DOCKER_WORKING_DIRECTORY;
    const repoPath = `${workingDirectory}/${ctx.repo}`;
    // The same scoped token authenticates the template-build clone; it is
    // passed by value to the throwaway build stage and never baked in.
    const getRepositoryAccess = async (): Promise<RepositoryAccess> => ({
      cloneUrl: `https://github.com/${ctx.owner}/${ctx.repo}.git`,
      authorization: { scheme: "bearer", token: credential.token },
    });
    const sandbox = provider === "e2b"
      ? this.buildE2bSandbox(ctx, id, workingDirectory, getRepositoryAccess)
      : this.buildDockerSandbox(ctx, id, workingDirectory, getRepositoryAccess);
    // Boot failures leave no env overlay behind (the credential is only
    // revealed per push), so nothing to unwind here but the rethrow.
    await sandbox.start();
    if (provider === "e2b") {
      // The E2B repo template pins to the default-branch head it saw at build
      // time, not to this run's sourceSha. Re-pin the checkout (fail-closed:
      // a checkout that cannot reach the sha aborts the acquire rather than
      // silently coding against drifted source).
      const sha = ctx.sourceSha;
      await this.exec(
        sandbox,
        `git rev-parse --verify -q "${sha}^{commit}" >/dev/null`
        + ` || git fetch --depth 1 origin "${sha}"`
        + ` || git fetch origin "${sha}" || git fetch origin;`
        + ` git checkout --detach "${sha}"`,
        repoPath,
      );
    }
    // Deterministic committer identity; harmless if the repo defines its own.
    await this.exec(sandbox, `git config user.name "${GIT_USER_NAME}"`
      + ` && git config user.email "${GIT_USER_EMAIL}"`, repoPath);
    // Token never enters the remote URL: auth rides on an env-conditional
    // extra header that only resolves while GIT_PUSH_TOKEN is in the overlay.
    await this.exec(
      sandbox,
      'git config http."https://github.com/".extraheader "Authorization: Bearer $GIT_PUSH_TOKEN"'
      + " || git config --get http.extraheader >/dev/null",
      repoPath,
    );
    const handle = new SandboxHandle(sandbox, ctx, repoPath, credential);
    this.handles.set(ctx.branch, handle);
    return handle;
  }

  /** Docker path: template built at `sourceSha`, container labelled for the orphan sweep. */
  private buildDockerSandbox(
    ctx: SandboxRepoContext,
    id: string,
    workingDirectory: string,
    getRepositoryAccess: () => Promise<RepositoryAccess>,
  ): MastraSandbox {
    const template = createDockerRepoTemplate({
      getRepositoryAccess,
      ref: ctx.sourceSha,
      workingDirectory,
    });
    if (template === undefined) {
      throw new Error(`Repository template for ${ctx.owner}/${ctx.repo} could not be built`);
    }
    return new DockerSandbox({
      id,
      template,
      labels: { [SANDBOX_LABEL]: ctx.runId, [SANDBOX_BRANCH_LABEL]: ctx.branch },
      env: { ...this.options.env, MAISTRA_SANDBOX_BRANCH: ctx.branch },
      ...(this.options.memory === undefined ? {} : { memory: this.options.memory }),
      ...(this.options.pidsLimit === undefined ? {} : { pidsLimit: this.options.pidsLimit }),
      ...(this.options.cpuQuota === undefined ? {} : { cpuQuota: this.options.cpuQuota }),
      ...(this.options.cpuPeriod === undefined ? {} : { cpuPeriod: this.options.cpuPeriod }),
      ...(this.options.timeout === undefined ? {} : { timeout: this.options.timeout }),
      ...(this.options.startTimeoutMs === undefined
        ? {}
        : { startTimeoutMs: this.options.startTimeoutMs }),
    });
  }

  /**
   * E2B path: cloud VM from the repo template. `sourceSha` re-pinning happens
   * after start (see {@link acquire}); the provider's default idle lifecycle
   * (`pause`) plus `ensureRunning()` on every reuse covers reconnection, so
   * no start timeout or orphan sweep is needed. Credentials fall back to the
   * E2B_API_KEY env var, same presence-gated convention as every other key.
   */
  private buildE2bSandbox(
    ctx: SandboxRepoContext,
    id: string,
    workingDirectory: string,
    getRepositoryAccess: () => Promise<RepositoryAccess>,
  ): MastraSandbox {
    const template = createRepoTemplate({ getRepositoryAccess, workingDirectory });
    if (template === undefined) {
      throw new Error(`Repository template for ${ctx.owner}/${ctx.repo} could not be built`);
    }
    return new E2BSandbox({
      id,
      template,
      metadata: { [SANDBOX_LABEL]: ctx.runId, [SANDBOX_BRANCH_LABEL]: ctx.branch },
      env: { ...this.options.env, MAISTRA_SANDBOX_BRANCH: ctx.branch },
      workingDirectory,
    });
  }

  peek(branch: string): SandboxHandle | undefined {
    return this.handles.get(branch);
  }

  /** Branches with a live (cached) sandbox handle. */
  liveBranches(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Reconnect to an already-provisioned run sandbox (a resumed flow, or the
   * backend answering a working-tree read). Never builds a half-configured
   * container: full context arrives through {@link acquire} in the flow.
   */
  async reattach(branch: string): Promise<SandboxHandle> {
    const handle = this.handles.get(branch);
    if (handle === undefined) {
      throw new Error(`No sandbox provisioned for branch ${branch}`);
    }
    await handle.sandbox.ensureRunning();
    return handle;
  }

  /** Best-effort teardown: clear the credential overlay, then destroy the container. */
  async destroy(branch: string): Promise<void> {
    const handle = this.handles.get(branch);
    if (handle === undefined) return;
    this.handles.delete(branch);
    handle.clearPushCredential();
    try {
      await handle.sandbox.destroy();
    } catch (error) {
      console.warn(
        `[sandbox] teardown failed for branch ${branch}:`
        + ` ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  /** Destroy every cached sandbox; used by shutdown/startup sweeps. */
  async destroyAll(): Promise<void> {
    for (const branch of [...this.handles.keys()]) {
      await this.destroy(branch);
    }
  }

  private async exec(sandbox: MastraSandbox, script: string, cwd: string): Promise<CommandResult> {
    const result = await sandbox.executeCommand!("sh", ["-c", `cd ${JSON.stringify(cwd)} && ${script}`]);
    if (!result.success) {
      throw new Error(`Sandbox command failed (exit ${result.exitCode}): ${redactSecrets(result.stderr || result.stdout)}`);
    }
    return result;
  }
}

/**
 * Read the change manifest for touched paths straight off the sandbox disk:
 * one `sh` round trip returns `path<TAB>sha256<TAB>bytes` per file, so the
 * approval hash is computed over the exact bytes that will be committed.
 * A missing file is reported with a `MISSING` sentinel for the caller to fail on.
 */
export async function readManifestFromDisk(
  sandbox: MastraSandbox,
  repoPath: string,
  touched: ReadonlyArray<{ path: string; validators: ChangeManifestEntry["validators"] }>,
): Promise<Array<ChangeManifestEntry | { path: string; missing: true }>> {
  const script = touched
    .map((entry) => {
      const p = JSON.stringify(entry.path);
      return `if [ -f ${p} ]; then sha=$(sha256sum ${p} | cut -d' ' -f1); size=$(wc -c <${p} | tr -d ' '); printf '%s\\t%s\\t%s\\n' ${p} "$sha" "$size"; else printf '%s\\tMISSING\\t0\\n' ${p}; fi`;
    })
    .join("; ");
  const result = await sandbox.executeCommand!("sh", ["-c", `cd ${JSON.stringify(repoPath)} && ${script}`]);
  if (!result.success) {
    throw new Error(`Sandbox manifest read failed (exit ${result.exitCode}): ${redactSecrets(result.stderr || result.stdout)}`);
  }
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  return touched.map((entry, index) => {
    const line = lines[index] ?? "";
    const [path, sha256, bytes] = line.split("\t");
    if (path !== entry.path || sha256 === undefined || sha256 === "MISSING") {
      return { path: entry.path, missing: true as const };
    }
    return {
      path: entry.path,
      sha256,
      bytes: Number(bytes),
      validators: entry.validators,
    };
  });
}

export type { CommandResult, SandboxFileInput };

/**
 * Cheap reachability probe for the Docker daemon (Docker Desktop on Windows).
 * Sandboxed lanes need a live daemon; when it is absent the host must fall
 * back to the MCP push_files path rather than fail every PR run. Uses the CLI
 * so it needs no declared dockerode dependency.
 */
export function isDockerReachable(): boolean {
  const docker = process.env.SANDBOX_DOCKER_PATH?.trim() || "docker";
  try {
    execFileSync(docker, ["info", "-f", "{{.ServerVersion}}"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove containers orphaned by a previous process that crashed before its
 * teardown ran (escalation, OOM, hard kill). Every sandbox carries the
 * `mastra.sandbox` label, so a label filter finds exactly ours and nothing
 * else. Never throws out of startup: an unreachable daemon (a flag-off host,
 * or Docker Desktop not yet running) just means there is nothing to sweep.
 */
export function sweepOrphanedSandboxes(): number {
  const docker = process.env.SANDBOX_DOCKER_PATH?.trim() || "docker";
  try {
    const listed = execFileSync(docker, ["ps", "-aq", `--filter=label=${SANDBOX_LABEL}`], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ids = listed.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    if (ids.length === 0) return 0;
    execFileSync(docker, ["rm", "-f", ...ids], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return ids.length;
  } catch (error) {
    console.warn(
      "[sandbox] orphan sweep skipped (docker CLI unavailable or errored):"
      + ` ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return 0;
  }
}

/**
 * Best-effort graceful-shutdown teardown for the host-owned containers this
 * process knows about. A crash is covered by {@link sweepOrphanedSandboxes} on
 * the next boot, so this only needs to handle clean signal-driven exits. Returns
 * a detach function so tests and hot-reload can undo the handlers.
 */
export function attachSandboxLifecycle(provisioner: SandboxProvisioner): () => void {
  let teardownStarted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (teardownStarted) {
      process.exit(0);
      return;
    }
    teardownStarted = true;
    void provisioner.destroyAll()
      .catch((error: unknown) => {
        console.warn(
          `[sandbox] shutdown teardown errored: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        );
      })
      .finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  };
  const sigint = (): void => onSignal("SIGINT");
  const sigterm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  return () => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  };
}
