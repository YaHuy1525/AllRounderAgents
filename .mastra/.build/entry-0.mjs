import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { Agent } from '@mastra/core/agent';
import { createHash } from 'node:crypto';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

"use strict";
const DEEPSEEK_FLASH_MODEL = "deepseek/deepseek-v4-flash";
const DEEPSEEK_FLASH_MODEL_CONFIG = {
  id: DEEPSEEK_FLASH_MODEL,
  url: "https://api.deepseek.com"
};

"use strict";
function formatScenarioExamples(scenarios) {
  return scenarios.map(
    (scenario) => `### ${scenario.name}
Input:
${JSON.stringify(scenario.input, null, 2)}
Expected output:
${JSON.stringify(scenario.expectedOutput, null, 2)}`
  ).join("\n\n");
}
function formatAgentScript(config) {
  return [
    config.role,
    "Rules:",
    ...config.rules.map((rule) => `- ${rule}`),
    `Return JSON only, matching: ${config.outputShape}`,
    "Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.",
    formatScenarioExamples(config.scenarios)
  ].join("\n");
}
function createLaneAgent(config) {
  return new Agent({
    id: config.id,
    name: config.name,
    ...config.description === void 0 ? {} : { description: config.description },
    model: DEEPSEEK_FLASH_MODEL_CONFIG,
    defaultGenerateOptionsLegacy: { temperature: 0 },
    defaultStreamOptionsLegacy: { temperature: 0 },
    instructions: async ({ requestContext }) => {
      const override = requestContext?.get("promptOverride");
      if (typeof override === "string" && override.length > 0) return override;
      return config.script;
    }
  });
}
function createScriptedAgent(config) {
  return createLaneAgent({
    id: config.id,
    name: config.name,
    description: config.description,
    script: formatAgentScript(config)
  });
}
function createStructuredAgent(config) {
  return createLaneAgent({
    id: config.id,
    name: config.name,
    description: config.description,
    script: config.prompt
  });
}

"use strict";
const financeGlScenarios = [
  {
    name: "unmatched ledger PAY-1",
    input: {
      type: "unmatched_ledger",
      account: "2000",
      currency: "USD",
      externalRef: "PAY-1",
      ledgerCents: -5e3,
      bankCents: null,
      deltaCents: 5e3
    },
    expectedOutput: {
      specialist: "gl",
      exceptionRef: "PAY-1",
      summary: "Ledger PAY-1 has no bank match; review unpresented items."
    }
  },
  {
    name: "amount mismatch INV-2",
    input: {
      type: "amount_mismatch",
      account: "1000",
      currency: "USD",
      externalRef: "INV-2",
      ledgerCents: 2500,
      bankCents: 2400,
      deltaCents: -100
    },
    expectedOutput: {
      specialist: "gl",
      exceptionRef: "INV-2",
      summary: "Amount mismatch of -100 cents on INV-2."
    }
  }
];
const financeTreasuryScenarios = [
  {
    name: "unmatched bank DEP-9",
    input: {
      type: "unmatched_bank",
      account: "1000",
      currency: "USD",
      externalRef: "DEP-9",
      ledgerCents: null,
      bankCents: 3e3,
      deltaCents: 3e3
    },
    expectedOutput: {
      specialist: "treasury",
      exceptionRef: "DEP-9",
      summary: "Bank DEP-9 has no ledger match; check cutoff and deposits in transit."
    }
  }
];
const financeTaxScenarios = [
  {
    name: "tax timing on INV-2",
    input: {
      type: "amount_mismatch",
      externalRef: "INV-2",
      deltaCents: -100
    },
    expectedOutput: {
      specialist: "tax",
      exceptionRef: "INV-2",
      summary: "Confirm tax timing is not the -100 cent variance on INV-2."
    }
  }
];
const financeAuditScenarios = [
  {
    name: "month-end pack with three exceptions",
    input: {
      period: "2026-08",
      exceptionRefs: ["INV-2", "PAY-1", "DEP-9"],
      postingLedger: "sandbox"
    },
    expectedOutput: {
      period: "2026-08",
      balanced: false,
      exceptionCount: 3,
      checks: [
        { id: "exceptions-have-rca", passed: true, detail: "Every exception has at least one specialist finding." },
        { id: "integer-money", passed: true, detail: "All money values are integer cents." },
        { id: "sandbox-ledger-only", passed: true, detail: "Posting adapters stay on the sandbox ledger." }
      ]
    }
  }
];

"use strict";
const auditAgent = createScriptedAgent({
  id: "finance-audit",
  name: "Finance audit agent",
  role: "You validate the recon pack before any sandbox post: coverage, integer money, sandbox-only ledger.",
  rules: [
    "Fail the pack if any exception lacks a specialist finding.",
    "Fail if any amount is not integer cents.",
    "Fail if posting.ledger is not sandbox."
  ],
  outputShape: "{ period, balanced, exceptionCount, checks[] }",
  scenarios: financeAuditScenarios
});

"use strict";
const glAgent = createScriptedAgent({
  id: "finance-gl",
  name: "Finance GL specialist",
  role: "You explain general-ledger exceptions in integer cents.",
  rules: [
    "Use only the exception fields provided.",
    "Money stays integer cents. Never emit floats.",
    "Do not recommend posting to a live ledger."
  ],
  outputShape: "{ specialist: 'gl', exceptionRef, summary }",
  scenarios: financeGlScenarios
});

"use strict";
const taxAgent = createScriptedAgent({
  id: "finance-tax",
  name: "Finance tax specialist",
  role: "You check whether an amount mismatch could be tax timing rather than a posting error.",
  rules: [
    "Do not conclude tax is the cause unless the input says so.",
    "Ask to confirm timing; do not invent a tax code.",
    "Integer cents only."
  ],
  outputShape: "{ specialist: 'tax', exceptionRef, summary }",
  scenarios: financeTaxScenarios
});

"use strict";
const treasuryAgent = createScriptedAgent({
  id: "finance-treasury",
  name: "Finance treasury specialist",
  role: "You explain unmatched bank items: cutoff, deposits in transit, and timing.",
  rules: [
    "Only unmatched_bank exceptions belong to treasury.",
    "Do not invent a matching ledger line.",
    "Keep posting read-only until a finance:post receipt exists."
  ],
  outputShape: "{ specialist: 'treasury', exceptionRef, summary }",
  scenarios: financeTreasuryScenarios
});

"use strict";

"use strict";
const dispatcherTriageScenarios = [
  {
    name: "month-end recon ticket",
    input: {
      key: "SCRUM-5",
      summary: "Reconcile September month-end ledger against bank",
      labels: ["finance", "ledger"]
    },
    expectedOutput: {
      domain: "finance",
      confidence: 0.92,
      urgency: 3,
      needsHuman: false,
      rationale: "Summary and labels are finance reconciliation work."
    }
  },
  {
    name: "unknown one-line ticket",
    input: { key: "SCRUM-99", summary: "Please look", labels: [] },
    expectedOutput: {
      domain: "unknown",
      confidence: 0.2,
      urgency: 2,
      needsHuman: true,
      rationale: "Not enough signal to choose a domain; escalate."
    }
  }
];
const dispatcherPreflightScenarios = [
  {
    name: "sandbox journal post",
    input: { action: "finance.sandbox-post", blastRadiusHint: "ledger" },
    expectedOutput: {
      action: "finance.sandbox-post",
      blastRadius: "high",
      reversibility: "compensable",
      score: 72,
      gate: "approval",
      reasons: ["Money movement requires a finance:post receipt."]
    }
  },
  {
    name: "jira comment only",
    input: { action: "jira.comment", blastRadiusHint: "ticket" },
    expectedOutput: {
      action: "jira.comment",
      blastRadius: "low",
      reversibility: "reversible",
      score: 12,
      gate: "auto",
      reasons: ["Commenting on Jira is reversible and low blast."]
    }
  }
];

"use strict";
const preflightAgent = createScriptedAgent({
  id: "dispatcher-preflight",
  name: "Dispatcher preflight",
  role: "You score each planned action for blast radius, reversibility, and gate.",
  rules: [
    "Finance posting, outbound mail, and production deploys always gate as approval.",
    "Irreversible plus high blast is refuse, never auto.",
    "Do not execute the action; only score it."
  ],
  outputShape: "{ action, blastRadius, reversibility, score, gate, reasons }",
  scenarios: dispatcherPreflightScenarios
});

"use strict";
const triageAgent = createScriptedAgent({
  id: "dispatcher-triage",
  name: "Dispatcher triage",
  role: "You classify a normalized Jira ticket into code, finance, marketing, support, or unknown.",
  rules: [
    "Use only the ticket key, summary, labels, and issue type.",
    "If confidence is below 0.6, domain is unknown and needsHuman is true.",
    "Never invent a domain from the project key alone."
  ],
  outputShape: "{ domain, confidence, urgency, needsHuman, rationale }",
  scenarios: dispatcherTriageScenarios
});

"use strict";

"use strict";
const marketingResearcherScenarios = [
  {
    name: "sourced launch claim",
    input: {
      brief: "Announce the September close toolkit. Mention 2-day close only if sourced.",
      sources: [{ sourceId: "runbook-close", span: "12-40", text: "Pilot teams closed in two business days." }]
    },
    expectedOutput: {
      claims: [
        {
          text: "Pilot teams closed in two business days.",
          sourceId: "runbook-close",
          span: "12-40"
        }
      ],
      unsourced: []
    }
  }
];
const marketingDrafterScenarios = [
  {
    name: "cited launch blurb",
    input: {
      claims: [{ text: "Pilot teams closed in two business days.", sourceId: "runbook-close" }]
    },
    expectedOutput: {
      draft: "Pilot teams closed in two business days.",
      claimSourceIds: ["runbook-close"]
    }
  }
];
const marketingBrandScenarios = [
  {
    name: "banned guarantee",
    input: {
      draft: "Guaranteed 2-day close for every customer.",
      bannedClaims: ["guaranteed"]
    },
    expectedOutput: {
      allowed: false,
      reasons: ["Draft uses banned claim language: guaranteed."]
    }
  },
  {
    name: "sourced allowed copy",
    input: {
      draft: "Pilot teams closed in two business days.",
      bannedClaims: ["guaranteed"]
    },
    expectedOutput: {
      allowed: true,
      reasons: []
    }
  }
];

"use strict";
const brandGuardrailAgent = createScriptedAgent({
  id: "marketing-brand-guardrail",
  name: "Marketing brand-guardrail",
  role: "You block drafts that use banned claims, unsourced guarantees, or legal overreach.",
  rules: [
    "allowed is false if any bannedClaims term appears in the draft.",
    "Do not rewrite the draft; only report reasons.",
    "Outbound publishing always stays behind a human gate even when allowed is true."
  ],
  outputShape: "{ allowed, reasons: string[] }",
  scenarios: marketingBrandScenarios
});

"use strict";
const marketingDrafterAgent = createScriptedAgent({
  id: "marketing-drafter",
  name: "Marketing drafter",
  role: "You write a short draft using only the grounded claims.",
  rules: [
    "Do not add claims that are not in the input.",
    "Keep claimSourceIds aligned with the sentences you used.",
    "Do not publish or schedule."
  ],
  outputShape: "{ draft, claimSourceIds: string[] }",
  scenarios: marketingDrafterScenarios
});

"use strict";
const marketingResearcherAgent = createScriptedAgent({
  id: "marketing-researcher",
  name: "Marketing researcher",
  role: "You ground marketing claims in provided sources. Unsourced claims go in unsourced, never in claims.",
  rules: [
    "Every claims[] item must include sourceId and span from the input sources.",
    "Do not invent statistics, customers, or sources.",
    "If a requested claim has no source, list it in unsourced."
  ],
  outputShape: "{ claims: [{ text, sourceId, span }], unsourced: string[] }",
  scenarios: marketingResearcherScenarios
});

