import { Mastra } from "@mastra/core/mastra";
import type { MCPServerBase } from "@mastra/core/mcp";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { SpanType } from "@mastra/core/observability";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { Memory } from "@mastra/memory";
import { MCPServer } from "@mastra/mcp";
import { PostgresStoreVNext } from "@mastra/pg";

import { allRounderAgents } from "./agents/registry.js";
import { hrHelpDrafterAgent } from "./agents/hr-help/agents/index.js";
import { mspDrafterAgent } from "./agents/msp/agents/index.js";
import { supportDrafterAgent } from "./agents/support/agents/index.js";
import { webSearchTool } from "./agents/programming/tools/web-search.js";
import { knowledgeVectorStore } from "./shared/rag.js";
import {
  criticAgreementScorer,
  dispatcherRoutingScorer,
  patchContractScorer,
  rcaEvidenceScorer,
  rcaGoldenPathScorer,
} from "./shared/scorers.js";
import {
  createAccessibilityFlow,
  type AccessibilityFlowDeps,
} from "./agents/accessibility/flow.js";
import {
  createDependenciesFlow,
  type DependenciesFlowDeps,
} from "./agents/dependencies/flow.js";
import { createFeaturesFlow, type FeaturesFlowDeps } from "./agents/features/flow.js";
import { createFinanceFlow } from "./agents/finance/flow.js";
import { MemorySandboxLedger, type SandboxLedger } from "./agents/finance/workflow.js";
import { createIssuesFlow, type IssuesFlowDeps } from "./agents/issues/flow.js";
import { MemoryEmployeeDirectory } from "./agents/hr/directory.js";
import { createHrHelpFlow, type HrHelpFlowDeps } from "./agents/hr-help/flow.js";
import { MemoryHrHelpRegistry } from "./agents/hr-help/tools/hr-help-registry.js";
import { MemoryHrPolicyRetriever } from "./agents/hr-help/tools/hr-policy.js";
import { createBillsFlow, type BillsFlowDeps } from "./agents/bills/flow.js";
import { MemoryBillsLedger } from "./agents/bills/tools/ledger.js";
import { createMspFlow, type MspFlowDeps } from "./agents/msp/flow.js";
import { createLeaveFlow, type LeaveFlowDeps } from "./agents/leave/flow.js";
import { MemoryLeaveRegistry } from "./agents/leave/tools/leave-registry.js";
import { createOffboardingFlow, type OffboardingFlowDeps } from "./agents/offboarding/flow.js";
import { MemoryOffboardingRegistry } from "./agents/offboarding/tools/offboarding-registry.js";
import { createOnboardingFlow, type OnboardingFlowDeps } from "./agents/onboarding/flow.js";
import { MemoryOnboardingRegistry } from "./agents/onboarding/tools/onboarding-registry.js";
import { createScreeningFlow, type ScreeningFlowDeps } from "./agents/screening/flow.js";
import { MemoryScreeningAts } from "./agents/screening/tools/screening-ats.js";
import { createCodingFlow, type CodingFlowDeps } from "./agents/programming/flow.js";
import { createReviewFlow, type ReviewFlowDeps } from "./agents/review/flow.js";
import { createVendorsFlow, type VendorsFlowDeps } from "./agents/vendors/flow.js";
import { MemoryVendorRegistry } from "./agents/vendors/tools/vendor-registry.js";
import { createSecurityFlow, type SecurityFlowDeps } from "./agents/security/flow.js";
import { MastraMemoryCaseHistory } from "./agents/security/tools/mastra-case-history.js";
import {
  MemoryAssetDirectory,
  MemoryCaseHistory,
  MemoryContainmentRegistry,
  MemoryTelemetrySearch,
  MemoryThreatIntel,
  type CaseHistory,
} from "./agents/security/tools/seams.js";
import { MemoryDeskAdapter } from "./desks/memory.js";
import { MemoryMailSender } from "./mail/memory.js";

/**
 * The Mastra HTTP server answers 504 after `server.timeout`, defaulting to
 * 180s (Hono timeout middleware on every route). Start/resume passes run
 * model steps synchronously, so the ceiling must match the API client's wait
 * (`MASTRA_REQUEST_TIMEOUT_SECONDS`, settings cap 600) — otherwise a slow
 * step fails the API run while its workflow keeps executing server-side.
 */
const DEFAULT_SERVER_TIMEOUT_SECONDS = 600;

function serverTimeoutMs(): number {
  const seconds = Number(process.env.MASTRA_REQUEST_TIMEOUT_SECONDS);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : DEFAULT_SERVER_TIMEOUT_SECONDS * 1000;
}

