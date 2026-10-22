import { createSkill } from "@mastra/core/skills";

/**
 * Event-driven development skill for the coding lane.
 *
 * No official Mastra skill covers this domain, so it is authored fresh around
 * messaging and async-work practice: event schema design, delivery semantics,
 * idempotent consumers, the outbox pattern, retries and dead-letter handling,
 * and sagas. It guides the actor when a patch adds or changes asynchronous,
 * event, or queue-backed behavior.
 */
export const eventDrivenSkill = createSkill({
  name: "event-driven-development",
  description:
    "Design and patch asynchronous, message, or event-based flows: event schema and versioning, commands versus events, delivery guarantees, idempotent consumers, the outbox pattern, ordering, retries with dead-letter handling, and sagas for eventual consistency. Use when a change involves queues, topics, webhooks, or background work.",
  instructions: `# Event-driven development

Assume every message is delivered at least once, out of order, and possibly more than once. Build so the system stays correct anyway.

## Model the events

- Name events as facts that already happened, in past tense, such as OrderPlaced or InvoicePaid. A command is intent to act; an event is a record that something is true. Do not mix them in one stream.
- Keep the event small: the identity, the minimum facts that changed, a schema version, and the time and causation id. Point to the source of truth for the rest instead of embedding whole records.
- Version the schema from the start and make readers tolerate unknown fields, so old producers and new consumers can coexist.
- Treat the event stream as immutable history. Emit a new correcting event rather than editing or deleting a past one.

## Delivery and idempotency

- Plan for at-least-once delivery by default, and make consumers idempotent with a natural key or a dedup store, so a retry cannot double-charge or double-create.
- Do not rely on global ordering. Where a sequence matters, key the partition by the entity id so one entity's events stay ordered, and carry a per-entity version so a stale event is dropped.
- Store the message id or dedup key before committing the effect, and commit the effect and the ack together so a crash between them does not lose or duplicate work.

## Atomic publish, the outbox

- Never write to the database and publish to the broker in two separate steps, since either can fail alone. Use the transactional outbox: write the event row inside the same transaction as the business change, then relay it to the broker asynchronously.

## Failure handling

- Retry transient failures with exponential backoff and jitter, cap the attempts, and route a message that keeps failing to a dead-letter queue for inspection instead of blocking the healthy stream.
- Make poison messages visible and recoverable. A consumer must not crash-loop on one bad payload, and replay from the dead-letter queue must be safe.
- Measure and respect consumer lag, and apply backpressure rather than accepting unbounded queue growth.

## Long-running work

- Coordinate multi-step flows across services with a saga, and give each step a compensating action so a later failure can undo earlier effects.
- Accept eventual consistency and design reads to handle a briefly stale view, showing progress rather than pretending a step is done.

## Keep it decoupled

- Producers must not know which consumers exist. If a producer waits on a consumer or shares its schema and deploy schedule, you have built a distributed monolith, not an event-driven system.

See references/checklist.md before you finalize.`,
  references: {
    "checklist.md": `# Event-driven final checklist

- Are events past-tense facts, small, versioned, and distinct from commands?
- Is delivery assumed at-least-once and is every consumer idempotent?
- Is ordering handled by entity key, not by trusting global order?
- Is publish atomic with the write via the outbox pattern?
- Do retries have backoff and jitter, a cap, and a dead-letter path?
- Are sagas compensable and reads tolerant of eventual consistency?
- Does the producer stay ignorant of its consumers?`,
  },
});
