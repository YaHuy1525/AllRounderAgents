import type { InlineSkill } from "@mastra/core/skills";

import { backendApiDesignSkill } from "./backend-api.js";
import { codeReviewSkill } from "./code-review.js";
import { eventDrivenSkill } from "./event-driven.js";
import { frontendUiDesignSkill } from "./frontend-ui.js";
import { issueInvestigationSkill } from "./investigation.js";
import { systemDesignSkill } from "./system-design.js";

/**
 * Coding-lane skills, staged per role.
 *
 * Each bundle is attached to one agent through its `skills` config, which makes
 * the agent auto-receive the `skill`, `skill_read`, and `skill_search` tools so
 * it can discover and load the guidance on demand. Content adapts the official
 * Mastra skill suite where a domain matched (understand-issue, react/tailwind
 * best-practices, api-design, code-review) and authors system-design and
 * event-driven fresh, since no official skill covered them.
 */

/** Investigator: research and root-cause reasoning only. */
export const investigatorSkills: InlineSkill[] = [issueInvestigationSkill];

/** Actor: the build disciplines it draws on while designing a patch. */
export const actorSkills: InlineSkill[] = [
  frontendUiDesignSkill,
  backendApiDesignSkill,
  systemDesignSkill,
  eventDrivenSkill,
];

/** Validator: the review discipline behind its pass-or-block verdict. */
export const validatorSkills: InlineSkill[] = [codeReviewSkill];

export {
  backendApiDesignSkill,
  codeReviewSkill,
  eventDrivenSkill,
  frontendUiDesignSkill,
  issueInvestigationSkill,
  systemDesignSkill,
};
