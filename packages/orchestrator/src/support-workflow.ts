import { createHash } from "node:crypto";

import { z } from "zod";

export const SupportWorkflowInputSchema = z
  .object({
    caseId: z.string().min(1),
    tenantId: z.string().min(1),
    ticketKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    query: z.string().min(1).max(20_000),
  })
  .strict();

export const CitationSchema = z
  .object({ sourceId: z.string().min(1), span: z.string().regex(/^\d+-\d+$/) })
  .strict();

export const PassageSchema = z
  .object({
    content: z.string().min(1),
    score: z.number().min(-1).max(1),
    stale: z.boolean(),
    citation: CitationSchema,
  })
  .strict();

export const SupportWorkflowOutputSchema = z
  .object({
    caseId: z.string(),
    ticketKey: z.string(),
    status: z.enum(["sent", "escalated"]),
    draft: z.string().optional(),
    citations: z.array(CitationSchema),
    evidence: z.array(z.string()),
    reason: z.string().optional(),
  })
  .strict();

export type SupportWorkflowInput = z.infer<typeof SupportWorkflowInputSchema>;
export type Passage = z.infer<typeof PassageSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type SupportWorkflowOutput = z.infer<typeof SupportWorkflowOutputSchema>;

export interface MastraCompatibleStep<I, O> {
  id: string;
  execute(input: I): Promise<O>;
}

export interface SupportRetriever {
  retrieve(tenantId: string, domain: "support", query: string, k: number): Promise<Passage[]>;
}

export interface SupportModel {
  draft(
    query: string,
    passages: Passage[],
  ): Promise<{ text: string; claimCitations: Citation[] }>;
}

export interface ApprovalGate {
  suspend(payload: {
    caseId: string;
    ticketKey: string;
    actionHash: string;
    draft: string;
    citations: Citation[];
  }): Promise<
    | { decision: "approved"; receipt: string }
    | { decision: "rejected" | "expired"; receipt?: never }
  >;
}

export interface SupportSender {
  send(input: {
    idempotencyKey: string;
    caseId: string;
    ticketKey: string;
    draft: string;
    approvalReceipt: string;
  }): Promise<{ artifact: string }>;
}

export class SupportWorkflow {
  readonly loadContextStep: MastraCompatibleStep<SupportWorkflowInput, SupportWorkflowInput>;
  readonly retrieveStep: MastraCompatibleStep<SupportWorkflowInput, Passage[]>;

  constructor(
    private readonly retriever: SupportRetriever,
    private readonly model: SupportModel,
    private readonly approvals: ApprovalGate,
    private readonly sender: SupportSender,
  ) {
    this.loadContextStep = {
      id: "load-context",
      execute: async (value) => SupportWorkflowInputSchema.parse(value),
    };
    this.retrieveStep = {
      id: "retrieve",
      execute: async (value) =>
        z.array(PassageSchema).max(8).parse(
          await this.retriever.retrieve(value.tenantId, "support", value.query, 5),
        ),
    };
  }

  async run(raw: SupportWorkflowInput): Promise<SupportWorkflowOutput> {
    const input = await this.loadContextStep.execute(raw);
    const passages = await this.retrieveStep.execute(input);
    if (passages.length === 0) {
      return this.escalate(input, [], "empty_retrieval");
    }
    if (passages.every((passage) => passage.stale)) {
      return this.escalate(input, passages.map((item) => item.citation), "stale_evidence");
    }

    const draft = await this.model.draft(input.query, passages);
    const supported = this.validate(draft.text, draft.claimCitations, passages);
    if (!supported) {
      return this.escalate(input, draft.claimCitations, "unsupported_claim");
    }

    const exactAction = {
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      draft: draft.text,
      citations: draft.claimCitations,
    };
    const actionHash = createHash("sha256")
      .update(JSON.stringify(exactAction))
      .digest("hex");
    const decision = await this.approvals.suspend({
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      actionHash,
      draft: draft.text,
      citations: draft.claimCitations,
    });
    if (decision.decision !== "approved" || decision.receipt.length === 0) {
      return this.escalate(input, draft.claimCitations, `approval_${decision.decision}`);
    }
    const send = await this.sender.send({
      idempotencyKey: actionHash,
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      draft: draft.text,
      approvalReceipt: decision.receipt,
    });
    return SupportWorkflowOutputSchema.parse({
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      status: "sent",
      draft: draft.text,
      citations: draft.claimCitations,
      evidence: [`approval:${actionHash}`, send.artifact],
    });
  }

  private validate(text: string, citations: Citation[], passages: Passage[]): boolean {
    if (text.trim().length === 0 || citations.length === 0) return false;
    const available = new Set(
      passages.map((item) => `${item.citation.sourceId}:${item.citation.span}`),
    );
    return citations.every((citation) => {
      const key = `${citation.sourceId}:${citation.span}`;
      return available.has(key) && text.includes(`[${key}]`);
    });
  }

  private escalate(
    input: SupportWorkflowInput,
    citations: Citation[],
    reason: string,
  ): SupportWorkflowOutput {
    return SupportWorkflowOutputSchema.parse({
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      status: "escalated",
      citations,
      evidence: [`escalation:${reason}`],
      reason,
    });
  }
}

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

export class MemorySupportSender implements SupportSender {
  readonly sent: Array<{ idempotencyKey: string; draft: string }> = [];
  private readonly receipts = new Map<string, { artifact: string }>();

  async send(input: {
    idempotencyKey: string;
    caseId: string;
    ticketKey: string;
    draft: string;
    approvalReceipt: string;
  }): Promise<{ artifact: string }> {
    if (input.approvalReceipt.length === 0) throw new Error("Approval receipt required");
    const prior = this.receipts.get(input.idempotencyKey);
    if (prior !== undefined) return prior;
    const receipt = { artifact: `support-send:${input.ticketKey}:${input.idempotencyKey}` };
    this.sent.push({ idempotencyKey: input.idempotencyKey, draft: input.draft });
    this.receipts.set(input.idempotencyKey, receipt);
    return receipt;
  }
}

export interface PilotResult {
  id: string;
  expectedEscalation: boolean;
  status: "sent" | "escalated";
}

export function pilotMetrics(results: PilotResult[]): {
  total: number;
  contained: number;
  escalated: number;
  containmentRate: number;
  escalationPrecision: number;
} {
  if (results.length !== 20) throw new Error("Pilot requires exactly 20 tickets");
  const contained = results.filter((item) => item.status === "sent").length;
  const escalatedResults = results.filter((item) => item.status === "escalated");
  const correctEscalations = escalatedResults.filter((item) => item.expectedEscalation).length;
  return {
    total: results.length,
    contained,
    escalated: escalatedResults.length,
    containmentRate: contained / results.length,
    escalationPrecision:
      escalatedResults.length === 0 ? 1 : correctEscalations / escalatedResults.length,
  };
}
