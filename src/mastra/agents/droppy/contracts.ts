import { z } from "zod";

/**
 * Droppy domain model.
 *
 * One data model for the whole store. Vendor field names never appear here —
 * they live in the collector layer and normalise into these shapes.
 *
 * The three research tools (Minea, PipiADS, Kalodata) are three scoring
 * engines over the SAME index. That is the whole point of the teardown: one
 * collector layer, one index, three scorers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 + 2: what the collectors gather, and the index it lands in
// ─────────────────────────────────────────────────────────────────────────────

/** Where a row came from. Every score must be attributable to a source. */
export const SourceSchema = z.enum([
  "meta_ad_library",
  "tiktok_creative_center",
  "pinterest_trends",
  "google_trends",
  "tiktok_shop",
  "amazon_au",
  "ebay_au",
  "cj_dropshipping",
]);
export type Source = z.infer<typeof SourceSchema>;

/** A raw ad observation. One row per ad per source per collection run. */
export const AdObservationSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  advertiserName: z.string().optional(),
  creativeUrl: z.string().url().optional(),
  headline: z.string().optional(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  region: z.string(),
  /** Engagement signals the source exposes. Absent when the source has none. */
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
  /** Days the ad has been continuously running. The strongest profitability proxy. */
  runDays: z.number().int().nonnegative().optional(),
  /** Products the collector could link to this ad. */
  linkedProductIds: z.array(z.string()).default([]),
});
export type AdObservation = z.infer<typeof AdObservationSchema>;

/** A product in the index. Supplied by a supplier, observed in ads, or both. */
export const ProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  supplierId: z.string(),
  supplierSku: z.string().optional(),
  category: z.string(),
  region: z.string(),
  /** Supplier unit cost in AUD. */
  supplierCostAud: z.number().nonnegative().optional(),
  /** Cheapest freight to the target AU postcode, AUD. */
  freightAud: z.number().nonnegative().optional(),
  /** Supplier warehouse the stock sits in. AU warehouse is preferred. */
  warehouse: z.string().optional(),
  inStock: z.boolean().optional(),
  stockQty: z.number().int().nonnegative().optional(),
  images: z.array(z.string().url()).default([]),
  observedAt: z.string().datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

/** A TikTok Shop product or shop, as Kalodata would see it. */
export const TikTokShopListingSchema = z.object({
  id: z.string(),
  title: z.string(),
  shopId: z.string().optional(),
  shopName: z.string().optional(),
  region: z.string(),
  priceAud: z.number().nonnegative().optional(),
  soldCount: z.number().int().nonnegative().optional(),
  /** Kalodata-style estimate. Never a real number — the source says so itself. */
  estimatedRevenueAud: z.number().nonnegative().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  commissionRate: z.number().min(0).max(1).optional(),
  observedAt: z.string().datetime(),
});
export type TikTokShopListing = z.infer<typeof TikTokShopListingSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: the three scoring engines. This is the IP.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minea-style engagement score.
 *
 * The real Minea weights are proprietary. These reproduce the documented
 * behaviour: long-running ads matter most, engagement per view second, and a
 * source that exposes no engagement signals cannot score above the floor.
 */
export const EngagementScoreSchema = z.object({
  /** 0-5, one decimal. */
  score: z.number().min(0).max(5),
  /** Uncapped sum of the components. Ties at the 5 cap are broken on this. */
  raw: z.number().min(0),
  runDaysComponent: z.number().min(0).max(5),
  engagementComponent: z.number().min(0).max(5),
  /** Why the score is what it is. Required — an unattributed score is not evidence. */
  reasons: z.array(z.string()).min(1),
});
export type EngagementScore = z.infer<typeof EngagementScoreSchema>;

/**
 * Kalodata-style sales estimate.
 *
 * Kalodata infers revenue from public signals and says its own figures "may
 * differ from real numbers". We reproduce the *shape* of that inference and
 * carry the uncertainty explicitly rather than pretending to precision.
 */