/**
 * Postgres TLS: managed hosts (Supabase, RDS) require it, local dev servers
 * usually reject it. `MASTRA_PG_SSL` overrides both ways; otherwise localhost
 * is plaintext and every other host gets TLS without CA pinning.
 */
function postgresSsl(connectionString: string): boolean | { rejectUnauthorized: boolean } {
  const override = process.env.MASTRA_PG_SSL;
  if (override === "true") return { rejectUnauthorized: false };
  if (override === "false") return false;
  try {
    const host = new URL(connectionString).hostname;
    if (host === "localhost" || host === "127.0.0.1") return false;
  } catch {
    return false;
  }
  return { rejectUnauthorized: false };
}

/**
 * Per-pool connection cap for the Postgres store. Supabase's session-mode
 * pooler limits total clients to a fixed `pool_size` (15 by default). Mastra
 * opens a read pool and a write pool from one store, and node-postgres defaults
 * each to 10, so the boot-time fan-out (`startWorkers` -> `loadDynamicWorkflows`)
 * blows past the cap and dies with `EMAXCONNSESSION`. Clamp each pool low so
 * the aggregate stays under the limit; override with `MASTRA_PG_POOL_MAX`. For
 * higher real throughput switch the URL to the transaction-mode pooler.
 */
function pgPoolMax(): number {
  const raw = Number(process.env.MASTRA_PG_POOL_MAX);
  return Number.isInteger(raw) && raw > 0 && raw <= 20 ? raw : 4;
}

/**
 * Tracing switch, read by the inline `Observability` config in
 * `createAllRounderMastra`. The store itself is metrics-capable either way
 * (see `buildMastraStorage`), so this flag only governs the exporter.
 */
function tracingEnabled(): boolean {
  const flag = process.env.MASTRA_OBSERVABILITY;
  return flag === "true" || flag === "1";
}

/**
 * Persistent Mastra storage when `DATABASE_URL` is set, in-memory otherwise
 * (tests, CI, local machines without Postgres). Persistence is what lets
 * suspended runs survive a host restart and the case index outlive a single
 * process (plan §5.1).
 *
 * Metrics rule from the docs: Studio's metrics panel requires an
 * observability domain whose `getFeatures()` includes `"metrics"`. The
 * classic `PostgresStore` stores traces but cannot serve metric queries
 * ("Metrics are not available with your current storage") and cannot list
 * scores, so the production store is `PostgresStoreVNext`: the normal
 * Postgres domains plus the vNext observability domain (metrics, logs,
 * scores, trace queries). Its `observability` connection intentionally
 * shares the primary pool config for this low-volume deployment; the server
 * logs one warning per boot about the shared connection, which is expected.
 * The `DATABASE_URL`-free fallback is `InMemoryStore`, whose built-in
 * observability domain is metrics-capable too, so tests and credential-free
 * dev runs stay entirely in-process. DuckDB is no longer part of the stack.
 */
function buildMastraStorage(): MastraCompositeStore {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    return new InMemoryStore({ id: "allrounder-orchestrator" });
  }
  const conn = {
    connectionString,
    ssl: postgresSsl(connectionString),
    max: pgPoolMax(),
    idleTimeoutMillis: 30_000,
  };
  return new PostgresStoreVNext({
    id: "allrounder-orchestrator",
    ...conn,
    observability: { ...conn },
  });
}

/**
 * The one instance-level `Memory` (Studio Memory/Threads registry).
 * Semantic recall engages when `MASTRA_MEMORY_EMBEDDER` names an embedder,
 * plain message-history recall otherwise. Only the conversational drafters
 * are attached to it (below); the deterministic single-shot agents stay
 * stateless on purpose.
 */
function buildCoreMemory(storage: MastraCompositeStore): Memory {
  const embedder = process.env.MASTRA_MEMORY_EMBEDDER;
  const semanticRecall = embedder !== undefined && embedder !== "";
  return new Memory({
    storage,
    ...(semanticRecall ? { embedder } : {}),
    options: { semanticRecall },
  });
}

/**
 * The security lane's `CaseHistory` on persistent storage (plan §5.1), now
 * sharing the instance core memory instead of constructing its own. Without
 * `DATABASE_URL` the fixture implementation stays in place so local runs
 * need no credentials.
 */
function buildSecurityCaseHistory(memory: Memory): CaseHistory {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") return new MemoryCaseHistory();
  return new MastraMemoryCaseHistory(memory);
}

