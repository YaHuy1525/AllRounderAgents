/**
 * Droppy lane.
 *
 * An autonomous AU dropshipping system: eight bots over one shared index, with
 * the AutoDS research recreation (three scoring engines) on top of one
 * collector layer that calls the free data sources.
 *
 * The selection rule is the plan's (D:\Code\Droppy\docs\PLAN.md §0): recreate
 * what costs us money, use free what doesn't. Shopify is the channel, kept.
 *
 * Design decisions live in D:\Code\Droppy\docs\architecture\adr:
 * - ADR 0001: recreate what costs money; Shopify is kept, not recreated.
 * - ADR 0002: no bot talks to another bot — they emit domain events.
 */

export * from "./contracts.js";
export * from "./config.js";
export * from "./tools/scoring.js";
export * from "./tools/collectors.js";
export * from "./tools/store.js";
export * from "./agents/bots.js";
