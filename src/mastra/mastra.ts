import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";

import { allRounderAgents } from "./agents/registry.js";
import { createFinanceFlow } from "./agents/finance/flow.js";
import { MemorySandboxLedger, type SandboxLedger } from "./agents/finance/workflow.js";
import { createCodingFlow, type CodingFlowDeps } from "./agents/programming/flow.js";

/**
 * `coding` is optional on purpose: GitHubRepositoryTools needs live
 * credentials/policy, so the coding flow registers only when a host
 * (e.g. the API layer) injects them. Finance always runs on the safe
 * in-memory ledger default.
 */
export function createAllRounderMastra(
  deps: { ledger?: SandboxLedger; coding?: CodingFlowDeps } = {},
) {
  const ledger = deps.ledger ?? new MemorySandboxLedger();
  return new Mastra({
    logger: false,
    storage: new InMemoryStore({ id: "allrounder-orchestrator" }),
    agents: allRounderAgents(),
    workflows: {
      financeFlow: createFinanceFlow({ ledger }),
      ...(deps.coding === undefined ? {} : { codingFlow: createCodingFlow(deps.coding) }),
    },
  });
}