/**
 * `coding`, `review`, `issues`, `features`, `dependencies` and `accessibility`
 * are optional on purpose: all six need live GitHub credentials/policy, so
 * they register only when a host (e.g. the API layer) injects them. Finance
 * always runs on the safe in-memory ledger default, vendors always runs on
 * the in-memory vendor registry, and leave/onboarding/offboarding/screening
 * always run on the fixture-backed employee directory and ATS plus their
 * in-memory registries while HR help runs on the fixture policy corpus and
 * its in-memory answer registry (the HR lanes make no network calls). The
 * security lane always runs on the fixture seams, with the case history
 * upgraded to Mastra Memory whenever `DATABASE_URL` is set (§5.1). The MSP
 * lane always runs on the in-memory desk and mailbox, with the host upgrading
 * to the Jira Cloud adapter and the on-disk outbox when the JIRA_* and MAIL_*
 * variables are set. Bills always runs on the in-memory ledger default (the
 * host injects the Xero ledger and the platform vendor registry), and the
 * post step is receipt-gated either way.
 */
export function createAllRounderMastra(
  deps: {
    ledger?: SandboxLedger;
    coding?: CodingFlowDeps;
    review?: ReviewFlowDeps;
    issues?: IssuesFlowDeps;
    features?: FeaturesFlowDeps;
    dependencies?: DependenciesFlowDeps;
    accessibility?: AccessibilityFlowDeps;
    vendors?: VendorsFlowDeps;
    leave?: LeaveFlowDeps;
    onboarding?: OnboardingFlowDeps;
    offboarding?: OffboardingFlowDeps;
    screening?: ScreeningFlowDeps;
    hrHelp?: HrHelpFlowDeps;
    msp?: MspFlowDeps;
    bills?: BillsFlowDeps;
    security?: SecurityFlowDeps;
  } = {},
) {
  const ledger = deps.ledger ?? new MemorySandboxLedger();
  const storage = buildMastraStorage();
  const coreMemory = buildCoreMemory(storage);
  // Studio Vectors registry: the Mastra-owned pgvector store behind the RAG
  // pilot (shared pool with `MastraRagHrPolicyRetriever`). Absent without
  // `DATABASE_URL`, so credential-free runs never touch the vector path.
  const knowledgeVectors = knowledgeVectorStore();
  // Studio Threads need memory on the agent itself. The three conversational
  // drafters share the instance core memory; `__setMemory` is the framework's
  // late-wiring setter (module-level agent singletons are built before this
  // function runs, so the constructor config is not an option). Workflow
  // calls without a threadId stay history-less, so lane behavior is
  // unchanged. Deterministic agents (investigator, actor, validator,
  // dispatcher, extractors) are deliberately left memory-free.
  for (const conversationalAgent of [hrHelpDrafterAgent, mspDrafterAgent, supportDrafterAgent]) {
    conversationalAgent.__setMemory(coreMemory);
  }
  // Every workflow is defined once, as its own `const`. The lanes mounted on
  // in-memory defaults go straight into the registry below. The six
  // GitHub-backed lanes may stay `undefined` when the host did not inject
  // their credentials, and each gets a one-line gate at registration: a lane
  // that was not supplied is absent from `workflows`, never a broken stub.
  const financeFlow = createFinanceFlow({ ledger });
  const vendorsFlow = createVendorsFlow(deps.vendors ?? { registry: new MemoryVendorRegistry() });
  const leaveFlow = createLeaveFlow(
    deps.leave ?? {
      directory: new MemoryEmployeeDirectory(),
      registry: new MemoryLeaveRegistry(),
    },
  );
  const onboardingFlow = createOnboardingFlow(
    deps.onboarding ?? {
      directory: new MemoryEmployeeDirectory(),
      registry: new MemoryOnboardingRegistry(),
    },
  );
  const offboardingFlow = createOffboardingFlow(
    deps.offboarding ?? {
      directory: new MemoryEmployeeDirectory(),
      registry: new MemoryOffboardingRegistry(),
    },
  );
  const screeningFlow = createScreeningFlow(
    deps.screening ?? {
      ats: new MemoryScreeningAts(),
    },
  );
  const hrHelpFlow = createHrHelpFlow(
    deps.hrHelp ?? {
      retriever: new MemoryHrPolicyRetriever(),
      registry: new MemoryHrHelpRegistry(),
    },
  );
  const mspFlow = createMspFlow(
    deps.msp ?? {
      desk: new MemoryDeskAdapter(),
      mail: new MemoryMailSender(),
    },
  );
  const billsFlow = createBillsFlow(deps.bills ?? { ledger: new MemoryBillsLedger() });
  const securityFlow = createSecurityFlow(
    deps.security ?? {
      telemetry: new MemoryTelemetrySearch(),
      assets: new MemoryAssetDirectory(),
      intel: new MemoryThreatIntel(),
      containment: new MemoryContainmentRegistry(),
      caseHistory: buildSecurityCaseHistory(coreMemory),
    },
  );
  const codingFlow = deps.coding === undefined ? undefined : createCodingFlow(deps.coding);
  const reviewFlow = deps.review === undefined ? undefined : createReviewFlow(deps.review);
  const issuesFlow = deps.issues === undefined ? undefined : createIssuesFlow(deps.issues);
  const featuresFlow = deps.features === undefined ? undefined : createFeaturesFlow(deps.features);
  const dependenciesFlow =
    deps.dependencies === undefined ? undefined : createDependenciesFlow(deps.dependencies);
  const accessibilityFlow =
    deps.accessibility === undefined
      ? undefined
      : createAccessibilityFlow(deps.accessibility);
  return new Mastra({
    logger: false,
    server: { timeout: serverTimeoutMs() },
    storage,
    // Native Mastra observability, opt-in via `MASTRA_OBSERVABILITY=true`
    // (off by default so the vitest suites and ordinary runs pay nothing; the
    // key must be absent rather than undefined). `MastraStorageExporter`
    // writes trace/log/metric/score events into the observability domain of
    // the store above (Postgres vNext when `DATABASE_URL` is set, in-memory
    // otherwise), which Mastra Studio reads back — no external collector and
    // no side-car database. `MODEL_CHUNK` spans are dropped as pure
    // noise, the sensitive-data filter stays on for the SOC/HR lanes' PII, and
    // the run/tenant context keys are lifted onto spans so a
    // suspended-then-resumed run stitches under one `runId`. Cost authority
    // stays with `run_archive`; this is the developer diagnostic view, not the
    // billing source of truth.
    ...(tracingEnabled()
      ? {
          observability: new Observability({
            configs: {
              default: {
                serviceName: "allrounder-agent",
                excludeSpanTypes: [SpanType.MODEL_CHUNK],
                requestContextKeys: ["runId", "tenantId", "ticketKey", "workflow"],
                exporters: [new MastraStorageExporter()],
              },
            },
            sensitiveDataFilter: true,
          }),
        }
      : {}),
    agents: allRounderAgents(),
    ...(knowledgeVectors !== undefined ? { vectors: { knowledge: knowledgeVectors } } : {}),
    // Instance memory registry (Studio Memory/Threads). `core` is the same
    // object the conversational drafters use and the security case history
    // runs on, so one store backs all of it.
    memory: { core: coreMemory },
    // MCP exposure (Studio MCP tab): Mastra's own read-only surface for
    // external MCP clients. Only non-mutating tools are published; the
    // GitHub `write_*` path stays behind the consuming MCPClient's
    // `requireToolApproval` and is never surfaced here. The upcast papers
    // over a known library-side variance: `MCPServer.listResources()` is
    // typed with zod-inferred `| undefined` optionals that read as wider
    // than the core base contract under `exactOptionalPropertyTypes`. It is
    // purely type-level; the instance extends the core base at runtime.
    mcpServers: {
      allrounder: new MCPServer({
        id: "allrounder-mcp",
        name: "AllRounder",
        version: "1.0.0",
        tools: { web_search: webSearchTool },
      }) as unknown as MCPServerBase,
    },
    // Registered scorers (Studio Evals). `rcaEvidence` also rides the
    // investigator agent for live sampling, but instance registration is
    // what makes each scorer resolvable for `runEvals()`, dataset
    // experiments, and trace scoring from Studio, and persists their
    // results into `mastra_scorers`. The three coding-lane scorers
    // (`rcaGoldenPath`, `patchContract`, `criticAgreement`) are the
    // experiment targets for the coding agents' golden datasets.
    scorers: {
      rcaEvidence: rcaEvidenceScorer,
      dispatcherRouting: dispatcherRoutingScorer,
      rcaGoldenPath: rcaGoldenPathScorer,
      patchContract: patchContractScorer,
      criticAgreement: criticAgreementScorer,
    },
    workflows: {
      financeFlow,
      vendorsFlow,
      leaveFlow,
      onboardingFlow,
      offboardingFlow,
      screeningFlow,
      hrHelpFlow,
      mspFlow,
      billsFlow,
      securityFlow,
      ...(codingFlow !== undefined ? { codingFlow } : {}),
      ...(reviewFlow !== undefined ? { reviewFlow } : {}),
      ...(issuesFlow !== undefined ? { issuesFlow } : {}),
      ...(featuresFlow !== undefined ? { featuresFlow } : {}),
      ...(dependenciesFlow !== undefined ? { dependenciesFlow } : {}),
      ...(accessibilityFlow !== undefined ? { accessibilityFlow } : {}),
    },
  });
}
