import { describe, expect, it } from "vitest";

import {
  analyseCreative,
  applyPricingRule,
  estimateSales,
  scoreCriteria,
  scoreEngagement,
  totalScore,
} from "../tools/scoring.js";
import { scoreProduct } from "../tools/collectors.js";
import { DEFAULT_DROPPY_CONFIG, loadDroppyConfig } from "../settings.js";
import type { AdObservation, Product, TikTokShopListing } from "../contracts.js";

const config = loadDroppyConfig();

describe("Engine 1 — Minea-style engagement scoring", () => {
  it("dominates on run-days: a 90-day ad outranks a high-engagement 1-day ad", () => {
    const longRunning = scoreEngagement(
      { runDays: 90, views: 100_000, likes: 1000, comments: 100, shares: 50 },
      config,
    );
    const freshButViral = scoreEngagement(
      { runDays: 1, views: 1_000_000, likes: 100_000, comments: 10_000, shares: 5000 },
      config,
    );
    expect(longRunning.runDaysComponent).toBe(5);
    // Both saturate the 5 cap, so the ranking has to come from the raw sum —
    // otherwise a 1-day viral ad and a 90-day profitable ad are indistinguishable.
    expect(longRunning.score).toBe(5);
    expect(freshButViral.score).toBe(5);
    expect(longRunning.raw).toBeGreaterThan(freshButViral.raw);
    expect(longRunning.reasons.join(" ")).toContain("90d");
  });

  it("floors to 1 when a source exposes no engagement signals", () => {
    const none = scoreEngagement({}, config);
    expect(none.score).toBe(1);
    expect(none.reasons.join(" ")).toContain("floored");
  });

  it("captions the saturation point honestly", () => {
    const atCap = scoreEngagement({ runDays: 200, views: 50_000, likes: 500, comments: 50, shares: 20 }, config);
    expect(atCap.runDaysComponent).toBe(5);
  });
});

describe("Engine 2 — Kalodata-style sales estimation", () => {
  it("refuses to estimate below the view floor", () => {
    const tooSmall = estimateSales({ views: 100, soldCount: 50, priceAud: 39.99 }, config);
    expect(tooSmall.confidence).toBe(0);
    expect(tooSmall.estimatedWeeklyRevenueAud).toBe(0);
    expect(tooSmall.signalsUsed.join(" ")).toContain("floor");
  });

  it("produces an interval that brackets the point estimate", () => {
    const est = estimateSales(
      { views: 100_000, likes: 2000, comments: 400, shares: 100, soldCount: 300, priceAud: 39.99, commissionRate: 0.15 },
      config,
    );
    expect(est.lowAud).toBeLessThan(est.estimatedWeeklyRevenueAud);
    expect(est.highAud).toBeGreaterThan(est.estimatedWeeklyRevenueAud);
    expect(est.confidence).toBeGreaterThan(0.5);
    // Commission is the strongest signal, so it must be named.
    expect(est.signalsUsed.join(" ")).toContain("commission");
  });

  it("is less confident with less evidence", () => {
    const rich = estimateSales({ views: 200_000, soldCount: 500, commissionRate: 0.2 }, config);
    const poor = estimateSales({ views: 6_000 }, config);
    expect(rich.confidence).toBeGreaterThan(poor.confidence);
  });
});

describe("Engine 3 — PipiADS-style creative analysis (TGA)", () => {
  it("flags a therapeutic claim", () => {
    const bad = analyseCreative({ headline: "Cures acne permanently and treats eczema" }, config);
    expect(bad.therapeuticClaim).toBe(true);
    expect(bad.cosmeticClaimOnly).toBe(false);
  });

  it("passes a cosmetic claim", () => {
    const good = analyseCreative({ headline: "Brightens the appearance of skin" }, config);
    expect(good.therapeuticClaim).toBe(false);
    expect(good.cosmeticClaimOnly).toBe(true);
  });

  it("detects a before/after hook, the wow-factor signal", () => {
    const hook = analyseCreative({ headline: "Before and after: results in 7 days" }, config);
    expect(hook.hook).toBe("before_after");
    expect(hook.wowFactor).toBe(true);
  });

  it("says unknown rather than guessing when there is no text", () => {
    const none = analyseCreative({}, config);
    expect(none.hook).toBe("unknown");
  });
});

