import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { PatchFileSchema, ValidatorResultSchema } from "../contracts.js";
import { RepositoryPolicyError } from "./github.js";
import { McpClientGitHubBackend, type CodeHit, type DirEntry } from "./mcp.js";
import { ValidatorRegistry } from "./validators.js";

/**
 * Read-only repository tools (`list_dir`, `search_code`, `read_file`) plus
 * `validate_patch`, which scores a draft against the same deterministic floor
 * the flow uses. Every call re-checks the repository allowlist and fails closed,
 * returning an availability string rather than throwing when unconfigured.
 * Writes stay in the flow behind the approval receipt.
 */

/**
 * Tool-loop step ceiling for the coding agents. Raised from the old
 * search-only budget of 4: an investigation now interleaves orient → search →
 * read steps before the final answer, and each tool round trip costs a step.
 * Still bounded on purpose — it caps cost and a runaway loop.
 */
export const CODING_TOOL_MAX_STEPS = 8;

/** Per-call content cap for read_file, mirroring the flow's 6 000-char
 * evidence budget so one read cannot flood the agent's context window. */
const MAX_READ_CHARS = 8_000;

/** Cap for list_dir entries, matching the plan's orientation budget. */
const MAX_DIR_ENTRIES = 200;

/** The slice of the GitHub backend these tools need; McpClientGitHubBackend (or
 * a test fake) implements it. Keeps the seam read-only by construction. */
export interface RepoReadBackend {
  fileContent(
    owner: string,
    repo: string,
    path: string,
    refSha: string,
  ): Promise<{ content: string; sha: string }>;
  dirEntries(owner: string, repo: string, path: string, refSha: string): Promise<DirEntry[]>;
  searchCode(owner: string, repo: string, query: string): Promise<CodeHit[]>;
}

let injectedBackend: RepoReadBackend | undefined;
let lazyBackend: RepoReadBackend | undefined;

/** Test seam: inject a fake read backend (or `undefined` to restore). */
export function setGitHubBackend(backend: RepoReadBackend | undefined): void {
  injectedBackend = backend;
  lazyBackend = undefined;
}

/**
 * Resolve the backend at call time: injected fake wins; otherwise a lazy
 * McpClientGitHubBackend only when a GitHub token is configured. `undefined` means
 * "repository access unavailable" and drives the degradation path.
 */
export function getGitHubBackend(): RepoReadBackend | undefined {
  if (injectedBackend !== undefined) return injectedBackend;
  const token = process.env.GITHUB_MCP_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") return undefined;
  lazyBackend ??= new McpClientGitHubBackend();
  return lazyBackend;
}

