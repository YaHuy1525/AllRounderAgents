import { describe, expect, it } from "vitest";

import {
  actorSkills,
  backendApiDesignSkill,
  codeReviewSkill,
  eventDrivenSkill,
  frontendUiDesignSkill,
  investigatorSkills,
  issueInvestigationSkill,
  systemDesignSkill,
  validatorSkills,
} from "../../../src/mastra/skills/index.js";

/**
 * Skills are validated when createSkill() runs, so a successful import already
 * proves each one meets the Agent Skills metadata rules. These assertions lock
 * the parts the agents depend on: the per-role bundles, unique lowercase-hyphen
 * names, and non-empty instructions carried to the skill tools at runtime.
 */

const allSkills = [
  issueInvestigationSkill,
  frontendUiDesignSkill,
  backendApiDesignSkill,
  systemDesignSkill,
  eventDrivenSkill,
  codeReviewSkill,
];

describe("coding-lane skills", () => {
  it("attaches one investigation skill to the investigator", () => {
    expect(investigatorSkills.map((skill) => skill.name)).toEqual(["issue-investigation"]);
  });

  it("attaches the four build domains to the actor", () => {
    expect(actorSkills.map((skill) => skill.name)).toEqual([
      "frontend-ui-design",
      "backend-api-design",
      "system-design",
      "event-driven-development",
    ]);
  });

  it("attaches the review skill to the validator", () => {
    expect(validatorSkills.map((skill) => skill.name)).toEqual(["code-review"]);
  });

  it("defines every skill inline with valid metadata and instructions", () => {
    for (const skill of allSkills) {
      expect(skill.__inline).toBe(true);
      expect(skill.name).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.instructions.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps skill names unique across the coding lane", () => {
    const names = allSkills.map((skill) => skill.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("bundles a reference checklist the skill_read tool can serve", () => {
    for (const skill of allSkills) {
      expect(skill.references).toContain("checklist.md");
    }
  });
});
