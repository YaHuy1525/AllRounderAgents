import { createSkill } from "@mastra/core/skills";

/**
 * Root-cause investigation skill for the coding lane.
 *
 * Adapts the guidance in the official Mastra `understand-issue` skill (trace
 * code history and architecture to diagnose a defect) into an inline,
 * in-memory skill. The agent loads it on demand through the `skill` and
 * `skill_read` tools, so it shapes *how* the investigator reasons without
 * widening its contract: the investigator still returns cited RCA JSON and
 * never proposes a patch.
 */
export const issueInvestigationSkill = createSkill({
  name: "issue-investigation",
  description:
    "Diagnose a repository defect down to a cited root cause. Use when turning a bug report or failing behavior into evidence-bound findings: locate the subsystem, follow the data and control flow, separate symptom from cause, and judge fixability. For coding-lane investigation only, not patch design.",
  instructions: `# Root-cause investigation

Investigate so every conclusion rests on source you actually read. Never conclude from a preview or an assumption.

## Method

1. Restate the report as an observable behavior: what input, what happened, what was expected. Strip the reporter's guessed cause.
2. Find the boundary where the failure becomes visible, then walk upstream toward where it originates. A symptom is where it shows; the cause is where the wrong state or decision is created.
3. Orient in the codebase before you cite. List the directory, search for the symbol, message, or snippet, and open every candidate file to read real lines.
4. Follow history when a change likely introduced it. Which commit altered the contract, guard, or default that now fails.
5. Name the single broken assumption the defect depends on, such as a value that is not what the code assumes, a race, a missing null check, or a contract drift between producer and consumer.
6. Check the negative paths and edges, empty, null, first and last, zero, concurrent, oversized, and unauthorized.

## Evidence discipline

- Every claim needs a file path with a line range you read. Quote the excerpt from those lines.
- Confidence tracks how directly the evidence shows the cause, not how plausible the story sounds.
- Judge fixability: is there a safe, bounded change in the allowlisted repository, or does the cause sit in external behavior.
- When the cause depends on external behavior you cannot see, search for it, then use the finding to raise or lower confidence only. Never paste web results into evidence.

## Stop conditions

- No readable file-level evidence means: empty evidence, low confidence, fixable false. Say so instead of guessing.

See references/checklist.md before you finalize.`,
  references: {
    "checklist.md": `# Investigation final checklist

- Is the failure restated as observable behavior, not the reporter's guess?
- Did I read the file and lines I cite, not infer them from a preview?
- Have I separated symptom location from originating cause?
- Is confidence justified by cited evidence alone?
- Did I check edge, negative, and concurrent paths?
- Is the fixability call grounded in what is inside the allowlisted repo?
- Did I avoid proposing any patch content?`,
  },
});