describe("The composite — six criteria, 0-30", () => {
  it("scores a strong candidate above the 20/30 threshold", () => {
    const criteria = scoreCriteria(
      {
        engagement: scoreEngagement({ runDays: 120, views: 200_000, likes: 5000, comments: 800, shares: 200 }, config),
        estimate: estimateSales({ views: 200_000, soldCount: 400, commissionRate: 0.15 }, config),
        creative: analyseCreative({ headline: "Before and after: visibly brightens the appearance of skin" }, config),
        supplierCostAud: 12,
        freightAud: 6,
        inStock: true,
        warehouse: "AU-Sydney",
        stockQty: 500,
        competitorCount: 2,
      },
      config,
    );
    const { total, proceeds, threshold } = totalScore(criteria, config);
    expect(total).toBeGreaterThanOrEqual(threshold);
    expect(proceeds).toBe(true);
    expect(threshold).toBe(20);
  });

  it("floors every criterion with no evidence rather than inventing a score", () => {
    const criteria = scoreCriteria({}, config);
    expect(criteria.trendSignal).toBe(1);
    expect(criteria.wowFactor).toBe(1);
    expect(criteria.pricePoint).toBe(1);
    expect(criteria.supplierAvailability).toBe(1);
    expect(criteria.shippingTime).toBe(1);
    expect(criteria.competition).toBe(5); // no data assumed benign, and it says so
    expect(Object.keys(criteria.reasons)).toHaveLength(6);
  });

  it("penalises a product at 5 competing stores", () => {
    const crowded = scoreCriteria({ competitorCount: 6 }, config);
    expect(crowded.competition).toBe(1);
  });

  it("rewards an AU warehouse on the shipping criterion", () => {
    const au = scoreCriteria({ inStock: true, warehouse: "AU-Melbourne" }, config);
    const cn = scoreCriteria({ inStock: true, warehouse: "CN-Shenzhen" }, config);
    expect(au.shippingTime).toBe(5);
    expect(au.shippingTime).toBeGreaterThan(cn.shippingTime);
  });

  it("reads the threshold from config, not a constant", () => {
    const strict = loadDroppyConfig({ shortlist: { proceedThreshold: 28 } });
    const criteria = { trendSignal: 5, wowFactor: 5, pricePoint: 5, supplierAvailability: 5, shippingTime: 5, competition: 4 }; // 29
    expect(totalScore(criteria, strict).total).toBe(29);
    expect(totalScore(criteria, strict).proceeds).toBe(true);
    expect(totalScore(criteria, strict).threshold).toBe(28);

    const lax = loadDroppyConfig({ shortlist: { proceedThreshold: 30 } });
    expect(totalScore(criteria, lax).proceeds).toBe(false); // 29 < 30
  });
});

describe("The pricing rule", () => {
  it("applies cost x 3.5, clamps, and always ends in .99", () => {
    expect(applyPricingRule(12, config)).toBe(41.99); // 42 → 41.99
    expect(applyPricingRule(1, config)).toBe(29.99); // clamped to min
    expect(applyPricingRule(100, config)).toBe(79.99); // clamped to max
  });

  it("never emits a price that is not .99", () => {
    for (const cost of [5, 8.5, 12, 15.75, 22.9, 30, 45, 60]) {
      expect(applyPricingRule(cost, config) % 1).toBeCloseTo(0.99, 5);
    }
  });
});

