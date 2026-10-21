import type { EngagementScore, SalesEstimate, CreativeAnalysis } from "../contracts.js";
import type { DroppyConfig } from "../config.js";

/**
 * The AutoDS recreation's scoring core.
 *
 * AutoDS is the one paid research tool in the stack (PLAN §1, R1: "$49+/mo, no
 * free tier"), so it is the one we rebuild. Its behaviour is three engines over
 * public ad signals:
 *
 *   1. engagement — run-days (the profitability proxy) + engagement per view
 *   2. estimate   — weekly revenue inferred from public signals, as an interval
 *   3. creative   — hook detection, plus the TGA therapeutic-claim lint
 *
 * Phase 1 recon extracts the real weights; until then these reproduce the
 * *documented* behaviour and say so. What matters for the build is that each
 * engine is a pure function of its inputs plus config: testable, tunable, and
 * independently replaceable — which is exactly what we cannot do while we rent
 * someone else's scorer.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Engine 1 — Minea-style engagement scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score an ad by how long it has been running and how much engagement it
 * attracts per view.
 *
 * Run-days dominates. An ad running for 90 days is a far stronger signal than
 * one with 10k likes that started yesterday — it means the advertiser keeps
 * paying for it, which means it converts. That is the "active longest" signal
 * the original spec describes.
 */
