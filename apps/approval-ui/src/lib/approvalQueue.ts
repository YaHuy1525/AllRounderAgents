import type { Approval } from "./models";

/**
 * Approval queue ordering: riskiest gate first, unranked last.
 *
 * One rule shared with both server repositories: risk descending with nulls
 * last, then oldest first. `Approval` carries no timestamp, so this relies
 * on the server's contract that `GET /approvals` returns the rows oldest
 * first within a band (Postgres orders by `created_at asc`, the in-memory
 * store keeps insertion order) and on `Array.prototype.sort` being stable
 * (ES2019), which preserves that age order for equal bands. A null band
 * ranks below every declared band, including the lowest, so nothing without
 * a declared risk is ever promoted.
 */
export function queueOrder(approvals: Approval[]): Approval[] {
  return [...approvals].sort((first, second) => bandOf(second) - bandOf(first));
}

/** The sort rank of one approval: null sorts last, bands sort high-first. */
function bandOf(approval: Approval): number {
  return approval.risk ?? -1;
}
