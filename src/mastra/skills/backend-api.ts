import { createSkill } from "@mastra/core/skills";

/**
 * Backend and API design skill for the coding lane.
 *
 * Adapts the official Mastra `api-design` skill into an inline skill. It steers
 * the actor toward clean resource models, honest HTTP semantics, validated
 * contracts, and safe evolution, which is the backend half of the coding lane's
 * patch work.
 */
export const backendApiDesignSkill = createSkill({
  name: "backend-api-design",
  description:
    "Design or patch a backend endpoint or service contract: resource modeling, HTTP verbs and status codes, request and response schemas, pagination, idempotency, authorization, and backwards-compatible evolution. Use for server, API, and data-layer changes. For backend work only.",
  instructions: `# Backend and API design

Make contracts explicit, honest about state, and safe to change later.

## Resource model and verbs

- Model endpoints around nouns and resources, use the HTTP verb for intent, and let the status code report the true outcome rather than always returning 200 with an error in the body.
- Use GET only for reads with no side effects, POST to create or trigger, PATCH for partial updates, PUT for full replacement, and DELETE for removal.
- Return 200 or 201 with the created resource and a Location header on create, 204 with no body on a successful delete, and reserve 4xx for the caller's fault and 5xx for the server's fault.

## Contracts and validation

- Define one typed request and response schema per operation and validate at the boundary before any handler runs. Reject unknown fields where the contract is strict.
- Keep a single consistent error envelope across the API: a stable machine code, a human message, and a per-field map for validation failures.
- Never leak internals in errors, stack traces, SQL, or object dumps. Echo only what the caller needs to correct the request.

## Queries, lists, and writes

- Paginate every list with an explicit, bounded page size and a stable cursor or offset. Never return an unbounded collection.
- Support filtering, sorting, and field selection as query parameters rather than inventing a new endpoint per view.
- Make writes idempotent where a client can retry safely, via a client-supplied idempotency key or a natural unique constraint, so a double submit cannot double-charge or double-create.

## Security and evolution

- Authorize at the resource boundary, scope tokens to least privilege, and never trust a client-supplied identity or tenant field.
- Treat every change to a public shape as a contract change. Add fields freely, but rename, remove, or retype only behind a version or with a deprecation window.
- Add timeouts, retries with backoff, and rate limits on anything that reaches another service, and make the failure path visible to the caller.

See references/checklist.md before you finalize a backend patch.`,
  references: {
    "checklist.md": `# Backend final checklist

- Do verbs and status codes match the real outcome?
- Is there one validated typed schema per operation, rejecting bad input at the boundary?
- Is the error envelope consistent and free of leaked internals?
- Are lists paginated, filterable, and sortable with a bounded page size?
- Are writes idempotent where a retry is possible?
- Is authorization enforced at the resource boundary, not only in the UI?
- Does the change stay backwards compatible or move behind a version?`,
  },
});
