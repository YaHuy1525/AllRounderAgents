import { createHash } from "node:crypto";

import {
  AuditPackSchema,
  FinanceExceptionSchema,
  FinanceWorkflowInputSchema,
  FinanceWorkflowOutputSchema,
  PostingInstructionSchema,
  type AuditPack,
  type FinanceException,
  type FinanceWorkflowInput,
  type FinanceWorkflowOutput,
  type LedgerLine,
  type PostingInstruction,
  type SpecialistFinding,
} from "./contracts.js";

export interface FinanceApprovalGate {
  suspend(payload: {
    caseId: string;
    ticketKey: string;
    actionHash: string;
    posting: PostingInstruction;
  }): Promise<
    | { decision: "approved"; receipt: string }
    | { decision: "rejected" | "expired"; receipt?: never }
  >;
}

export interface SandboxLedger {
  post(input: {
    idempotencyKey: string;
    approvalReceipt: string;
    posting: PostingInstruction;
  }): Promise<{ artifact: string }>;
}

export const FINANCE_FLOW_STEPS = [
  "load-context",
  "reconcile",
  "detect-exceptions",
  "rca",
  "specialist-fanout",
  "merge",
  "audit",
  "approval",
  "sandbox-post",
] as const;

export class FinanceWorkflow {
  readonly steps = FINANCE_FLOW_STEPS.map((id) => ({ id }));

  constructor(
    private readonly approvals: FinanceApprovalGate,
    private readonly ledger: SandboxLedger,
  ) {}

  async run(raw: FinanceWorkflowInput): Promise<FinanceWorkflowOutput> {
    const input = FinanceWorkflowInputSchema.parse(raw);
    const exceptions = reconcile(input.ledger, input.bank);
    const findings = exceptions.flatMap(specialistFindings);
    const posting = proposePosting(input.period, exceptions);
    const auditPack = audit(input.period, exceptions, findings, posting);
    if (!auditPack.checks.every((check) => check.passed)) {
      return FinanceWorkflowOutputSchema.parse({
        caseId: input.caseId,
        ticketKey: input.ticketKey,
        status: "escalated",
        exceptions,
        auditPack,
        reason: "audit_failed",
        evidence: ["escalation:audit_failed"],
      });
    }
    if (posting === undefined) {
      return FinanceWorkflowOutputSchema.parse({
        caseId: input.caseId,
        ticketKey: input.ticketKey,
        status: "awaiting_approval",
        exceptions,
        auditPack,
        reason: "balanced_close_requires_review",
        evidence: ["recon:balanced"],
      });
    }
    const actionHash = createHash("sha256")
      .update(JSON.stringify(posting))
      .digest("hex");
    const decision = await this.approvals.suspend({
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      actionHash,
      posting,
    });
    if (decision.decision !== "approved" || decision.receipt.length === 0) {
      return FinanceWorkflowOutputSchema.parse({
        caseId: input.caseId,
        ticketKey: input.ticketKey,
        status: "escalated",
        exceptions,
        auditPack,
        posting,
        reason: `approval_${decision.decision}`,
        evidence: [`escalation:approval_${decision.decision}`],
      });
    }
    const posted = await this.ledger.post({
      idempotencyKey: actionHash,
      approvalReceipt: decision.receipt,
      posting,
    });
    return FinanceWorkflowOutputSchema.parse({
      caseId: input.caseId,
      ticketKey: input.ticketKey,
      status: "posted",
      exceptions,
      auditPack,
      posting,
      evidence: [`approval:${actionHash}`, posted.artifact],
    });
  }
}

export function reconcile(ledger: LedgerLine[], bank: LedgerLine[]): FinanceException[] {
  const keys = new Set([
    ...ledger.map(lineKey),
    ...bank.map(lineKey),
  ]);
  const exceptions: FinanceException[] = [];
  for (const key of [...keys].sort()) {
    const left = sumCents(ledger.filter((line) => lineKey(line) === key));
    const right = sumCents(bank.filter((line) => lineKey(line) === key));
    const sample = ledger.find((line) => lineKey(line) === key)
      ?? bank.find((line) => lineKey(line) === key);
    if (sample === undefined || left === right) continue;
    const type =
      left === null ? "unmatched_bank" : right === null ? "unmatched_ledger" : "amount_mismatch";
    exceptions.push(
      FinanceExceptionSchema.parse({
        type,
        account: sample.account,
        currency: sample.currency,
        externalRef: sample.externalRef,
        ledgerCents: left,
        bankCents: right,
        deltaCents: (right ?? 0) - (left ?? 0),
      }),
    );
  }
  return exceptions;
}

