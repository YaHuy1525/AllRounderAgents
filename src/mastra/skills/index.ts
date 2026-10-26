import type { InlineSkill } from "@mastra/core/skills";

import { backendApiDesignSkill } from "./backend-api.js";
import { codeReviewSkill } from "./code-review.js";
import { eventDrivenSkill } from "./event-driven.js";
import { frontendUiDesignSkill } from "./frontend-ui.js";
import { issueInvestigationSkill } from "./investigation.js";
import { systemDesignSkill } from "./system-design.js";

/**
 * Coding-lane skills, staged per role. Each bundle is attached through an agent's
 * `skills` config, which adds the `skill`, `skill_read` and `skill_search` tools so
 * guidance loads on demand. Content adapts the official Mastra suite where a domain
 * matched, and system-design and event-driven are authored fresh.
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
