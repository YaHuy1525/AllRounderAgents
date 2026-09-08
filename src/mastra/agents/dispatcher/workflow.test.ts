import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createDispatcher, type WorkflowStep } from "./workflow.js";
import { fixtureFile } from "../../shared/fixtures.js";

const fixtures = JSON.parse(
  readFileSync(fixtureFile("phase0_tickets.json"), "utf8"),
) as Array<{
  name: string;
  expectedDomain: string;
  payload: { issue: { key: string; fields: Record<string, unknown> }; timestamp: number };
}>;

describe("provider-neutral dispatcher", () => {
  const dispatcher = createDispatcher();

  for (const fixture of fixtures) {
    it(`routes ${fixture.name} to ${fixture.expectedDomain}`, async () => {
      const output = await dispatcher.execute({
        inputData: fixture.payload,
        context: { requestId: fixture.name, correlationId: fixture.name, actor: "test" },
      });
      expect(output.verdict.domain).toBe(fixture.expectedDomain);
      expect(output.workflow.kind).toBe("comment-only");
      if (fixture.expectedDomain === "unknown") {
        expect(output.gate).toBe("approval");
        expect(output.comment.toLowerCase()).toContain("escalat");
      } else {
        expect(output.comment).toContain(output.verdict.rationale);
      }
    });
  }

  it("exposes Mastra-compatible named workflow steps without a provider", () => {
    const steps: readonly WorkflowStep[] = dispatcher.steps;
    expect(steps.map((step) => step.id)).toEqual(["normalize", "triage", "preflight", "route"]);
  });

  it("normalizes a null Jira description consistently with Python", async () => {
    const fixture = structuredClone(fixtures[0]!);
    fixture.payload.issue.fields.description = null;
    const result = await dispatcher.execute({
      inputData: fixture.payload,
      context: { requestId: "r", correlationId: "c", actor: "test" },
    });
    expect(result.ticket.description).toBe("");
  });

  it("fails closed when a custom triage provider throws", async () => {
    const failing = createDispatcher({
      triage: async () => {
        throw new Error("provider timeout");
      },
    });
    const result = await failing.execute({
      inputData: fixtures[0]!.payload,
      context: { requestId: "r", correlationId: "c", actor: "test" },
    });
    expect(result.verdict.domain).toBe("unknown");
    expect(result.gate).toBe("approval");
  });
});

