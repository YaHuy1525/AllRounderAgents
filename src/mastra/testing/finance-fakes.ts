import type { PostingInstruction } from "../agents/finance/contracts.js";
import type { FinanceApprovalGate } from "../agents/finance/workflow.js";

/** Deterministic `FinanceApprovalGate` for the finance workflow tests. */
export class FakeFinanceApprovalGate implements FinanceApprovalGate {
  readonly suspended: Array<{ actionHash: string; posting: PostingInstruction }> = [];

  constructor(private readonly decision: "approved" | "rejected" | "expired") {}

  async suspend(payload: {
    caseId: string;
    ticketKey: string;
    actionHash: string;
    posting: PostingInstruction;
  }): Promise<
    | { decision: "approved"; receipt: string }
    | { decision: "rejected" | "expired"; receipt?: never }
  > {
    this.suspended.push({ actionHash: payload.actionHash, posting: payload.posting });
    return this.decision === "approved"
      ? { decision: "approved", receipt: `fake:${payload.actionHash}` }
      : { decision: this.decision };
  }
}