export const SalesEstimateSchema = z.object({
  estimatedWeeklyRevenueAud: z.number().nonnegative(),
  /** The interval we would actually act on. Wide is honest. */
  lowAud: z.number().nonnegative(),
  highAud: z.number().nonnegative(),
  /** 0-1. Below ~0.4 the estimate is not actionable. */
  confidence: z.number().min(0).max(1),
  signalsUsed: z.array(z.string()).min(1),
});
export type SalesEstimate = z.infer<typeof SalesEstimateSchema>;

/** PipiADS-style creative analysis. What the ad is actually doing. */
export const CreativeAnalysisSchema = z.object({
  /** Hook type the creative opens with. */
  hook: z.enum([
    "before_after",
    "problem_solution",
    "testimonial",
    "demo",
    "ugc",
    "influencer",
    "text_only",
    "unknown",
  ]),
  /** Whether the ad shows a visible before/after or problem being solved. */
  wowFactor: z.boolean(),
  /** Whether the ad makes a therapeutic claim (TGA risk). */
  therapeuticClaim: z.boolean(),
  /** Whether the ad is cosmetic-claim only (TGA safe). */
  cosmeticClaimOnly: z.boolean(),
  notes: z.array(z.string()).default([]),
});
export type CreativeAnalysis = z.infer<typeof CreativeAnalysisSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The shortlist: what R1 emits, and what L2 consumes
// ─────────────────────────────────────────────────────────────────────────────

/** One scored candidate. Emitted by R1, gated by human approval, consumed by L2. */
export const ShortlistCandidateSchema = z.object({
  id: z.string(),
  productId: z.string(),
  title: z.string(),
  category: z.string(),
  /** Total 0-30. The original spec's threshold: proceed at >=20. */
  totalScore: z.number().min(0).max(30),
  /** The six criteria, 1-5 each. Source-attributed. */
  criteria: z.object({
    trendSignal: z.number().min(1).max(5),
    wowFactor: z.number().min(1).max(5),
    pricePoint: z.number().min(1).max(5),
    supplierAvailability: z.number().min(1).max(5),
    shippingTime: z.number().min(1).max(5),
    competition: z.number().min(1).max(5),
  }),
  /** Per-source evidence. A candidate with one source is a hypothesis, not a pick. */
  sources: z.array(SourceSchema).min(1),
  engagementScore: EngagementScoreSchema.optional(),
  salesEstimate: SalesEstimateSchema.optional(),
  creativeAnalysis: CreativeAnalysisSchema.optional(),
  /** Computed from supplier cost + freight + expected ad spend. */
  projectedMarginAud: z.number().optional(),
  /** Pricing rule output: supplier cost x 3.5, clamped, always .99. */
  suggestedPriceAud: z.number().optional(),
  /** Human gate. Never auto-approve. */
  approvalStatus: z.enum(["pending", "approved", "rejected"]).default("pending"),
  approvedBy: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
  scoredAt: z.string().datetime(),
  /** Free-text rationale, source-attributed. */
  rationale: z.string(),
});
export type ShortlistCandidate = z.infer<typeof ShortlistCandidateSchema>;

