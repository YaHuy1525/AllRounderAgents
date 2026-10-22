import type {
  AdObservation,
  Product,
  ShortlistCandidate,
  Source,
  TikTokShopListing,
} from "../contracts.js";
import type { DroppyConfig } from "../config.js";
import { analyseCreative, estimateSales, scoreCriteria, scoreEngagement, totalScore } from "./scoring.js";

/**
 * Layer 1 — bounded collectors.
 *
 * These are the FREE data sources (PLAN §1, bucket F): Meta Ad Library, TikTok
 * Creative Centre, Pinterest Trends, Google Trends, and the supplier catalogues.
 * We call them, we do not rebuild them.
 *
 * Bounded on purpose: AU only, human rate, our own accounts. That is what keeps
 * the project free and legal (PLAN §5), and it is the honest scope. We will
 * never have a 100M-ad index. We do not need one — we run one store, in one
 * category, in one country.
 *
 * Every collector returns normalised rows. Vendor field names live here and
 * nowhere else: the domain model never sees them.
 */

/** A raw row from any source, before normalisation. */
export type RawRow = Record<string, unknown>;

/** Why a collection run produced nothing. Surfaced, never silently swallowed. */
export type CollectionOutcome =
  | { kind: "ok"; rows: number }
  | { kind: "rate_limited"; retryAfterMinutes: number }
  | { kind: "unavailable"; reason: string }
  | { kind: "empty"; reason: string };

export interface Collector {
  readonly source: Source;
  /** Human label for logs and the UI. */
  readonly label: string;
  /**
   * Collect bounded rows for the configured category. Implementations must
   * respect config.collection limits and must never exceed them.
   */
  collect(config: DroppyConfig): Promise<{ rows: RawRow[]; outcome: CollectionOutcome }>;
}

/**
 * Normalise one raw row into an AdObservation.
 *
 * Each source has its own shape. This is the only place that knows it. A row
 * that cannot be normalised is dropped and counted — partial trust is worse
 * than none, because a half-parsed ad looks like evidence.
 */
export function normaliseAdRow(
  source: Source,
  raw: RawRow,
  config: DroppyConfig,
): AdObservation | null {
  const region = String(raw["region"] ?? config.region.countryCode);
  const firstSeen = toDate(raw["firstSeenAt"] ?? raw["start_date"] ?? raw["created_at"]);
  const lastSeen = toDate(raw["lastSeenAt"] ?? raw["end_date"] ?? raw["created_at"]);
  if (!firstSeen) return null;

  const runDaysRaw = raw["runDays"] ?? raw["run_days"];
  const runDays =
    typeof runDaysRaw === "number"
      ? runDaysRaw
      : firstSeen && lastSeen
        ? Math.max(0, Math.round((lastSeen.getTime() - firstSeen.getTime()) / 86_400_000))
        : 0;

  return {
    id: String(raw["id"] ?? crypto.randomUUID()),
    source,
    advertiserName: optionalString(raw["advertiserName"] ?? raw["page_name"]),
    creativeUrl: optionalUrl(raw["creativeUrl"] ?? raw["video_url"]),
    headline: optionalString(raw["headline"] ?? raw["ad_text"]),
    firstSeenAt: firstSeen.toISOString(),
    lastSeenAt: (lastSeen ?? firstSeen).toISOString(),
    region,
    likes: optionalInt(raw["likes"] ?? raw["like_count"]),
    comments: optionalInt(raw["comments"] ?? raw["comment_count"]),
    shares: optionalInt(raw["shares"] ?? raw["share_count"]),
    views: optionalInt(raw["views"] ?? raw["play_count"]),
    runDays,
    linkedProductIds: Array.isArray(raw["linkedProductIds"])
      ? (raw["linkedProductIds"] as string[])
      : [],
  };
}

/** Normalise a supplier or TikTok Shop row into a Product. */
export function normaliseProductRow(
  raw: RawRow,
  config: DroppyConfig,
): Product | null {
  const title = optionalString(raw["title"] ?? raw["productName"]);
  if (!title) return null;
  return {
    id: String(raw["id"] ?? crypto.randomUUID()),
    title,
    supplierId: String(raw["supplierId"] ?? "unknown"),
    supplierSku: optionalString(raw["supplierSku"] ?? raw["vid"]),
    category: config.category.key,
    region: config.region.countryCode,
    supplierCostAud: optionalNumber(raw["supplierCostAud"] ?? raw["cost"]),
    freightAud: optionalNumber(raw["freightAud"] ?? raw["freight"]),
    warehouse: optionalString(raw["warehouse"] ?? raw["warehouseName"]),
    inStock: typeof raw["inStock"] === "boolean" ? raw["inStock"] : undefined,
    stockQty: optionalInt(raw["stockQty"] ?? raw["stock"]),
    images: Array.isArray(raw["images"])
      ? (raw["images"] as unknown[]).filter((u): u is string => typeof u === "string")
      : [],
    observedAt: new Date().toISOString(),
  };
}

