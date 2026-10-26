import type {
  AdObservation,
  DomainEvent,
  Listing,
  MarginSnapshot,
  Order,
  Product,
  ShortlistCandidate,
  SupportTicket,
  TikTokShopListing,
} from "../contracts.js";
import type { DroppyConfig } from "../settings.js";

/**
 * Layer 2, the local index: one data model shared by the three scorers instead of
 * a copy each. In-memory behind a persistence seam that backs onto Supabase in
 * production, so the swap is one implementation change. Every write is idempotent
 * on its natural key, because replaying an event twice must produce one change.
 */
export interface DroppyStore {
  upsertAd(observation: AdObservation): void;
  upsertProduct(product: Product): void;
  upsertTikTokShopListing(listing: TikTokShopListing): void;
  putCandidate(candidate: ShortlistCandidate): void;
  putListing(listing: Listing): void;
  putOrder(order: Order): void;
  putTicket(ticket: SupportTicket): void;
  putMarginSnapshot(snapshot: MarginSnapshot): void;
  appendEvent(event: DomainEvent): void;

  productsByCategory(category: string): Product[];
  adsByProduct(productId: string): AdObservation[];
  tiktokShopByProduct(productId: string): TikTokShopListing | undefined;
  candidates(): ShortlistCandidate[];
  candidateById(id: string): ShortlistCandidate | undefined;
  pendingCandidates(): ShortlistCandidate[];
  listingById(id: string): Listing | undefined;
  listings(): Listing[];
  orderById(id: string): Order | undefined;
  ordersByStatus(status: Order["status"]): Order[];
  ticketById(id: string): SupportTicket | undefined;
  openTickets(): SupportTicket[];
  latestMarginForListing(listingId: string): MarginSnapshot | undefined;
  eventsByName(name: DomainEvent["name"]): DomainEvent[];
}

export function createInMemoryStore(_config: DroppyConfig): DroppyStore {
  const ads = new Map<string, AdObservation>();
  const products = new Map<string, Product>();
  const tiktokShop = new Map<string, TikTokShopListing>();
  const candidates = new Map<string, ShortlistCandidate>();
  const listings = new Map<string, Listing>();
  const orders = new Map<string, Order>();
  const tickets = new Map<string, SupportTicket>();
  const margins = new Map<string, MarginSnapshot>();
  const events: DomainEvent[] = [];

  return {
    upsertAd(o) {
      ads.set(o.id, o);
    },
    upsertProduct(p) {
      products.set(p.id, p);
    },
    upsertTikTokShopListing(l) {
      tiktokShop.set(l.id, l);
    },
    putCandidate(c) {
      candidates.set(c.id, c);
    },
    putListing(l) {
      listings.set(l.id, l);
    },
    putOrder(o) {
      orders.set(o.id, o);
    },
    putTicket(t) {
      tickets.set(t.id, t);
    },
    putMarginSnapshot(s) {
      margins.set(s.listingId, s);
    },
    appendEvent(e) {
      // Idempotency: the dedupe key is the natural business key.
      if (events.some((existing) => existing.dedupeKey === e.dedupeKey)) return;
      events.push(e);
    },

    productsByCategory(category) {
      return [...products.values()].filter((p) => p.category === category);
    },
    adsByProduct(productId) {
      return [...ads.values()].filter((a) => a.linkedProductIds.includes(productId));
    },
    tiktokShopByProduct(productId) {
      const match = [...tiktokShop.values()].find((l) => l.id === productId);
      return match;
    },
    candidates() {
      return [...candidates.values()];
    },
    candidateById(id) {
      return candidates.get(id);
    },
    pendingCandidates() {
      return [...candidates.values()].filter((c) => c.approvalStatus === "pending");
    },
    listingById(id) {
      return listings.get(id);
    },
    listings() {
      return [...listings.values()];
    },
    orderById(id) {
      return orders.get(id);
    },
    ordersByStatus(status) {
      return [...orders.values()].filter((o) => o.status === status);
    },
    ticketById(id) {
      return tickets.get(id);
    },
    openTickets() {
      return [...tickets.values()].filter((t) => t.status === "open");
    },
    latestMarginForListing(listingId) {
      return margins.get(listingId);
    },
    eventsByName(name) {
      return events.filter((e) => e.name === name);
    },
  };
}

/** A store that is also observable: it emits domain events on write. */
export interface EventEmittingStore extends DroppyStore {
  /** Events appended since the last call. Used by the bus to route. */
  drainEvents(): DomainEvent[];
}

export function createEventEmittingStore(
  config: DroppyConfig,
): EventEmittingStore {
  const base = createInMemoryStore(config);
  const pending: DomainEvent[] = [];
  // The dedupe set and the store's own index must agree, or a replayed event
  // reaches the bus twice — the exact thing this layer exists to prevent.
  const seen = new Set<string>();
  const emit = (event: DomainEvent): void => {
    if (seen.has(event.dedupeKey)) return; // replay: no state change, no delivery
    seen.add(event.dedupeKey);
    base.appendEvent(event);
    pending.push(event);
  };
  return {
    ...base,
    appendEvent: emit,
    drainEvents() {
      const out = pending.splice(0, pending.length);
      return out;
    },
  };
}

export type { DomainEvent };
