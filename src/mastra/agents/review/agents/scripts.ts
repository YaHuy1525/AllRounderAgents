import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the PR reviewer. Expected outputs are on-contract
 * (`ReviewModelOutputSchema`): verdict + confidence + summary + strengths +
 * improvements + inline comments on changed files only.
 */
export const reviewReviewerScenarios: AgentScenario[] = [
  {
    name: "guarded endpoint missing an authorization check",
    input: {
      pullRequest: {
        number: 42,
        title: "Add refund endpoint",
        repository: "acme/app",
        baseBranch: "main",
        headSha: "a".repeat(40),
      },
      categories: ["code-quality", "security"],
      files: [
        {
          path: "src/api/refunds.ts",
          patch: "@@ -10,6 +10,10 @@\n export async function refund(orderId: string) {\n+  const order = await orders.get(orderId);\n+  await payments.refund(order.id);\n }",
        },
      ],
    },
    expectedOutput: {
      verdict: "request_changes",
      confidence: 0.82,
      summary:
        "The new refund endpoint mutates money without checking that the caller is allowed to refund the order.",
      strengths: ["Reuses the existing payments client instead of adding a new integration."],
      improvements: ["Authorize the caller before issuing the refund."],
      comments: [
        {
          path: "src/api/refunds.ts",
          line: 11,
          body: "This handler refunds an order straight from the request without an authorization check.",
        },
      ],
    },
  },
  {
    name: "safe documentation-only change",
    input: {
      pullRequest: {
        number: 17,
        title: "Clarify retry policy in the README",
        repository: "acme/app",
        baseBranch: "main",
        headSha: "b".repeat(40),
      },
      categories: ["code-quality", "meets-requirements"],
      files: [
        {
          path: "README.md",
          patch: "@@ -4,3 +4,4 @@\n ## Retries\n+Failed jobs retry twice with exponential backoff.",
        },
      ],
    },
    expectedOutput: {
      verdict: "approve",
      confidence: 0.74,
      summary: "Documentation-only change that matches the retry policy already shipped in the worker.",
      strengths: ["States the retry count and backoff plainly."],
      improvements: [],
      comments: [],
    },
  },
];