/** Normalise a TikTok Shop row. Kalodata-shaped. */
export function normaliseTikTokShopRow(
  raw: RawRow,
  config: DroppyConfig,
): TikTokShopListing | null {
  const title = optionalString(raw["title"] ?? raw["product_name"]);
  if (!title) return null;
  return {
    id: String(raw["id"] ?? raw["product_id"] ?? crypto.randomUUID()),
    title,
    shopId: optionalString(raw["shopId"] ?? raw["shop_id"]),
    shopName: optionalString(raw["shopName"] ?? raw["shop_name"]),
    region: String(raw["region"] ?? config.region.countryCode),
    priceAud: optionalNumber(raw["priceAud"] ?? raw["price"]),
    soldCount: optionalInt(raw["soldCount"] ?? raw["sold_count"]),
    estimatedRevenueAud: optionalNumber(
      raw["estimatedRevenueAud"] ?? raw["estimated_revenue"],
    ),
    rating: optionalNumber(raw["rating"]),
    reviewCount: optionalInt(raw["reviewCount"] ?? raw["review_count"]),
    commissionRate: optionalNumber(raw["commissionRate"] ?? raw["commission_rate"]),
    observedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrichment: turn raw rows into scored candidates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Combine the three engines over one product.
 *
 * This is the teardown's payoff: one product, scored by all three engines, with
 * every input attributed. The original tools each score independently and
 * charge separately for it.
 */
export function scoreProduct(
  product: Product,
  ads: AdObservation[],
  listing: TikTokShopListing | undefined,
  config: DroppyConfig,
): Omit<ShortlistCandidate, "id" | "scoredAt" | "approvalStatus"> {
  const engagement = scoreEngagement(
    {
      runDays: maxRunDays(ads),
      views: sumViews(ads),
      likes: sumLikes(ads),
      comments: sumComments(ads),
      shares: sumShares(ads),
    },
    config,
  );

  const estimate = estimateSales(
    {
      views: listing ? Math.max(listing.reviewCount ?? 0, listing.soldCount ?? 0) * 20 : sumViews(ads),
      likes: sumLikes(ads),
      comments: sumComments(ads),
      shares: sumShares(ads),
      soldCount: listing?.soldCount,
      priceAud: listing?.priceAud ?? product.supplierCostAud,
      commissionRate: listing?.commissionRate,
      runDays: maxRunDays(ads),
    },
    config,
  );

  const creative = analyseCreative(
    {
      headline: ads[0]?.headline,
      body: ads[0]?.headline,
      hasVisualBeforeAfter: undefined,
    },
    config,
  );

  const criteria = scoreCriteria(
    {
      engagement,
      estimate,
      creative,
      supplierCostAud: product.supplierCostAud,
      freightAud: product.freightAud,
      inStock: product.inStock,
      warehouse: product.warehouse,
      stockQty: product.stockQty,
      competitorCount: ads.length,
    },
    config,
  );

  const { total, proceeds, threshold } = totalScore(criteria, config);

  return {
    productId: product.id,
    title: product.title,
    category: config.category.key,
    totalScore: total,
    criteria: {
      trendSignal: criteria.trendSignal,
      wowFactor: criteria.wowFactor,
      pricePoint: criteria.pricePoint,
      supplierAvailability: criteria.supplierAvailability,
      shippingTime: criteria.shippingTime,
      competition: criteria.competition,
    },
    sources: uniqueSources(ads, listing),
    engagementScore: engagement,
    salesEstimate: estimate,
    creativeAnalysis: creative,
    projectedMarginAud: projectedMargin(product, config),
    suggestedPriceAud:
      product.supplierCostAud !== undefined
        ? applyPricing(product.supplierCostAud, config)
        : undefined,
    rationale: [
      `score ${total}/30 (threshold ${threshold}, ${proceeds ? "proceeds" : "below"})`,
      `sources: ${uniqueSources(ads, listing).join(", ")}`,
      `estimate confidence ${estimate.confidence}`,
      creative.therapeuticClaim ? "TGA RISK: therapeutic claim" : "TGA clean",
    ].join("; "),
  };
}

function projectedMargin(
  product: Product,
  config: DroppyConfig,
): number | undefined {
  if (product.supplierCostAud === undefined) return undefined;
  const price = applyPricing(product.supplierCostAud, config);
  const freight = product.freightAud ?? 0;
  // Expected ad spend per sale: $8-15 when optimised, per the original spec.
  const adSpend = 11;
  return round2(price - product.supplierCostAud - freight - adSpend);
}

function applyPricing(supplierCostAud: number, config: DroppyConfig): number {
  const { multiplier, minAud, maxAud, priceEnding } = config.pricing;
  const raw = supplierCostAud * multiplier;
  const clamped = Math.min(Math.max(raw, minAud), maxAud);
  return round2(Math.min(Math.max(Math.floor(clamped) + priceEnding - 1, minAud), maxAud));
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function maxRunDays(ads: AdObservation[]): number | undefined {
  if (ads.length === 0) return undefined;
  return Math.max(...ads.map((a) => a.runDays ?? 0));
}
function sumViews(ads: AdObservation[]): number | undefined {
  const total = ads.reduce((s, a) => s + (a.views ?? 0), 0);
  return total > 0 ? total : undefined;
}
function sumLikes(ads: AdObservation[]): number | undefined {
  const total = ads.reduce((s, a) => s + (a.likes ?? 0), 0);
  return total > 0 ? total : undefined;
}
function sumComments(ads: AdObservation[]): number | undefined {
  const total = ads.reduce((s, a) => s + (a.comments ?? 0), 0);
  return total > 0 ? total : undefined;
}
function sumShares(ads: AdObservation[]): number | undefined {
  const total = ads.reduce((s, a) => s + (a.shares ?? 0), 0);
  return total > 0 ? total : undefined;
}

function uniqueSources(
  ads: AdObservation[],
  listing: TikTokShopListing | undefined,
): Source[] {
  const set = new Set<Source>(ads.map((a) => a.source));
  if (listing) set.add("tiktok_shop");
  return [...set];
}

function toDate(value: unknown): Date | null {
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function optionalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
