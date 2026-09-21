import { auditAgent, glAgent, taxAgent, treasuryAgent } from "./finance/agents/index.js";
import { preflightAgent, triageAgent } from "./dispatcher/agents/index.js";
import {
  accessibilityAuditorAgent,
  accessibilityFixerAgent,
} from "./accessibility/agents/index.js";
import { featureEngineerAgent, featurePlannerAgent } from "./features/agents/index.js";
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
import { issueAnalystAgent, issueEngineerAgent } from "./issues/agents/index.js";
import { hrHelpDrafterAgent, hrHelpGuardrailAgent } from "./hr-help/agents/index.js";
import { leaveAdvisorAgent } from "./leave/agents/index.js";
import { offboardingAuditAgent } from "./offboarding/agents/index.js";
import { onboardingRiskAgent, onboardingVerifierAgent } from "./onboarding/agents/index.js";
import { hrGuardrailAgent } from "./screening/agents/index.js";
import { reviewerAgent } from "./review/agents/index.js";
import { vendorRiskAgent, vendorVerifierAgent } from "./vendors/agents/index.js";
import {
  alertTriageAgent,
  containmentAdvisorAgent,
  investigationAgent,
  reportingAgent,
} from "./security/agents/index.js";
import { supportDrafterAgent, supportResearcherAgent } from "./support/agents/index.js";

export function allRounderAgents() {
  return {
    dispatcherTriage: triageAgent,
    dispatcherPreflight: preflightAgent,
    programmingInvestigator: investigatorAgent,
    programmingActor: actorAgent,
    programmingValidator: validatorAgent,
    reviewReviewer: reviewerAgent,
    issuesAnalyst: issueAnalystAgent,
    issuesEngineer: issueEngineerAgent,
    featuresPlanner: featurePlannerAgent,
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
  };
}