"use strict";

"use strict";
function bulletLines(items) {
  return items.map((item) => `- ${item}`).join("\n");
}
function structuredAgentPrompt(config) {
  const directive = config.directives.map((step, index) => `${index + 1}. ${step}`).join("\n");
  const framework = config.framework === void 0 ? "" : [
    "",
    `<${config.framework.tag}>`,
    config.framework.title,
    "Dimensions:",
    ...config.framework.dimensions.map(
      (dimension) => `- ${dimension.name}: ${dimension.guidance}`
    ),
    `</${config.framework.tag}>`
  ].join("\n");
  return [
    "<identity>",
    config.identity,
    "</identity>",
    "",
    "<primary_directive>",
    directive,
    `Quality bar: ${config.qualityBar}`,
    "</primary_directive>",
    framework,
    "",
    "<output_format>",
    `Return JSON only, matching: ${config.outputShape}`,
    ...config.outputFields.map((field) => `- ${field}`),
    "IMPORTANT:",
    ...config.conditionalRules.map((rule) => `- ${rule}`),
    "</output_format>",
    "",
    "<constraints>",
    bulletLines(config.constraints),
    "</constraints>",
    "",
    "<examples>",
    "Follow these scenario examples. Copy the expected-output shape. Do not invent keys, tickets, money, or sources.",
    formatScenarioExamples(config.scenarios),
    "</examples>",
    "",
    "<verification>",
    "Before returning, review your draft against this checklist:",
    bulletLines(config.verification),
    "</verification>"
  ].join("\n");
}

"use strict";
const programmingInvestigatorScenarios = [
  {
    name: "null check on login handler",
    input: {
      ticketKey: "ENG-12",
      problem: "Login 500 when email is missing",
      evidenceHint: "src/auth/login.ts:41 throws on undefined email"
    },
    expectedOutput: {
      summary: "login() dereferences email without a guard, causing a 500.",
      confidence: 0.86,
      evidence: [
        {
          path: "src/auth/login.ts",
          startLine: 41,
          endLine: 44,
          excerpt: "const domain = email.split('@')[1];"
        }
      ],
      fixable: true
    }
  },
  {
    name: "unfixable missing logs",
    input: {
      ticketKey: "ENG-40",
      problem: "Prod 500 with no stack or source path",
      evidenceHint: ""
    },
    expectedOutput: {
      summary: "No cited source lines are available; escalate instead of guessing a patch.",
      confidence: 0.2,
      evidence: [],
      fixable: false
    }
  }
];
const programmingActorScenarios = [
  {
    name: "guard missing email",
    input: {
      rca: "login() dereferences email without a guard",
      path: "src/auth/login.ts"
    },
    expectedOutput: {
      summary: "Return 400 when email is missing before split.",
      files: [
        {
          path: "src/auth/login.ts",
          content: "if (!email) return { status: 400 };\nconst domain = email.split('@')[1];\n",
          validators: ["basic-syntax"]
        }
      ]
    }
  }
];
const programmingValidatorScenarios = [
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
          message: "balanced syntax"
        }
      ]
    }
  }
];

"use strict";
const actorAgent = createStructuredAgent({
  id: "programming-actor",
  name: "Programming actor",
  description: "Turns a cited root-cause analysis into the smallest surgical patch that fixes it, limited to the evidence files.",
  prompt: structuredAgentPrompt({
    identity: "You are the Programming Actor for the AllRounder coding lane \u2014 a specialized AI that designs a surgical patch from a cited root-cause analysis (RCA). You patch the smallest surface that fixes the cited cause; you never widen scope.",
    directives: [
      "Read the RCA evidence and the current source at the evidence paths.",
      "Identify the minimal change that fixes the cited root cause.",
      "Write the complete new content for each patched file.",
      "Return the patch plan JSON object below and nothing else."
    ],
    qualityBar: "Your patch must be surgical, complete, and self-consistent: only files named in the RCA evidence change, the change is the smallest that fixes the cited cause, and every file ships as full replacement content, not a diff.",
    framework: {
      tag: "patch_design",
      title: "Check the patch against every dimension before finalizing:",
      dimensions: [
        {
          name: "Surgical scope",
          guidance: "Does every patched file appear in the RCA evidence? Is any change beyond the cited cause?"
        },
        {
          name: "Negative paths",
          guidance: "Does the patch add or preserve guards so the failing input is handled instead of crashing?"
        },
        {
          name: "Edge cases",
          guidance: "Does the change behave correctly at boundaries (empty input, first/last element, zero values)?"
        },
        {
          name: "Integration contracts",
          guidance: "Does the patch keep public signatures, config schemas, and data formats unchanged?"
        }
      ]
    },
    outputShape: "{ summary, files: [{ path, content, validators }] }",
    outputFields: [
      "summary \u2014 one sentence describing the fix.",
      "path \u2014 relative and normalized; exactly as named in the RCA evidence.",
      "content \u2014 the complete replacement file content, never a diff or ellipsis.",
      "validators \u2014 one or more of json, yaml, xml, basic-syntax that the content must pass."
    ],
    conditionalRules: [
      "If the RCA gives no readable evidence file, do not invent content for it.",
      "Never patch .github/workflows/** or infra/prod/**."
    ],
    constraints: [
      "Objectivity: patch only the defect named by the RCA; do not refactor or restyle code nearby.",
      "Specificity: reuse the exact paths from the evidence; never rename files.",
      "Accuracy: same RCA and source must produce the same patch; JSON only, no prose outside the object."
    ],
    verification: [
      "Is every patched file present in the RCA evidence?",
      "Is the change the smallest one that fixes the cited cause?",
      "Is each content block complete replacement content that passes its validators?",
      "Did I avoid touching denied or unrelated paths?"
    ],
    scenarios: programmingActorScenarios
  })
});

"use strict";
const investigatorAgent = createStructuredAgent({
  id: "programming-investigator",
  name: "Programming investigator",
  description: "Diagnoses coding-ticket failures into cited root-cause analyses with evidence, confidence, and fixability; never proposes patches.",
  prompt: structuredAgentPrompt({
    identity: "You are the Programming Investigator for the AllRounder coding lane \u2014 a specialized AI focused on turning a coding ticket into a cited root-cause analysis (RCA). You only diagnose repository failures; you never propose, sketch, or edit a patch.",
    directives: [
      "Read the ticket problem and any source context provided with it.",
      "Locate the exact file path and line range where the failure originates.",
      "Assess confidence from the strength of the cited evidence you can actually see.",
      "Decide whether a safe repository fix exists for the defect.",
      "Return the RCA JSON object below and nothing else."
    ],
    qualityBar: "Your analysis must be thorough, objective, and focused: every claim needs a file path with a line range, and no speculation about code you cannot see.",
    framework: {
      tag: "rca_analysis",
      title: "Walk the defect through every dimension before concluding:",
      dimensions: [
        {
          name: "Functional behavior",
          guidance: "Which code path breaks under the reported scenario, and where exactly?"
        },
        {
          name: "Edge cases",
          guidance: "Which boundary or unusual-but-valid input trips the defect?"
        },
        {
          name: "Negative paths",
          guidance: "Which missing guard or validation failure causes the crash?"
        },
        {
          name: "Integration points",
          guidance: "Which external system, API contract, or data flow is involved?"
        }
      ]
    },
    outputShape: "{ summary, confidence, evidence[], fixable }",
    outputFields: [
      "summary \u2014 one or two sentences naming the root cause; no patch proposals.",
      "confidence \u2014 a number between 0 and 1 reflecting only the cited evidence.",
      "evidence[] \u2014 { path, startLine, endLine, excerpt }: path is relative and normalized; excerpt quotes the visible source at the cited lines.",
      "fixable \u2014 true only when a safe repository fix exists."
    ],
    conditionalRules: [
      "If no file-level evidence is visible, return evidence [] with fixable false and confidence below 0.4; never guess a root cause.",
      "Never cite a file you cannot see; never invent line numbers or excerpts."
    ],
    constraints: [
      "Objectivity: base the analysis strictly on the ticket and the provided source content.",
      "Specificity: cite relative paths with exact line ranges so the finding is actionable.",
      "Accuracy: same ticket content must produce the same output; JSON only, no prose outside the object."
    ],
    verification: [
      "Have I cited a path and a line range for every claim I made?",
      "Is my confidence justified by evidence I actually see?",
      "If evidence is empty or weak, did I stay below 0.4 and set fixable false?",
      "Did I avoid proposing a patch?"
    ],
    scenarios: programmingInvestigatorScenarios
  })
});

"use strict";
const validatorAgent = createStructuredAgent({
  id: "programming-validator",
  name: "Programming validator",
  description: "Reports validator results for a bounded patch without editing it; marks pass/fail per file and validator.",
  prompt: structuredAgentPrompt({
    identity: "You are the Programming Validator for the AllRounder coding lane \u2014 a specialized AI that reports whether a bounded patch passes its own validators. You report results; you never edit the patch.",
    directives: [
      "Read the patch files and the validator names declared on each file.",
      "Run every declared validator over the file content.",
      "Mark passed false if any validator fails.",
      "Return the validation report JSON object below and nothing else."
    ],
    qualityBar: "Your report must be strict and mechanical: the verdict follows from the syntax checks alone, each result names its validator and path, and the report never rewrites or suggests patch content.",
    framework: {
      tag: "validation_scope",
      title: "Evaluate the patch against every validator dimension:",
      dimensions: [
        {
          name: "json",
          guidance: "Is the content parseable JSON with balanced structure and no trailing commas?"
        },
        {
          name: "yaml",
          guidance: "Is the content parseable YAML with consistent indentation and no tabs?"
        },
        {
          name: "xml",
          guidance: "Is the content well-formed XML with every tag closed and properly nested?"
        },
        {
          name: "basic-syntax",
          guidance: "Are brackets, braces, parens, and quotes balanced with no stray terminators?"
        }
      ]
    },
    outputShape: "{ passed, attempts, results[] }",
    outputFields: [
      "passed \u2014 false if any validator result failed.",
      "attempts \u2014 1 for the original patch, 2 after a single repair already ran.",
      "results[] \u2014 { validator, path, passed, message }: one entry per file/validator pair with a concrete message."
    ],
    conditionalRules: [
      "Do not invent CI status: omit ciStatus unless a check was actually read.",
      "If the patch declares no validators, report a failed result with an explanatory message."
    ],
    constraints: [
      "Objectivity: judge the content only, never the intent of the change.",
      "Specificity: each result names the validator, path, and the exact failure.",
      "Accuracy: same content and validators must produce the same report; JSON only, no prose outside the object."
    ],
    verification: [
      "Did I run every declared validator on every file?",
      "Is attempts correct (1 or 2)?",
      "Did I omit ciStatus instead of guessing a CI state?",
      "Did I avoid editing or rewriting the patch?"
    ],
    scenarios: programmingValidatorScenarios
  })
});

"use strict";

"use strict";
const supportResearcherScenarios = [
  {
    name: "refund FAQ hit",
    input: {
      query: "How long do refunds take?",
      passages: [
        {
          sourceId: "kb-refunds",
          span: "0-80",
          content: "Refunds post in 5-7 business days after approval.",
          stale: false
        }
      ]
    },
    expectedOutput: {
      citations: [{ sourceId: "kb-refunds", span: "0-80" }],
      empty: false,
      stale: false
    }
  },
  {
    name: "empty retrieval",
    input: { query: "What is the CEO's personal cell number?", passages: [] },
    expectedOutput: {
      citations: [],
      empty: true,
      stale: false
    }
  }
];
const supportDrafterScenarios = [
  {
    name: "cited refund reply",
    input: {
      query: "How long do refunds take?",
      citations: [{ sourceId: "kb-refunds", span: "0-80" }],
      passage: "Refunds post in 5-7 business days after approval."
    },
    expectedOutput: {
      draft: "Refunds post in 5-7 business days after approval.",
      citations: [{ sourceId: "kb-refunds", span: "0-80" }]
    }
  }
];

