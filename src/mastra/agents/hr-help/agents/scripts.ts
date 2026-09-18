import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the HR help drafter. Expected outputs are
 * on-contract (`DraftModelOutputSchema`): the answer with its `[sourceId:span]`
 * markers and the citation list the draft validation checks against the
 * retrieved passages.
 */
export const hrHelpDrafterScenarios: AgentScenario[] = [
  {
    name: "parental leave entitlement",
    input: {
      question: "How much parental leave do we offer for a primary caregiver?",
      passages: [
        {
          sourceId: "hr_policy/leave-and-time-off.md",
          span: "540-780",
          title: "Leave and Time Off",
          text: "Parental leave provides 20 weeks at full pay for the primary caregiver and 12 weeks at full pay for the secondary caregiver.",
          stale: false,
        },
      ],
    },
    expectedOutput: {
      answer:
        "Parental leave provides 20 weeks at full pay for the primary caregiver and 12 weeks at full pay for the secondary caregiver, and it should be requested at least 30 days before the expected start date where practical [hr_policy/leave-and-time-off.md:540-780].",
      citations: [{ sourceId: "hr_policy/leave-and-time-off.md", span: "540-780" }],
    },
  },
  {
    name: "expense claim window",
    input: {
      question: "What is the deadline for filing an expense claim?",
      passages: [
        {
          sourceId: "hr_policy/benefits-and-pay.md",
          span: "300-460",
          title: "Benefits and Pay",
          text: "Expense claims are reimbursed when submitted within 30 calendar days of the expense date.",
          stale: false,
        },
      ],
    },
    expectedOutput: {
      answer:
        "Expense claims are reimbursed when submitted within 30 calendar days of the expense date, and receipts are required for any claim above 25 EUR [hr_policy/benefits-and-pay.md:300-460].",
      citations: [{ sourceId: "hr_policy/benefits-and-pay.md", span: "300-460" }],
    },
  },
];

/**
 * Few-shot scenarios for the HR help guardrail. Expected outputs are
 * on-contract (`HrHelpGuardrailOutputSchema`): the allow verdict, the
 * narrative, the confidence, and the legal-advice and PII-leakage flags.
 */
export const hrHelpGuardrailScenarios: AgentScenario[] = [
  {
    name: "clean cited answer",
    input: {
      question: "What is the deadline for filing an expense claim?",
      answer:
        "Expense claims are reimbursed when submitted within 30 calendar days of the expense date [hr_policy/benefits-and-pay.md:300-460].",
      citations: [{ sourceId: "hr_policy/benefits-and-pay.md", span: "300-460" }],
    },
    expectedOutput: {
      allowed: true,
      summary: "The answer stays on policy, cites its passage, and names no people.",
      confidence: 0.87,
      flags: [],
    },
  },
  {
    name: "legal advice and a leaked name",
    input: {
      question: "Can my manager refuse my grievance appeal?",
      answer:
        "You can sue the company for that refusal, and Ines Varga will likely lose in court [hr_policy/conduct-and-grievances.md:220-340].",
      citations: [{ sourceId: "hr_policy/conduct-and-grievances.md", span: "220-340" }],
    },
    expectedOutput: {
      allowed: false,
      summary:
        "The draft promises a legal outcome instead of stating policy, and it names an employee.",
      confidence: 0.9,
      flags: [
        {
          kind: "legal-advice",
          detail: "Claims the employee can sue and predicts a court outcome; policy statements must not interpret law.",
          sourceId: "answer",
          span: "0-52",
        },
        {
          kind: "pii-leakage",
          detail: "Names an employee in the answer; refer to people by role only.",
          sourceId: "answer",
          span: "53-110",
        },
      ],
    },
  },
];