/** The repository allowlist, parsed from the same env the flow policy uses. */
export function readRepositoryAllowlist(): string[] {
  return (process.env.GITHUB_REPOSITORY_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Fail-closed repository policy, reusing the flow's RepositoryPolicyError
 * vocabulary: a read against a non-allowlisted repo (or with no policy at
 * all) is denied with the same code and message the deterministic reader
 * raises — the difference is the tool hands the model an error string, not a
 * flow failure.
 */
function assertRepositoryAllowed(owner: string, repo: string): void {
  const allowlist = readRepositoryAllowlist();
  if (allowlist.length === 0) {
    throw new RepositoryPolicyError(
      "repository_denied",
      "Repository policy is not configured (GITHUB_REPOSITORY_ALLOWLIST is empty)",
    );
  }
  if (!allowlist.includes(`${owner}/${repo}`)) {
    throw new RepositoryPolicyError("repository_denied", "Repository not allowed");
  }
}

/** Slice file content to an optional 1-based inclusive line window, then cap
 * the character budget so one read stays a bounded context contribution. */
function sliceContent(
  content: string,
  startLine?: number,
  endLine?: number,
): {
  window: string;
  totalLines: number;
  truncated: boolean;
  windowStart?: number | undefined;
  windowEnd?: number | undefined;
} {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  let windowStart: number | undefined;
  let windowEnd: number | undefined;
  let selected = lines;
  if (startLine !== undefined || endLine !== undefined) {
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(totalLines, Math.max(start, endLine ?? totalLines));
    selected = lines.slice(start - 1, end);
    windowStart = start;
    windowEnd = end;
  }
  let truncated = false;
  let window = selected.join("\n");
  if (window.length > MAX_READ_CHARS) {
    window = `${window.slice(0, MAX_READ_CHARS)}…`;
    truncated = true;
  }
  return {
    window,
    totalLines,
    truncated,
    ...(windowStart === undefined ? {} : { windowStart }),
    ...(windowEnd === undefined ? {} : { windowEnd }),
  };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export interface ReadFileInput {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

export interface ReadFileOutput {
  path: string;
  ref: string;
  content: string;
  sha: string;
  totalLines: number;
  truncated: boolean;
  startLine?: number | undefined;
  endLine?: number | undefined;
  error?: string | undefined;
}

/** Core read with policy + slicing, exported for offline testing (mirrors
 * runTavilySearch's standalone shape). */
export async function readRepoFile(
  input: ReadFileInput,
  backend: RepoReadBackend,
): Promise<ReadFileOutput> {
  assertRepositoryAllowed(input.owner, input.repo);
  const { content, sha } = await backend.fileContent(input.owner, input.repo, input.path, input.ref);
  const sliced = sliceContent(content, input.startLine, input.endLine);
  return {
    path: input.path,
    ref: input.ref,
    content: sliced.window,
    sha,
    totalLines: sliced.totalLines,
    truncated: sliced.truncated,
    ...(sliced.windowStart === undefined ? {} : { startLine: sliced.windowStart }),
    ...(sliced.windowEnd === undefined ? {} : { endLine: sliced.windowEnd }),
  };
}

const REPO_SCOPE_INPUT = {
  owner: z.string().min(1).max(100).describe("Repository owner."),
  repo: z.string().min(1).max(100).describe("Repository name."),
  ref: z
    .string()
    .min(1)
    .max(128)
    .describe("Commit SHA or branch to read at — use the source SHA from the ticket context."),
};

const READ_FILE_OUTPUT_SCHEMA = z.object({
  path: z.string(),
  ref: z.string(),
  content: z.string(),
  sha: z.string(),
  totalLines: z.number().int().nonnegative(),
  truncated: z.boolean(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  error: z.string().optional(),
});

export const readFileTool = createTool({
  id: "read_file",
  description:
    "Read the current content of one file in the ticket's allowlisted repository at a given ref. "
    + "Optionally pass a 1-based inclusive startLine/endLine window. Use it to confirm a file exists "
    + "and to cite only lines you actually see; never quote content that is not in the returned window.",
  inputSchema: z.object({
    ...REPO_SCOPE_INPUT,
    path: z.string().min(1).max(500).describe("Relative, normalized file path."),
    startLine: z.number().int().min(1).optional().describe("First line of the window (1-based, optional)."),
    endLine: z.number().int().min(1).optional().describe("Last line of the window (inclusive, optional)."),
  }),
  outputSchema: READ_FILE_OUTPUT_SCHEMA,
  execute: async (input, context) => {
    // Trace decoration per the Mastra tracing docs: outcome + shape fields go
    // onto the TOOL_CALL span's metadata so a policy denial is distinguishable
    // from a backend failure without reading the model-facing error string.
    // No-ops when tracing is off (currentSpan is then undefined).
    const mark = (outcome: string, fields: Record<string, unknown> = {}): void => {
      context?.tracingContext?.currentSpan?.update({
        metadata: {
          tool: "read_file",
          scope: `${input.owner}/${input.repo}@${input.ref}`,
          outcome,
          ...fields,
        },
      });
    };
    const base = { path: input.path, ref: input.ref, content: "", sha: "", totalLines: 0, truncated: false };
    const backend = getGitHubBackend();
    if (backend === undefined) {
      mark("no_backend");
      return { ...base, error: "repository access unavailable: no GitHub token configured; work from the provided source context" };
    }
    try {
      const result = await readRepoFile(input, backend);
      mark("ok", { totalLines: result.totalLines, truncated: result.truncated });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mark(error instanceof RepositoryPolicyError ? "policy_denied" : "backend_error", {
        reason: message,
      });
      return { ...base, error: `repository read failed: ${message}` };
    }
  },
});

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

export interface ListDirInput {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

/** Core listing with policy + entry cap, exported for offline testing. */
export async function listRepoDir(
  input: ListDirInput,
  backend: RepoReadBackend,
): Promise<{ path: string; entries: DirEntry[]; truncated: boolean; error?: string | undefined }> {
  assertRepositoryAllowed(input.owner, input.repo);
  const all = await backend.dirEntries(input.owner, input.repo, input.path, input.ref);
  return { path: input.path, entries: all.slice(0, MAX_DIR_ENTRIES), truncated: all.length > MAX_DIR_ENTRIES };
}

const LIST_DIR_OUTPUT_SCHEMA = z.object({
  path: z.string(),
  entries: z.array(z.object({ name: z.string(), kind: z.enum(["file", "dir"]) })),
  truncated: z.boolean(),
  error: z.string().optional(),
});

export const listDirTool = createTool({
  id: "list_dir",
  description:
    "List file and directory entry names under a path in the ticket's allowlisted repository "
    + "(use '.' for the repository root). Use it to orient before guessing where a failing file lives.",
  inputSchema: z.object({
    ...REPO_SCOPE_INPUT,
    path: z.string().min(1).max(500).describe("Directory path relative to the repository root; '.' for the root."),
  }),
  outputSchema: LIST_DIR_OUTPUT_SCHEMA,
  execute: async (input, context) => {
    const mark = (outcome: string, fields: Record<string, unknown> = {}): void => {
      context?.tracingContext?.currentSpan?.update({
        metadata: {
          tool: "list_dir",
          scope: `${input.owner}/${input.repo}@${input.ref}`,
          outcome,
          ...fields,
        },
      });
    };
    const backend = getGitHubBackend();
    if (backend === undefined) {
      mark("no_backend");
      return { path: input.path, entries: [], truncated: false, error: "repository access unavailable: no GitHub token configured" };
    }
    try {
      const result = await listRepoDir(input, backend);
      mark("ok", { entries: result.entries.length, truncated: result.truncated });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mark(error instanceof RepositoryPolicyError ? "policy_denied" : "backend_error", {
        reason: message,
      });
      return { path: input.path, entries: [], truncated: false, error: `directory listing failed: ${message}` };
    }
  },
});

// ---------------------------------------------------------------------------
// search_code
// ---------------------------------------------------------------------------

/** Core search with policy, exported for offline testing. */
export async function searchRepoCode(
  input: { owner: string; repo: string; query: string },
  backend: RepoReadBackend,
): Promise<{ query: string; results: CodeHit[]; error?: string | undefined }> {
  assertRepositoryAllowed(input.owner, input.repo);
  const results = await backend.searchCode(input.owner, input.repo, input.query);
  return { query: input.query, results };
}

const SEARCH_CODE_OUTPUT_SCHEMA = z.object({
  query: z.string(),
  results: z.array(z.object({ path: z.string(), preview: z.string() })),
  error: z.string().optional(),
});

export const searchCodeTool = createTool({
  id: "search_code",
  description:
    "Search the ticket's allowlisted repository for a symbol, message, or code snippet. Returns up "
    + "to 10 hits with file path and a short preview. Degrades to no results when code search is "
    + "unavailable — confirm any hit with read_file before citing it.",
  inputSchema: z.object({
    ...REPO_SCOPE_INPUT,
    query: z.string().min(1).max(300).describe("Code search query; it is automatically scoped to the given repository."),
  }),
  outputSchema: SEARCH_CODE_OUTPUT_SCHEMA,
  execute: async (input, context) => {
    const mark = (outcome: string, fields: Record<string, unknown> = {}): void => {
      context?.tracingContext?.currentSpan?.update({
        metadata: {
          tool: "search_code",
          scope: `${input.owner}/${input.repo}@${input.ref}`,
          outcome,
          ...fields,
        },
      });
    };
    const backend = getGitHubBackend();
    if (backend === undefined) {
      mark("no_backend");
      return { query: input.query, results: [], error: "repository access unavailable: no GitHub token configured" };
    }
    try {
      const result = await searchRepoCode(input, backend);
      mark("ok", { hits: result.results.length });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mark(error instanceof RepositoryPolicyError ? "policy_denied" : "backend_error", {
        reason: message,
      });
      return { query: input.query, results: [], error: `code search failed: ${message}` };
    }
  },
});

// ---------------------------------------------------------------------------
// validate_patch (actor self-check: pure, deterministic, no network)
// ---------------------------------------------------------------------------

const registry = new ValidatorRegistry();

/**
 * Run the flow's deterministic structure floor (json/yaml/xml/basic-syntax)
 * over a draft patch. The actor calls this in-turn before returning; the
 * flow's outer validators stay as the authoritative scoring pass, so this is
 * strictly a self-correction aid and never a governance seam.
 */
export function validatePatchDraft(
  files: z.infer<typeof PatchFileSchema>[],
): { passed: boolean; results: z.infer<typeof ValidatorResultSchema>[]; error?: string | undefined } {
  const report = registry.validate({ summary: "validate_patch tool self-check", files });
  return { passed: report.passed, results: report.results };
}

const VALIDATE_PATCH_OUTPUT_SCHEMA = z.object({
  passed: z.boolean(),
  results: z.array(ValidatorResultSchema),
  error: z.string().optional(),
});

export const validatePatchTool = createTool({
  id: "validate_patch",
  description:
    "Validate draft patch files with the same deterministic structure validators the pipeline runs "
    + "(json, yaml, xml, basic-syntax). Call it with your complete draft files before returning the "
    + "patch plan and fix every reported failure. This is a self-check only; it does not approve the patch.",
  inputSchema: z.object({
    files: z.array(PatchFileSchema).min(1).max(50).describe("The draft files exactly as you would return them in the patch plan."),
  }),
  outputSchema: VALIDATE_PATCH_OUTPUT_SCHEMA,
  execute: async ({ files }, context) => {
    const mark = (outcome: string, fields: Record<string, unknown> = {}): void => {
      context?.tracingContext?.currentSpan?.update({
        metadata: { tool: "validate_patch", outcome, files: files.length, ...fields },
      });
    };
    try {
      const result = validatePatchDraft(files);
      mark(result.passed ? "passed" : "failed", {
        failures: result.results.filter((item) => !item.passed).length,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mark("error", { reason: message });
      return { passed: false, results: [], error: `validation could not run: ${message}` };
    }
  },
});