"use strict";
const supportDrafterAgent = createScriptedAgent({
  id: "support-drafter",
  name: "Support drafter",
  role: "You draft a support reply that only uses cited passages.",
  rules: [
    "Every factual sentence must map to a citation already in the input.",
    "Do not send the reply; wait for an approval receipt.",
    "If citations are empty, do not draft a product claim."
  ],
  outputShape: "{ draft, citations: [{ sourceId, span }] }",
  scenarios: supportDrafterScenarios
});

"use strict";
const supportResearcherAgent = createScriptedAgent({
  id: "support-researcher",
  name: "Support researcher",
  role: "You select cited passages for a support question. You do not draft the customer reply.",
  rules: [
    "If passages is empty, empty is true and citations is [].",
    "If every passage is stale, stale is true and the case must escalate.",
    "Never invent a sourceId."
  ],
  outputShape: "{ citations: [{ sourceId, span }], empty, stale }",
  scenarios: supportResearcherScenarios
});

"use strict";

"use strict";
function allRounderAgents() {
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
    supportDrafter: supportDrafterAgent
  };
}

"use strict";
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const CentsSchema = z.number().int();
const LedgerLineSchema = z.object({
  account: z.string().min(1).max(32),
  amountCents: CentsSchema,
  currency: CurrencySchema,
  externalRef: z.string().min(1).max(80)
}).strict();
const FinanceWorkflowInputSchema = z.object({
  caseId: z.string().min(1),
  tenantId: z.string().min(1),
  ticketKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  ledger: z.array(LedgerLineSchema).min(1).max(1e4),
  bank: z.array(LedgerLineSchema).min(1).max(1e4)
}).strict();
const ExceptionTypeSchema = z.enum([
  "amount_mismatch",
  "unmatched_ledger",
  "unmatched_bank"
]);
const FinanceExceptionSchema = z.object({
  type: ExceptionTypeSchema,
  account: z.string().min(1),
  currency: CurrencySchema,
  externalRef: z.string().min(1),
  ledgerCents: z.number().int().nullable(),
  bankCents: z.number().int().nullable(),
  deltaCents: z.number().int()
}).strict();
const SpecialistFindingSchema = z.object({
  specialist: z.enum(["gl", "treasury", "tax"]),
  exceptionRef: z.string().min(1),
  summary: z.string().min(1).max(2e3)
}).strict();
const AuditCheckSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().min(1).max(2e3)
}).strict();
const AuditPackSchema = z.object({
  period: z.string(),
  balanced: z.boolean(),
  exceptionCount: z.number().int().nonnegative(),
  checks: z.array(AuditCheckSchema).min(1),
  findings: z.array(SpecialistFindingSchema)
}).strict();
const JournalLineSchema = z.object({
  account: z.string().min(1).max(32),
  amountCents: CentsSchema,
  currency: CurrencySchema,
  memo: z.string().min(1).max(500)
}).strict();
const PostingInstructionSchema = z.object({
  ledger: z.literal("sandbox"),
  period: z.string(),
  lines: z.array(JournalLineSchema).min(1).max(100)
}).strict();
const FinanceWorkflowOutputSchema = z.object({
  caseId: z.string(),
  ticketKey: z.string(),
  status: z.enum(["awaiting_approval", "posted", "escalated"]),
  exceptions: z.array(FinanceExceptionSchema),
  auditPack: AuditPackSchema,
  posting: PostingInstructionSchema.optional(),
  reason: z.string().optional(),
  evidence: z.array(z.string())
}).strict();

"use strict";
const FINANCE_FLOW_STEPS = [
  "load-context",
  "reconcile",
  "detect-exceptions",
  "rca",
  "specialist-fanout",
  "merge",
  "audit",
  "approval",
  "sandbox-post"
];
class FinanceWorkflow {
  constructor(approvals, ledger) {
    this.approvals = approvals;
    this.ledger = ledger;
  }
  approvals;
  ledger;
  steps = FINANCE_FLOW_STEPS.map((id) => ({ id }));
  async run(raw) {
    const input = FinanceWorkflowInputSchema.parse(raw);
    const exceptions = reconcile(input.ledger, input.bank);
    const findings = exceptions.flatMap(specialistFindings);
    const posting = proposePosting(input.period, exceptions);
    const auditPack = audit(input.period, exceptions, findings, posting);
    if (!auditPack.checks.every((check) => check.passed)) {
      return FinanceWorkflowOutputSchema.parse({
        caseId: input.caseId,
        ticketKey: input.ticketKey,
        status: "escalated",
        exceptions,
        auditPack,
        reason: "audit_failed",
        evidence: ["escalation:audit_failed"]
      });
    }
    if (posting === void 0) {
      return FinanceWorkflowOutputSchema.parse({
        caseId: input.caseId,
        ticketKey: input.ticketKey,
        status: "awaiting_approval",
        exceptions,
        auditPack,
        reason: "balanced_close_requires_review",
        evidence: ["recon:balanced"]
      });
    }
    const actionHash = createHash("sha256").update(JSON.stringify(posting)).digest("hex");
    const decision = await this.approvals.suspend({
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      actionHash,
      posting
    });
    if (decision.decision !== "approved" || decision.receipt.length === 0) {
      return FinanceWorkflowOutputSchema.parse({
        caseId: input.caseId,
        ticketKey: input.ticketKey,
        status: "escalated",
        exceptions,
        auditPack,
        posting,
        reason: `approval_${decision.decision}`,
        evidence: [`escalation:approval_${decision.decision}`]
      });
    }
    const posted = await this.ledger.post({
      idempotencyKey: actionHash,
      approvalReceipt: decision.receipt,
      posting
    });
    return FinanceWorkflowOutputSchema.parse({
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      status: "posted",
      exceptions,
      auditPack,
      posting,
      evidence: [`approval:${actionHash}`, posted.artifact]
    });
  }
}
function reconcile(ledger, bank) {
  const keys = /* @__PURE__ */ new Set([
    ...ledger.map(lineKey),
    ...bank.map(lineKey)
  ]);
  const exceptions = [];
  for (const key of [...keys].sort()) {
    const left = sumCents(ledger.filter((line) => lineKey(line) === key));
    const right = sumCents(bank.filter((line) => lineKey(line) === key));
    const sample = ledger.find((line) => lineKey(line) === key) ?? bank.find((line) => lineKey(line) === key);
    if (sample === void 0 || left === right) continue;
    const type = left === null ? "unmatched_bank" : right === null ? "unmatched_ledger" : "amount_mismatch";
    exceptions.push(
      FinanceExceptionSchema.parse({
        type,
        account: sample.account,
        currency: sample.currency,
        externalRef: sample.externalRef,
        ledgerCents: left,
        bankCents: right,
        deltaCents: (right ?? 0) - (left ?? 0)
      })
    );
  }
  return exceptions;
}
function rca(exception) {
  if (exception.type === "unmatched_bank") {
    return {
      exceptionRef: exception.externalRef,
      cause: `Bank ${exception.externalRef} has no ledger match.`
    };
  }
  if (exception.type === "unmatched_ledger") {
    return {
      exceptionRef: exception.externalRef,
      cause: `Ledger ${exception.externalRef} has no bank match.`
    };
  }
  return {
    exceptionRef: exception.externalRef,
    cause: `Amount mismatch of ${exception.deltaCents} cents on ${exception.externalRef}.`
  };
}
function specialistFindings(exception) {
  if (exception.type === "unmatched_bank") {
    return [
      {
        specialist: "treasury",
        exceptionRef: exception.externalRef,
        summary: `Bank ${exception.externalRef} has no ledger match; check cutoff and deposits in transit.`
      }
    ];
  }
  if (exception.type === "unmatched_ledger") {
    return [
      {
        specialist: "gl",
        exceptionRef: exception.externalRef,
        summary: `Ledger ${exception.externalRef} has no bank match; review unpresented items.`
      }
    ];
  }
  return [
    {
      specialist: "gl",
      exceptionRef: exception.externalRef,
      summary: `Amount mismatch of ${exception.deltaCents} cents on ${exception.externalRef}.`
    },
    {
      specialist: "tax",
      exceptionRef: exception.externalRef,
      summary: `Confirm tax timing is not the ${exception.deltaCents} cent variance on ${exception.externalRef}.`
    }
  ];
}
function proposePosting(period, exceptions) {
  const lines = exceptions.flatMap((exception) => {
    if (exception.deltaCents === 0) return [];
    return [
      {
        account: exception.account,
        amountCents: exception.deltaCents,
        currency: exception.currency,
        memo: `Adjust ${exception.externalRef} (${exception.type})`
      }
    ];
  });
  if (lines.length === 0) return void 0;
  return PostingInstructionSchema.parse({ ledger: "sandbox", period, lines });
}
function audit(period, exceptions, findings, posting) {
  const refs = new Set(exceptions.map((item) => item.externalRef));
  const covered = findings.every((finding) => refs.has(finding.exceptionRef));
  const integerCents = exceptions.every((item) => Number.isInteger(item.deltaCents));
  const sandboxOnly = posting === void 0 || posting.ledger === "sandbox";
  return AuditPackSchema.parse({
    period,
    balanced: exceptions.length === 0,
    exceptionCount: exceptions.length,
    findings,
    checks: [
      {
        id: "exceptions-have-rca",
        passed: covered && findings.length >= exceptions.length,
        detail: "Every exception has at least one specialist finding."
      },
      {
        id: "integer-money",
        passed: integerCents,
        detail: "All money values are integer cents."
      },
      {
        id: "sandbox-ledger-only",
        passed: sandboxOnly,
        detail: "Posting adapters stay on the sandbox ledger until a later production unlock."
      }
    ]
  });
}
function lineKey(line) {
  return `${line.account}|${line.currency}|${line.externalRef}`;
}
function sumCents(lines) {
  if (lines.length === 0) return null;
  return lines.reduce((total, line) => total + line.amountCents, 0);
}
class FakeFinanceApprovalGate {
  constructor(decision) {
    this.decision = decision;
  }
  decision;
  suspended = [];
  async suspend(payload) {
    this.suspended.push({ actionHash: payload.actionHash, posting: payload.posting });
    return this.decision === "approved" ? { decision: "approved", receipt: `fake:${payload.actionHash}` } : { decision: this.decision };
  }
}
class MemorySandboxLedger {
  posted = [];
  receipts = /* @__PURE__ */ new Map();
  async post(input) {
    if (input.approvalReceipt.length === 0) throw new Error("Approval receipt required");
    const prior = this.receipts.get(input.idempotencyKey);
    if (prior !== void 0) return prior;
    this.posted.push(input.posting);
    const receipt = { artifact: `sandbox-post:${input.idempotencyKey}` };
    this.receipts.set(input.idempotencyKey, receipt);
    return receipt;
  }
}

