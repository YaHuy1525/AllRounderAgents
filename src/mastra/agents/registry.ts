import { auditAgent, glAgent, taxAgent, treasuryAgent } from "./finance/agents/index.js";
import { preflightAgent, triageAgent } from "./dispatcher/agents/index.js";
import {
  accessibilityAuditorAgent,
  accessibilityFixerAgent,
} from "./accessibility/agents/index.js";
import {
  featureAcDrafterAgent,
  featureEngineerAgent,
  featurePlannerAgent,
} from "./features/agents/index.js";
import {
  dependencyEngineerAgent,
  dependencyRepairAgent,
} from "./dependencies/agents/index.js";
import {
  brandGuardrailAgent,
  marketingDrafterAgent,
  marketingResearcherAgent,
} from "./marketing/agents/index.js";
import { actorAgent, investigatorAgent, validatorAgent } from "./programming/agents/index.js";
import { upgradeAdvisorAgent } from "./llmops/index.js";
import { issueAnalystAgent, issueEngineerAgent } from "./issues/agents/index.js";
import { hrHelpDrafterAgent, hrHelpGuardrailAgent } from "./hr-help/agents/index.js";
import { mspDrafterAgent } from "./msp/agents/index.js";
import { billExtractorAgent } from "./bills/agents/index.js";
import { leaveAdvisorAgent } from "./leave/agents/index.js";
import { offboardingAuditAgent } from "./offboarding/agents/index.js";
import { onboardingRiskAgent, onboardingVerifierAgent } from "./onboarding/agents/index.js";
import { hrGuardrailAgent } from "./screening/agents/index.js";
import { reviewerAgent } from "./review/agents/index.js";
import { qaLeadAgent } from "./qa/agents/index.js";
import { vendorRiskAgent, vendorVerifierAgent } from "./vendors/agents/index.js";
import {
  alertTriageAgent,
  containmentAdvisorAgent,
  investigationAgent,
  reportingAgent,
} from "./security/agents/index.js";
import { supportDrafterAgent, supportResearcherAgent } from "./support/agents/index.js";
import { consoleAssistantAgent } from "./console/agents/index.js";
import { droppyAgents } from "./droppy/agents/bots.js";

export function allRounderAgents() {
  return {
    dispatcherTriage: triageAgent,
    dispatcherPreflight: preflightAgent,
    programmingInvestigator: investigatorAgent,
    programmingActor: actorAgent,
    programmingValidator: validatorAgent,
    // Meta agent: reads coding-agent experiment scores and proposes upgrades.
    // Registered alongside the domain agents so it appears in Studio and is
    // callable over the agents API; it is read-only and gates nothing.
    llmopsUpgradeAdvisor: upgradeAdvisorAgent,
    reviewReviewer: reviewerAgent,
    // QA lead: the supervisor of the four-specialist testing squad. It holds
    // no tools of its own; the delegation gate in `qa/squad.ts` decides which
    // child a phase may reach, and the executor stays refused until a human
    // approved a case set.
    qaLead: qaLeadAgent,
    issuesAnalyst: issueAnalystAgent,
    issuesEngineer: issueEngineerAgent,
    featuresPlanner: featurePlannerAgent,
    featuresAcDrafter: featureAcDrafterAgent,
    featuresEngineer: featureEngineerAgent,
    dependenciesEngineer: dependencyEngineerAgent,
    dependenciesRepair: dependencyRepairAgent,
    accessibilityAuditor: accessibilityAuditorAgent,
    accessibilityFixer: accessibilityFixerAgent,
    vendorsVerifier: vendorVerifierAgent,
    vendorsRisk: vendorRiskAgent,
    leaveAdvisor: leaveAdvisorAgent,
    onboardingVerifier: onboardingVerifierAgent,
    onboardingRisk: onboardingRiskAgent,
    offboardingAudit: offboardingAuditAgent,
    screeningGuardrail: hrGuardrailAgent,
    hrHelpDrafter: hrHelpDrafterAgent,
    hrHelpGuardrail: hrHelpGuardrailAgent,
    mspDrafter: mspDrafterAgent,
    billsExtractor: billExtractorAgent,
    financeGl: glAgent,
    financeTreasury: treasuryAgent,
    financeTax: taxAgent,
    financeAudit: auditAgent,
    securityTriage: alertTriageAgent,
    securityInvestigator: investigationAgent,
    securityContainmentAdvisor: containmentAdvisorAgent,
    securityReporter: reportingAgent,
    marketingResearcher: marketingResearcherAgent,
    marketingDrafter: marketingDrafterAgent,
    marketingBrandGuardrail: brandGuardrailAgent,
    supportResearcher: supportResearcherAgent,
    supportDrafter: supportDrafterAgent,
    // Conversational console assistant: the only agent that retrieves its own
    // grounding through the Mastra knowledge search tools. Always registered so
    // Studio shows it; the tools appear only when the knowledge plane is wired.
    consoleAssistant: consoleAssistantAgent,
    // Droppy lane: the autonomous AU dropshipping system. Nine bots over one
    // shared index, with three reverse-engineered research engines (Minea,
    // PipiADS, Kalodata) on one collector layer. See docs/architecture/adr.
    droppyResearch: droppyAgents.researchAgent,
    droppyListing: droppyAgents.listingAgent,
    droppyOrders: droppyAgents.orderAgent,
    droppyTracking: droppyAgents.trackingAgent,
    droppyExceptions: droppyAgents.exceptionAgent,
    droppySupport: droppyAgents.supportAgent,
    droppyPricing: droppyAgents.pricingAgent,
    droppyAds: droppyAgents.adsAgent,
  };
}