export function rca(exception: FinanceException): { exceptionRef: string; cause: string } {
  if (exception.type === "unmatched_bank") {
    return {
      exceptionRef: exception.externalRef,
      cause: `Bank ${exception.externalRef} has no ledger match.`,
    };
  }
  if (exception.type === "unmatched_ledger") {
    return {
      exceptionRef: exception.externalRef,
      cause: `Ledger ${exception.externalRef} has no bank match.`,
    };
  }
  return {
    exceptionRef: exception.externalRef,
    cause: `Amount mismatch of ${exception.deltaCents} cents on ${exception.externalRef}.`,
  };
}

export function specialistFindings(exception: FinanceException): SpecialistFinding[] {
  if (exception.type === "unmatched_bank") {
    return [
      {
        specialist: "treasury",
        exceptionRef: exception.externalRef,
        summary: `Bank ${exception.externalRef} has no ledger match; check cutoff and deposits in transit.`,
      },
    ];
  }
  if (exception.type === "unmatched_ledger") {
    return [
      {
        specialist: "gl",
        exceptionRef: exception.externalRef,
        summary: `Ledger ${exception.externalRef} has no bank match; review unpresented items.`,
      },
    ];
  }
  return [
    {
      specialist: "gl",
      exceptionRef: exception.externalRef,
      summary: `Amount mismatch of ${exception.deltaCents} cents on ${exception.externalRef}.`,
    },
    {
      specialist: "tax",
      exceptionRef: exception.externalRef,
      summary: `Confirm tax timing is not the ${exception.deltaCents} cent variance on ${exception.externalRef}.`,
    },
  ];
}

export function proposePosting(
  period: string,
  exceptions: FinanceException[],
): PostingInstruction | undefined {
  const lines = exceptions.flatMap((exception) => {
    if (exception.deltaCents === 0) return [];
    return [
      {
        account: exception.account,
        amountCents: exception.deltaCents,
        currency: exception.currency,
        memo: `Adjust ${exception.externalRef} (${exception.type})`,
      },
    ];
  });
  if (lines.length === 0) return undefined;
  return PostingInstructionSchema.parse({ ledger: "sandbox", period, lines });
}

export function audit(
  period: string,
  exceptions: FinanceException[],
  findings: SpecialistFinding[],
  posting: PostingInstruction | undefined,
): AuditPack {
  const refs = new Set(exceptions.map((item) => item.externalRef));
  const covered = findings.every((finding) => refs.has(finding.exceptionRef));
  const integerCents = exceptions.every((item) => Number.isInteger(item.deltaCents));
  const sandboxOnly = posting === undefined || posting.ledger === "sandbox";
  return AuditPackSchema.parse({
    period,
    balanced: exceptions.length === 0,
    exceptionCount: exceptions.length,
    findings,
    checks: [
      {
        id: "exceptions-have-rca",
        passed: covered && findings.length >= exceptions.length,
        detail: "Every exception has at least one specialist finding.",
      },
      {
        id: "integer-money",
        passed: integerCents,
        detail: "All money values are integer cents.",
      },
      {
        id: "sandbox-ledger-only",
        passed: sandboxOnly,
        detail: "Posting adapters stay on the sandbox ledger until a later production unlock.",
      },
    ],
  });
}

function lineKey(line: LedgerLine): string {
  return `${line.account}|${line.currency}|${line.externalRef}`;
}

function sumCents(lines: LedgerLine[]): number | null {
  if (lines.length === 0) return null;
  return lines.reduce((total, line) => total + line.amountCents, 0);
}

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

export class MemorySandboxLedger implements SandboxLedger {
  readonly posted: PostingInstruction[] = [];
  private readonly receipts = new Map<string, { artifact: string }>();

  async post(input: {
    idempotencyKey: string;
    approvalReceipt: string;
    posting: PostingInstruction;
  }): Promise<{ artifact: string }> {
    if (input.approvalReceipt.length === 0) throw new Error("Approval receipt required");
    const prior = this.receipts.get(input.idempotencyKey);
    if (prior !== undefined) return prior;
    this.posted.push(input.posting);
    const receipt = { artifact: `sandbox-post:${input.idempotencyKey}` };
    this.receipts.set(input.idempotencyKey, receipt);
    return receipt;
  }
}
