import { createAllRounderMastra } from "./mastra.js";
import type { CodingFlowDeps } from "./agents/programming/flow.js";
import {
  FetchGitHubTransport,
  GitHubRepositoryTools,
  type GitHubPolicy,
} from "./agents/programming/tools/github.js";
import { McpGitHubBackend } from "./agents/programming/tools/mcp.js";

/**
 * Host wiring for `mastra dev`: the coding flow needs a repository allowlist
 * plus either an MCP-backed session (GITHUB_ACCESS=mcp, default; the hosted
 * GitHub MCP server authenticates with a bearer PAT from GITHUB_MCP_TOKEN,
 * falling back to GITHUB_TOKEN) or REST credentials (GITHUB_ACCESS=rest with
 * GITHUB_TOKEN), so it registers only when the allowlist is configured
 * (see the GITHUB_* block in .env.example). Without it the instance still
 * boots with the finance flow, matching the documented optional-coding
 * contract in `createAllRounderMastra`.
 */
function readStringArrayEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of strings, e.g. ["owner/repo"]`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`${name} must be a JSON array of strings, e.g. ["owner/repo"]`);
  }
  return parsed as string[];
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildCodingDeps(): CodingFlowDeps | undefined {
  const repositories = readStringArrayEnv("GITHUB_REPOSITORY_ALLOWLIST");
  if (repositories === undefined || repositories.length === 0) {
    return undefined;
  }
  const policy: GitHubPolicy = {
    repositories,
    baseBranch: process.env.GITHUB_BASE_BRANCH?.trim() || "main",
    allowPaths:
      readStringArrayEnv("GITHUB_PATH_ALLOWLIST") ?? ["src/**", "tests/**", "config/**", "docs/**"],
    denyPaths:
      readStringArrayEnv("GITHUB_PATH_DENYLIST") ?? [".github/workflows/**", "infra/prod/**"],
    destructivePaths: readStringArrayEnv("GITHUB_DESTRUCTIVE_PATHS") ?? ["migrations/**", "infra/**"],
    maxFiles: readPositiveNumberEnv("GITHUB_MAX_PATCH_FILES", 10),
    maxPatchBytes: readPositiveNumberEnv("GITHUB_MAX_PATCH_BYTES", 250_000),
    timeoutMs: readPositiveNumberEnv("GITHUB_REQUEST_TIMEOUT_SECONDS", 10) * 1000,
  };
  const access = process.env.GITHUB_ACCESS?.trim() || "mcp";
  if (access === "mcp") {
    const token = process.env.GITHUB_MCP_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim();
    if (token === undefined || token === "") {
      console.warn(
        "[mastra] GITHUB_ACCESS=mcp but neither GITHUB_MCP_TOKEN nor GITHUB_TOKEN is"
        + " set; first write (apply) will fail with an authorization error.",
      );
    }
    return { github: new GitHubRepositoryTools(new McpGitHubBackend(), policy) };
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    return undefined;
  }
  return { github: new GitHubRepositoryTools(new FetchGitHubTransport(token), policy) };
}

const coding = buildCodingDeps();
if (coding === undefined) {
  console.warn(
    "[mastra] GITHUB_REPOSITORY_ALLOWLIST is not set, or GITHUB_ACCESS=rest without"
    + " GITHUB_TOKEN; codingFlow is not registered (financeFlow only).",
  );
}

export const mastra = createAllRounderMastra(coding === undefined ? {} : { coding });
