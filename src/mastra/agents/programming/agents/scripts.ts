import type { AgentScenario } from "../../script.js";

export const programmingInvestigatorScenarios: AgentScenario[] = [
  {
    name: "null check on login handler",
    input: {
      ticketKey: "ENG-12",
      problem: "Login 500 when email is missing",
      evidenceHint: "src/auth/login.ts:41 throws on undefined email",
    },
    expectedOutput: {
      summary: "login() dereferences email without a guard, causing a 500.",
      confidence: 0.86,
      evidence: [
        {
          path: "src/auth/login.ts",
          startLine: 41,
          endLine: 44,
          excerpt: "const domain = email.split('@')[1];",
        },
      ],
      fixable: true,
    },
  },
  {
    name: "unfixable missing logs",
    input: {
      ticketKey: "ENG-40",
      problem: "Prod 500 with no stack or source path",
      evidenceHint: "",
    },
    expectedOutput: {
      summary: "No cited source lines are available; escalate instead of guessing a patch.",
      confidence: 0.2,
      evidence: [],
      fixable: false,
    },
  },
];

export const programmingActorScenarios: AgentScenario[] = [
  {
    name: "guard missing email",
    input: {
      rca: "login() dereferences email without a guard",
      path: "src/auth/login.ts",
    },
    expectedOutput: {
      summary: "Return 400 when email is missing before split.",
      files: [
        {
          path: "src/auth/login.ts",
          content: "if (!email) return { status: 400 };\nconst domain = email.split('@')[1];\n",
          validators: ["basic-syntax"],
        },
      ],
    },
  },
];

export const programmingValidatorScenarios: AgentScenario[] = [
  {
    name: "syntax pass",
    input: { path: "src/auth/login.ts", validators: ["basic-syntax"], content: "export const ok = 1;\n" },
    expectedOutput: {
      passed: true,
      attempts: 1,
      results: [
        {
          validator: "basic-syntax",
          path: "src/auth/login.ts",
          passed: true,
          message: "balanced syntax",
        },
      ],
    },
  },
];
