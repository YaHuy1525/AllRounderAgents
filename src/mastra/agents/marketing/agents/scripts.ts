import type { AgentScenario } from "../../script.js";

export const marketingResearcherScenarios: AgentScenario[] = [
  {
    name: "sourced launch claim",
    input: {
      brief: "Announce the September close toolkit. Mention 2-day close only if sourced.",
      sources: [{ sourceId: "runbook-close", span: "12-40", text: "Pilot teams closed in two business days." }],
    },
    expectedOutput: {
      claims: [
        {
          text: "Pilot teams closed in two business days.",
          sourceId: "runbook-close",
          span: "12-40",
        },
      ],
      unsourced: [],
    },
  },
];

export const marketingDrafterScenarios: AgentScenario[] = [
  {
    name: "cited launch blurb",
    input: {
      claims: [{ text: "Pilot teams closed in two business days.", sourceId: "runbook-close" }],
    },
    expectedOutput: {
      draft: "Pilot teams closed in two business days.",
      claimSourceIds: ["runbook-close"],
    },
  },
];

export const marketingBrandScenarios: AgentScenario[] = [
  {
    name: "banned guarantee",
    input: {
      draft: "Guaranteed 2-day close for every customer.",
      bannedClaims: ["guaranteed"],
    },
    expectedOutput: {
      allowed: false,
      reasons: ["Draft uses banned claim language: guaranteed."],
    },
  },
  {
    name: "sourced allowed copy",
    input: {
      draft: "Pilot teams closed in two business days.",
      bannedClaims: ["guaranteed"],
    },
    expectedOutput: {
      allowed: true,
      reasons: [],
    },
  },
];
