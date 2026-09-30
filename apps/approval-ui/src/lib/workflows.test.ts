import { describe, expect, it } from "vitest";

import {
  sanitizeWorkflow,
  sanitizeWorkflowCatalog,
  type WorkflowDefinition,
} from "./workflows.js";

const REVIEW: WorkflowDefinition = {
  id: "review",
  title: "PR review",
  mastraWorkflow: "review-workflow",
  steps: [
    { id: "select-pr", title: "Select the PR", sideEffecting: false, integrations: [] },
    { id: "review-options", title: "Post the review", sideEffecting: true, integrations: ["github"] },
  ],
};

describe("workflow catalog sanitizers", () => {
  it("accepts a well-formed catalog payload", () => {
    expect(sanitizeWorkflowCatalog({ workflows: [REVIEW] })).toEqual([REVIEW]);
  });

  it("drops malformed entries and tolerates a missing integrations key", () => {
    const tolerated = {
      ...REVIEW,
      id: "no-integrations-key",
      steps: [{ id: "y", title: "Y", sideEffecting: false }],
    };
    const result = sanitizeWorkflowCatalog({
      workflows: [
        REVIEW,
        { ...REVIEW, id: "" },
        { ...REVIEW, id: "no-steps", steps: [] },
        { ...REVIEW, id: "bad-step", steps: [{ id: "x", title: "X", sideEffecting: "yes" }] },
        tolerated,
        "junk",
      ],
    });
    expect(result).toEqual([
      REVIEW,
      {
        ...REVIEW,
        id: "no-integrations-key",
        steps: [{ id: "y", title: "Y", sideEffecting: false, integrations: [] }],
      },
    ]);
  });

  it("rejects non-catalog payloads outright", () => {
    expect(sanitizeWorkflowCatalog(null)).toBeNull();
    expect(sanitizeWorkflowCatalog({})).toBeNull();
    expect(sanitizeWorkflowCatalog({ workflows: "nope" })).toBeNull();
  });

  it("rejects workflows without an id, title, mastra workflow, or steps", () => {
    expect(sanitizeWorkflow({ ...REVIEW, id: undefined })).toBeNull();
    expect(sanitizeWorkflow({ ...REVIEW, title: 7 })).toBeNull();
    expect(sanitizeWorkflow({ ...REVIEW, mastraWorkflow: undefined })).toBeNull();
    expect(sanitizeWorkflow({ ...REVIEW, steps: [] })).toBeNull();
    expect(sanitizeWorkflow({ ...REVIEW, steps: undefined })).toBeNull();
  });

  it("rejects integrations that are not a string array", () => {
    expect(
      sanitizeWorkflow({
        ...REVIEW,
        steps: [
          { id: "select-pr", title: "Select the PR", sideEffecting: false, integrations: [7] },
        ],
      }),
    ).toBeNull();
  });
});