describe("scoreProduct — one product, three engines, attributed", () => {
  const product: Product = {
    id: "p1",
    title: "Vitamin C Brightening Serum",
    supplierId: "cj_dropshipping",
    supplierSku: "VID-1",
    category: "beauty",
    region: "AU",
    supplierCostAud: 12,
    freightAud: 6,
    warehouse: "AU-Sydney",
    inStock: true,
    stockQty: 500,
    images: [],
    observedAt: new Date().toISOString(),
  };

  const ads: AdObservation[] = [
    {
      id: "a1",
      source: "meta_ad_library",
      advertiserName: "Glow Co",
      creativeUrl: "https://example.com/v.mp4",
      headline: "Before and after: visibly brightens the appearance of skin",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-10-17T00:00:00.000Z",
      region: "AU",
      likes: 5000,
      comments: 800,
      shares: 200,
      views: 200_000,
      runDays: 77,
      linkedProductIds: ["p1"],
    },
    {
      id: "a2",
      source: "tiktok_creative_center",
      advertiserName: "Glow Co",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-10-17T00:00:00.000Z",
      region: "AU",
      likes: 2000,
      comments: 400,
      shares: 100,
      views: 90_000,
      runDays: 77,
      linkedProductIds: ["p1"],
    },
  ];

  const listing: TikTokShopListing = {
    id: "p1",
    title: "Vitamin C Brightening Serum",
    shopId: "s1",
    shopName: "Glow Official",
    region: "AU",
    priceAud: 39.99,
    soldCount: 400,
    estimatedRevenueAud: 16_000,
    rating: 4.8,
    reviewCount: 320,
    commissionRate: 0.15,
    observedAt: new Date().toISOString(),
  };

  it("combines all three engines and attributes every source", () => {
    const scored = scoreProduct(product, ads, listing, config);
    expect(scored.sources).toContain("meta_ad_library");
    expect(scored.sources).toContain("tiktok_creative_center");
    expect(scored.sources).toContain("tiktok_shop");
    expect(scored.suggestedPriceAud).toBe(41.99);
    expect(scored.totalScore).toBeGreaterThanOrEqual(20);
    expect(scored.projectedMarginAud).toBeGreaterThan(0);
  });

  it("blocks a therapeutic claim at the composite layer", () => {
    const badAds = ads.map((a, i) =>
      i === 0 ? { ...a, headline: "Cures acne and treats eczema" } : a,
    );
    const scored = scoreProduct(product, badAds, listing, config);
    expect(scored.creativeAnalysis?.therapeuticClaim).toBe(true);
    expect(scored.rationale).toContain("TGA RISK");
  });

  it("is honest about being single-source", () => {
    const single = scoreProduct(product, [ads[0]!], undefined, config);
    expect(single.sources).toEqual(["meta_ad_library"]);
    expect(single.rationale).toContain("meta_ad_library");
  });
});

describe("Config", () => {
  it("ships the original spec's defaults", () => {
    expect(DEFAULT_DROPPY_CONFIG.pricing).toEqual({
      multiplier: 3.5,
      minAud: 29.99,
      maxAud: 79.99,
      priceEnding: 0.99,
    });
    expect(DEFAULT_DROPPY_CONFIG.region.countryCode).toBe("AU");
    expect(DEFAULT_DROPPY_CONFIG.suppliers[0]).toBe("cj_dropshipping");
    expect(DEFAULT_DROPPY_CONFIG.channel.provider).toBe("shopify");
  });

  it("is category-agnostic: changing the category is a config change", () => {
    const petStore = loadDroppyConfig({
      storeName: "Droppy Pets",
      category: { label: "Pet Care", key: "pet-care", keywords: ["dog toy"] },
    });
    expect(petStore.category.key).toBe("pet-care");
    expect(petStore.storeName).toBe("Droppy Pets");
    // Everything else is unchanged.
    expect(petStore.pricing).toEqual(DEFAULT_DROPPY_CONFIG.pricing);
  });

  it("rejects a malformed category key", () => {
    expect(() =>
      loadDroppyConfig({ category: { label: "X", key: "Not Valid" } }),
    ).toThrow(/config invalid/i);
  });
});
