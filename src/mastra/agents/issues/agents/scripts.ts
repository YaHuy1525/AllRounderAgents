import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the bug analyst. Expected outputs are on-contract
 * (`IssueAnalysisOutputSchema`): summary + confidence + similar updates +
 * cited affected files (line ranges inside shown content) + regression plan.
 */
export const issueAnalystScenarios: AgentScenario[] = [
  {
    name: "null dereference in the profile loader",
    input: {
      ticket: { key: "ABC-42", summary: "Profile page crashes when the address is missing" },
      files: [
        {
          path: "src/profile/loader.ts",
          content:
            "export function loadProfile(raw: RawProfile) {\n  return {\n    name: raw.name,\n    city: raw.address.city,\n  };\n}",
        },
        {
          path: "tests/profile/loader.test.ts",
          content: 'import { loadProfile } from "../../src/profile/loader";\n',
        },
      ],
      regressionTestRequired: true,
    },
    expectedOutput: {
      summary:
        "loadProfile dereferences raw.address without a guard, so a profile without an address crashes the page.",
      confidence: 0.86,
      similarUpdates: [
        {
          reference: "src/profile/settings.ts",
          note: "A sibling loader already uses an optional chain for the same raw shape.",
        },
      ],
      affectedFiles: [
        {
          path: "src/profile/loader.ts",
          startLine: 3,
          endLine: 4,
          changeDescription: "Guard the address access and fall back to an unknown city.",
          validators: ["basic-syntax"],
        },
      ],
      regressionTest: {
        path: "tests/profile/loader.test.ts",
        description: "Add a case for a profile without an address and assert no throw.",
      },
    },
  },
  {
    name: "invalid retry config fails as yaml",
    input: {
      ticket: { key: "ABC-77", summary: "Worker does not start: bad retry config" },
      files: [
        {
          path: "config/worker.yaml",
          content: "worker:\n  retries: three\n  backoff: exponential",
        },
      ],
      regressionTestRequired: false,
    },
    expectedOutput: {
      summary: "The retry count is a word where the worker expects an integer.",
      confidence: 0.93,
      similarUpdates: [],
      affectedFiles: [
        {
          path: "config/worker.yaml",
          startLine: 2,
          endLine: 2,
          changeDescription: "Change retries to an integer matching the documented policy.",
          validators: ["yaml"],
        },
      ],
      regressionTest: null,
    },
  },
];

/**
 * Few-shot scenarios for the bug engineer. Expected outputs are on-contract
 * (`IssueImplementationOutputSchema`): full replacement contents per file plus
 * the regression test that ships with the fix.
 */
export const issueEngineerScenarios: AgentScenario[] = [
  {
    name: "guard the address access",
    input: {
      ticket: { key: "ABC-42", summary: "Profile page crashes when the address is missing" },
      analysis: "loadProfile dereferences raw.address without a guard.",
      files: [{ path: "src/profile/loader.ts" }],
    },
    expectedOutput: {
      summary: "Guarded the address access and defaulted the city.",
      files: [
        {
          path: "src/profile/loader.ts",
          content:
            'export function loadProfile(raw: RawProfile) {\n  return {\n    name: raw.name,\n    city: raw.address?.city ?? "Unknown",\n  };\n}',
          validators: ["basic-syntax"],
        },
      ],
      regressionTest: {
        path: "tests/profile/loader.test.ts",
        content:
          'import { loadProfile } from "../../src/profile/loader";\n\ntest("missing address does not throw", () => {\n  expect(loadProfile({ name: "Ada" })).toEqual({ name: "Ada", city: "Unknown" });\n});',
      },
    },
  },
  {
    name: "fix the retry count type",
    input: {
      ticket: { key: "ABC-77", summary: "Worker does not start: bad retry config" },
      analysis: "The retry count is a word where the worker expects an integer.",
      files: [{ path: "config/worker.yaml" }],
    },
    expectedOutput: {
      summary: "Set retries to an integer.",
      files: [
        {
          path: "config/worker.yaml",
          content: "worker:\n  retries: 3\n  backoff: exponential",
          validators: ["yaml"],
        },
      ],
      regressionTest: null,
    },
  },
];