"use strict";
const RcaNoteSchema = z.object({
  exceptionRef: z.string().min(1),
  cause: z.string().min(1).max(2e3)
}).strict();
const FinanceRunStateSchema = z.object({
  context: FinanceWorkflowInputSchema,
  exceptions: z.array(FinanceExceptionSchema),
  rca: z.array(RcaNoteSchema),
  findings: z.array(SpecialistFindingSchema),
  posting: PostingInstructionSchema.optional(),
  auditPack: AuditPackSchema.optional(),
  actionHash: z.string().optional(),
  halt: z.enum(["none", "audit_failed", "balanced_close"]),
  approvalDecision: z.enum(["approved", "rejected", "expired"]).optional(),
  approvalReceipt: z.string().min(1).optional()
}).strict();
const ApprovalResumeSchema = z.object({
  decision: z.enum(["approved", "rejected", "expired"]),
  receipt: z.string().min(1).optional()
}).strict();
const ApprovalSuspendSchema = z.object({
  caseId: z.string().min(1),
  ticketKey: z.string().min(1),
  actionHash: z.string().min(1),
  posting: PostingInstructionSchema
}).strict();
function emptyState(context) {
  return {
    context,
    exceptions: [],
    rca: [],
    findings: [],
    halt: "none"
  };
}
function postingHash(posting) {
  return createHash("sha256").update(JSON.stringify(posting)).digest("hex");
}
function finalize(state, status, evidence, reason) {
  const auditPack = state.auditPack;
  if (auditPack === void 0) {
    throw new Error("Audit pack is required before close");
  }
  const output = {
    caseId: state.context.caseId,
    ticketKey: state.context.ticketKey,
    status,
    exceptions: state.exceptions,
    auditPack,
    evidence
  };
  if (state.posting !== void 0) output.posting = state.posting;
  if (reason !== void 0) output.reason = reason;
  return FinanceWorkflowOutputSchema.parse(output);
}
function createFinanceFlow(deps) {
  const loadContext = createStep({
    id: FINANCE_FLOW_STEPS[0],
    inputSchema: FinanceWorkflowInputSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => emptyState(FinanceWorkflowInputSchema.parse(inputData))
  });
  const reconcileStep = createStep({
    id: FINANCE_FLOW_STEPS[1],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => ({
      ...inputData,
      exceptions: reconcile(inputData.context.ledger, inputData.context.bank)
    })
  });
  const detectExceptions = createStep({
    id: FINANCE_FLOW_STEPS[2],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => inputData
  });
  const rcaStep = createStep({
    id: FINANCE_FLOW_STEPS[3],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => ({
      ...inputData,
      rca: inputData.exceptions.map(rca)
    })
  });
  const specialistFanout = createStep({
    id: FINANCE_FLOW_STEPS[4],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => ({
      ...inputData,
      findings: inputData.exceptions.flatMap(specialistFindings)
    })
  });
  const merge = createStep({
    id: FINANCE_FLOW_STEPS[5],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => inputData
  });
  const auditStep = createStep({
    id: FINANCE_FLOW_STEPS[6],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => {
      const posting = proposePosting(inputData.context.period, inputData.exceptions);
      const auditPack = audit(
        inputData.context.period,
        inputData.exceptions,
        inputData.findings,
        posting
      );
      const next = {
        ...inputData,
        auditPack,
        halt: !auditPack.checks.every((check) => check.passed) ? "audit_failed" : posting === void 0 ? "balanced_close" : "none"
      };
      if (posting !== void 0) {
        next.posting = posting;
        next.actionHash = postingHash(posting);
      }
      return next;
    }
  });
  const approval = createStep({
    id: FINANCE_FLOW_STEPS[7],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    resumeSchema: ApprovalResumeSchema,
    suspendSchema: ApprovalSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.halt !== "none") return inputData;
      const posting = inputData.posting;
      const actionHash = inputData.actionHash;
      if (posting === void 0 || actionHash === void 0) {
        return { ...inputData, halt: "balanced_close" };
      }
      if (resumeData === void 0) {
        return await suspend({
          caseId: inputData.context.caseId,
          ticketKey: inputData.context.ticketKey,
          actionHash,
          posting
        });
      }
      if (resumeData.decision !== "approved" || resumeData.receipt === void 0) {
        const next = {
          ...inputData,
          approvalDecision: resumeData.decision === "approved" ? "rejected" : resumeData.decision
        };
        return next;
      }
      return {
        ...inputData,
        approvalDecision: "approved",
        approvalReceipt: resumeData.receipt
      };
    }
  });
  const sandboxPost = createStep({
    id: FINANCE_FLOW_STEPS[8],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceWorkflowOutputSchema,
    execute: async ({ inputData }) => {
      if (inputData.halt === "audit_failed") {
        return finalize(inputData, "escalated", ["escalation:audit_failed"], "audit_failed");
      }
      if (inputData.halt === "balanced_close") {
        return finalize(
          inputData,
          "awaiting_approval",
          ["recon:balanced"],
          "balanced_close_requires_review"
        );
      }
      if (inputData.approvalDecision !== "approved" || inputData.approvalReceipt === void 0 || inputData.posting === void 0 || inputData.actionHash === void 0) {
        const decision = inputData.approvalDecision ?? "rejected";
        return finalize(
          inputData,
          "escalated",
          [`escalation:approval_${decision}`],
          `approval_${decision}`
        );
      }
      const posted = await deps.ledger.post({
        idempotencyKey: inputData.actionHash,
        approvalReceipt: inputData.approvalReceipt,
        posting: inputData.posting
      });
      return finalize(inputData, "posted", [`approval:${inputData.actionHash}`, posted.artifact]);
    }
  });
  return createWorkflow({
    id: "financeFlow",
    inputSchema: FinanceWorkflowInputSchema,
    outputSchema: FinanceWorkflowOutputSchema,
    options: {
      validateInputs: true
    }
  }).then(loadContext).then(reconcileStep).then(detectExceptions).then(rcaStep).then(specialistFanout).then(merge).then(auditStep).then(approval).then(sandboxPost).commit();
}

"use strict";
const ShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const RepositoryPathSchema = z.string().min(1).max(500).refine(
  (value) => {
    const segments = value.split("/");
    return !value.startsWith("/") && !value.includes("\\") && !/[?#%\u0000-\u001f\u007f]/.test(value) && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  },
  { message: "Repository path must be relative and normalized" }
);
const RcaEvidenceSchema = z.object({
  path: RepositoryPathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string().min(1).max(4e3)
}).strict().refine((value) => value.endLine >= value.startLine, "Invalid evidence line range");
const RootCauseAnalysisSchema = z.object({
  summary: z.string().min(1).max(4e3),
  confidence: z.number().min(0).max(1),
  evidence: z.array(RcaEvidenceSchema).max(20),
  fixable: z.boolean()
}).strict();
const PatchFileSchema = z.object({
  path: RepositoryPathSchema,
  content: z.string().max(1e6),
  validators: z.array(z.enum(["json", "yaml", "xml", "basic-syntax"])).min(1).max(4)
}).strict();
const PatchPlanSchema = z.object({
  summary: z.string().min(1).max(2e3),
  files: z.array(PatchFileSchema).min(1).max(50)
}).strict();
const ValidatorResultSchema = z.object({
  validator: z.string().min(1),
  path: RepositoryPathSchema,
  passed: z.boolean(),
  message: z.string().min(1).max(2e3)
}).strict();
const ValidationReportSchema = z.object({
  passed: z.boolean(),
  attempts: z.number().int().min(1).max(2),
  results: z.array(ValidatorResultSchema),
  ciStatus: z.enum(["pending", "success", "failure", "neutral"]).optional()
}).strict();
const PullRequestReceiptSchema = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  draft: z.literal(true),
  branch: z.string().min(1).max(250),
  baseBranch: z.string().min(1).max(250),
  sourceSha: ShaSchema,
  commitSha: ShaSchema,
  patchHash: z.string().regex(/^[a-f0-9]{64}$/),
  replayed: z.boolean()
}).strict();
const EscalationSchema = z.object({
  reason: z.enum([
    "insufficient_evidence",
    "unfixable",
    "path_denied",
    "approval_required",
    "approval_rejected",
    "stale_source",
    "validation_failed_after_repair",
    "ci_failed"
  ]),
  diagnosisOnly: z.boolean(),
  detail: z.string().min(1).max(2e3)
}).strict();
const PreviewManifestSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().min(1),
  sourceSha: ShaSchema,
  branch: z.string().min(1),
  patchHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(
    z.object({
      path: RepositoryPathSchema,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
      validators: z.array(z.string().min(1))
    }).strict()
  ),
  risk: z.enum(["low", "medium", "high"]),
  evidence: z.array(RcaEvidenceSchema).min(1)
}).strict();
const printableAscii = /^[\x20-\x7e]+$/;
const CodingWorkflowInputSchema = z.object({
  runId: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  ticketKey: z.string().regex(printableAscii).max(250),
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100),
  baseBranch: z.string().min(1).max(250),
  sourceSha: ShaSchema,
  branch: z.string().regex(printableAscii).max(250),
  problem: z.string().min(1).max(4e3),
  approvedDestructivePaths: z.array(z.string().max(500)).default([])
}).strict();
const CodingWorkflowOutputSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["draft_pr_opened", "awaiting_ci", "escalated"]),
  rca: RootCauseAnalysisSchema,
  validation: ValidationReportSchema,
  manifest: PreviewManifestSchema.optional(),
  pr: PullRequestReceiptSchema.optional(),
  escalation: EscalationSchema.optional()
}).strict();

