import { createSkill } from "@mastra/core/skills";

/**
 * System design skill for the coding lane.
 *
 * There is no matching skill in the official Mastra suite, so this is authored
 * fresh from standard architecture practice. It shapes how the actor reasons
 * about boundaries, data flow, failure, and trade-offs before it writes a
 * patch, and it keeps the smallest-scope discipline of the lane: design here
 * means choosing the right structure for the change, not redesigning the
 * system around it.
 */
export const systemDesignSkill = createSkill({
  name: "system-design",
  description:
    "Reason about structure before changing it: component boundaries, data and control flow, state ownership, storage choice, failure modes, scalability and reliability trade-offs, and security boundaries. Use when a change touches how parts of the system fit together, not for isolated line-level fixes.",
  instructions: `# System design

Design the change against the real constraints, then keep it the smallest structure that meets them.

## Ground the design

- Turn the request into explicit requirements and constraints first: functional behavior, scale, latency, data volume, consistency needs, budget, and what already exists.
- State the assumptions you are making and the ones that would change the design if wrong.
- Prefer reusing and extending what the system already has over introducing a new moving part.

## Structure and boundaries

- Split by responsibility and rate of change. A module should have one reason to change and hide its internals behind a narrow interface.
- Make data ownership explicit: who writes it, who reads it, and what happens when they disagree. Shared mutable state across boundaries is a smell.
- Draw the happy path and the failure path. Every cross-component call can time out, retry, or land twice.
- Put a clear seam between layers so each side is testable alone, and keep the domain logic free of framework and transport details.

## Data and state

- Choose storage by access pattern: relational for enforced invariants and joins, document or key-value for flexible nested reads, queue or log for async handoff, cache for read hotspots.
- Decide the consistency need per flow. Strong consistency costs latency and availability, so apply it only where a wrong read is a bug.
- Version anything long-lived: schemas, events, and stored formats. Assume old data outlives the code that wrote it.

## Reliability, scale, and security

- Identify the single points of failure and give each a bounded remedy: retry with backoff and jitter, a timeout, a circuit breaker, or a graceful-degrade path.
- Scale reads with caching and replicas, scale writes by partitioning by a natural key, and always know the bottleneck before optimizing.
- Define the trust boundary and put validation and authorization there. Never rely on a client-supplied identity.
- Make it observable: logs correlated by a request id, metrics on the golden signals, and traces across the seams you are adding.

## Decide and record

- Where options trade off, name the winner and the cost you accepted. A design with no stated trade-off has an unexamined one.
- Keep the result reversible where possible: feature flags, additive migrations, and shippable slices beat big-bang swaps.

See references/checklist.md before you finalize.`,
  references: {
    "checklist.md": `# Design final checklist

- Are requirements, constraints, and assumptions written down?
- Does each module have one reason to change behind a narrow interface?
- Are data ownership and the failure path explicit, not just the happy path?
- Is storage and consistency chosen per access pattern, not by habit?
- Does every single point of failure have a bounded remedy?
- Is the trust boundary enforced with validation and authz?
- Is the main trade-off named, and is the change reversible where it can be?`,
  },
});