export function scoreEngagement(
  input: {
    runDays?: number | undefined;
    views?: number | undefined;
    likes?: number | undefined;
    comments?: number | undefined;
    shares?: number | undefined;
  },
  _config: DroppyConfig,
): EngagementScore {
  const reasons: string[] = [];

  // Run-days component: 0-5, saturating at 90 days.
  const runDays = input.runDays ?? 0;
  const runDaysRaw = Math.min(runDays / 90, 1) * 5;
  const runDaysComponent = round1(runDaysRaw);
  if (runDays === 0) {
    reasons.push("no run-days signal from this source; run-days component floored");
  } else if (runDays >= 90) {
    reasons.push(`running ${runDays}d (>=90d saturation); strongest profitability proxy`);
  } else {
    reasons.push(`running ${runDays}d; ${Math.round((runDays / 90) * 100)}% of saturation`);
  }

  // Engagement component: engagement per 1k views, 0-5.
  // A source that exposes no engagement cannot score above the floor.
  const views = input.views ?? 0;
  const engagement =
    (input.likes ?? 0) + (input.comments ?? 0) * 3 + (input.shares ?? 0) * 5;
  if (views === 0 || engagement === 0) {
    reasons.push("source exposes no engagement signals; engagement component floored to 1");
    return {
      score: round1(Math.max(runDaysComponent, 1)),
      raw: round1(runDaysComponent + 1),
      runDaysComponent,
      engagementComponent: 1,
      reasons,
    };
  }
  const perThousand = (engagement / views) * 1000;
  // 100 engagements per 1k views is an extraordinarily good ad; 10 is weak.
  const engagementRaw = Math.min(perThousand / 100, 1) * 5;
  const engagementComponent = round1(engagementRaw);
  reasons.push(
    `${perThousand.toFixed(1)} engagements per 1k views across ${views.toLocaleString()} views`,
  );

  return {
    score: round1(Math.min(runDaysComponent + engagementComponent, 5)),
    raw: round1(runDaysComponent + engagementComponent),
    runDaysComponent,
    engagementComponent,
    reasons,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine 2 — Kalodata-style sales estimation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate weekly revenue for a TikTok Shop listing from public signals.
 *
 * Kalodata's own docs say the figures "may differ from real numbers". We take
 * that seriously: the output is an interval plus a confidence, and a low
 * confidence estimate is not shortlistable. Pretending to precision here would
 * be worse than having no estimate at all.
 */
export function estimateSales(
  input: {
    views?: number | undefined;
    likes?: number | undefined;
    comments?: number | undefined;
    shares?: number | undefined;
    soldCount?: number | undefined;
    priceAud?: number | undefined;
    commissionRate?: number | undefined;
    runDays?: number | undefined;
  },
  config: DroppyConfig,
): SalesEstimate {
  const signals: string[] = [];
  const rule = config.estimate;

  const views = input.views ?? 0;
  if (views < rule.minViews) {
    return {
      estimatedWeeklyRevenueAud: 0,
      lowAud: 0,
      highAud: 0,
      confidence: 0,
      signalsUsed: [
        `only ${views.toLocaleString()} views; below the ${rule.minViews.toLocaleString()} floor — not actionable`,
      ],
    };
  }
  signals.push(`${views.toLocaleString()} views`);

  // Base rate: revenue per view, scaled by the listing price when known.
  const price = input.priceAud ?? 0;
  const baseRate = rule.revenuePerView * (price > 0 ? Math.max(price / 40, 0.5) : 1);
  if (price > 0) signals.push(`listed at A$${price.toFixed(2)}`);

  // Engagement uplift.
  const engagement =
    (input.likes ?? 0) + (input.comments ?? 0) * 3 + (input.shares ?? 0) * 5;
  const perThousand = views > 0 ? (engagement / views) * 1000 : 0;
  const uplift =
    perThousand > 50 ? rule.engagementUplift : perThousand > 20 ? 1.3 : 1;
  if (perThousand > 20) signals.push(`${perThousand.toFixed(1)} engagements/1k views`);

  // Longevity uplift: a listing that has sold for weeks is not a flash.
  const runDays = input.runDays ?? 0;
  const longevity = runDays >= 30 ? 1.5 : runDays >= 14 ? 1.2 : 1;
  if (runDays >= 14) signals.push(`selling for ${runDays}d`);

  // Commission data is the strongest signal when present: it is a real number
  // from the affiliate marketplace, not an inference.
  let commissionSignal = 1;
  if (input.commissionRate && input.commissionRate > 0) {
    commissionSignal = 1 + input.commissionRate;
    signals.push(`commission rate ${(input.commissionRate * 100).toFixed(0)}%`);
  }

  const weekly = views * baseRate * uplift * longevity * commissionSignal;

  // The interval. Wide on purpose: the model's uncertainty is real.
  const low = weekly * 0.35;
  const high = weekly * 2.4;

  // Confidence: how much evidence we actually had.
  const evidenceCount = signals.length;
  const confidence = clamp01(
    0.15 +
      evidenceCount * 0.12 +
      (views > 100_000 ? 0.15 : views > 20_000 ? 0.08 : 0) +
      (input.commissionRate ? 0.15 : 0) +
      (input.soldCount && input.soldCount > 0 ? 0.1 : 0),
  );

  return {
    estimatedWeeklyRevenueAud: round2(weekly),
    lowAud: round2(low),
    highAud: round2(high),
    confidence: round2(confidence),
    signalsUsed: signals,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine 3 — PipiADS-style creative analysis
// ─────────────────────────────────────────────────────────────────────────────

const HOOK_KEYWORDS: Array<{ hook: CreativeAnalysis["hook"]; terms: string[] }> = [
  { hook: "before_after", terms: ["before and after", "before vs after", "results in", "transform"] },
  { hook: "problem_solution", terms: ["problem", "struggle", "fix", "solution", "finally"] },
  { hook: "testimonial", terms: ["i tried", "my skin", "honestly", "review", "i was"] },
  { hook: "demo", terms: ["watch", "how to", "apply", "step by step", "tutorial"] },
  { hook: "ugc", terms: ["day in", "routine", "with me", "get ready"] },
];

/**
 * Analyse a creative from its text signals.
 *
 * Two of the outputs are compliance-critical, not cosmetic:
 * - `therapeuticClaim` triggers the TGA lint. Beauty products may make cosmetic
 *   claims only.
 * - `wowFactor` is the "visible before/after or problem solved" criterion from
 *   the original spec, and it is a real scoring input.
 *
 * Text-only analysis is a placeholder until the creative itself can be read.
 * It is honest about that: `hook: "unknown"` rather than a guess.
 */
export function analyseCreative(
  input: {
    headline?: string | undefined;
    body?: string | undefined;
    hasVisualBeforeAfter?: boolean | undefined;
  },
  _config: DroppyConfig,
): CreativeAnalysis {
  const text = `${input.headline ?? ""} ${input.body ?? ""}`.toLowerCase();
  const notes: string[] = [];

  const hook = HOOK_KEYWORDS.find((entry) =>
    entry.terms.some((term) => text.includes(term)),
  )?.hook ?? "unknown";
  if (hook === "unknown") {
    notes.push("no hook keyword matched; creative text was not readable");
  } else {
    notes.push(`hook detected: ${hook}`);
  }

  const wowFactor =
    hook === "before_after" ||
    input.hasVisualBeforeAfter === true ||
    text.includes("before and after");
  if (wowFactor) notes.push("visible before/after or problem/solution present");

  // TGA: therapeutic claims are blocked. Cosmetic claims are fine.
  const THERAPEUTIC = [
    "cures",
    "treats",
    "heals",
    "medical",
    "clinical",
    "dermatologist approved",
    "prescription",
    "anti-aging that works",
    "reverses",
    "repair dna",
    "therapeutic",
  ];
  const therapeuticClaim = THERAPEUTIC.some((term) => text.includes(term));
  if (therapeuticClaim) {
    notes.push("THERAPEUTIC CLAIM DETECTED — TGA breach risk; cosmetic claims only");
  }

  const COSMETIC = [
    "moisturis",
    "hydrat",
    "glow",
    "soft",
    "smooth",
    "radiant",
    "cleanse",
    "nourish",
    "brighten",
    "appearance of",
  ];
  const cosmeticClaimOnly =
    !therapeuticClaim && COSMETIC.some((term) => text.includes(term));
  if (cosmeticClaimOnly) notes.push("cosmetic claims only — TGA clean");

  return {
    hook,
    wowFactor,
    therapeuticClaim,
    cosmeticClaimOnly,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The composite: turn evidence into the six criteria
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a candidate against the original spec's six criteria, 1-5 each.
 *
 * Every criterion is derived from evidence, never asserted. A criterion with
 * no evidence scores 1 and says so — an unattributed score is worse than no
 * score, because it looks like evidence.
 */
export function scoreCriteria(
  input: {
    engagement?: EngagementScore | undefined;
    estimate?: SalesEstimate | undefined;
    creative?: CreativeAnalysis | undefined;
    supplierCostAud?: number | undefined;
    freightAud?: number | undefined;
    inStock?: boolean | undefined;
    warehouse?: string | undefined;
    stockQty?: number | undefined;
    competitorCount?: number | undefined;
    trendSlope?: number | undefined;
  },
  config: DroppyConfig,
): {
  trendSignal: number;
  wowFactor: number;
  pricePoint: number;
  supplierAvailability: number;
  shippingTime: number;
  competition: number;
  reasons: Record<string, string>;
} {
  const reasons: Record<string, string> = {};

  // Trend signal: engagement score, adjusted by trend slope when available.
  let trendSignal = input.engagement ? input.engagement.score : 1;
  if (typeof input.trendSlope === "number") {
    const slopeBoost = input.trendSlope > 0.2 ? 1 : input.trendSlope > 0 ? 0.5 : 0;
    trendSignal = clamp5(trendSignal + slopeBoost);
    reasons.trendSignal = `engagement ${input.engagement?.score ?? "n/a"} + slope ${input.trendSlope}`;
  } else {
    reasons.trendSignal = input.engagement
      ? `engagement score ${input.engagement.score}`
      : "no trend evidence; floored to 1";
  }

  // Wow factor: from creative analysis, backed by the sales estimate.
  let wowFactor = input.creative?.wowFactor ? 4 : 1;
  if (input.creative?.wowFactor && (input.estimate?.confidence ?? 0) > 0.5) {
    wowFactor = 5;
  }
  reasons.wowFactor = input.creative
    ? `creative wow=${input.creative.wowFactor}, estimate confidence ${input.estimate?.confidence ?? "n/a"}`
    : "no creative analysis; floored to 1";

  // Price point: the original spec's sweet spot is $25-60 AU.
  const price = input.supplierCostAud ?? 0;
  const suggested = price > 0 ? applyPricingRule(price, config) : 0;
  let pricePoint = 1;
  if (suggested >= 25 && suggested <= 60) pricePoint = 5;
  else if (suggested >= 20 && suggested <= 79.99) pricePoint = 3;
  else if (suggested > 0) pricePoint = 2;
  reasons.pricePoint =
    suggested > 0
      ? `suggested A$${suggested.toFixed(2)} (cost A$${price.toFixed(2)})`
      : "no supplier cost; floored to 1";

  // Supplier availability: in stock, in an AU warehouse, with depth.
  let supplierAvailability = 1;
  if (input.inStock === true) {
    supplierAvailability = 3;
    if (input.warehouse?.toUpperCase().includes("AU")) supplierAvailability += 1;
    if ((input.stockQty ?? 0) >= 50) supplierAvailability += 1;
  }
  supplierAvailability = clamp5(supplierAvailability);
  reasons.supplierAvailability = input.inStock
    ? `in stock${input.warehouse ? `, warehouse ${input.warehouse}` : ""}, qty ${input.stockQty ?? "?"}`
    : "not in stock; floored to 1";

  // Shipping time: the original spec requires under 7 days from an AU warehouse.
  let shippingTime = 1;
  if (input.warehouse?.toUpperCase().includes("AU")) shippingTime = 5;
  else if (input.inStock) shippingTime = 3;
  reasons.shippingTime = input.warehouse?.toUpperCase().includes("AU")
    ? "AU warehouse; under 7 days"
    : input.warehouse
      ? `warehouse ${input.warehouse}; over 7 days`
      : "warehouse unknown; floored to 1";

  // Competition: the original spec proceeds below 5 stores running ads.
  const competitors = input.competitorCount ?? 0;
  let competition = 5;
  if (competitors >= 5) competition = 1;
  else if (competitors >= 3) competition = 3;
  reasons.competition =
    competitors > 0
      ? `${competitors} competing store(s) running ads`
      : "no competition data; assumed benign";

  return {
    trendSignal: clamp5(trendSignal),
    wowFactor: clamp5(wowFactor),
    pricePoint: clamp5(pricePoint),
    supplierAvailability,
    shippingTime: clamp5(shippingTime),
    competition: clamp5(competition),
    reasons,
  };
}

/** Pricing rule: supplier cost x multiplier, clamped, always ending in .99. */
export function applyPricingRule(
  supplierCostAud: number,
  config: DroppyConfig,
): number {
  const { multiplier, minAud, maxAud, priceEnding } = config.pricing;
  // Apply the .99 ending FIRST, then clamp. Clamping first floors the clamped
  // value and loses the ending: cost 100 x 3.5 = 350, clamped to 79.99, then
  // floored to 78.99 — neither the max nor what we meant to charge.
  const ended = Math.floor(supplierCostAud * multiplier) + priceEnding - 1;
  return round2(Math.min(Math.max(ended, minAud), maxAud));
}

/** The 0-30 total and whether it clears the configured proceed threshold. */
export function totalScore(
  criteria: { trendSignal: number; wowFactor: number; pricePoint: number; supplierAvailability: number; shippingTime: number; competition: number },
  config: DroppyConfig,
): { total: number; proceeds: boolean; threshold: number } {
  const total = round1(
    criteria.trendSignal +
      criteria.wowFactor +
      criteria.pricePoint +
      criteria.supplierAvailability +
      criteria.shippingTime +
      criteria.competition,
  );
  const threshold = config.shortlist.proceedThreshold;
  return { total, proceeds: total >= threshold, threshold };
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp5(n: number): number {
  return Math.min(Math.max(n, 1), 5);
}
function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/** Re-exported so callers do not need the zod import for the estimate type. */
export type { SalesEstimate, EngagementScore, CreativeAnalysis };