"use strict";
class RepositoryPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RepositoryPolicyError";
  }
  code;
}
class StaleSourceError extends Error {
  constructor() {
    super("Expected source SHA no longer matches base branch");
    this.name = "StaleSourceError";
  }
}
class FetchGitHubTransport {
  constructor(token, baseUrl = "https://api.github.com") {
    this.token = token;
    this.baseUrl = baseUrl;
    if (token.length < 1) throw new Error("GitHub token is required");
  }
  token;
  baseUrl;
  async request(method, path, body, timeoutMs = 1e4) {
    const request = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(timeoutMs),
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    };
    const response = await fetch(`${this.baseUrl}${path}`, request);
    const responseBody = await response.json().catch(() => ({}));
    return { status: response.status, body: responseBody };
  }
}
function globMatches(path, glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}
function isSafeBranchName(value) {
  const segments = value.split("/");
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/.test(value) && !value.includes("..") && !value.endsWith(".") && segments.every((segment) => segment.length > 0 && !segment.endsWith(".lock"));
}
function bodyObject(response) {
  if (response.status < 200 || response.status >= 300 || typeof response.body !== "object" || response.body === null || Array.isArray(response.body)) {
    throw new Error(`GitHub request failed (${response.status})`);
  }
  return response.body;
}
function aggregateCheckRuns(runs) {
  if (runs.some((run) => typeof run === "object" && run !== null && "conclusion" in run && run.conclusion === "failure")) return "failure";
  if (runs.some((run) => typeof run === "object" && run !== null && "status" in run && run.status !== "completed")) return "pending";
  return "success";
}
function computePatchHash(files) {
  const fileManifest = files.map((file) => ({
    path: file.path,
    sha256: createHash("sha256").update(file.content).digest("hex"),
    bytes: Buffer.byteLength(file.content),
    validators: file.validators
  }));
  return createHash("sha256").update(JSON.stringify(fileManifest)).digest("hex");
}
class GitHubSourceReader {
  constructor(backend, policy) {
    this.backend = backend;
    this.policy = policy;
  }
  backend;
  policy;
  assertRepository(owner, repo, baseBranch) {
    if (!this.policy.repositories.includes(`${owner}/${repo}`)) {
      throw new RepositoryPolicyError("repository_denied", "Repository not allowed");
    }
    if (baseBranch !== this.policy.baseBranch) {
      throw new RepositoryPolicyError("repository_denied", "Base branch not allowed");
    }
  }
  assertPath(path) {
    if (this.policy.denyPaths.some((glob) => globMatches(path, glob)) || !this.policy.allowPaths.some((glob) => globMatches(path, glob))) {
      throw new RepositoryPolicyError("path_denied", `Path denied: ${path}`);
    }
  }
  isDestructive(path) {
    return this.policy.destructivePaths.some((glob) => globMatches(path, glob));
  }
  async sourceSha(owner, repo, baseBranch) {
    this.assertRepository(owner, repo, baseBranch);
    return this.backend.headSha(owner, repo, baseBranch);
  }
  async content(owner, repo, path, sourceSha) {
    this.assertRepository(owner, repo, this.policy.baseBranch);
    this.assertPath(path);
    return this.backend.fileContent(owner, repo, path, sourceSha);
  }
}
class GitHubWriter {
  constructor(backend, policy, reader) {
    this.backend = backend;
    this.policy = policy;
    this.reader = reader;
  }
  backend;
  policy;
  reader;
  receipts = /* @__PURE__ */ new Map();
  preflight(owner, repo, baseBranch, branch, sourceSha, files, evidence, approvedDestructivePaths) {
    this.reader.assertRepository(owner, repo, baseBranch);
    if (!isSafeBranchName(branch)) {
      throw new RepositoryPolicyError("path_denied", "Branch name is not a safe Git reference");
    }
    const uniquePaths = new Set(files.map((file) => file.path));
    const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    if (files.length > this.policy.maxFiles || uniquePaths.size !== files.length || bytes > this.policy.maxPatchBytes) {
      throw new RepositoryPolicyError("limits_exceeded", "Patch limits exceeded");
    }
    for (const file of files) {
      this.reader.assertPath(file.path);
      if (this.reader.isDestructive(file.path) && !approvedDestructivePaths.includes(file.path)) {
        throw new RepositoryPolicyError("approval_required", `Approval required: ${file.path}`);
      }
    }
    const fileManifest = files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
      bytes: Buffer.byteLength(file.content),
      validators: file.validators
    }));
    const patchHash = computePatchHash(files);
    return {
      repository: `${owner}/${repo}`,
      baseBranch,
      sourceSha,
      branch,
      patchHash,
      files: fileManifest,
      risk: files.some((file) => this.reader.isDestructive(file.path)) ? "high" : "low",
      evidence
    };
  }
  async apply(manifest, files, title, body) {
    const [owner, repo] = manifest.repository.split("/");
    if (owner === void 0 || repo === void 0) throw new Error("Invalid repository");
    const key = `${manifest.repository}:${manifest.branch}:${manifest.patchHash}`;
    const prior = this.receipts.get(key);
    if (prior !== void 0) return PullRequestReceiptSchema.parse({ ...prior, replayed: true });
    const durableReplay = await this.findDurableReplay(owner, repo, manifest);
    if (durableReplay !== void 0) {
      this.receipts.set(key, durableReplay);
      return durableReplay;
    }
    const actualSha = await this.reader.sourceSha(owner, repo, manifest.baseBranch);
    if (actualSha !== manifest.sourceSha) throw new StaleSourceError();
    const { commitSha } = await this.backend.commitFiles(
      owner,
      repo,
      manifest.branch,
      title,
      manifest.sourceSha,
      files
    );
    const pull = await this.backend.openDraftPull(
      owner,
      repo,
      manifest.branch,
      manifest.baseBranch,
      title,
      body
    );
    const receipt = PullRequestReceiptSchema.parse({
      url: pull.url,
      number: pull.number,
      draft: true,
      branch: manifest.branch,
      baseBranch: manifest.baseBranch,
      sourceSha: manifest.sourceSha,
      commitSha,
      patchHash: manifest.patchHash,
      replayed: false
    });
    this.receipts.set(key, receipt);
    return receipt;
  }
  async findDurableReplay(owner, repo, manifest) {
    const branchSha = await this.backend.branchHead(owner, repo, manifest.branch);
    if (branchSha === void 0) return void 0;
    const pulls = await this.backend.listOpenPulls(owner, repo, manifest.branch);
    const matching = pulls.find((value) => value.draft && value.body.includes(`Patch hash: ${manifest.patchHash}`));
    if (matching === void 0) {
      throw new Error("Branch already exists without a matching idempotent Draft PR");
    }
    return PullRequestReceiptSchema.parse({
      url: matching.url,
      number: matching.number,
      draft: true,
      branch: manifest.branch,
      baseBranch: manifest.baseBranch,
      sourceSha: manifest.sourceSha,
      commitSha: branchSha,
      patchHash: manifest.patchHash,
      replayed: true
    });
  }
  async checks(owner, repo, commitSha) {
    this.reader.assertRepository(owner, repo, this.policy.baseBranch);
    const receipt = [...this.receipts.values()].find((value) => value.commitSha === commitSha);
    return this.backend.checkRuns(owner, repo, commitSha, receipt?.number);
  }
}
class RestGitHubBackend {
  constructor(transport, policy) {
    this.transport = transport;
    this.policy = policy;
  }
  transport;
  policy;
  async headSha(owner, repo, branch) {
    const response = bodyObject(await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      void 0,
      this.policy.timeoutMs
    ));
    const object = response.object;
    if (typeof object !== "object" || object === null || !("sha" in object) || typeof object.sha !== "string") throw new Error("Malformed GitHub ref response");
    return object.sha;
  }
  async branchHead(owner, repo, branch) {
    const response = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      void 0,
      this.policy.timeoutMs
    );
    if (response.status === 404) return void 0;
    const parsed = bodyObject(response);
    const object = parsed.object;
    if (typeof object !== "object" || object === null || !("sha" in object) || typeof object.sha !== "string") throw new Error("Malformed GitHub branch response");
    return object.sha;
  }
  async fileContent(owner, repo, path, refSha) {
    const response = bodyObject(await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(refSha)}`,
      void 0,
      this.policy.timeoutMs
    ));
    if (typeof response.content !== "string" || typeof response.sha !== "string") {
      throw new Error("Malformed GitHub contents response");
    }
    return {
      content: Buffer.from(response.content.replace(/\s/g, ""), "base64").toString("utf8"),
      sha: response.sha
    };
  }
  async commitFiles(owner, repo, branch, message, baseSha, files) {
    const commit = bodyObject(await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/git/commits/${baseSha}`,
      void 0,
      this.policy.timeoutMs
    ));
    const tree = commit.tree;
    if (typeof tree !== "object" || tree === null || !("sha" in tree) || typeof tree.sha !== "string") throw new Error("Malformed GitHub commit response");
    const treeEntries = [];
    for (const file of files) {
      const blob = bodyObject(await this.transport.request(
        "POST",
        `/repos/${owner}/${repo}/git/blobs`,
        { content: file.content, encoding: "utf-8" },
        this.policy.timeoutMs
      ));
      if (typeof blob.sha !== "string") throw new Error("Malformed GitHub blob response");
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = bodyObject(await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/git/trees`,
      { base_tree: tree.sha, tree: treeEntries },
      this.policy.timeoutMs
    ));
    const createdCommit = bodyObject(await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/git/commits`,
      { message, tree: newTree.sha, parents: [baseSha] },
      this.policy.timeoutMs
    ));
    if (typeof createdCommit.sha !== "string") throw new Error("Malformed commit response");
    bodyObject(await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/git/refs`,
      { ref: `refs/heads/${branch}`, sha: createdCommit.sha },
      this.policy.timeoutMs
    ));
    return { commitSha: createdCommit.sha };
  }
  async openDraftPull(owner, repo, branch, baseBranch, title, body) {
    const pull = bodyObject(await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      { title, head: branch, base: baseBranch, body, draft: true },
      this.policy.timeoutMs
    ));
    if (typeof pull.html_url !== "string" || typeof pull.number !== "number") {
      throw new Error("Malformed pull request response");
    }
    return { number: pull.number, url: pull.html_url };
  }
  async listOpenPulls(owner, repo, branch) {
    const pulls = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
      void 0,
      this.policy.timeoutMs
    );
    if (pulls.status < 200 || pulls.status >= 300 || !Array.isArray(pulls.body)) {
      throw new Error(`GitHub request failed (${pulls.status})`);
    }
    return pulls.body.map((value) => {
      if (typeof value !== "object" || value === null || !("number" in value) || typeof value.number !== "number" || !("html_url" in value) || typeof value.html_url !== "string" || !("body" in value) || typeof value.body !== "string" || !("draft" in value) || typeof value.draft !== "boolean") {
        throw new Error("Malformed pull request list response");
      }
      return {
        number: value.number,
        url: value.html_url,
        body: value.body,
        draft: value.draft
      };
    });
  }
  async checkRuns(owner, repo, commitSha, _pullNumber) {
    const response = bodyObject(await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/commits/${commitSha}/check-runs`,
      void 0,
      this.policy.timeoutMs
    ));
    const runs = Array.isArray(response.check_runs) ? response.check_runs : [];
    return aggregateCheckRuns(runs);
  }
}
class GitHubRepositoryTools {
  reader;
  writer;
  constructor(backendOrTransport, policy) {
    const backend = "headSha" in backendOrTransport ? backendOrTransport : new RestGitHubBackend(backendOrTransport, policy);
    this.reader = new GitHubSourceReader(backend, policy);
    this.writer = new GitHubWriter(backend, policy, this.reader);
  }
}
class FakeGitHubTransport {
  sourceSha;
  checks;
  treeSha;
  commitSha;
  writeCalls = 0;
  commitCreates = 0;
  pullRequests = [];
  logs = [];
  branchSha;
  constructor(config) {
    this.sourceSha = config.sourceSha;
    this.treeSha = config.treeSha;
    this.commitSha = config.commitSha;
    this.checks = config.checks;
  }
  async request(method, path, body) {
    this.logs.push(`${method} ${path}`);
    if (method === "POST") this.writeCalls += 1;
    if (path.endsWith("/git/ref/heads/main")) {
      return { status: 200, body: { object: { sha: this.sourceSha } } };
    }
    if (path.includes("/git/ref/heads/")) {
      return this.branchSha === void 0 ? { status: 404, body: {} } : { status: 200, body: { object: { sha: this.branchSha } } };
    }
    if (/\/git\/commits\/[a-f0-9]+$/.test(path) && method === "GET") {
      return { status: 200, body: { tree: { sha: this.treeSha } } };
    }
    if (path.endsWith("/git/blobs")) return { status: 201, body: { sha: "e".repeat(40) } };
    if (path.endsWith("/git/trees")) return { status: 201, body: { sha: "f".repeat(40) } };
    if (path.endsWith("/git/commits") && method === "POST") {
      this.commitCreates += 1;
      return { status: 201, body: { sha: this.commitSha } };
    }
    if (path.endsWith("/git/refs")) {
      const value = body;
      this.branchSha = value.sha;
      return { status: 201, body: { ref: "created" } };
    }
    if (path.includes("/pulls?")) {
      return {
        status: 200,
        body: this.pullRequests.map((pull, index) => ({
          ...pull,
          html_url: `https://github.example/acme/widget/pull/${index + 1}`,
          number: index + 1
        }))
      };
    }
    if (path.endsWith("/pulls")) {
      const value = body;
      this.pullRequests.push(value);
      return {
        status: 201,
        body: { html_url: "https://github.example/acme/widget/pull/1", number: 1 }
      };
    }
    if (path.endsWith("/check-runs")) {
      const check = this.checks === "failure" ? { status: "completed", conclusion: "failure" } : this.checks === "pending" ? { status: "in_progress", conclusion: null } : { status: "completed", conclusion: "success" };
      return { status: 200, body: { check_runs: [check] } };
    }
    if (path.includes("/contents/")) {
      return { status: 200, body: { content: Buffer.from("fixture").toString("base64"), sha: "1".repeat(40) } };
    }
    return { status: 404, body: {} };
  }
}

