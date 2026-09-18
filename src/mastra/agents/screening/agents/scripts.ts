import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the HR guardrail. Expected outputs are on-contract
 * (`GuardrailOutputSchema`): the allow verdict, the narrative, the confidence,
 * and the per-candidate flags the screen checkpoint attaches to the artifact.
 */
export const hrGuardrailScenarios: AgentScenario[] = [
  {
    name: "clean citations",
    input: {
      requisitionId: "REQ-2001",
      roleTitle: "Senior Frontend Engineer",
      criteria: [{ id: "react-depth", label: "React depth", mustHave: true }],
      candidates: [
        {
          candidateId: "C-3001",
          candidateLabel: "I. V.",
          headline: "Staff engineer, 9 years",
          notes: ["Panel availability confirmed for the week after next."],
          evidence: [
            {
              sourceId: "cv:C-3001",
              span: "83-140",
              criterionId: "react-depth",
              text: "Led the migration of the billing console to React 19 with server components.",
            },
          ],
        },
      ],
    },
    expectedOutput: {
      allowed: true,
      summary:
        "One candidate with rubric-cited evidence and no protected-attribute language.",
      confidence: 0.86,
      flags: [],
    },
  },
  {
    name: "protected attribute and non-rubric notes",
    input: {
      requisitionId: "REQ-2001",
      roleTitle: "Senior Frontend Engineer",
      criteria: [{ id: "react-depth", label: "React depth", mustHave: true }],
      candidates: [
        {
          candidateId: "C-3003",
          candidateLabel: "H. S.",
          headline: "Senior engineer, 8 years",
          notes: [
            "Screening note: around 40 years old; plenty of runway before retirement, worth fast-tracking.",
          ],
          evidence: [
            {
              sourceId: "cv:C-3003",
              span: "64-120",
              criterionId: "react-depth",
              text: "Leads the React guild and reviews component architecture across teams.",
            },
          ],
        },
        {
          candidateId: "C-3002",
          candidateLabel: "B. C.",
          headline: "Senior engineer, 7 years",
          notes: ["Interviewer note: would be a great culture fit for the Friday drinks crowd."],
          evidence: [
            {
              sourceId: "cv:C-3002",
              span: "40-92",
              criterionId: "react-depth",
              text: "Built a real-time operations dashboard in React with custom hooks.",
            },
          ],
        },
      ],
    },
    expectedOutput: {
      allowed: false,
      summary:
        "Two candidates carry screening notes outside the rubric: one leans on age and retirement timing, one on culture fit rather than criteria.",
      confidence: 0.71,
      flags: [
        {
          candidateId: "C-3003",
          kind: "protected-attribute",
          detail: "Note references age and retirement timing.",
          sourceId: "note:C-3003",
          span: "1-88",
        },
        {
          candidateId: "C-3002",
          kind: "non-rubric",
          detail: "Culture-fit claim is not grounded in a rubric criterion.",
          sourceId: "note:C-3002",
          span: "1-72",
        },
      ],
    },
  },
];
