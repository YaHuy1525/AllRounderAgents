import { createAllRounderMastra } from "./mastra.js";
import type { AccessibilityFlowDeps } from "./agents/accessibility/flow.js";
import {
  AxeCrawlerClient,
  FetchCrawlTransport,
} from "./agents/accessibility/tools/axe-crawler.js";
import {
  GitHubAccessibilityReader,
  type AccessibilityReader,
} from "./agents/accessibility/tools/github-accessibility.js";
import type { DependenciesFlowDeps } from "./agents/dependencies/flow.js";
import {
  GitHubDependencyReader,
  type DependencyReader,
} from "./agents/dependencies/tools/github-dependencies.js";
import {
  FetchRegistryTransport,
  NpmRegistryClient,
} from "./agents/dependencies/tools/npm-registry.js";
import type { FeaturesFlowDeps } from "./agents/features/flow.js";
import { GitHubFeatureReader } from "./agents/features/tools/github-features.js";
import type { IssuesFlowDeps } from "./agents/issues/flow.js";
import { GitHubIssueReader, type IssueReader } from "./agents/issues/tools/github-issues.js";
import type { CodingFlowDeps } from "./agents/programming/flow.js";
import {
  FetchGitHubTransport,
  GitHubRepositoryTools,
  type GitHubPolicy,
} from "./agents/programming/tools/github.js";
import { McpGitHubBackend } from "./agents/programming/tools/mcp.js";
import type { ReviewFlowDeps } from "./agents/review/flow.js";
import { GitHubReviewTools } from "./agents/review/tools/github-review.js";

/**
 * Host wiring for `mastra dev`: the coding, review, issues, features,
 * dependency and accessibility flows need a repository allowlist; coding runs
 * over an MCP-backed session (GITHUB_ACCESS=mcp, default; the hosted GitHub
 * MCP server authenticates with a bearer PAT from GITHUB_MCP_TOKEN, falling
 * back to GITHUB_TOKEN) or REST credentials (GITHUB_ACCESS=rest with
 * GITHUB_TOKEN), while review, issues, features, dependencies and
 * accessibility always use the REST API with GITHUB_TOKEN (the dependency
 * scan additionally reads the npm registry over HTTPS, and the accessibility
 * audit talks to the self-hosted axe-runner at AXE_AUDIT_URL). The effective
 * repository policy is GITHUB_REPOSITORY_ALLOWLIST plus every repository the
 * REST token can see, discovered once at startup; discovery failures degrade
 * to the allowlist. Each flow registers only when its prerequisites are
 * configured (see the GITHUB_* block in .env.example). Without them the
 * instance still boots with the finance and vendors flows, matching the
 * documented optional-flow contract in `createAllRounderMastra`.
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

const GITHUB_API_BASE = "https://api.github.com";
const REPOSITORY_PAGE_SIZE = 100;
const REPOSITORY_MAX_PAGES = 5;

/**
 * Every repository the REST token can see, fetched once at startup so the
 * flows (and their checkpoint pickers) cover the whole account rather than
 * just the operator allowlist. Failures degrade to the allowlist.
 */
async function discoverTokenRepositories(token: string | undefined): Promise<string[]> {
  if (token === undefined || token === "") {
    return [];
  }
  const discovered: string[] = [];
  try {
    for (let page = 1; page <= REPOSITORY_MAX_PAGES; page += 1) {
      const response = await fetch(
        `${GITHUB_API_BASE}/user/repos?per_page=${REPOSITORY_PAGE_SIZE}`
          + `&sort=pushed&direction=desc&page=${page}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "allrounder-agent",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        console.warn(
          `[mastra] repository discovery stopped on page ${page} (HTTP`
            + ` ${response.status}); keeping the allowlist plus what was discovered.`,
        );
        break;
      }
      const payload: unknown = await response.json();
      const items = Array.isArray(payload) ? payload : [];
      for (const item of items) {
        if (typeof item !== "object" || item === null) {
          continue;
        }
        const fullName = (item as { full_name?: unknown }).full_name;
        if (typeof fullName === "string" && fullName !== "" && !discovered.includes(fullName)) {
          discovered.push(fullName);
        }
      }
      if (items.length < REPOSITORY_PAGE_SIZE) {
        break;
      }
    }
  } catch (error) {
    console.warn(
      "[mastra] repository discovery failed; keeping GITHUB_REPOSITORY_ALLOWLIST"
        + ` only: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (discovered.length > 0) {
    console.info(
      `[mastra] repository discovery found ${discovered.length} repositories for the REST token.`,
    );
  }
  return discovered;
}

const discoveredRepositories = await discoverTokenRepositories(
  process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_MCP_TOKEN?.trim(),
);

function buildRepositoryPolicy(): GitHubPolicy | undefined {
  const allowlist = readStringArrayEnv("GITHUB_REPOSITORY_ALLOWLIST");
  if (allowlist === undefined || allowlist.length === 0) {
    return undefined;
  }
  const repositories = [...allowlist];
  for (const repository of discoveredRepositories) {
    if (!repositories.includes(repository)) {
      repositories.push(repository);
    }
  }
  return {
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
}

function buildCodingDeps(): CodingFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
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

function buildReviewDeps(): ReviewFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] GITHUB_TOKEN is not set; reviewFlow is not registered (pull-request"
      + " reviews need REST credentials).",
    );
    return undefined;
  }
  return { github: new GitHubReviewTools(new FetchGitHubTransport(token), policy) };
}

function buildIssuesDeps(): IssuesFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] GITHUB_TOKEN is not set; issuesFlow is not registered (issue resolution"
      + " reads repositories over the REST API).",
    );
    return undefined;
  }
  const transport = new FetchGitHubTransport(token);
  const tools = new GitHubRepositoryTools(transport, policy);
  const reader: IssueReader = new GitHubIssueReader(tools.reader, transport, policy);
  return {
    github: { reader, writer: tools.writer },
    repositories: policy.repositories,
    baseBranch: policy.baseBranch,
  };
}

