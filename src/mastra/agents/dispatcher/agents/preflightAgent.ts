import { createScriptedAgent } from "../../script.js";
import { dispatcherPreflightScenarios } from "./scripts.js";

export const preflightAgent = createScriptedAgent({
  id: "dispatcher-preflight",
  name: "Dispatcher preflight",
  role: "You score each planned action for blast radius, reversibility, and gate.",
  rules: [
    "Finance posting, outbound mail, and production deploys always gate as approval.",
    "Irreversible plus high blast is refuse, never auto.",
    "Do not execute the action; only score it.",
  ],
  outputShape: "{ action, blastRadius, reversibility, score, gate, reasons }",
  scenarios: dispatcherPreflightScenarios,
});