/** A live listing on the Shopify store. */
export const ListingSchema = z.object({
  id: z.string(),
  shopifyProductId: z.string().optional(),
  productId: z.string(),
  title: z.string(),
  descriptionHtml: z.string(),
  tags: z.array(z.string()).default([]),
  priceAud: z.number().positive(),
  compareAtPriceAud: z.number().positive().optional(),
  inventoryQty: z.number().int().nonnegative().default(0),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
  deliveryEstimateDays: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Listing = z.infer<typeof ListingSchema>;

/** Margin snapshot. M7's whole job. */
export const MarginSnapshotSchema = z.object({
  listingId: z.string(),
  sellingPriceAud: z.number().positive(),
  supplierCostAud: z.number().nonnegative(),
  freightAud: z.number().nonnegative(),
  /** Expected ad spend per sale, from A8's actuals. */
  expectedAdSpendAud: z.number().nonnegative(),
  netProfitAud: z.number(),
  /** Net profit / selling price. The original spec's floor is 50%. */
  marginPct: z.number(),
  marginFloorPct: z.number().default(0.5),
  belowFloor: z.boolean(),
  stockQty: z.number().int().nonnegative(),
  outOfStock: z.boolean(),
  capturedAt: z.string().datetime(),
});
export type MarginSnapshot = z.infer<typeof MarginSnapshotSchema>;

/** An ad set and its performance. A8's whole job. */
export const AdSetPerformanceSchema = z.object({
  adSetId: z.string(),
  listingId: z.string(),
  name: z.string(),
  /** broad | interest | lookalike */
  audienceType: z.enum(["broad", "interest", "lookalike"]),
  dailyBudgetAud: z.number().positive(),
  status: z.enum(["active", "paused"]).default("active"),
  spendAud: z.number().nonnegative().default(0),
  revenueAud: z.number().nonnegative().default(0),
  impressions: z.number().int().nonnegative().default(0),
  clicks: z.number().int().nonnegative().default(0),
  conversions: z.number().int().nonnegative().default(0),
  roas: z.number().nonnegative().default(0),
  ctr: z.number().nonnegative().default(0),
  capturedAt: z.string().datetime(),
});
export type AdSetPerformance = z.infer<typeof AdSetPerformanceSchema>;

/** A support ticket. S6's whole job. */
export const SupportTicketSchema = z.object({
  id: z.string(),
  orderId: z.string().optional(),
  customerEmail: z.string(),
  subject: z.string(),
  body: z.string(),
  /** S6's classification. */
  kind: z.enum([
    "wismo",
    "return_request",
    "damaged_or_wrong",
    "cancel_request",
    "unknown",
  ]),
  /** ACL rule: faulty/misdescribed/unfit goods get a remedy, no questions asked. */
  aclApplies: z.boolean().default(false),
  /** Contains ACCC / lawyer / fraud — escalate immediately, never auto-reply. */
  requiresEscalation: z.boolean().default(false),
  status: z.enum(["open", "auto_replied", "escalated", "resolved"]).default("open"),
  replyBody: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type SupportTicket = z.infer<typeof SupportTicketSchema>;

/** Order lifecycle. O3, T4, X5. */
export const OrderSchema = z.object({
  id: z.string(),
  shopifyOrderId: z.string().optional(),
  listingId: z.string().optional(),
  customerEmail: z.string(),
  shippingAddress: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    postcode: z.string(),
    country: z.string().length(2),
  }),
  lineItems: z
    .array(
      z.object({
        productId: z.string(),
        title: z.string(),
        qty: z.number().int().positive(),
        unitPriceAud: z.number().positive(),
      }),
    )
    .min(1),
  totalAud: z.number().positive(),
  status: z.enum([
    "new",
    "address_validated",
    "supplier_confirmed",
    "shipped",
    "delivered",
    "exception",
    "cancelled",
    "refunded",
  ]).default("new"),
  supplierOrderId: z.string().optional(),
  trackingNumber: z.string().optional(),
  trackingException: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Order = z.infer<typeof OrderSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Events. ADR 0002: no bot talks to another bot. They emit these.
// ─────────────────────────────────────────────────────────────────────────────

export const EventNameSchema = z.enum([
  "product.shortlisted",
  "listing.created",
  "order.created",
  "order.supplier_confirmed",
  "logistics.update",
  "tracking.exception",
  "support.email",
  "margin.breach",
  "ad.performance",
]);
export type EventName = z.infer<typeof EventNameSchema>;

export const DomainEventSchema = z.object({
  id: z.string(),
  name: EventNameSchema,
  /** The bot or adapter that emitted it. For loop detection. */
  emittedBy: z.string(),
  /** Idempotency key. Replaying the same event must produce one state change. */
  dedupeKey: z.string(),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;
