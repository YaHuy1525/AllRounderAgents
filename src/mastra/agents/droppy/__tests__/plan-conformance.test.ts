import { describe, expect, it } from "vitest";

import { allRounderAgents } from "../../registry.js";
import { EventNameSchema } from "../contracts.js";
import { loadDroppyConfig } from "../settings.js";

/**
 * Plan conformance.
 *
 * The plan (D:\Code\Droppy\docs\PLAN.md) is the authority. These tests pin the
 * implementation to it, so a later change that silently adds a ninth bot, drops
 * an event, or starts recreating Shopify fails here instead of in production.
 *
 * The bot set and the event vocabulary are the two things most likely to drift:
 * both are "obvious" to add to and both are load-bearing.
 */

/** PLAN §4 Phase 4 — the plan freezes this at eight bots. */
const PLAN_BOTS = [
  { key: "droppyResearch", id: "droppy-r1-research", code: "R1" },
  { key: "droppyListing", id: "droppy-l2-listing", code: "L2" },
  { key: "droppyOrders", id: "droppy-o3-orders", code: "O3" },
  { key: "droppyTracking", id: "droppy-t4-tracking", code: "T4" },
  { key: "droppyExceptions", id: "droppy-x5-exceptions", code: "X5" },
  { key: "droppySupport", id: "droppy-s6-support", code: "S6" },
  { key: "droppyPricing", id: "droppy-m7-pricing", code: "M7" },
  { key: "droppyAds", id: "droppy-a8-ads", code: "A8" },
] as const;

/** PLAN §4 Phase 2 — the event vocabulary, verbatim. */
const PLAN_EVENTS = [
  "product.shortlisted",
  "listing.created",
  "order.created",
  "order.supplier_confirmed",
  "logistics.update",
  "tracking.exception",
  "support.email",
  "margin.breach",
  "ad.performance",
] as const;

describe("PLAN §4 Phase 4 — exactly eight bots", () => {
  it("registers the plan's eight bots under their plan codes", () => {
    const agents = allRounderAgents();
    for (const bot of PLAN_BOTS) {
      expect(agents, `missing ${bot.key} (${bot.code})`).toHaveProperty(bot.key);
      expect(
        (agents as Record<string, { id?: string }>)[bot.key]?.id,
        `${bot.key} should carry id ${bot.id}`,
      ).toBe(bot.id);
    }
  });

  it("registers no ninth Droppy bot", () => {
    const agents = allRounderAgents() as Record<string, unknown>;
    const droppyKeys = Object.keys(agents).filter((k) => k.startsWith("droppy"));
    expect(droppyKeys).toHaveLength(PLAN_BOTS.length);
    expect(droppyKeys.sort()).toEqual(PLAN_BOTS.map((b) => b.key).sort());
  });
});

describe("PLAN §4 Phase 2 — the event vocabulary", () => {
  it("matches the plan's nine events exactly", () => {
    expect([...EventNameSchema.options].sort()).toEqual([...PLAN_EVENTS].sort());
  });

  it("has no event the plan does not name", () => {
    const extras = [...EventNameSchema.options].filter(
      (e) => !(PLAN_EVENTS as readonly string[]).includes(e),
    );
    expect(extras).toEqual([]);
  });
});

describe("PLAN §0 — the selection rule", () => {
  it("keeps Shopify as the channel; nothing in the lane recreates it", () => {
    const config = loadDroppyConfig();
    expect(config.channel.provider).toBe("shopify");
    // The channel is called, never rebuilt.
    expect(config.channel).not.toHaveProperty("recreated");
  });

  it("recreates only the paid research tool, and uses the free sources", () => {
    const config = loadDroppyConfig();
    // Suppliers are free (F2, F3) — called, not rebuilt.
    expect(config.suppliers).toEqual(["cj_dropshipping", "zendrop"]);
    // The region and postcode are AU — the free sources are queried AU-only.
    expect(config.region.countryCode).toBe("AU");
    expect(config.region.freightPostcode).toBe("2000");
  });
});

describe("PLAN §6 — compliance is executable, not prose", () => {
  it("carries the ACL/TGA/GST rules as config, not as comments", () => {
    const config = loadDroppyConfig();
    expect(config.compliance.blockTherapeuticClaims).toBe(true);
    expect(config.compliance.aclRemedyMandatory).toBe(true);
    expect(config.compliance.gstThresholdAud).toBe(75000);
    expect(config.compliance.requireDeliveryEstimate).toBe(true);
  });

  it("blocks ACCC/lawyer/fraud before any auto-reply", () => {
    const config = loadDroppyConfig();
    for (const term of ["accc", "lawyer", "fraud"]) {
      expect(config.compliance.escalationKeywords).toContain(term);
    }
  });
});
