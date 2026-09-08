import { auditAgent, glAgent, taxAgent, treasuryAgent } from "./finance/agents/index.js";
import { preflightAgent, triageAgent } from "./dispatcher/agents/index.js";
import {
  brandGuardrailAgent,
  marketingDrafterAgent,
  marketingResearcherAgent,
} from "./marketing/agents/index.js";
import { actorAgent, investigatorAgent, validatorAgent } from "./programming/agents/index.js";
import { supportDrafterAgent, supportResearcherAgent } from "./support/agents/index.js";

export function allRounderAgents() {
  return {
    dispatcherTriage: triageAgent,
    dispatcherPreflight: preflightAgent,
    programmingInvestigator: investigatorAgent,
    programmingActor: actorAgent,
    programmingValidator: validatorAgent,
    financeGl: glAgent,
    financeTreasury: treasuryAgent,
    financeTax: taxAgent,
    financeAudit: auditAgent,
    marketingResearcher: marketingResearcherAgent,
    marketingDrafter: marketingDrafterAgent,
    marketingBrandGuardrail: brandGuardrailAgent,
    supportResearcher: supportResearcherAgent,
    supportDrafter: supportDrafterAgent,
  };
}
