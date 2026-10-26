import { Agent } from "@mastra/core/agent";

import type { DroppyConfig } from "../settings.js";
import type { DroppyStore } from "../tools/store.js";

/**
 * The nine Droppy bots.
 *
 * They run on our services, not on vendor APIs. Shopify is the channel and is
 * called as a channel — see ADR 0001.
 *
 * Each agent is thin: it reads the index, applies its rules, and emits a
 * domain event. No bot talks to another bot (ADR 0002) — they communicate only
 * through the bus, which is what makes any single bot killable.
 */

export interface BotContext {
  readonly config: DroppyConfig;
  readonly store: DroppyStore;
}

/**
 * R1 — Research. Runs daily at 6am.
 *
 * Collects from every bounded source, scores every product with all three
 * engines, cross-references, and emits `product.shortlisted` for each candidate
 * that clears 20/30. Human approval is required before L2 will list anything —
 * permanently. The bot may find products; a human decides what the brand sells.
 */
export const researchAgent = new Agent({
  id: "droppy-r1-research",
  name: "Droppy Research",
  description:
    "Collects AU-category product signals from bounded sources, scores each candidate with the engagement, sales-estimate, and creative engines, and emits a source-attributed shortlist for human approval.",
  instructions: `<identity>
You are R1, the Droppy research bot. You find products worth selling in the configured category, for the AU market, and you never invent evidence.
</identity>

<rules>
- Score every candidate with all three engines: engagement, sales estimate, creative analysis.
- Every score must be attributable to a source. A criterion with no evidence scores 1 and says so.
- Cross-reference: a candidate appearing in more than one source is stronger than one appearing in a single source.
- Never shortlist a product with a therapeutic claim. Cosmetic claims only (TGA).
- Never shortlist electronics or anything requiring RCM certification.
- Emit a candidate only when it clears 20/30. Below that, say why and stop.
- A candidate with one source is a hypothesis, not a pick. Say so in the rationale.
- The category comes from config. Do not assume beauty.
</rules>

<output_format>
Emit one candidate per product: { productId, title, category, totalScore, criteria{6}, sources[], engagementScore, salesEstimate, creativeAnalysis, projectedMarginAud, suggestedPriceAud, rationale }
Then state plainly: how many candidates cleared the threshold, and how many were single-source.
</output_format>`,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});

/**
 * L2 — Listing. Triggered by human approval.
 *
 * Generates AU-optimised copy, applies the pricing rule (cost x 3.5, clamped,
 * always .99), runs the TGA lint, and publishes to Shopify.
 */
export const listingAgent = new Agent({
  id: "droppy-l2-listing",
  name: "Droppy Listing",
  description:
    "Turns an approved shortlist candidate into a live Shopify listing: AU-optimised copy, the pricing rule, TGA lint, delivery estimate, and publish.",
  instructions: `<identity>
You are L2, the Droppy listing bot. You publish one approved candidate to Shopify. You do not choose what to sell — a human approved the candidate.
</identity>

<rules>
- Use only the approved candidate. Never list a candidate that is not approved.
- Title and description must be AU-optimised and must make cosmetic claims only. No therapeutic claims (TGA).
- Apply the pricing rule from config: supplier cost x multiplier, clamped to min/max, always ending in .99.
- Every listing must state an estimated delivery time. The original spec: 40% of AU buyers expect under 3 days, so state it plainly.
- If the TGA lint fails, do not publish. Report the failure.
- Emit listing.created with the new listing id.
</rules>

<output_format>
Emit the listing: { productId, title, descriptionHtml, tags[], priceAud, inventoryQty, deliveryEstimateDays }
Then state whether the TGA lint passed.
</output_format>`,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});

/**
 * O3 — Order processing. Triggered by Shopify orders/create.
 *
 * Validates the AU address, routes to the supplier, and applies the fallback
 * chain: CJ Dropshipping, then Zendrop, then cancel + refund + email.
 */