"use strict";
function balanced(content, pairs) {
  const closing = new Set(Object.values(pairs));
  const stack = [];
  let quote;
  let escaped = false;
  for (const character of content) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== void 0) {
      escaped = true;
      continue;
    }
    if (quote !== void 0) {
      if (character === quote) quote = void 0;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (pairs[character] !== void 0) {
      stack.push(pairs[character]);
    } else if (closing.has(character) && stack.pop() !== character) {
      return `Unexpected closing delimiter ${character}`;
    }
  }
  if (quote !== void 0) return "Unclosed string literal";
  if (stack.length > 0) return `Missing closing delimiter ${stack.at(-1) ?? ""}`;
  return void 0;
}
const validators = {
  json: (content) => {
    try {
      JSON.parse(content);
      return void 0;
    } catch {
      return "Invalid JSON";
    }
  },
  yaml: (content) => {
    if (content.includes("	")) return "YAML tabs are not allowed";
    const invalid = content.split(/\r?\n/).find((line) => line.trim() !== "" && !line.trimStart().startsWith("#") && !line.trimStart().startsWith("-") && !line.includes(":"));
    return invalid === void 0 ? balanced(content, { "[": "]", "{": "}" }) : "Invalid YAML mapping";
  },
  xml: (content) => {
    const stack = [];
    const tags = content.match(/<[^>]+>/g);
    if (tags === null) return "XML contains no elements";
    for (const tag of tags) {
      if (/^<\?/.test(tag) || /^<!/.test(tag) || /\/>$/.test(tag)) continue;
      const closing = tag.match(/^<\/([A-Za-z_][\w:.-]*)\s*>$/);
      if (closing !== null) {
        if (stack.pop() !== closing[1]) return "Mismatched XML closing tag";
        continue;
      }
      const opening = tag.match(/^<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?>$/);
      if (opening === null) return "Invalid XML tag";
      stack.push(opening[1] ?? "");
    }
    return stack.length === 0 ? void 0 : "Unclosed XML tag";
  },
  "basic-syntax": (content) => balanced(content, { "(": ")", "[": "]", "{": "}" })
};
class ValidatorRegistry {
  validate(patch, attempts = 1) {
    const results = patch.files.flatMap(
      (file) => file.validators.map((name) => {
        const validator = validators[name];
        const error = validator === void 0 ? `Validator ${name} is not allowlisted` : validator(file.content);
        return {
          validator: name,
          path: file.path,
          passed: error === void 0,
          message: error ?? "Passed"
        };
      })
    );
    return ValidationReportSchema.parse({
      passed: results.every((result) => result.passed),
      attempts,
      results
    });
  }
}

"use strict";
class MemoryCodingRunStore {
  records = /* @__PURE__ */ new Map();
  async save(record) {
    this.records.set(record.input.runId, structuredClone(record));
  }
}
const EMPTY_VALIDATION = {
  passed: false,
  attempts: 1,
  results: []
};
function codingPullRequestBody(input, rca, manifest, validation) {
  return [
    `Ticket: ${input.ticketKey}`,
    `Source SHA: ${manifest.sourceSha}`,
    `Patch hash: ${manifest.patchHash}`,
    "",
    "RCA evidence",
    ...rca.evidence.map((item) => `- ${item.path}:${item.startLine}-${item.endLine}`),
    "",
    "Validation",
    ...validation.results.map((item) => `- ${item.validator} ${item.path}: ${item.message}`)
  ].join("\n");
}
class CodingWorkflow {
  constructor(reader, writer, validators, model, store, confidenceFloor) {
    this.reader = reader;
    this.writer = writer;
    this.validators = validators;
    this.model = model;
    this.store = store;
    this.confidenceFloor = confidenceFloor;
  }
  reader;
  writer;
  validators;
  model;
  store;
  confidenceFloor;
  steps = [
    { id: "load-context" },
    { id: "investigate" },
    { id: "strict-rca" },
    { id: "plan-surgical-patch" },
    { id: "preflight" },
    { id: "patch" },
    { id: "validate" },
    { id: "draft-pr" },
    { id: "evidence-close" }
  ];
  async run(input) {
    this.reader.assertRepository(input.owner, input.repo, input.baseBranch);
    const context = { input, source: this.reader };
    const rca = RootCauseAnalysisSchema.parse(await this.model.investigate(context));
    if (rca.evidence.length === 0 || rca.confidence < this.confidenceFloor) {
      return this.escalate(input, rca, EMPTY_VALIDATION, "insufficient_evidence", "RCA evidence or confidence is below policy");
    }
    if (!rca.fixable) {
      return this.escalate(input, rca, EMPTY_VALIDATION, "unfixable", "Diagnosis is evidence-backed but has no safe repository fix");
    }
    const plannedPatch = PatchPlanSchema.safeParse(await this.model.planPatch(context, rca));
    if (!plannedPatch.success) {
      return this.escalate(
        input,
        rca,
        EMPTY_VALIDATION,
        "path_denied",
        "The proposed patch did not satisfy the safe patch contract"
      );
    }
    let patch = plannedPatch.data;
    let manifest;
    try {
      manifest = PreviewManifestSchema.parse(this.writer.preflight(
        input.owner,
        input.repo,
        input.baseBranch,
        input.branch,
        input.sourceSha,
        patch.files,
        rca.evidence,
        input.approvedDestructivePaths
      ));
    } catch (error) {
      if (error instanceof RepositoryPolicyError) {
        const reason = error.code === "approval_required" ? "approval_required" : "path_denied";
        return this.escalate(input, rca, EMPTY_VALIDATION, reason, error.message);
      }
      throw error;
    }
    if (await this.reader.sourceSha(input.owner, input.repo, input.baseBranch) !== input.sourceSha) {
      return this.escalate(input, rca, EMPTY_VALIDATION, "stale_source", "Base branch changed after investigation");
    }
    let validation = this.validators.validate(patch);
    if (!validation.passed) {
      const repairedPatch = PatchPlanSchema.safeParse(
        await this.model.repairPatch(context, patch, validation)
      );
      if (!repairedPatch.success) {
        return this.escalate(
          input,
          rca,
          validation,
          "path_denied",
          "The repaired patch did not satisfy the safe patch contract",
          manifest
        );
      }
      patch = repairedPatch.data;
      try {
        manifest = PreviewManifestSchema.parse(this.writer.preflight(
          input.owner,
          input.repo,
          input.baseBranch,
          input.branch,
          input.sourceSha,
          patch.files,
          rca.evidence,
          input.approvedDestructivePaths
        ));
      } catch (error) {
        if (error instanceof RepositoryPolicyError) {
          const reason = error.code === "approval_required" ? "approval_required" : "path_denied";
          return this.escalate(input, rca, validation, reason, error.message);
        }
        throw error;
      }
      validation = this.validators.validate(patch, 2);
      if (!validation.passed) {
        return this.escalate(
          input,
          rca,
          validation,
          "validation_failed_after_repair",
          "Allowlisted validation failed after the single repair attempt",
          manifest
        );
      }
    }
    let pr;
    try {
      pr = await this.writer.apply(
        manifest,
        patch.files,
        `[${input.ticketKey}] ${patch.summary}`,
        codingPullRequestBody(input, rca, manifest, validation)
      );
    } catch (error) {
      if (error instanceof StaleSourceError) {
        return this.escalate(input, rca, validation, "stale_source", error.message, manifest);
      }
      throw error;
    }
    const ciStatus = await this.writer.checks(input.owner, input.repo, pr.commitSha);
    validation = ValidationReportSchema.parse({ ...validation, ciStatus });
    if (ciStatus === "failure") {
      return this.escalate(
        input,
        rca,
        validation,
        "ci_failed",
        "GitHub checks reported failure; Draft PR remains for review",
        manifest,
        pr
      );
    }
    const record = { input, rca, manifest, validation, pr };
    await this.store.save(record);
    return {
      runId: input.runId,
      status: ciStatus === "pending" ? "awaiting_ci" : "draft_pr_opened",
      rca,
      validation,
      manifest,
      pr
    };
  }
  async escalate(input, rca, validation, reason, detail, manifest, pr) {
    const escalation = EscalationSchema.parse({
      reason,
      diagnosisOnly: true,
      detail
    });
    const record = {
      input,
      rca,
      validation,
      ...manifest === void 0 ? {} : { manifest },
      ...pr === void 0 ? {} : { pr },
      escalation
    };
    await this.store.save(record);
    return {
      runId: input.runId,
      status: "escalated",
      rca,
      validation,
      ...manifest === void 0 ? {} : { manifest },
      ...pr === void 0 ? {} : { pr },
      escalation
    };
  }
}

