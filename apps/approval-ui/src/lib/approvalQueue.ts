import type { Approval } from "./models";

/**
 * Approval queue: riskiest gate first, unranked last, plus the band chip each card
 * shows. The ordering relies on the server returning rows oldest-first within a
 * band and on `Array.prototype.sort` being stable, since `Approval` carries no
 * timestamp. A null band ranks below every declared band.
 */
export function queueOrder(approvals: Approval[]): Approval[] {
  return [...approvals].sort((first, second) => bandOf(second) - bandOf(first));
}

/** The sort rank of one approval: null sorts last, bands sort high-first. */
function bandOf(approval: Approval): number {
  return approval.risk ?? -1;
}

/** The chip a card renders for one declared band: text plus its class. */
export type RiskBand = {
  readonly label: string;
  readonly className: string;
};

/**
 * Risk band chips for the queue's three anchors — the same `policy/risk.yaml`
 * scores `queueOrder` sorts on. The base `approval-risk` class travels with
 * the band modifier so this function owns the chip's whole class string.
 */
const RISK_ANCHOR_CHIPS: Readonly<Record<number, RiskBand>> = {
  10: { label: "Low", className: "approval-risk risk-low" },
  55: { label: "Medium", className: "approval-risk risk-medium" },
  90: { label: "High", className: "approval-risk risk-high" },
};

/**
 * The chip for one approval's risk, or `null` when it carries no declared band
 * (which renders nothing).
 *
 * A value outside the anchors — only an operator-declared 0-100 number can
 * reach here — shows the number itself in the neutral pill, with no band
 * modifier: colour may never contradict the number printed beside it, so only
 * 10/55/90 get the low/medium/high chips.
 */
export function riskBand(risk: number | null): RiskBand | null {
  if (risk === null) return null;
  return RISK_ANCHOR_CHIPS[risk] ?? { label: `Risk ${risk}`, className: "approval-risk" };
}
