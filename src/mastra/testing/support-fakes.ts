import type {
  ApprovalGate,
  Citation,
  Passage,
  SupportModel,
  SupportRetriever,
} from "../agents/support/workflow.js";

/** In-memory `SupportRetriever` returning a fixed passage set for tests. */
export class FakeSupportRetriever implements SupportRetriever {
  constructor(private readonly passages: Passage[]) {}

  async retrieve(
    _tenantId: string,
    _domain: "support",
    _query: string,
    k: number,
  ): Promise<Passage[]> {
    return this.passages.slice(0, k);
  }
}

/** `SupportModel` that drafts deterministically from the first retrieved passage. */
export class DeterministicSupportModel implements SupportModel {
  async draft(
    _query: string,
    passages: Passage[],
  ): Promise<{ text: string; claimCitations: Citation[] }> {
    const first = passages[0];
    if (first === undefined) return { text: "", claimCitations: [] };
    const marker = `[${first.citation.sourceId}:${first.citation.span}]`;
    return {
      text: `${first.content} ${marker}`,
      claimCitations: [first.citation],
    };
  }
}

/** Deterministic `ApprovalGate` recording suspensions and replaying a fixed decision. */
export class FakeApprovalGate implements ApprovalGate {
  readonly suspended: Array<{
    caseId: string;
    ticketKey: string;
    actionHash: string;
    draft: string;
    citations: Citation[];
  }> = [];

  constructor(private readonly decision: "approved" | "rejected" | "expired") {}

  async suspend(payload: {
    caseId: string;
    ticketKey: string;
    actionHash: string;
    draft: string;
    citations: Citation[];
  }): Promise<
    | { decision: "approved"; receipt: string }
    | { decision: "rejected" | "expired"; receipt?: never }
  > {
    this.suspended.push(payload);
    return this.decision === "approved"
      ? { decision: "approved", receipt: `fake:${payload.actionHash}` }
      : { decision: this.decision };
  }
}