"use strict";
const CODING_FLOW_STEPS = [
  "load-context",
  "investigate",
  "strict-rca",
  "plan-surgical-patch",
  "preflight",
  "patch",
  "validate",
  "draft-pr",
  "evidence-close"
];
const CodingRunStateSchema = z.object({
  input: CodingWorkflowInputSchema,
  rca: RootCauseAnalysisSchema.optional(),
  patch: PatchPlanSchema.optional(),
  manifest: PreviewManifestSchema.optional(),
  validation: ValidationReportSchema,
  pr: PullRequestReceiptSchema.optional(),
  escalation: EscalationSchema.optional(),
  /** Destructive paths granted by an approved resume; empty unless gated. */
  grantedApprovals: z.array(z.string().max(500)).optional(),
  close: z.enum(["escalated", "draft_pr_opened", "awaiting_ci"]).optional()
}).strict();
const CodingApprovalSuspendSchema = z.object({
  runId: z.string().min(1),
  ticketKey: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  summary: z.string().min(1).max(2e3),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(
    z.object({
      path: z.string().min(1).max(500),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
      validators: z.array(z.string().min(1))
    }).strict()
  ),
  destructivePaths: z.array(z.string().min(1)).min(1)
}).strict();
const CodingApprovalResumeSchema = z.object({
  decision: z.enum(["approved", "rejected", "expired"]),
  receipt: z.string().min(1).optional()
}).strict();
function unique(values) {
  return [...new Set(values)];
}
function truncate(message, max = 1900) {
  return message.length <= max ? message : `${message.slice(0, max)}\u2026`;
}
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Agent output did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
function parseJsonObject(schema, text, label) {
  const parsed = schema.safeParse(extractJson(text));
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`${label} contract violation: ${detail}`);
  }
  return parsed.data;
}
function createCodingAgentModel(options = {}) {
  const investigator = options.investigator ?? investigatorAgent;
  const actor = options.actor ?? actorAgent;
  return {
    async investigate(context) {
      const prompt = [
        "Investigate this coding ticket from a Jira bug report.",
        `Ticket: ${context.input.ticketKey}`,
        `Repository: ${context.input.owner}/${context.input.repo}@${context.input.baseBranch}`,
        "Problem:",
        context.input.problem,
        "",
        "Rules:",
        "- Cite file paths with line ranges only when the ticket itself names them.",
        "- If no file-level evidence is visible, return evidence [] with fixable false and confidence below 0.4.",
        "- Do not propose a patch.",
        "Return JSON matching { summary, confidence, evidence[{ path, startLine, endLine, excerpt }], fixable }."
      ].join("\n");
      const { text } = await investigator.generate(prompt);
      return parseJsonObject(RootCauseAnalysisSchema, text, "Investigator");
    },
    async planPatch(context, rca) {
      const evidenceFiles = [];
      for (const item of rca.evidence.slice(0, 4)) {
        try {
          const file = await context.source.content(
            context.input.owner,
            context.input.repo,
            item.path,
            context.input.sourceSha
          );
          evidenceFiles.push(
            `--- ${item.path} (${item.startLine}-${item.endLine}) ---
${file.content.slice(0, 6e3)}`
          );
        } catch {
          evidenceFiles.push(`--- ${item.path} --- (unreadable; do not invent content)`);
        }
      }
      const prompt = [
        "Plan a surgical patch for the cited root cause.",
        `Ticket: ${context.input.ticketKey}`,
        "Root cause summary:",
        rca.summary,
        "",
        "Current source at the evidence paths:",
        ...evidenceFiles.length === 0 ? ["(no readable evidence)"] : evidenceFiles,
        "",
        "Rules:",
        "- Patch only files named in the RCA evidence.",
        "- Keep the change the smallest that fixes the cited cause.",
        "- validators must be one or more of json, yaml, xml, basic-syntax.",
        "Return JSON matching { summary, files[{ path, content, validators }] }."
      ].join("\n");
      const { text } = await actor.generate(prompt);
      return parseJsonObject(PatchPlanSchema, text, "Actor");
    },
    async repairPatch(_context, patch, report) {
      const prompt = [
        "Repair this patch so it passes its own validators.",
        "Patch:",
        JSON.stringify(patch, null, 2),
        "",
        "Validator failures:",
        ...report.results.map((result) => `- ${result.validator} ${result.path}: ${result.message}`),
        "",
        "Rules:",
        "- Keep the same file paths.",
        "- Return the complete repaired patch, not a diff.",
        "Return JSON matching { summary, files[{ path, content, validators }] }."
      ].join("\n");
      const { text } = await actor.generate(prompt);
      return parseJsonObject(PatchPlanSchema, text, "Actor repair");
    }
  };
}
function createCodingFlow(deps) {
  const { github } = deps;
  const reader = github.reader;
  const writer = github.writer;
  const validators = deps.validators ?? new ValidatorRegistry();
  const model = deps.model ?? createCodingAgentModel();
  const store = deps.store ?? new MemoryCodingRunStore();
  const confidenceFloor = deps.confidenceFloor ?? 0.8;
  function escalate(state, reason, detail, options = {}) {
    return {
      ...state,
      close: "escalated",
      validation: options.validation ?? state.validation,
      ...options.manifest === void 0 ? {} : { manifest: options.manifest },
      ...options.pr === void 0 ? {} : { pr: options.pr },
      escalation: EscalationSchema.parse({ reason, diagnosisOnly: true, detail: truncate(detail) })
    };
  }
  function requireRca(state) {
    if (state.rca === void 0) throw new Error("Coding flow: RCA missing before use");
    return state.rca;
  }
  function requirePatch(state) {
    if (state.patch === void 0) throw new Error("Coding flow: patch missing before use");
    return state.patch;
  }
  function approvedPaths(state) {
    return unique([...state.input.approvedDestructivePaths, ...state.grantedApprovals ?? []]);
  }
  function deniedDestructivePaths(state) {
    const allowed = new Set(approvedPaths(state));
    return requirePatch(state).files.filter((file) => reader.isDestructive(file.path) && !allowed.has(file.path)).map((file) => file.path);
  }
  function stateWithRca(state, rca) {
    return { ...state, rca };
  }
  const loadContext = createStep({
    id: CODING_FLOW_STEPS[0],
    inputSchema: CodingWorkflowInputSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => ({
      input: CodingWorkflowInputSchema.parse(inputData),
      validation: EMPTY_VALIDATION
    })
  });
  const investigate = createStep({
    id: CODING_FLOW_STEPS[1],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.close !== void 0) return state;
      const context = { input: state.input, source: reader };
      let rca;
      try {
        rca = RootCauseAnalysisSchema.parse(await model.investigate(context));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown model failure";
        rca = {
          summary: truncate(`Investigation could not be completed: ${message}`, 4e3),
          confidence: 0,
          evidence: [],
          fixable: false
        };
        return escalate(stateWithRca(state, rca), "insufficient_evidence", message);
      }
      return stateWithRca(state, rca);
    }
  });
  const strictRca = createStep({
    id: CODING_FLOW_STEPS[2],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.close !== void 0) return state;
      const rca = requireRca(state);
      if (rca.evidence.length === 0 || rca.confidence < confidenceFloor) {
        return escalate(
          state,
          "insufficient_evidence",
          "RCA evidence or confidence is below policy"
        );
      }
      if (!rca.fixable) {
        return escalate(
          state,
          "unfixable",
          "Diagnosis is evidence-backed but has no safe repository fix"
        );
      }
      return state;
    }
  });
  const planSurgicalPatch = createStep({
    id: CODING_FLOW_STEPS[3],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.close !== void 0) return state;
      const context = { input: state.input, source: reader };
      try {
        const patch2 = PatchPlanSchema.parse(await model.planPatch(context, requireRca(state)));
        return { ...state, patch: patch2 };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown model failure";
        return escalate(
          state,
          "path_denied",
          `The proposed patch did not satisfy the safe patch contract: ${message}`
        );
      }
    }
  });
  const preflight = createStep({
    id: CODING_FLOW_STEPS[4],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    resumeSchema: CodingApprovalResumeSchema,
    suspendSchema: CodingApprovalSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      const state = inputData;
      if (state.close !== void 0) return state;
      const patch2 = requirePatch(state);
      const { input } = state;
      const approvals = approvedPaths(state);
      const preflightOrSuspend = async (granted) => {
        try {
          const manifest = writer.preflight(
            input.owner,
            input.repo,
            input.baseBranch,
            input.branch,
            input.sourceSha,
            patch2.files,
            requireRca(state).evidence,
            granted
          );
          return { ...state, manifest, grantedApprovals: granted };
        } catch (error) {
          if (error instanceof RepositoryPolicyError && error.code === "approval_required") {
            if (resumeData === void 0) {
              return await suspend({
                runId: input.runId,
                ticketKey: input.ticketKey,
                repository: `${input.owner}/${input.repo}`,
                branch: input.branch,
                summary: patch2.summary,
                actionHash: computePatchHash(patch2.files),
                files: patch2.files.map((file) => ({
                  path: file.path,
                  sha256: createHash("sha256").update(file.content).digest("hex"),
                  bytes: Buffer.byteLength(file.content),
                  validators: file.validators
                })),
                destructivePaths: deniedDestructivePaths(state)
              });
            }
            return escalate(
              state,
              "path_denied",
              "The approved resume still did not satisfy repository policy"
            );
          }
          if (error instanceof RepositoryPolicyError) {
            return escalate(state, "path_denied", error.message);
          }
          throw error;
        }
      };
      if (resumeData === void 0) {
        return preflightOrSuspend(approvals);
      }
      if (resumeData.decision !== "approved" || resumeData.receipt === void 0) {
        return escalate(
          state,
          "approval_rejected",
          `Approval was ${resumeData.decision} for ${input.ticketKey}`
        );
      }
      return preflightOrSuspend(unique([...approvals, ...deniedDestructivePaths(state)]));
    }
  });
  const patch = createStep({
    id: CODING_FLOW_STEPS[5],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.close !== void 0) return state;
      const actual = await reader.sourceSha(state.input.owner, state.input.repo, state.input.baseBranch);
      if (actual !== state.input.sourceSha) {
        return escalate(state, "stale_source", "Base branch changed after investigation");
      }
      return state;
    }
  });
  const validate = createStep({
    id: CODING_FLOW_STEPS[6],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.close !== void 0) return state;
      let patch2 = requirePatch(state);
      let report = validators.validate(patch2);
      if (report.passed) {
        return { ...state, validation: report };
      }
      let repaired;
      try {
        repaired = PatchPlanSchema.parse(
          await model.repairPatch(
            { input: state.input, source: reader },
            patch2,
            report
          )
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown model failure";
        return escalate(
          state,
          "path_denied",
          `The repaired patch did not satisfy the safe patch contract: ${message}`,
          { validation: report }
        );
      }
      patch2 = repaired;
      try {
        const manifest = writer.preflight(
          state.input.owner,
          state.input.repo,
          state.input.baseBranch,
          state.input.branch,
          state.input.sourceSha,
          patch2.files,
          requireRca(state).evidence,
          approvedPaths(state)
        );
        report = validators.validate(patch2, 2);
        if (!report.passed) {
          return escalate(
            state,
            "validation_failed_after_repair",
            "Allowlisted validation failed after the single repair attempt",
            { validation: report, manifest }
          );
        }
        return { ...state, patch: patch2, manifest, validation: report };
      } catch (error) {
        if (error instanceof RepositoryPolicyError && error.code === "approval_required") {
          return escalate(
            state,
            "approval_required",
            "The repair introduced a destructive path; a new approval-gated run is required",
            { validation: report }
          );
        }
        if (error instanceof RepositoryPolicyError) {
          return escalate(state, "path_denied", error.message, { validation: report });
        }
        throw error;
      }
    }
  });
  const draftPr = createStep({
    id: CODING_FLOW_STEPS[7],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingRunStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.close !== void 0) return state;
      const patch2 = requirePatch(state);
      const manifest = state.manifest;
      if (manifest === void 0) throw new Error("Coding flow: manifest missing before Draft PR");
      const rca = requireRca(state);
      let pr;
      try {
        pr = await writer.apply(
          manifest,
          patch2.files,
          `[${state.input.ticketKey}] ${patch2.summary}`,
          codingPullRequestBody(state.input, rca, manifest, state.validation)
        );
      } catch (error) {
        if (error instanceof StaleSourceError) {
          return escalate(
            state,
            "stale_source",
            "Base branch changed after investigation",
            { manifest }
          );
        }
        throw error;
      }
      const ciStatus = await writer.checks(state.input.owner, state.input.repo, pr.commitSha);
      const validation = ValidationReportSchema.parse({ ...state.validation, ciStatus });
      if (ciStatus === "failure") {
        return escalate(
          state,
          "ci_failed",
          "GitHub checks reported failure; Draft PR remains for review",
          { validation, manifest, pr }
        );
      }
      const close = ciStatus === "pending" ? "awaiting_ci" : "draft_pr_opened";
      return {
        ...state,
        pr,
        validation,
        close
      };
    }
  });
  const evidenceClose = createStep({
    id: CODING_FLOW_STEPS[8],
    inputSchema: CodingRunStateSchema,
    outputSchema: CodingWorkflowOutputSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.close === void 0) {
        throw new Error("Coding flow: run ended without a terminal decision");
      }
      const record = {
        input: state.input,
        rca: requireRca(state),
        validation: state.validation,
        ...state.manifest === void 0 ? {} : { manifest: state.manifest },
        ...state.pr === void 0 ? {} : { pr: state.pr },
        ...state.escalation === void 0 ? {} : { escalation: state.escalation }
      };
      await store.save(record);
      const output = {
        runId: state.input.runId,
        status: state.close,
        rca: record.rca,
        validation: record.validation,
        ...record.manifest === void 0 ? {} : { manifest: record.manifest },
        ...record.pr === void 0 ? {} : { pr: record.pr },
        ...record.escalation === void 0 ? {} : { escalation: record.escalation }
      };
      return CodingWorkflowOutputSchema.parse(output);
    }
  });
  return createWorkflow({
    id: "codingFlow",
    inputSchema: CodingWorkflowInputSchema,
    outputSchema: CodingWorkflowOutputSchema,
    options: {
      validateInputs: true
    }
  }).then(loadContext).then(investigate).then(strictRca).then(planSurgicalPatch).then(preflight).then(patch).then(validate).then(draftPr).then(evidenceClose).commit();
}

"use strict";
function createAllRounderMastra(deps = {}) {
  const ledger = deps.ledger ?? new MemorySandboxLedger();
  return new Mastra({
    logger: false,
    storage: new InMemoryStore({ id: "allrounder-orchestrator" }),
    agents: allRounderAgents(),
    workflows: {
      financeFlow: createFinanceFlow({ ledger }),
      ...deps.coding === void 0 ? {} : { codingFlow: createCodingFlow(deps.coding) }
    }
  });
}

