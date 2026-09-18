import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";

import { allRounderAgents } from "./agents/registry.js";
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
 * `coding`, `review`, `issues`, `features`, `dependencies` and `accessibility`
 * are optional on purpose: all six need live GitHub credentials/policy, so
 * they register only when a host (e.g. the API layer) injects them. Finance
 * always runs on the safe in-memory ledger default, vendors always runs on
 * the in-memory vendor registry, and leave/onboarding/offboarding/screening
 * always run on the fixture-backed employee directory and ATS plus their
 * in-memory registries while HR help runs on the fixture policy corpus and
 * its in-memory answer registry (the HR lanes make no network calls).
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
  } = {},
) {
  const ledger = deps.ledger ?? new MemorySandboxLedger();
  return new Mastra({
    logger: false,
    server: { timeout: serverTimeoutMs() },
    storage: new InMemoryStore({ id: "allrounder-orchestrator" }),
    agents: allRounderAgents(),
    workflows: {
      financeFlow: createFinanceFlow({ ledger }),
      ...(deps.coding === undefined ? {} : { codingFlow: createCodingFlow(deps.coding) }),
      ...(deps.review === undefined ? {} : { reviewFlow: createReviewFlow(deps.review) }),
      ...(deps.issues === undefined ? {} : { issuesFlow: createIssuesFlow(deps.issues) }),
      ...(deps.features === undefined ? {} : { featuresFlow: createFeaturesFlow(deps.features) }),
      ...(deps.dependencies === undefined
        ? {}
        : { dependenciesFlow: createDependenciesFlow(deps.dependencies) }),
      ...(deps.accessibility === undefined
        ? {}
        : { accessibilityFlow: createAccessibilityFlow(deps.accessibility) }),
      vendorsFlow: createVendorsFlow(deps.vendors ?? { registry: new MemoryVendorRegistry() }),
      leaveFlow: createLeaveFlow(
        deps.leave ?? {
          directory: new MemoryEmployeeDirectory(),
          registry: new MemoryLeaveRegistry(),
        },
      ),
      onboardingFlow: createOnboardingFlow(
        deps.onboarding ?? {
          directory: new MemoryEmployeeDirectory(),
          registry: new MemoryOnboardingRegistry(),
        },
      ),
      offboardingFlow: createOffboardingFlow(
        deps.offboarding ?? {
          directory: new MemoryEmployeeDirectory(),
          registry: new MemoryOffboardingRegistry(),
        },
      ),
      screeningFlow: createScreeningFlow(
        deps.screening ?? {
          ats: new MemoryScreeningAts(),
        },
      ),
      hrHelpFlow: createHrHelpFlow(
        deps.hrHelp ?? {
          retriever: new MemoryHrPolicyRetriever(),
          registry: new MemoryHrHelpRegistry(),
        },
      ),
    },
  });
}