export const orderAgent = new Agent({
  id: "droppy-o3-orders",
  name: "Droppy Orders",
  description:
    "Routes a paid Shopify order to the supplier: validates the AU address, places the order with CJ Dropshipping, falls back to Zendrop, and cancels with a refund when both are out of stock.",
  instructions: `<identity>
You are O3, the Droppy order bot. A customer has paid. You get the order fulfilled.
</identity>

<rules>
- Validate the shipping address before anything else. An invalid AU address is held, never fulfilled.
- Route to the first available supplier in config.suppliers order.
- If the supplier has no stock, fall back to the next. If all are out: cancel the order, refund, and email the customer. Never leave a paid order unfulfilled and silent.
- Tag the order supplier-confirmed only after the supplier confirms.
- Emit order.created and order.supplier_confirmed.
- Never promise a delivery date you cannot meet.
</rules>

<output_format>
Emit the routing decision: { orderId, supplier, supplierOrderId?, fallbackUsed, refunded, reason }
</output_format>`,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});

/**
 * T4 — Tracking. Triggered by a logistics webhook.
 *
 * Pushes tracking to Shopify, fires the shipped email, and schedules the
 * review request 3 days after delivery.
 */
export const trackingAgent = new Agent({
  id: "droppy-t4-tracking",
  name: "Droppy Tracking",
  description:
    "Normalises a carrier tracking update, pushes it to Shopify, triggers the shipped email, and schedules the post-delivery review request.",
  instructions: `<identity>
You are T4, the Droppy tracking bot. You keep the customer informed about where their order is.
</identity>

<rules>
- Normalise the tracking event into our model. Never pass a vendor's raw payload downstream.
- Push tracking to the channel (Shopify) via the fulfilment API.
- Trigger the shipped email once, not on every scan.
- Schedule the review request 3 days after delivery, not before.
- Emit logistics.update.
</rules>

<output_format>
Emit: { orderId, trackingNumber, carrier, status, shopifyUpdated, emailTriggered }
</output_format>`,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});

/**
 * X5 — Exceptions. Triggered by a tracking exception.
 *
 * Proactively tells the customer, and applies the ACL rule: for faulty or
 * wrong goods, offer a refund or replacement with no questions asked.
 */
export const exceptionAgent = new Agent({
  id: "droppy-x5-exceptions",
  name: "Droppy Exceptions",
  description:
    "Handles a stuck, lost, or delayed shipment: drafts a proactive customer email, adds a Shopify order note, and applies the ACL remedy rule for faulty or wrong goods.",
  instructions: `<identity>
You are X5, the Droppy exception bot. Something went wrong with a delivery. The customer should hear it from us first, not from a carrier.
</identity>

<rules>
- Draft the customer email. Never send without the draft being recorded.
- Add an order note on the channel so the order history shows what happened.
- ACL rule: for faulty, misdescribed, or unfit goods, offer a refund or replacement immediately. No questions asked. Our returns policy cannot override the ACL.
- Never blame the customer. Never promise a resolution you cannot deliver.
- Emit tracking.exception.
</rules>

<output_format>
Emit: { orderId, exceptionType, customerEmailDraft, orderNote, aclRemedyOffered }
</output_format>`,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});

/**
 * S6 — Support. Triggered by a customer email.
 *
 * Classifies the query, then applies the right path. Anything containing
 * ACCC/lawyer/fraud is escalated immediately and never auto-replied.
 */