"use strict";
const GITHUB_MCP_DEFAULT_URL = "https://api.githubcopilot.com/mcp/";
class GitHubMcpError extends Error {
  constructor(tool, message, cause) {
    super(message);
    this.tool = tool;
    this.cause = cause;
    this.name = "GitHubMcpError";
  }
  tool;
  cause;
}
class SdkGitHubMcpSession {
  constructor(serverUrl, token) {
    this.serverUrl = serverUrl;
    this.token = token;
  }
  serverUrl;
  token;
  client;
  transport;
  async connect() {
    if (this.client !== void 0) return;
    const client = new Client(
      { name: "allrounder-coding-agent", version: "0.1.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(this.serverUrl),
      this.token === void 0 || this.token === "" ? void 0 : { requestInit: { headers: { Authorization: `Bearer ${this.token}` } } }
    );
    this.client = client;
    this.transport = transport;
    try {
      await client.connect(transport);
    } catch (error) {
      this.client = void 0;
      this.transport = void 0;
      if (error instanceof UnauthorizedError) {
        throw new GitHubMcpError(
          "connect",
          "GitHub MCP authorization failed. Set GITHUB_MCP_TOKEN (or GITHUB_TOKEN) to a classic repo-scope PAT or a fine-grained token with Contents and Pull requests read/write, then verify with `node scripts/github-mcp-verify.mjs`.",
          error
        );
      }
      throw error;
    }
  }
  async listTools() {
    await this.connect();
    const result = await this.client?.listTools();
    return result?.tools.map((tool) => ({ name: tool.name })) ?? [];
  }
  async callTool(name, args) {
    await this.connect();
    const result = await this.client?.callTool({ name, arguments: args });
    return result ?? {};
  }
  async close() {
    const transport = this.transport;
    this.client = void 0;
    this.transport = void 0;
    if (transport !== void 0) await transport.close();
  }
}
function objectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function toolText(result) {
  if (!Array.isArray(result.content)) return "";
  return result.content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n");
}
function resourceText(result) {
  if (!Array.isArray(result.content)) return void 0;
  for (const part of result.content) {
    if (typeof part?.resource?.text === "string") return part.resource.text;
  }
  return void 0;
}
function metaSha(result) {
  if (!Array.isArray(result.content)) return "";
  for (const part of result.content) {
    const match = typeof part?.text === "string" ? part.text.match(/SHA:\s*([0-9a-f]{40})/) : void 0;
    if (match?.[1] !== void 0) return match[1];
  }
  return "";
}
function toolData(result) {
  if (objectValue(result.structuredContent) !== void 0) return result.structuredContent;
  const text = toolText(result);
  if (text.trim() === "") return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
class McpGitHubBackend {
  requiredTools = [
    "get_commit",
    "get_file_contents",
    "push_files",
    "create_pull_request",
    "list_pull_requests"
  ];
  tools;
  session;
  closeSession = false;
  constructor(opts) {
    if (opts?.session !== void 0) {
      this.session = opts.session;
      return;
    }
    const token = opts?.token ?? process.env.GITHUB_MCP_TOKEN ?? process.env.GITHUB_TOKEN;
    this.session = new SdkGitHubMcpSession(
      opts?.serverUrl ?? process.env.GITHUB_MCP_URL ?? GITHUB_MCP_DEFAULT_URL,
      token
    );
    this.closeSession = true;
  }
  async assertTools() {
    if (this.tools !== void 0) return;
    const tools = new Set((await this.session.listTools()).map((tool) => tool.name));
    const missing = this.requiredTools.filter((name) => !tools.has(name));
    if (missing.length > 0) {
      throw new GitHubMcpError(
        "connect",
        `GitHub MCP server is missing required tools: ${missing.join(", ")}`
      );
    }
    this.tools = tools;
  }
  async callRaw(tool, args, conflictIsStale = false) {
    await this.assertTools();
    let result;
    try {
      result = await this.session.callTool(tool, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Unauthorized|401|invalid token|token.*expired/i.test(message)) {
        throw new GitHubMcpError(
          tool,
          `GitHub MCP authorization failed: ${message}`,
          error
        );
      }
      if (conflictIsStale && /already exists|not fast-forward|fast-forward|reference/i.test(message)) {
        throw new StaleSourceError();
      }
      throw new GitHubMcpError(tool, `GitHub MCP call failed: ${message}`, error);
    }
    if (result.isError === true) {
      const message = toolText(result);
      if (conflictIsStale && /already exists|fast-forward/i.test(message)) {
        throw new StaleSourceError();
      }
      throw new GitHubMcpError(tool, message === "" ? "MCP tool reported an error" : message);
    }
    return result;
  }
  async call(tool, args, conflictIsStale = false) {
    return toolData(await this.callRaw(tool, args, conflictIsStale));
  }
  responseObject(tool, data) {
    const value = objectValue(data);
    if (value === void 0) {
      throw new GitHubMcpError(tool, "MCP tool returned a non-object payload");
    }
    return value;
  }
  async headSha(owner, repo, branch) {
    const data = this.responseObject("get_commit", await this.call(
      "get_commit",
      { owner, repo, sha: branch }
    ));
    if (typeof data.sha !== "string") {
      throw new GitHubMcpError("get_commit", "Malformed commit response");
    }
    return data.sha;
  }
  async branchHead(owner, repo, branch) {
    try {
      const data = this.responseObject("get_commit", await this.call(
        "get_commit",
        { owner, repo, sha: branch }
      ));
      return typeof data.sha === "string" ? data.sha : void 0;
    } catch (error) {
      if (error instanceof GitHubMcpError && /not found|no commit found|404|could not resolve/i.test(error.message)) {
        return void 0;
      }
      throw error;
    }
  }
  async fileContent(owner, repo, path, refSha) {
    const result = await this.callRaw("get_file_contents", {
      owner,
      repo,
      path,
      sha: refSha
    });
    const structured = objectValue(result.structuredContent);
    if (structured !== void 0) {
      if (typeof structured.content !== "string") {
        throw new GitHubMcpError("get_file_contents", "Malformed file contents response");
      }
      return {
        content: decodeFileContent(structured.content),
        sha: typeof structured.sha === "string" ? structured.sha : ""
      };
    }
    const resource = resourceText(result);
    if (resource !== void 0) {
      return { content: resource, sha: metaSha(result) };
    }
    const data = toolData(result);
    const value = objectValue(data);
    if (value !== void 0) {
      if (typeof value.content !== "string") {
        throw new GitHubMcpError("get_file_contents", "Malformed file contents response");
      }
      return {
        content: decodeFileContent(value.content),
        sha: typeof value.sha === "string" ? value.sha : ""
      };
    }
    if (typeof data === "string") {
      return { content: decodeFileContent(data), sha: metaSha(result) };
    }
    throw new GitHubMcpError("get_file_contents", "MCP tool returned a non-object payload");
  }
  async commitFiles(owner, repo, branch, message, _baseSha, files) {
    await this.call(
      "push_files",
      {
        owner,
        repo,
        branch,
        files: files.map((file) => ({ path: file.path, content: file.content })),
        message
      },
      true
    );
    return { commitSha: await this.headSha(owner, repo, branch) };
  }
  async openDraftPull(owner, repo, branch, baseBranch, title, body) {
    const data = this.responseObject("create_pull_request", await this.call(
      "create_pull_request",
      { owner, repo, title, body, head: branch, base: baseBranch, draft: true },
      true
    ));
    const url = typeof data.url === "string" ? data.url : typeof data.html_url === "string" ? data.html_url : "";
    let number = typeof data.number === "number" ? data.number : Number.NaN;
    if (!Number.isInteger(number) || number <= 0) {
      const match = /\/pull\/(\d+)\/?$/.exec(url);
      if (match?.[1] === void 0 || url === "") {
        throw new GitHubMcpError("create_pull_request", "Malformed pull request response");
      }
      number = Number(match[1]);
    }
    return { number, url };
  }
  async listOpenPulls(owner, repo, branch) {
    const data = await this.call("list_pull_requests", {
      owner,
      repo,
      state: "open",
      head: `${owner}:${branch}`
    });
    const rawList = Array.isArray(data) ? data : this.responseObject("list_pull_requests", data)?.pulls;
    if (!Array.isArray(rawList)) {
      throw new GitHubMcpError("list_pull_requests", "Malformed pull request list response");
    }
    return rawList.map((entry) => {
      const value = objectValue(entry);
      if (value === void 0 || typeof value.number !== "number" || typeof value.html_url !== "string") {
        throw new GitHubMcpError("list_pull_requests", "Malformed pull request list response");
      }
      return {
        number: value.number,
        url: value.html_url,
        body: typeof value.body === "string" ? value.body : "",
        draft: value.draft === true
      };
    });
  }
  async checkRuns(owner, repo, commitSha, pullNumber) {
    await this.assertTools();
    if (pullNumber === void 0) {
      throw new GitHubMcpError(
        "checkRuns",
        "GitHub MCP check runs require the pull request number (writer apply must precede checks)"
      );
    }
    const tools = this.tools ?? /* @__PURE__ */ new Set();
    if (tools.has("get_pull_request_status")) {
      const data = this.responseObject("get_pull_request_status", await this.call(
        "get_pull_request_status",
        { owner, repo, pull_number: pullNumber }
      ));
      return normalizeCheckPayload(data);
    }
    if (tools.has("pull_request_read")) {
      const data = this.responseObject("pull_request_read", await this.call(
        "pull_request_read",
        { owner, repo, pullNumber, method: "get_check_runs" }
      ));
      return normalizeCheckPayload(data);
    }
    throw new GitHubMcpError(
      "checkRuns",
      "GitHub MCP server exposes neither get_pull_request_status nor pull_request_read"
    );
  }
  async close() {
    if (this.closeSession) await this.session.close();
  }
}
function normalizeCheckPayload(data) {
  if (typeof data.state === "string") {
    if (data.state === "FAILURE") return "failure";
    if (data.state === "PENDING") return "pending";
    if (data.state === "SUCCESS") return "success";
  }
  const runs = Array.isArray(data.check_runs) ? data.check_runs : Array.isArray(data.runs) ? data.runs : [];
  return aggregateCheckRuns(runs);
}
function decodeFileContent(value) {
  const compact = value.replace(/\s/g, "");
  if (compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf8");
      if (decoded.length > 0 || compact.length === 0) return decoded;
    } catch {
    }
  }
  return value;
}

"use strict";
function readStringArrayEnv(name) {
  const raw = process.env[name];
  if (raw === void 0 || raw.trim() === "") return void 0;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of strings, e.g. ["owner/repo"]`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`${name} must be a JSON array of strings, e.g. ["owner/repo"]`);
  }
  return parsed;
}
function readPositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function buildCodingDeps() {
  const repositories = readStringArrayEnv("GITHUB_REPOSITORY_ALLOWLIST");
  if (repositories === void 0 || repositories.length === 0) {
    return void 0;
  }
  const policy = {
    repositories,
    baseBranch: process.env.GITHUB_BASE_BRANCH?.trim() || "main",
    allowPaths: readStringArrayEnv("GITHUB_PATH_ALLOWLIST") ?? ["src/**", "tests/**", "config/**", "docs/**"],
    denyPaths: readStringArrayEnv("GITHUB_PATH_DENYLIST") ?? [".github/workflows/**", "infra/prod/**"],
    destructivePaths: readStringArrayEnv("GITHUB_DESTRUCTIVE_PATHS") ?? ["migrations/**", "infra/**"],
    maxFiles: readPositiveNumberEnv("GITHUB_MAX_PATCH_FILES", 10),
    maxPatchBytes: readPositiveNumberEnv("GITHUB_MAX_PATCH_BYTES", 25e4),
    timeoutMs: readPositiveNumberEnv("GITHUB_REQUEST_TIMEOUT_SECONDS", 10) * 1e3
  };
  const access = process.env.GITHUB_ACCESS?.trim() || "mcp";
  if (access === "mcp") {
    const token2 = process.env.GITHUB_MCP_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim();
    if (token2 === void 0 || token2 === "") {
      console.warn(
        "[mastra] GITHUB_ACCESS=mcp but neither GITHUB_MCP_TOKEN nor GITHUB_TOKEN is set; first write (apply) will fail with an authorization error."
      );
    }
    return { github: new GitHubRepositoryTools(new McpGitHubBackend(), policy) };
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token === void 0 || token === "") {
    return void 0;
  }
  return { github: new GitHubRepositoryTools(new FetchGitHubTransport(token), policy) };
}
const coding = buildCodingDeps();
if (coding === void 0) {
  console.warn(
    "[mastra] GITHUB_REPOSITORY_ALLOWLIST is not set, or GITHUB_ACCESS=rest without GITHUB_TOKEN; codingFlow is not registered (financeFlow only)."
  );
}
const mastra = createAllRounderMastra(coding === void 0 ? {} : { coding });

"use strict";

export { mastra };
