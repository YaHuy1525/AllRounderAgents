import type { AgentScenario } from "../../script.js";

export const supportResearcherScenarios: AgentScenario[] = [
  {
    name: "refund FAQ hit",
    input: {
      query: "How long do refunds take?",
      passages: [
        {
          sourceId: "kb-refunds",
          span: "0-80",
          content: "Refunds post in 5-7 business days after approval.",
          stale: false,
        },
      ],
    },
    expectedOutput: {
      citations: [{ sourceId: "kb-refunds", span: "0-80" }],
      empty: false,
      stale: false,
    },
  },
  {
    name: "empty retrieval",
    input: { query: "What is the CEO's personal cell number?", passages: [] },
    expectedOutput: {
      citations: [],
      empty: true,
      stale: false,
    },
  },
];

export const supportDrafterScenarios: AgentScenario[] = [
  {
    name: "cited refund reply",
    input: {
      query: "How long do refunds take?",
      citations: [{ sourceId: "kb-refunds", span: "0-80" }],
      passage: "Refunds post in 5-7 business days after approval.",
    },
    expectedOutput: {
      draft: "Refunds post in 5-7 business days after approval.",
      citations: [{ sourceId: "kb-refunds", span: "0-80" }],
    },
  },
];
