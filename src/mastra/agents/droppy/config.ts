import { z } from "zod";

/**
 * Droppy runtime configuration.
 *
 * The category is a first-class setting, not a constant. The whole store is
 * category-scoped: collectors, scoring weights, TGA lint rules, and the pricing
 * rule all read from here. Changing the category is a config change, not a
 * code change.
 */

const RegionSchema = z.object({
  /** ISO-3166 alpha-2. AU for this store. */
  countryCode: z.string().length(2).default("AU"),
  /** Currency the store sells in. */
  currency: z.string().length(3).default("AUD"),
  /** Freight is quoted to this postcode. */
  freightPostcode: z.string().default("2000"),
  /** Language for generated copy. */
  language: z.string().default("en-AU"),
});

const CategorySchema = z.object({
  /** Human label, shown in the UI and used in copy. */
  label: z.string().min(1),
  /** Machine key used in the index and in file paths. */
  key: z.string().min(1).regex(/^[a-z0-9-]+$/),
  /** Search terms fed to every collector. */
  keywords: z.array(z.string()).min(1),
  /** TikTok Shop / supplier category ids, when a source exposes them. */
  supplierCategoryIds: z.array(z.string()).default([]),
  /** Excluded subcategories. Electronics are excluded by default (RCM). */
  excludedKeywords: z.array(z.string()).default(["electronics", "rcm", "battery"]),
});

/**
 * Pricing rule. The original spec: supplier cost x 3.5, min 29.99, max 79.99,
 * always ending in .99.
 */
const PricingRuleSchema = z.object({
  multiplier: z.number().positive().default(3.5),
  minAud: z.number().positive().default(29.99),
  maxAud: z.number().positive().default(79.99),
  /** Always round down to this, then subtract one cent. */
  priceEnding: z.literal(0.99).default(0.99),
});

/**
 * Margin floor. The original spec: below 50% margin, M7 raises the price; at 0
 * stock, M7 zeroes the listing inventory.
 */
const MarginRuleSchema = z.object({
  floorPct: z.number().min(0).max(1).default(0.5),
  /** Raise price by this much when below floor. */
  escalationPct: z.number().min(0).max(1).default(0.1),
  /** Hard block: never sell below this margin, even if it means delisting. */
  hardFloorPct: z.number().min(0).max(1).default(0.3),
});

/**
 * Shortlist rule. The original spec: six criteria scored 1-5 each, summed, and
 * a candidate proceeds at 20/30 or above. That is a plain sum, so the weights
 * live in the criteria themselves, not in config — the only tunable is the
 * threshold.
 */
const ShortlistRuleSchema = z.object({
  /** Minimum total score out of 30 to shortlist. */
  proceedThreshold: z.number().int().min(1).max(30).default(20),
});

/**
 * Kalodata-style estimation tuning. The estimate engine is the hardest IP and
 * the most sensitive to its priors, so the priors are config, not code.
 */
const EstimateRuleSchema = z.object({
  /** Minimum confidence before a candidate is shortlistable. */
  minConfidence: z.number().min(0).max(1).default(0.4),
  /** Revenue per view, the base rate the model scales from. */
  revenuePerView: z.number().positive().default(0.0008),
  /** Engagement uplift applied when a source exposes engagement. */
  engagementUplift: z.number().positive().default(1.6),
  /** Views needed before the estimate is worth anything. */
  minViews: z.number().int().positive().default(5000),
});

const CollectionRuleSchema = z.object({
  /**
   * Bounded collection (strategy A). Human-scale, our own accounts, AU only.
   * This is what keeps the project free and legal — see RESEARCH-PLAN 3b.
   */
  maxAdsPerSource: z.number().int().positive().default(200),
  maxProductsPerSource: z.number().int().positive().default(100),
  /** Hard ceiling on collection runs per day, per source. */
  maxRunsPerDay: z.number().int().positive().default(4),
  /** Minimum gap between runs of the same source. */
  minIntervalMinutes: z.number().int().positive().default(30),
  /** Respect each source's robots/rate limits. Never disabled. */
  respectRateLimits: z.literal(true).default(true),
});

const ScheduleRuleSchema = z.object({
  researchCron: z.string().default("0 6 * * *"),
  adsCron: z.string().default("0 8 * * *"),
  analyticsCron: z.string().default("0 9 * * *"),
  /** M7's cadence. Every 6 hours in the original spec. */
  pricingCron: z.string().default("0 */6 * * *"),
  timezone: z.string().default("Australia/Sydney"),
});

