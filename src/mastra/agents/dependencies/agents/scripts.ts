import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the dependency engineer. Expected outputs are
 * on-contract (`DependencyAssessmentOutputSchema`): the bump summary, the
 * confidence, and the breaking notes per out-of-date group.
 */
export const dependencyEngineerScenarios: AgentScenario[] = [
  {
    name: "orders service patch and major bumps",
    input: {
      repository: "acme/app",
      groups: [
        {
          id: "patch",
          packages: [
            { name: "zod", from: "^3.22.1", to: "3.22.4", changelogExcerpt: "Fixes refine() inference." },
          ],
        },
        {
          id: "major",
          packages: [
            {
              name: "react-router",
              from: "^5.3.4",
              to: "6.26.0",
              changelogExcerpt: "Removes the v5 component APIs in favour of the data router.",
            },
          ],
        },
      ],
    },
    expectedOutput: {
      summary: "Bumps zod within patch range and react-router across a major upgrade.",
      confidence: 0.81,
      groups: [
        { id: "patch", breakingNotes: [] },
        {
          id: "major",
          breakingNotes: [
            "react-router v6 removes the v5 route-component props — the route table must migrate to the data router.",
          ],
        },
      ],
    },
  },
  {
    name: "minor SDK refresh",
    input: {
      repository: "acme/lib",
      groups: [
        {
          id: "minor",
          packages: [
            {
              name: "@acme/sdk",
              from: "~4.1.0",
              to: "4.3.2",
              changelogExcerpt: "Adds retry helpers; deprecates the legacy client.",
            },
          ],
        },
      ],
    },
    expectedOutput: {
      summary: "Refreshes @acme/sdk within the minor range; the legacy client is deprecated.",
      confidence: 0.86,
      groups: [
        {
          id: "minor",
          breakingNotes: ["The legacy client is deprecated and will be removed in v5."],
        },
      ],
    },
  },
];

/**
 * Few-shot scenarios for the dependency repair agent. Expected outputs are
 * on-contract (`DependencyRepairSuggestionSchema`): exactly one repair
 * suggestion after a failed install/tests, then the human decides.
 */
export const dependencyRepairScenarios: AgentScenario[] = [
  {
    name: "lockfile integrity mismatch",
    input: {
      repository: "acme/app",
      groups: [
        {
          id: "patch",
          failures: [
            {
              path: "package-lock.json",
              validator: "json",
              message: "Unexpected token } in JSON at position 4821",
            },
          ],
        },
      ],
    },
    expectedOutput: {
      suggestion:
        "Regenerate the lockfile from package.json with npm install --package-lock-only, then re-run the group.",
      confidence: 0.77,
    },
  },
  {
    name: "peer range conflict",
    input: {
      repository: "acme/lib",
      groups: [
        {
          id: "major",
          failures: [
            {
              path: "package.json",
              validator: "json",
              message: "Invalid version specifier for @acme/sdk",
            },
          ],
        },
      ],
    },
    expectedOutput: {
      suggestion:
        "Exclude @acme/sdk from the major group and retry after pinning the peer range in package.json.",
      confidence: 0.72,
    },
  },
];
