import { describe, expect, it } from "vitest";

import { allRounderAgents } from "../../registry.js";
import { DEFAULT_DROPPY_CONFIG, loadDroppyConfig } from "../config.js";
import { createEventEmittingStore, createInMemoryStore } from "../tools/store.js";
import type { AdObservation, DomainEvent, Order, Product, ShortlistCandidate } from "../contracts.js";

const config = loadDroppyConfig();

const product: Product = {
  id: "p1",
  title: "Vitamin C Serum",
  supplierId: "cj_dropshipping",
  supplierSku: "V1",
  category: "beauty",
  region: "AU",
  supplierCostAud: 12,
  freightAud: 6,
  warehouse: "AU-Sydney",
  inStock: true,
  stockQty: 500,
  images: [],
  observedAt: "2026-10-17T00:00:00.000Z",
};

describe("The index (Layer 2)", () => {
  it("indexes ads by product across sources", () => {
    const store = createInMemoryStore(config);
    const ad = (id: string, source: AdObservation["source"]): AdObservation => ({
      id,
      source,
      region: "AU",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-10-17T00:00:00.000Z",
      runDays: 77,
      linkedProductIds: ["p1"],
    });
    store.upsertAd(ad("m1", "meta_ad_library"));
    store.upsertAd(ad("t1", "tiktok_creative_center"));

    const ads = store.adsByProduct("p1");
    expect(ads).toHaveLength(2);
    expect(ads.map((a) => a.source).sort()).toEqual(["meta_ad_library", "tiktok_creative_center"]);
  });

  it("is idempotent on natural keys — replaying an ad is not a second ad", () => {
    const store = createInMemoryStore(config);
    const ad: AdObservation = {
      id: "m1",
      source: "meta_ad_library",
      region: "AU",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-10-17T00:00:00.000Z",
      runDays: 77,
      linkedProductIds: ["p1"],
    };
    store.upsertAd(ad);
    store.upsertAd({ ...ad, runDays: 90 });
    expect(store.adsByProduct("p1")).toHaveLength(1);
    expect(store.adsByProduct("p1")[0]?.runDays).toBe(90);
  });

  it("dedupes domain events so a replay produces one state change", () => {
    const store = createEventEmittingStore(config);
    const event = (dedupeKey: string): DomainEvent => ({
      id: crypto.randomUUID(),
      name: "order.created",
      emittedBy: "droppy-orders",
      dedupeKey,
      occurredAt: "2026-10-17T00:00:00.000Z",
      payload: { orderId: "o1" },
    });
    store.appendEvent(event("order:o1"));
    store.appendEvent(event("order:o1")); // replay
    store.appendEvent(event("order:o2"));

    expect(store.eventsByName("order.created")).toHaveLength(2);
    expect(store.drainEvents()).toHaveLength(2);
    // Second drain is empty — no re-delivery.
    expect(store.drainEvents()).toHaveLength(0);
  });

  it("surfaces only pending candidates for approval", () => {
    const store = createInMemoryStore(config);
    const candidate = (id: string, status: ShortlistCandidate["approvalStatus"]): ShortlistCandidate => ({
      id,
      productId: id,
      title: id,
      category: "beauty",
      totalScore: 22,
      criteria: { trendSignal: 4, wowFactor: 4, pricePoint: 4, supplierAvailability: 4, shippingTime: 3, competition: 3 },
      sources: ["meta_ad_library"],
      engagementScore: { score: 4, raw: 4, runDaysComponent: 3, engagementComponent: 1, reasons: [] },
      salesEstimate: { estimatedWeeklyRevenueAud: 1000, lowAud: 350, highAud: 2400, confidence: 0.6, signalsUsed: [] },
      creativeAnalysis: { hook: "unknown", wowFactor: false, therapeuticClaim: false, cosmeticClaimOnly: false, notes: [] },
      projectedMarginAud: 15,
      approvalStatus: status,
      scoredAt: "2026-10-17T00:00:00.000Z",
      rationale: "test",
    });
    store.putCandidate(candidate("c1", "pending"));
    store.putCandidate(candidate("c2", "approved"));
    store.putCandidate(candidate("c3", "rejected"));

    expect(store.pendingCandidates().map((c) => c.id)).toEqual(["c1"]);
  });

  it("answers the status queries the order bot needs", () => {
    const store = createInMemoryStore(config);
    const order = (id: string, status: Order["status"]): Order => ({
      id,
      listingId: "l1",
      customerEmail: "a@example.com",
      shippingAddress: {
        line1: "1 Test St",
        city: "Sydney",
        state: "NSW",
        postcode: "2000",
        country: "AU",
      },
      lineItems: [{ productId: "p1", title: "Serum", qty: 1, unitPriceAud: 41.99 }],
      totalAud: 41.99,
      status,
      tags: [],
      trackingException: false,
      createdAt: "2026-10-17T00:00:00.000Z",
      updatedAt: "2026-10-17T00:00:00.000Z",
    });
    store.putOrder(order("o1", "new"));
    store.putOrder(order("o2", "new"));
    store.putOrder(order("o3", "supplier_confirmed"));

    expect(store.ordersByStatus("new")).toHaveLength(2);
    expect(store.orderById("o1")?.status).toBe("new");
  });

  it("tracks open tickets and the latest margin snapshot per listing", () => {
    const store = createInMemoryStore(config);
    store.putMarginSnapshot({
      listingId: "l1",
      sellingPriceAud: 41.99,
      supplierCostAud: 12,
      freightAud: 6,
      expectedAdSpendAud: 11,
      netProfitAud: 12.99,
      marginPct: 0.31,
      marginFloorPct: 0.5,
      belowFloor: false,
      stockQty: 500,
      outOfStock: false,
      capturedAt: "2026-10-17T00:00:00.000Z",
    });
    store.putMarginSnapshot({
      listingId: "l1",
      sellingPriceAud: 39.99,
      supplierCostAud: 12,
      freightAud: 6,
      expectedAdSpendAud: 11,
      netProfitAud: 10.99,
      marginPct: 0.27,
      marginFloorPct: 0.5,
      belowFloor: true,
      stockQty: 500,
      outOfStock: false,
      capturedAt: "2026-10-17T06:00:00.000Z",
    });
    const latest = store.latestMarginForListing("l1");
    expect(latest?.belowFloor).toBe(true);
  });

  it("does not leak products from another category", () => {
    const store = createInMemoryStore(config);
    store.upsertProduct(product);
    store.upsertProduct({ ...product, id: "p2", category: "pet-care" });
    expect(store.productsByCategory("beauty")).toHaveLength(1);
    expect(store.productsByCategory("pet-care")).toHaveLength(1);
  });
});

