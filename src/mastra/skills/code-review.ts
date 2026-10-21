import { createSkill } from "@mastra/core/skills";

/**
 * Code review skill for the coding lane.
 *
 * Adapts the official Mastra `code-review` skill into an inline skill for the
 * validator. It sharpens the critic's judgment order and finding quality while
 * keeping the validator's contract intact: it returns a pass-or-block verdict
 * against the spec and never edits the patch.
 */
export const codeReviewSkill = createSkill({
  name: "code-review",
  description:
    "Review a change for correctness, security, performance, and maintainability against its stated requirements, and turn that into an evidence-bound verdict with actionable findings. Use when judging a patch or diff you did not write. For review only, never for rewriting the change.",
  instructions: `# Code review

Judge the change against what it was supposed to do, in a fixed priority order. Point at the exact location. Never rewrite the author's code in the review.

## Priority order

1. Correctness against the requirement. Does it actually satisfy each acceptance criterion, and does it fix the named root cause rather than a nearby symptom?
2. Security. Trust boundaries, injection, secrets in code or logs, authorization on every path, and unsafe input reaching a dangerous sink.
3. Data and contract safety. Schema and format changes that break existing data or callers, missing validation at the boundary, and inconsistent error handling.
4. Reliability. Failure and retry paths, timeouts, unbounded growth, and the edge cases at empty, null, first, last, zero, and concurrent.
5. Performance. Only the changes that can actually regress the hot path, such as N-plus-one queries or needless re-renders.
6. Maintainability and tests. Naming, dead code, scope creep beyond the ticket, and whether tests assert behavior rather than implementation.

## Finding quality

- Classify each finding: blocker for a correctness or security break, major for a real defect or missing requirement, minor for quality, and nit for style taste.
- Make every finding actionable and located: name the criterion or risk, the file and line, and the concrete condition that fails.
- Do not block on taste. Approve is a valid answer when the criteria are met, and an unstated concern is not a finding.

## Verdict discipline

- Judge the patch against the stated acceptance criteria and the cited evidence, not the author's summary of intent.
- Set block when any acceptance criterion is unmet or the patch is off-spec or unsafe, and pass only when the named criteria are genuinely satisfied.
- List every criterion you actually checked so the verdict is auditable, and suggest nothing the author did not ask for.

See references/checklist.md before you return a verdict.`,
  references: {
    "checklist.md": `# Review final checklist

- Did I check correctness against each acceptance criterion first?
- Did I look for injection, secrets, and missing authorization on every path?
- Are data and interface changes safe for existing consumers?
- Did I trace the failure, retry, and edge-case paths?
- Is every finding severity-rated, located, and actionable?
- Did I avoid blocking on style taste and scope creep of my own?
- Does the verdict follow only from the spec and the cited evidence?`,
  },
});
