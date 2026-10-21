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
import type { HrHelpFlowDeps } from "./agents/hr-help/flow.js";
import {
  HR_POLICY_DOMAIN,
  HttpHrPolicyRetriever,
} from "./agents/hr-help/tools/hr-knowledge.js";
import { MemoryHrPolicyRetriever, type HrPolicyRetriever } from "./agents/hr-help/tools/hr-policy.js";
import { MemoryHrHelpRegistry } from "./agents/hr-help/tools/hr-help-registry.js";
import { fixtureFile } from "./shared/fixtures.js";
import {
  MastraRagHrPolicyRetriever,
  knowledgeVectorStore,
  readEmbeddingSettings,
} from "./shared/rag.js";
import type { IssuesFlowDeps } from "./agents/issues/flow.js";
import { GitHubIssueReader, type IssueReader } from "./agents/issues/tools/github-issues.js";
import type { BillsFlowDeps } from "./agents/bills/flow.js";
import { MemoryBillsLedger } from "./agents/bills/tools/ledger.js";
import { HttpVendorRegistry } from "./agents/bills/tools/vendors.js";
import { HttpXeroLedger } from "./agents/bills/tools/xero.js";
import type { MspFlowDeps } from "./agents/msp/flow.js";
import { HttpMspKnowledge } from "./agents/msp/tools/knowledge.js";
import type { CodingFlowDeps } from "./agents/programming/flow.js";
import {
  FetchGitHubTransport,
  GitHubRepositoryTools,
  type GitHubBackend,
  type GitHubPolicy,
} from "./agents/programming/tools/github.js";
import { McpClientGitHubBackend } from "./agents/programming/tools/mcp.js";
import { SandboxGitHubBackend, type LaneSandbox } from "./agents/programming/tools/sandbox-backend.js";
import {
  SandboxProvisioner,
  attachSandboxLifecycle,
  isDockerReachable,
  sweepOrphanedSandboxes,
} from "./agents/programming/tools/sandbox.js";
import type { ReviewFlowDeps } from "./agents/review/flow.js";
import { GitHubReviewTools } from "./agents/review/tools/github-review.js";
import { HaloDeskAdapter } from "./desks/halo.js";
import { JiraDeskAdapter } from "./desks/jira.js";
import { MemoryDeskAdapter } from "./desks/memory.js";
import { MemoryMailSender } from "./mail/memory.js";
import { OutboxMailSender } from "./mail/outbox.js";

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
 * configured (see the GITHUB_* block in .env.example). The MSP lane always
 * registers: it talks to the Jira Cloud desk when JIRA_BASE_URL, JIRA_EMAIL,
 * JIRA_API_TOKEN and JIRA_PROJECT_KEY are set, or to the HaloPSA desk when
 * HALO_BASE_URL, HALO_CLIENT_ID and HALO_CLIENT_SECRET are set instead
 * (Jira wins when both are configured; see buildMspDeps), writes replies to
 * the outbox at MAIL_OUTBOX_DIR (MAIL_FROM names the sending mailbox) and
 * otherwise keeps the in-memory desk and mailbox defaults. The bills lane
 * always registers too: it posts draft bills to Xero when the XERO_* variables are
 * set, keeps the in-memory ledger otherwise, and reads the vendor registry
 * over the platform service bridge. Without the GitHub block the instance
 * still boots with the finance and vendors flows, matching the documented
 * optional-flow contract in `createAllRounderMastra`. The HR help lane grounds
 * answers on the `hr:policy` knowledge partition through the same service
 * bridge once HR_KB_TENANT names the tenant that owns it (see
 * buildHrHelpDeps), with the company handbook `fixtures/company/hr_policy`
 * as its outage fallback.
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

function readOptionalIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function readClientIdsEnv(name: string): Record<string, number> | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const example =
    `${name} must be a JSON object of client refs to Halo company ids, e.g. {"acme":42}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(example);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(example);
  }
  const entries = Object.entries(parsed);
  if (entries.some(([, value]) => typeof value !== "number" || !Number.isInteger(value))) {
    throw new Error(example);
  }
  return parsed as Record<string, number>;
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

/**
 * Rollout flag for the sandbox-git migration: SANDBOX_GIT_LANES is a csv of
 * lane tokens (coding,issues,features,a11y,deps). A listed lane gets the
 * per-run Docker sandbox backend and manifest-based state; any other lane keeps
 * the MCP push_files path. The migration is now the default: an UNSET flag
 * enables all five PR lanes. Rolling back is explicit — set SANDBOX_GIT_LANES
 * to an empty value to force every lane onto push_files. Independently, a host
 * with no reachable Docker daemon downgrades all lanes to the flag-off path
 * below, so a run never fails purely because the sandbox provider is absent.
 */
const ALL_SANDBOX_LANES = "coding,issues,features,a11y,deps";
const sandboxLanes = new Set(
  (process.env.SANDBOX_GIT_LANES ?? ALL_SANDBOX_LANES)
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== ""),
);

// Sandboxed lanes need a live Docker daemon; without one (Docker Desktop not
// running, or a CI host with no daemon) fall back to the MCP path instead of
// failing. The probe only runs when at least one lane is otherwise enabled.
if (sandboxLanes.size > 0 && !isDockerReachable()) {
  console.warn(
    "[mastra] sandbox lanes requested but no reachable Docker daemon; every PR"
      + " lane falls back to the MCP push_files path for this process.",
  );
  sandboxLanes.clear();
}

function laneSandboxed(lane: "coding" | "issues" | "features" | "a11y" | "deps"): boolean {
  return sandboxLanes.has(lane);
}

/** One provisioner for the whole instance: every sandboxed lane shares it. */
const sandboxProvisioner = new SandboxProvisioner({
  memory: readOptionalIntegerEnv("SANDBOX_MEMORY_MB"),
  pidsLimit: readOptionalIntegerEnv("SANDBOX_PIDS_LIMIT"),
  cpuQuota: readOptionalIntegerEnv("SANDBOX_CPU_QUOTA_US"),
  cpuPeriod: readOptionalIntegerEnv("SANDBOX_CPU_PERIOD_US"),
  timeout: readPositiveNumberEnv("SANDBOX_COMMAND_TIMEOUT_SECONDS", 300) * 1000,
  startTimeoutMs: readPositiveNumberEnv("SANDBOX_START_TIMEOUT_SECONDS", 900) * 1000,
});

// Sandboxed lanes own host-visible containers, so only when at least one lane
// is enabled do we sweep containers orphaned by a prior crashed process and
// tear the running ones down on a clean signal-driven shutdown. A resource cap
// set here bounds what a repository's own test/build may consume inside the
// Docker Desktop VM; CPU is quota/period in microseconds (e.g. 100000/100000
// caps a container at one core). Both hooks are inert on a flag-off host.
if (sandboxLanes.size > 0) {
  const swept = sweepOrphanedSandboxes();
  if (swept > 0) {
    console.info(`[mastra] swept ${swept} orphaned sandbox container(s) at startup.`);
  }
  attachSandboxLifecycle(sandboxProvisioner);
}

/**
 * Backend selection for a PR lane: the sandbox backend wraps the MCP backend
 * (API facts still come from GitHub), and the policy records sandboxMode so
 * the byte cap bounds changed-file bytes rather than transported bodies.
 */
function laneBackend(
  lane: "coding" | "issues" | "features" | "a11y" | "deps",
  policy: GitHubPolicy,
): { backend: GitHubBackend; policy: GitHubPolicy; sandbox?: LaneSandbox } {
  const mcp = new McpClientGitHubBackend();
  if (!laneSandboxed(lane)) {
    return { backend: mcp, policy };
  }
  const backend = new SandboxGitHubBackend(
    (branch) => sandboxProvisioner.reattach(branch),
    mcp,
  );
  const sandboxPolicy: GitHubPolicy = { ...policy, sandboxMode: true };
  return {
    backend,
    policy: sandboxPolicy,
    sandbox: { mode: "sandbox", provisioner: sandboxProvisioner, backend },
  };
}

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
  const token = process.env.GITHUB_MCP_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] neither GITHUB_MCP_TOKEN nor GITHUB_TOKEN is set; the coding lane's"
      + " first write (apply) will fail with an authorization error.",
    );
  }
  const lane = laneBackend("coding", policy);
  return {
    github: new GitHubRepositoryTools(lane.backend, lane.policy),
    ...(lane.sandbox === undefined ? {} : { sandbox: lane.sandbox }),
  };
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
  return {
    github: new GitHubReviewTools(new McpClientGitHubBackend(), new FetchGitHubTransport(token), policy),
  };
}

function buildIssuesDeps(): IssuesFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_MCP_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] no GitHub MCP token; issuesFlow is not registered (issue resolution"
      + " reads repositories via the GitHub MCP tools).",
    );
    return undefined;
  }
  const lane = laneBackend("issues", policy);
  const tools = new GitHubRepositoryTools(lane.backend, lane.policy);
  const reader: IssueReader = new GitHubIssueReader(tools.reader, lane.backend, lane.policy);
  return {
    github: { reader, writer: tools.writer },
    repositories: lane.policy.repositories,
    baseBranch: lane.policy.baseBranch,
    ...(lane.sandbox === undefined ? {} : { sandbox: lane.sandbox }),
  };
}

function buildFeaturesDeps(): FeaturesFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_MCP_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] no GitHub MCP token; featuresFlow is not registered (feature"
      + " implementation reads repositories via the GitHub MCP tools).",
    );
    return undefined;
  }
  const lane = laneBackend("features", policy);
  const tools = new GitHubRepositoryTools(lane.backend, lane.policy);
  const reader = new GitHubFeatureReader(tools.reader, lane.backend, lane.policy);
  return {
    github: { reader, writer: tools.writer },
    repositories: lane.policy.repositories,
    baseBranch: lane.policy.baseBranch,
    ...(lane.sandbox === undefined ? {} : { sandbox: lane.sandbox }),
  };
}

function buildDependenciesDeps(): DependenciesFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_MCP_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] no GitHub MCP token; dependenciesFlow is not registered (dependency"
      + " bumps read manifests and open pull requests via the GitHub MCP tools).",
    );
    return undefined;
  }
  const lane = laneBackend("deps", policy);
  const tools = new GitHubRepositoryTools(lane.backend, lane.policy);
  const reader: DependencyReader = new GitHubDependencyReader(tools.reader, lane.backend, lane.policy);
  return {
    github: { reader, writer: tools.writer },
    registry: new NpmRegistryClient(new FetchRegistryTransport()),
    repositories: lane.policy.repositories,
    baseBranch: lane.policy.baseBranch,
    ...(lane.sandbox === undefined ? {} : { sandbox: lane.sandbox }),
  };
}

function buildAccessibilityDeps(): AccessibilityFlowDeps | undefined {
  const policy = buildRepositoryPolicy();
  if (policy === undefined) {
    return undefined;
  }
  const token = process.env.GITHUB_MCP_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.warn(
      "[mastra] no GitHub MCP token; accessibilityFlow is not registered (the audit"
      + " reads route components and opens the fix pull request via the GitHub MCP tools).",
    );
    return undefined;
  }
  const lane = laneBackend("a11y", policy);
  const tools = new GitHubRepositoryTools(lane.backend, lane.policy);
  const reader: AccessibilityReader = new GitHubAccessibilityReader(
    tools.reader,
    lane.backend,
    lane.policy,
  );
  return {
    github: { reader, writer: tools.writer },
    crawler: new AxeCrawlerClient(new FetchCrawlTransport(process.env.AXE_AUDIT_URL?.trim())),
    repositories: lane.policy.repositories,
    baseBranch: lane.policy.baseBranch,
    ...(lane.sandbox === undefined ? {} : { sandbox: lane.sandbox }),
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

/**
 * MSP lane wiring: the Jira Cloud adapter replaces the in-memory desk only
 * when all four JIRA_* values are present; otherwise the HaloPSA adapter
 * takes the desk when HALO_BASE_URL, HALO_CLIENT_ID and HALO_CLIENT_SECRET
 * are set, with HALO_TENANT, HALO_SCOPE, HALO_TICKET_TYPE_ID,
 * HALO_DEFAULT_CLIENT_ID and HALO_CLIENT_IDS as optional refinements. Jira
 * wins when both desks are configured; a half-configured block warns instead
 * of silently demoting. Replies land as .eml files in MAIL_OUTBOX_DIR when
 * that is set. With KNOWLEDGE_API_URL and KNOWLEDGE_SERVICE_TOKEN set,
 * drafts ground on the platform knowledge API; otherwise the lane drafts
 * from nothing and each draft escalates for a human edit. The memory
 * defaults are the M1 sandbox.
 */
function buildMspDeps(): MspFlowDeps {
  const baseUrl = process.env.JIRA_BASE_URL?.trim();
  const email = process.env.JIRA_EMAIL?.trim();
  const apiToken = process.env.JIRA_API_TOKEN?.trim();
  const projectKey = process.env.JIRA_PROJECT_KEY?.trim();
  const present = [baseUrl, email, apiToken, projectKey].filter(
    (value) => value !== undefined && value !== "",
  ).length;
  let desk: MspFlowDeps["desk"] = new MemoryDeskAdapter();
  if (present === 4) {
    desk = new JiraDeskAdapter({
      baseUrl: baseUrl as string,
      email: email as string,
      apiToken: apiToken as string,
      projectKey: projectKey as string,
    });
    console.info(`[mastra] mspFlow uses the Jira Cloud desk (project ${projectKey}).`);
  } else if (present > 0) {
    console.warn(
      "[mastra] JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN and JIRA_PROJECT_KEY must all"
      + " be set together; mspFlow ignores the partial Jira block.",
    );
  }
  const haloBaseUrl = process.env.HALO_BASE_URL?.trim();
  const haloClientId = process.env.HALO_CLIENT_ID?.trim();
  const haloClientSecret = process.env.HALO_CLIENT_SECRET?.trim();
  const haloPresent = [haloBaseUrl, haloClientId, haloClientSecret].filter(
    (value) => value !== undefined && value !== "",
  ).length;
  if (haloPresent === 3) {
    if (desk.provider === "jira") {
      console.warn(
        "[mastra] both the JIRA_* and HALO_* desks are configured; mspFlow keeps the"
        + " Jira Cloud desk.",
      );
    } else {
      const haloTenant = process.env.HALO_TENANT?.trim();
      const haloScope = process.env.HALO_SCOPE?.trim();
      const haloTicketTypeId = readOptionalIntegerEnv("HALO_TICKET_TYPE_ID");
      const haloDefaultClientId = readOptionalIntegerEnv("HALO_DEFAULT_CLIENT_ID");
      const haloClientIds = readClientIdsEnv("HALO_CLIENT_IDS");
      desk = new HaloDeskAdapter({
        baseUrl: haloBaseUrl as string,
        clientId: haloClientId as string,
        clientSecret: haloClientSecret as string,
        ...(haloTenant === undefined || haloTenant === "" ? {} : { tenant: haloTenant }),
        ...(haloScope === undefined || haloScope === "" ? {} : { scope: haloScope }),
        ...(haloTicketTypeId === undefined ? {} : { ticketTypeId: haloTicketTypeId }),
        ...(haloDefaultClientId === undefined ? {} : { defaultClientId: haloDefaultClientId }),
        ...(haloClientIds === undefined ? {} : { clientIds: haloClientIds }),
      });
      console.info(`[mastra] mspFlow uses the HaloPSA desk (${haloBaseUrl as string}).`);
    }
  } else if (haloPresent > 0) {
    console.warn(
      "[mastra] HALO_BASE_URL, HALO_CLIENT_ID and HALO_CLIENT_SECRET must all be set"
      + " together; mspFlow ignores the partial HaloPSA block.",
    );
  }
  const outboxDir = process.env.MAIL_OUTBOX_DIR?.trim();
  const mailFrom = process.env.MAIL_FROM?.trim();
  let mail: MspFlowDeps["mail"] = new MemoryMailSender();
  if (outboxDir !== undefined && outboxDir !== "") {
    mail = new OutboxMailSender({
      dir: outboxDir,
      address: mailFrom !== undefined && mailFrom !== ""
        ? mailFrom
        : "service-desk@msp.local",
    });
    console.info(`[mastra] mspFlow writes replies to the outbox at ${outboxDir}.`);
  } else if (mailFrom !== undefined && mailFrom !== "") {
    console.warn(
      "[mastra] MAIL_FROM is set without MAIL_OUTBOX_DIR; mspFlow keeps the in-memory"
      + " mailbox.",
    );
  }
  const knowledgeUrl = process.env.KNOWLEDGE_API_URL?.trim();
  const knowledgeToken = process.env.KNOWLEDGE_SERVICE_TOKEN?.trim();
  let knowledge: MspFlowDeps["knowledge"];
  if (
    knowledgeUrl !== undefined && knowledgeUrl !== ""
    && knowledgeToken !== undefined && knowledgeToken !== ""
  ) {
    knowledge = new HttpMspKnowledge({ baseUrl: knowledgeUrl, serviceToken: knowledgeToken });
    console.info("[mastra] mspFlow grounds drafts through the platform knowledge API.");
  } else if (
    (knowledgeUrl !== undefined && knowledgeUrl !== "")
    || (knowledgeToken !== undefined && knowledgeToken !== "")
  ) {
    console.warn(
      "[mastra] KNOWLEDGE_API_URL and KNOWLEDGE_SERVICE_TOKEN must both be set;"
      + " mspFlow drafts carry no retrieval and escalate for a human edit.",
    );
  }
  return { desk, mail, ...(knowledge === undefined ? {} : { knowledge }) };
}

const msp = buildMspDeps();

/**
 * Bills lane wiring: the Xero ledger replaces the memory ledger when
 * XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_TENANT_ID are all present (a
 * half-configured block warns instead of silently demoting), with
 * XERO_ACCOUNT_CODE optionally stamping every posted line. The vendor
 * registry reads the platform API over the shared service bridge
 * (KNOWLEDGE_API_URL plus KNOWLEDGE_SERVICE_TOKEN, the same token the
 * knowledge routes verify); without it the registry is absent and every bill
 * escalates as vendor_unverified. The memory defaults are the M4 sandbox.
 */
function buildBillsDeps(): BillsFlowDeps {
  const clientId = process.env.XERO_CLIENT_ID?.trim();
  const clientSecret = process.env.XERO_CLIENT_SECRET?.trim();
  const xeroTenantId = process.env.XERO_TENANT_ID?.trim();
  const present = [clientId, clientSecret, xeroTenantId].filter(
    (value) => value !== undefined && value !== "",
  ).length;
  let ledger: BillsFlowDeps["ledger"] = new MemoryBillsLedger();
  if (present === 3) {
    const accountCode = process.env.XERO_ACCOUNT_CODE?.trim();
    ledger = new HttpXeroLedger({
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      tenantId: xeroTenantId as string,
      ...(accountCode === undefined || accountCode === "" ? {} : { accountCode }),
    });
    console.info("[mastra] billsFlow posts draft bills to the Xero ledger.");
  } else if (present > 0) {
    console.warn(
      "[mastra] XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_TENANT_ID must all be set"
      + " together; billsFlow keeps the in-memory ledger.",
    );
  }
  const serviceUrl = process.env.KNOWLEDGE_API_URL?.trim();
  const serviceToken = process.env.KNOWLEDGE_SERVICE_TOKEN?.trim();
  let registry: BillsFlowDeps["registry"];
  if (
    serviceUrl !== undefined && serviceUrl !== ""
    && serviceToken !== undefined && serviceToken !== ""
  ) {
    registry = new HttpVendorRegistry({ baseUrl: serviceUrl, serviceToken });
    console.info("[mastra] billsFlow checks bills against the platform vendor registry.");
  } else if (
    (serviceUrl !== undefined && serviceUrl !== "")
    || (serviceToken !== undefined && serviceToken !== "")
  ) {
    console.warn(
      "[mastra] KNOWLEDGE_API_URL and KNOWLEDGE_SERVICE_TOKEN must both be set;"
      + " billsFlow cannot reach the vendor registry and every bill escalates as"
      + " vendor_unverified.",
    );
  }
  return { ledger, ...(registry === undefined ? {} : { registry }) };
}

const bills = buildBillsDeps();

/**
 * HR help lane wiring: with KNOWLEDGE_API_URL, KNOWLEDGE_SERVICE_TOKEN and
 * HR_KB_TENANT set, answers ground on the tenant's `hr:policy` knowledge
 * partition through the platform API's hybrid retrieval (pgvector plus the
 * Postgres lexical arm, fused). The fallback for an unreachable service is
 * the on-disk company handbook (`fixtures/company/hr_policy` — the very
 * files the seeder ingests), so an outage never answers from the golden
 * fixture corpus, which quotes different numbers. Without the trio the lane
 * keeps the fixture retriever, so the flow, its citations and its tests run
 * exactly as before. Seed the partition with `scripts/hr-kb-seed.py`.
 *
 * `MASTRA_RAG_PILOT=true` opts the lane into the Phase 4 experiment: the
 * baseline above becomes the fallback and a Mastra-owned pgvector index
 * (`hr_policy_pilot`, never the Python-owned `kb_chunks`) answers first,
 * embedded through the pinned `EMBEDDING_*`/`MODEL_*` block. Needs
 * `DATABASE_URL` plus an embedding key; without either the pilot stays off
 * and the chain below is returned untouched. Any pilot failure degrades to
 * the baseline, so the lane never goes dark because the experiment did.
 */
function buildHrHelpDeps(): HrHelpFlowDeps {
  const registry = new MemoryHrHelpRegistry();
  const baseline = buildHrHelpBaselineRetriever();
  if (process.env.MASTRA_RAG_PILOT === "true") {
    const store = knowledgeVectorStore();
    const embedding = readEmbeddingSettings();
    if (store !== undefined && embedding !== undefined) {
      console.info(
        "[mastra] hrHelpFlow RAG pilot ON: cosine top-k over the Mastra-owned"
          + " hr_policy_pilot index, falling back to the baseline retriever.",
      );
      return {
        retriever: new MastraRagHrPolicyRetriever({ store, embedding, fallback: baseline }),
        registry,
      };
    }
    console.warn(
      "[mastra] MASTRA_RAG_PILOT=true but DATABASE_URL and/or the EMBEDDING_*/MODEL_*"
        + " block is missing; hrHelpFlow keeps the baseline retriever.",
    );
  }
  return { retriever: baseline, registry };
}

/** The non-pilot HR retrieval chain: platform hybrid, else on-disk fixtures. */
function buildHrHelpBaselineRetriever(): HrPolicyRetriever {
  const baseUrl = process.env.KNOWLEDGE_API_URL?.trim();
  const serviceToken = process.env.KNOWLEDGE_SERVICE_TOKEN?.trim();
  const tenantId = process.env.HR_KB_TENANT?.trim();
  const present = [baseUrl, serviceToken, tenantId].filter(
    (value) => value !== undefined && value !== "",
  ).length;
  if (present === 3) {
    console.info(
      `[mastra] hrHelpFlow grounds answers on the ${HR_POLICY_DOMAIN} knowledge partition`
        + ` (tenant ${tenantId as string}).`,
    );
    return new HttpHrPolicyRetriever({
      baseUrl: baseUrl as string,
      serviceToken: serviceToken as string,
      tenantId: tenantId as string,
      fallback: new MemoryHrPolicyRetriever({
        directory: fixtureFile("company/hr_policy"),
      }),
    });
  }
  if (present > 0) {
    console.warn(
      "[mastra] KNOWLEDGE_API_URL, KNOWLEDGE_SERVICE_TOKEN and HR_KB_TENANT must all be"
        + " set together; hrHelpFlow keeps the on-disk policy corpus.",
    );
  }
  return new MemoryHrPolicyRetriever();
}

const hrHelp = buildHrHelpDeps();

export const mastra = createAllRounderMastra({
  ...(coding === undefined ? {} : { coding }),
  ...(review === undefined ? {} : { review }),
  ...(issues === undefined ? {} : { issues }),
  ...(features === undefined ? {} : { features }),
  ...(dependencies === undefined ? {} : { dependencies }),
  ...(accessibility === undefined ? {} : { accessibility }),
  msp,
  bills,
  hrHelp,
});