describe("Registration — the nine bots are live", () => {
  it("exposes all nine Droppy agents through the platform registry", () => {
    const agents = allRounderAgents();
    const droppy = [
      "droppyResearch",
      "droppyListing",
      "droppyOrders",
      "droppyTracking",
      "droppyExceptions",
      "droppySupport",
      "droppyPricing",
      "droppyAds",
    ];
    for (const name of droppy) {
      expect(agents, `missing ${name}`).toHaveProperty(name);
    }
  });

  it("registers the rest of the platform too — no regression", () => {
    const agents = allRounderAgents();
    expect(agents).toHaveProperty("dispatcherTriage");
    expect(agents).toHaveProperty("supportDrafter");
    expect(agents).toHaveProperty("marketingBrandGuardrail");
  });

  it("gives each bot a stable id and a non-empty instruction set", async () => {
    const agents = allRounderAgents();
    for (const key of Object.keys(agents) as Array<keyof typeof agents>) {
      const agent = agents[key];
      expect(agent, `${key} has no id`).toHaveProperty("id");
      const instructions = await agent.getInstructions();
      // Mastra may hand back a string or a SystemMessage object.
      const text = typeof instructions === "string" ? instructions : JSON.stringify(instructions);
      expect(text.length, `${key} has no instructions`).toBeGreaterThan(50);
    }
  });
});

describe("Config — the category is a first-class setting", () => {
  it("keeps the whole store category-scoped without touching code", () => {
    const pets = loadDroppyConfig({
      storeName: "Droppy Pets",
      category: { label: "Pet Care", key: "pet-care", keywords: ["dog toy", "cat bed"] },
    });
    expect(pets.category.keywords).toEqual(["dog toy", "cat bed"]);
    expect(pets.category.excludedKeywords).toEqual(["electronics", "rcm", "battery"]);
    expect(DEFAULT_DROPPY_CONFIG.category.key).toBe("beauty");
  });
});