function buildFeaturesDeps(): FeaturesFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] GITHUB_TOKEN is not set; featuresFlow is not registered (feature"
      + " implementation reads repositories over the REST API).",
    );
    return undefined;
  }
  const transport = new FetchGitHubTransport(token);
  const tools = new GitHubRepositoryTools(transport, policy);
  const reader = new GitHubFeatureReader(tools.reader, transport, policy);
  return {
    github: { reader, writer: tools.writer },
    repositories: policy.repositories,
    baseBranch: policy.baseBranch,
  };
}

function buildDependenciesDeps(): DependenciesFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] GITHUB_TOKEN is not set; dependenciesFlow is not registered (dependency"
      + " bumps read manifests and open pull requests over the REST API).",
    );
    return undefined;
  }
  const transport = new FetchGitHubTransport(token);
  const tools = new GitHubRepositoryTools(transport, policy);
  const reader: DependencyReader = new GitHubDependencyReader(tools.reader, transport, policy);
  return {
    github: { reader, writer: tools.writer },
    registry: new NpmRegistryClient(new FetchRegistryTransport()),
    repositories: policy.repositories,
    baseBranch: policy.baseBranch,
  };
}

function buildAccessibilityDeps(): AccessibilityFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] GITHUB_TOKEN is not set; accessibilityFlow is not registered (the audit"
      + " reads route components and opens the fix pull request over the REST API).",
    );
    return undefined;
  }
  const transport = new FetchGitHubTransport(token);
  const tools = new GitHubRepositoryTools(transport, policy);
  const reader: AccessibilityReader = new GitHubAccessibilityReader(
    tools.reader,
    transport,
    policy,
  );
  return {
    github: { reader, writer: tools.writer },
    crawler: new AxeCrawlerClient(new FetchCrawlTransport(process.env.AXE_AUDIT_URL?.trim())),
    repositories: policy.repositories,
    baseBranch: policy.baseBranch,
  };
}

const coding = buildCodingDeps();
if (coding === undefined) {
  console.warn(
    "[mastra] GITHUB_REPOSITORY_ALLOWLIST is not set, or GITHUB_ACCESS=rest without"
    + " GITHUB_TOKEN; codingFlow is not registered (financeFlow only).",
  );
}

const review = buildReviewDeps();
if (review === undefined) {
  console.warn(
    "[mastra] GITHUB_REPOSITORY_ALLOWLIST or GITHUB_TOKEN is not set; reviewFlow is not"
    + " registered.",
  );
}

const issues = buildIssuesDeps();
if (issues === undefined) {
  console.warn(
    "[mastra] GITHUB_REPOSITORY_ALLOWLIST or GITHUB_TOKEN is not set; issuesFlow is not"
    + " registered.",
  );
}

const features = buildFeaturesDeps();
if (features === undefined) {
  console.warn(
    "[mastra] GITHUB_REPOSITORY_ALLOWLIST or GITHUB_TOKEN is not set; featuresFlow is not"
    + " registered.",
  );
}

const dependencies = buildDependenciesDeps();
if (dependencies === undefined) {
  console.warn(
    "[mastra] GITHUB_REPOSITORY_ALLOWLIST or GITHUB_TOKEN is not set; dependenciesFlow is"
    + " not registered.",
  );
}

const accessibility = buildAccessibilityDeps();
if (accessibility === undefined) {
  console.warn(
    "[mastra] GITHUB_REPOSITORY_ALLOWLIST or GITHUB_TOKEN is not set; accessibilityFlow is"
    + " not registered.",
  );
}

export const mastra = createAllRounderMastra({
  ...(coding === undefined ? {} : { coding }),
  ...(review === undefined ? {} : { review }),
  ...(issues === undefined ? {} : { issues }),
  ...(features === undefined ? {} : { features }),
  ...(dependencies === undefined ? {} : { dependencies }),
  ...(accessibility === undefined ? {} : { accessibility }),
});
