"use client";

import { useEffect, useState, type CSSProperties } from "react";

import { integrationAccent, integrationLabel, workflowProviderIndex } from "@/lib/integrations";
import type { Approval } from "@/lib/models";
import { DECIDE_HINT } from "@/lib/roles";
import { workflowLabel } from "@/lib/runs";
import { listWorkflows } from "@/lib/workflows";

import { IconArrowRight, IconCheck, IconCheckCircle, IconClock, IconFileText, IconLock, IconXCircle, ProviderGlyph } from "./icons";
import { PayloadView } from "./PayloadView";

type RunRef = { runId: string; workflow: string };

type ApprovalsViewProps = {
  approvals: Approval[];
  failed: boolean;
  onDecide: (id: string, decision: "approved" | "rejected") => void;
  /** Deep link into a run-backed approval's inspector (chips become buttons). */
  onOpenRun?: (run: RunRef) => void;
  /** False disables the decision buttons; the server stays source of truth. */
  canDecide?: boolean;
};

/** Run-backed approvals carry the workflow and run id in their action payload. */
function approvalRun(action: Record<string, unknown>): RunRef | null {
  const runId = action["runId"];
  if (typeof runId !== "string" || runId === "") return null;
  const workflow = action["workflow"];
  return { runId, workflow: typeof workflow === "string" ? workflow : "" };
}

/** Builds a chip click handler without relying on closure narrowing. */
function runOpener(onOpenRun: (run: RunRef) => void, run: RunRef): () => void {
  return () => onOpenRun(run);
}

/**
 * The platforms row on a run-backed approval: the workflow label, a chip per
 * platform the workflow touches, and — when the workflow declares none — a
 * plain "Open run" link so the inspector is always one click away.
 */
function ApprovalRunRow({
  action,
  providers,
  onOpenRun,
}: {
  action: Record<string, unknown>;
  providers: ReadonlyMap<string, string[]> | null;
  onOpenRun?: (run: RunRef) => void;
}) {
  const run = approvalRun(action);
  if (run === null) return null;
  const chips = providers?.get(run.workflow) ?? [];
  return (
    <p className="approval-platforms">
      <span className="approval-platforms-label">{`${workflowLabel(run.workflow)} run`}</span>
      {chips.map((provider) => {
        const style = {
          "--provider-accent": integrationAccent(provider),
        } as CSSProperties;
        return onOpenRun !== undefined ? (
          <button
            key={provider}
            type="button"
            className="integration-chip approval-platform-chip"
            style={style}
            title="Open the run"
            onClick={runOpener(onOpenRun, run)}
          >
            <ProviderGlyph provider={provider} />
            {integrationLabel(provider)}
          </button>
        ) : (
          <span key={provider} className="integration-chip" style={style}>
            <ProviderGlyph provider={provider} />
            {integrationLabel(provider)}
          </span>
        );
      })}
      {chips.length === 0 && onOpenRun !== undefined ? (
        <button
          type="button"
          className="approval-run-link"
          onClick={runOpener(onOpenRun, run)}
        >
          Open run
          <IconArrowRight />
        </button>
      ) : null}
    </p>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Flags gates that expire within the half hour so their card can emphasize it. */
function expirySoon(value: string): boolean {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const diff = date.getTime() - Date.now();
  return diff > 0 && diff < 30 * 60 * 1000;
}

function decisionClass(decision: Approval["decision"]): string {
  if (decision === "approved") return "approval-approved";
  if (decision === "rejected") return "approval-rejected";
  if (decision === "expired") return "approval-expired";
  return "approval-pending";
}

function decisionLabel(decision: Approval["decision"]): string {
  if (decision === null) return "Awaiting decision";
  return decision.charAt(0).toUpperCase() + decision.slice(1);
}

/**
 * View C — the approvals inbox. Every human gate renders as a card: the case
 * key header, the action payload as formatted rows, the evidence chips, and
 * an expiry line that emphasizes gates about to lapse. Approve/Reject post to
 * the same decision endpoint the ticket gate uses.
 */
export function ApprovalsView({
  approvals,
  failed,
  onDecide,
  onOpenRun,
  canDecide = true,
}: ApprovalsViewProps) {
  const [providers, setProviders] = useState<ReadonlyMap<string, string[]> | null>(null);

  // The catalog resolves the platform chips; a failed fetch just hides them.
  useEffect(() => {
    let cancelled = false;
    listWorkflows().then(
      (workflows) => {
        if (!cancelled) setProviders(workflowProviderIndex(workflows));
      },
      () => {
        // Chips stay hidden; approval cards still work.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section id="approvals-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Human gates</p>
          <h2>Pending approvals</h2>
        </div>
        {approvals.length > 0 ? (
          <span className="sprint-badge">{`${approvals.length} gates`}</span>
        ) : null}
      </div>
      {!canDecide && !failed && approvals.some((approval) => approval.decision === null) && (
        <p className="role-hint" role="note">
          <IconLock />
          {DECIDE_HINT}
        </p>
      )}
      <section id="approvals" className="approval-list" aria-live="polite">
        {failed ? (
          <p className="approval-notice">
            <IconLock />
            <span>Sign in to view approvals.</span>
          </p>
        ) : approvals.length === 0 ? (
          <p className="approval-notice">
            <IconCheckCircle />
            <span>No approvals waiting.</span>
          </p>
        ) : (
          approvals.map((approval, index) => (
            <article
              key={approval.id}
              className="approval-card anim-fade-up"
              style={{ "--i": index } as CSSProperties}
            >
              <header className="approval-head">
                <span className="approval-case">
                  <IconFileText />
                  {`Case ${approval.caseId}`}
                </span>
                <span className={`approval-status ${decisionClass(approval.decision)}`}>
                  {decisionLabel(approval.decision)}
                </span>
              </header>
              <p className="approval-scope">
                <span>{`Scope: ${approval.scope}`}</span>
                <span>{`Approver: ${approval.approver}`}</span>
              </p>
              <ApprovalRunRow action={approval.action} providers={providers} onOpenRun={onOpenRun} />
              <div className="event-payload approval-action">
                <PayloadView value={approval.action} />
              </div>
              <p className="gate-evidence">
                <span className="gate-evidence-label">Evidence:</span>
                {approval.evidence.length === 0 ? (
                  <span className="evidence-chip evidence-none">none</span>
                ) : (
                  approval.evidence.map((item) => (
                    <span key={`${item.sourceId}:${item.span}`} className="evidence-chip" title={`${item.sourceId}:${item.span}`}>
                      {`${item.sourceId}:${item.span}`}
                    </span>
                  ))
                )}
              </p>
              <p className={`approval-expiry${expirySoon(approval.expiresAt) ? " soon" : ""}`}>
                <IconClock />
                {`Expires: ${formatTimestamp(approval.expiresAt)}`}
              </p>
              {approval.decision === null ? (
                <div className="gate-actions">
                  <button
                    type="button"
                    className="approve"
                    disabled={!canDecide}
                    title={canDecide ? undefined : DECIDE_HINT}
                    onClick={() => onDecide(approval.id, "approved")}
                  >
                    <IconCheck />
                    <span>Approve</span>
                  </button>
                  <button
                    type="button"
                    disabled={!canDecide}
                    title={canDecide ? undefined : DECIDE_HINT}
                    onClick={() => onDecide(approval.id, "rejected")}
                  >
                    <IconXCircle />
                    <span>Reject</span>
                  </button>
                </div>
              ) : (
                <strong className="gate-decision">{`Decision: ${approval.decision}`}</strong>
              )}
            </article>
          ))
        )}
      </section>
    </section>
  );
}
