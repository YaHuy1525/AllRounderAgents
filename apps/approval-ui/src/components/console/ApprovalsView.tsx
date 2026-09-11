import type { Approval } from "@/lib/models";

type ApprovalsViewProps = {
  approvals: Approval[];
  failed: boolean;
  onDecide: (id: string, decision: "approved" | "rejected") => void;
};

export function ApprovalsView({ approvals, failed, onDecide }: ApprovalsViewProps) {
  return (
    <section id="approvals-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Human gates</p>
          <h2>Pending approvals</h2>
        </div>
      </div>
      <section id="approvals" className="approval-list" aria-live="polite">
        {failed ? (
          <p>Sign in to view approvals.</p>
        ) : approvals.length === 0 ? (
          <p>No approvals waiting.</p>
        ) : (
          approvals.map((approval) => (
            <article key={approval.id} className="approval-card">
              <h2>{`Case ${approval.caseId}`}</h2>
              <pre>{JSON.stringify(approval.action, null, 2)}</pre>
              <p>
                {`Evidence: ${approval.evidence
                  .map((item) => `${item.sourceId}:${item.span}`)
                  .join(", ")}`}
              </p>
              <p>{`Expires: ${approval.expiresAt}`}</p>
              {approval.decision === null ? (
                <div className="approval-actions">
                  <button type="button" onClick={() => onDecide(approval.id, "approved")}>
                    Approve
                  </button>
                  <button type="button" onClick={() => onDecide(approval.id, "rejected")}>
                    Reject
                  </button>
                </div>
              ) : (
                <strong>{`Decision: ${approval.decision}`}</strong>
              )}
            </article>
          ))
        )}
      </section>
    </section>
  );
}
