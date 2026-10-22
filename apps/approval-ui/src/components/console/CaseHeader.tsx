"use client";

import type { ReactNode } from "react";

import type { CaseHeaderLink, CaseHeaderModel } from "@/lib/cases";

import { IconAlert, IconCheck, IconClock } from "./icons";

/**
 * The Case-360 header (upgrade U2): a five-block card pinned atop every
 * ticket — status pill + title + summary, key facts, risks, next, receipts.
 * The component is presentation only: `caseHeaderModel` selects the per-lane
 * fields, and every risk and the next entry focus the step panel that holds
 * their evidence. Nothing here executes a decision.
 */
export function CaseHeader({
  model,
  actions,
  onFocusStep,
}: {
  model: CaseHeaderModel;
  /** Header actions (search trigger, run badge) forwarded from the tab. */
  actions?: ReactNode;
  /** Focuses the step panel carrying a risk or next entry's evidence. */
  onFocusStep?: (stepId: string) => void;
}) {
  function focus(link: CaseHeaderLink): void {
    if (link.stepId === null || link.stepId === "" || onFocusStep === undefined) return;
    onFocusStep(link.stepId);
  }

  const receiptParts: string[] = [];
  if (model.receipts.signed > 0) receiptParts.push(`${model.receipts.signed} signed`);
  if (model.receipts.pending > 0) receiptParts.push(`${model.receipts.pending} pending`);

  return (
    <section className="case-header" aria-label="Case overview">
      <header className="ticket-view-header">
        <div>
          <p className="ticket-key">{`${model.key} · ${model.laneLabel}`}</p>
          <h2>{model.title}</h2>
        </div>
        {actions !== undefined && <div className="ticket-view-actions">{actions}</div>}
      </header>

      <p className="case-header-lede">
        <span className={`case-pill tone-${model.status.tone}`}>{model.status.label}</span>
        <span className="case-header-summary">{model.summary}</span>
      </p>

      <div className="case-header-grid">
        <section className="case-block" aria-label="Key facts">
          <h3>Key facts</h3>
          <dl className="case-facts">
            {model.facts.map((fact) => (
              <div key={fact.label} className="case-fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="case-block" aria-label="Risks">
          <h3>Risks</h3>
          {model.risks.length === 0 ? (
            <p className="case-block-empty">No risks detected.</p>
          ) : (
            <ul className="case-risks">
              {model.risks.map((risk) => (
                <li key={risk.source}>
                  <button
                    type="button"
                    className={`case-risk tone-${risk.tone}`}
                    title={risk.source}
                    disabled={risk.stepId === null || onFocusStep === undefined}
                    onClick={() => focus(risk)}
                  >
                    <IconAlert />
                    <span className="case-risk-label">{risk.label}</span>
                    <span className="case-risk-detail">{risk.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="case-block" aria-label="Next">
          <h3>Next</h3>
          <button
            type="button"
            className={`case-next tone-${model.next.tone}`}
            title={model.next.source}
            disabled={model.next.stepId === null || onFocusStep === undefined}
            onClick={() => focus(model.next)}
          >
            <span className="case-next-label">{model.next.label}</span>
            <span className="case-next-detail">{model.next.detail}</span>
          </button>
        </section>

        <section className="case-block" aria-label="Receipts">
          <h3>Receipts</h3>
          {model.receipts.items.length === 0 ? (
            <p className="case-block-empty">No receipts yet.</p>
          ) : (
            <>
              <p className="case-receipts-line">
                {receiptParts.length > 0 ? receiptParts.join(" · ") : "None outstanding"}
              </p>
              <ul className="case-receipts">
                {model.receipts.items.map((item) => (
                  <li key={item.source} className={`case-receipt state-${item.state}`}>
                    {item.state === "signed" ? <IconCheck /> : <IconClock />}
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
