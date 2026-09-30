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
  type GitHubPolicy,
} from "./agents/programming/tools/github.js";
import { McpGitHubBackend } from "./agents/programming/tools/mcp.js";
import type { ReviewFlowDeps } from "./agents/review/flow.js";
import { GitHubReviewTools } from "./agents/review/tools/github-review.js";
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
 * JIRA_API_TOKEN and JIRA_PROJECT_KEY are set, writes replies to the outbox
 * at MAIL_OUTBOX_DIR (MAIL_FROM names the sending mailbox) and otherwise
 * keeps the in-memory desk and mailbox defaults. The bills lane always
 * registers too: it posts draft bills to Xero when the XERO_* variables are
 * set, keeps the in-memory ledger otherwise, and reads the vendor registry
 * over the platform service bridge. Without the GitHub block the instance
 * still boots with the finance and vendors flows, matching the documented
 * optional-flow contract in `createAllRounderMastra`.
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

/**
 * MSP lane wiring: the Jira Cloud adapter replaces the in-memory desk only
 * when all four JIRA_* values are present (a half-configured block warns
 * instead of silently demoting), and replies land as .eml files in
 * MAIL_OUTBOX_DIR when that is set. With KNOWLEDGE_API_URL and
 * KNOWLEDGE_SERVICE_TOKEN set, drafts ground on the platform knowledge API;
 * otherwise the lane drafts from nothing and each draft escalates for a
 * human edit. The memory defaults are the M1 sandbox.
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
      + " be set together; mspFlow keeps the in-memory desk.",
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

export const mastra = createAllRounderMastra({
  ...(coding === undefined ? {} : { coding }),
  ...(review === undefined ? {} : { review }),
  ...(issues === undefined ? {} : { issues }),
  ...(features === undefined ? {} : { features }),
  ...(dependencies === undefined ? {} : { dependencies }),
  ...(accessibility === undefined ? {} : { accessibility }),
  msp,
  bills,
});