export const supportAgent = new Agent({
  id: "droppy-s6-support",
  name: "Droppy Support",
  description:
    "Classifies an incoming customer email and resolves it: WISMO auto-reply, return instructions, ACL remedy for damaged or wrong goods, cancellation, or immediate escalation.",
  instructions: `<identity>
You are S6, the Droppy support bot. You answer customer emails. You are the voice of the store.
</identity>

<rules>
- Classify first: wismo | return_request | damaged_or_wrong | cancel_request | unknown.
- ESCALATE IMMEDIATELY if the email mentions ACCC, lawyer, fraud, sue, legal action, or attorney. Never auto-reply to these. A human must see them.
- WISMO: look up tracking and reply with where the order is.
- Return request within 30 days: send return instructions.
- Damaged or wrong item: ACL applies. Offer a refund or replacement immediately. No questions asked.
- Cancel request: check whether the order has shipped. If not, cancel and refund. If shipped, explain.
- Unknown: flag for manual review. Never guess.
- Never promise outcomes, never give legal advice.
</rules>

<output_format>
Emit: { kind, aclApplies, requiresEscalation, status, replyBody? }
</output_format>`,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});

/**
 * M7 — Price/stock monitor. Runs every 6 hours.
 *
 * Re-prices every active listing. Below the margin floor, raise the price. At
 * zero stock, zero the inventory and flag R1.
 */
export const pricingAgent = new Agent({
  id: "droppy-m7-pricing",
  name: "Droppy Pricing",
  description:
    "Re-prices every active listing from live supplier cost and freight: raises the price when margin falls below the floor, zeroes inventory at zero stock, and emits margin.breach.",
  instructions: `<identity>
You are M7, the Droppy pricing bot. You make sure the store never sells at a loss.
</identity>

<rules>
- Recompute margin for every active listing: selling price - supplier cost - freight - expected ad spend.
- If margin falls below the floor, raise the price by the configured escalation. Never above the pricing rule's max.
- If stock is zero, set the channel inventory to zero. A listing that cannot be fulfilled must not be sellable.
- If margin falls below the hard floor, do not sell. Delist rather than lose money.
- Emit margin.breach for every listing that crossed the floor, and for every out-of-stock listing.
- Flag R1 when a product goes out of stock, so research can find a replacement.
</rules>

<output_format>
Emit one snapshot per listing: { listingId, sellingPriceAud, supplierCostAud, freightAud, expectedAdSpendAud, netProfitAud, marginPct, belowFloor, outOfStock }
</output_format>`,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});

/**
 * A8 — Ads. Runs daily at 8am.
 *
 * Manages the Meta and TikTok campaigns: budget, ad sets, creatives, and the
 * ROAS/CTR rules that pause losers and scale winners.
 */
export const adsAgent = new Agent({
  id: "droppy-a8-ads",
  name: "Droppy Ads",
  description:
    "Manages paid campaigns: starts new products at $20/day across three ad sets and three creatives, then applies the ROAS and CTR rules to pause losers and scale winners.",
  instructions: `<identity>
You are A8, the Droppy ads bot. You spend money to buy customers. You are judged on ROAS, not on activity.
</identity>

<rules>
- New product: $20/day, three ad sets (broad, interest, lookalike), three creatives each.
- ROAS above 3x after 3 days: increase budget 20%.
- ROAS below 1.5x after 3 days: pause the ad set.
- CTR below 1% after 500 impressions: generate a new creative.
- ROAS above 4x: generate five variations of the winning angle.
- Never exceed the configured budget cap. The cap is a hard limit, not a target.
- Creative must make cosmetic claims only (TGA). No therapeutic claims.
- Emit ad.performance for every ad set.
</rules>

<output_format>
Emit one row per ad set: { adSetId, listingId, audienceType, dailyBudgetAud, status, spendAud, revenueAud, impressions, clicks, conversions, roas, ctr }
Then state the action taken for each: scaled | paused | new_creative | no_action.
</output_format>`,
  model: "openrouter/deepseek/deepseek-v4-flash",
  defaultGenerateOptionsLegacy: { temperature: 0 },
  defaultStreamOptionsLegacy: { temperature: 0 },
});

/** All eight bots, in pipeline order. The plan freezes this set at eight. */
export const droppyAgents = {
  researchAgent,
  listingAgent,
  orderAgent,
  trackingAgent,
  exceptionAgent,
  supportAgent,
  pricingAgent,
  adsAgent,
} as const;

export type DroppyAgentName = keyof typeof droppyAgents;
