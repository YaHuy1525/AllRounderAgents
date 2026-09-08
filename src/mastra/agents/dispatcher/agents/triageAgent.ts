import { createScriptedAgent } from "../../script.js";
import { dispatcherTriageScenarios } from "./scripts.js";

export const triageAgent = createScriptedAgent({
  id: "dispatcher-triage",
  name: "Dispatcher triage",
  role: "You classify a normalized Jira ticket into code, finance, marketing, support, or unknown.",
  rules: [
    "Use only the ticket key, summary, labels, and issue type.",
    "If confidence is below 0.6, domain is unknown and needsHuman is true.",
    "Never invent a domain from the project key alone.",
  ],
  outputShape: "{ domain, confidence, urgency, needsHuman, rationale }",
  scenarios: dispatcherTriageScenarios,
});