const ComplianceRuleSchema = z.object({
  /** TGA: therapeutic claims are blocked; cosmetic claims only. */
  blockTherapeuticClaims: z.literal(true).default(true),
  /** ACL: remedy for faulty/misdescribed/unfit goods is mandatory. */
  aclRemedyMandatory: z.literal(true).default(true),
  /** GST registration threshold. */
  gstThresholdAud: z.number().positive().default(75000),
  /** Shipping estimate must be stated on every listing. */
  requireDeliveryEstimate: z.literal(true).default(true),
  /** Escalation triggers. Never auto-replied. */
  escalationKeywords: z
    .array(z.string())
    .default(["accc", "lawyer", "fraud", "sue", "legal action", "attorney"]),
});

const DroppyConfigSchema = z.object({
  storeName: z.string().min(1),
  region: RegionSchema,
  category: CategorySchema,
  pricing: PricingRuleSchema,
  margin: MarginRuleSchema,
  shortlist: ShortlistRuleSchema,
  estimate: EstimateRuleSchema,
  collection: CollectionRuleSchema,
  schedule: ScheduleRuleSchema,
  compliance: ComplianceRuleSchema,
  /** Supplier priority order. CJ first, Zendrop failover. */
  suppliers: z
    .array(z.enum(["cj_dropshipping", "zendrop"]))
    .min(1)
    .default(["cj_dropshipping", "zendrop"]),
  /** Shopify is the channel. Not recreated — see ADR 0001. */
  channel: z.object({
    provider: z.literal("shopify"),
    apiVersion: z.string().default("2025-01"),
  }),
});

export type DroppyConfig = z.infer<typeof DroppyConfigSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type PricingRule = z.infer<typeof PricingRuleSchema>;

/**
 * The default configuration. Beauty is the starting category; change
 * `category` and the whole store follows.
 */
export const DEFAULT_DROPPY_CONFIG: DroppyConfig = {
  storeName: "Droppy",
  region: {
    countryCode: "AU",
    currency: "AUD",
    freightPostcode: "2000",
    language: "en-AU",
  },
  category: {
    label: "Beauty & Personal Care",
    key: "beauty",
    keywords: [
      "skincare",
      "serum",
      "moisturiser",
      "face mask",
      "beauty tool",
      "hair care",
      "body care",
    ],
    supplierCategoryIds: [],
    excludedKeywords: ["electronics", "rcm", "battery"],
  },
  pricing: { multiplier: 3.5, minAud: 29.99, maxAud: 79.99, priceEnding: 0.99 },
  margin: { floorPct: 0.5, escalationPct: 0.1, hardFloorPct: 0.3 },
  shortlist: { proceedThreshold: 20 },
  estimate: {
    minConfidence: 0.4,
    revenuePerView: 0.0008,
    engagementUplift: 1.6,
    minViews: 5000,
  },
  collection: {
    maxAdsPerSource: 200,
    maxProductsPerSource: 100,
    maxRunsPerDay: 4,
    minIntervalMinutes: 30,
    respectRateLimits: true,
  },
  schedule: {
    researchCron: "0 6 * * *",
    adsCron: "0 8 * * *",
    analyticsCron: "0 9 * * *",
    pricingCron: "0 */6 * * *",
    timezone: "Australia/Sydney",
  },
  compliance: {
    blockTherapeuticClaims: true,
    aclRemedyMandatory: true,
    gstThresholdAud: 75000,
    requireDeliveryEstimate: true,
    escalationKeywords: [
      "accc",
      "lawyer",
      "fraud",
      "sue",
      "legal action",
      "attorney",
    ],
  },
  suppliers: ["cj_dropshipping", "zendrop"],
  channel: { provider: "shopify", apiVersion: "2025-01" },
};

/** A partial that recurses — so `category: { key: "pet-care" }` is valid. */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Load and validate config. The category is whatever the config says; nothing
 * here hard-codes beauty. Overrides are deep-partial: you can change just the
 * category key and everything else keeps its default.
 */
export function loadDroppyConfig(overrides?: DeepPartial<DroppyConfig>): DroppyConfig {
  const merged = overrides
    ? deepMerge(DEFAULT_DROPPY_CONFIG, overrides)
    : DEFAULT_DROPPY_CONFIG;
  const parsed = DroppyConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(
      `Droppy config invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (Array.isArray(base) || typeof base !== "object" || base === null) {
    return (override as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const existing = out[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}
