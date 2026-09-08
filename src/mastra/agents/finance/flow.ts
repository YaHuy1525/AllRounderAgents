import { createHash } from "node:crypto";

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  AuditPackSchema,
  FinanceExceptionSchema,
  FinanceWorkflowInputSchema,
  FinanceWorkflowOutputSchema,
  PostingInstructionSchema,
  SpecialistFindingSchema,
  type FinanceWorkflowOutput,
  type PostingInstruction,
} from "./contracts.js";
import {
  FINANCE_FLOW_STEPS,
  audit,
  proposePosting,
  rca,
  reconcile,
  specialistFindings,
  type SandboxLedger,
} from "./workflow.js";

const RcaNoteSchema = z
  .object({
    exceptionRef: z.string().min(1),
    cause: z.string().min(1).max(2_000),
  })
  .strict();

const FinanceRunStateSchema = z
  .object({
    context: FinanceWorkflowInputSchema,
    exceptions: z.array(FinanceExceptionSchema),
    rca: z.array(RcaNoteSchema),
    findings: z.array(SpecialistFindingSchema),
    posting: PostingInstructionSchema.optional(),
    auditPack: AuditPackSchema.optional(),
    actionHash: z.string().optional(),
    halt: z.enum(["none", "audit_failed", "balanced_close"]),
    approvalDecision: z.enum(["approved", "rejected", "expired"]).optional(),
    approvalReceipt: z.string().min(1).optional(),
  })
  .strict();

const ApprovalResumeSchema = z
  .object({
    decision: z.enum(["approved", "rejected", "expired"]),
    receipt: z.string().min(1).optional(),
  })
  .strict();

const ApprovalSuspendSchema = z
  .object({
    caseId: z.string().min(1),
    ticketKey: z.string().min(1),
    actionHash: z.string().min(1),
    posting: PostingInstructionSchema,
  })
  .strict();

type FinanceRunState = z.infer<typeof FinanceRunStateSchema>;

function emptyState(context: z.infer<typeof FinanceWorkflowInputSchema>): FinanceRunState {
  return {
    context,
    exceptions: [],
    rca: [],
    findings: [],
    halt: "none",
  };
}

function postingHash(posting: PostingInstruction): string {
  return createHash("sha256").update(JSON.stringify(posting)).digest("hex");
}

function finalize(
  state: FinanceRunState,
  status: FinanceWorkflowOutput["status"],
  evidence: string[],
  reason?: string,
): FinanceWorkflowOutput {
  const auditPack = state.auditPack;
  if (auditPack === undefined) {
    throw new Error("Audit pack is required before close");
  }
  const output: FinanceWorkflowOutput = {
    caseId: state.context.caseId,
    ticketKey: state.context.ticketKey,
    status,
    exceptions: state.exceptions,
    auditPack,
    evidence,
  };
  if (state.posting !== undefined) output.posting = state.posting;
  if (reason !== undefined) output.reason = reason;
  return FinanceWorkflowOutputSchema.parse(output);
}

export function createFinanceFlow(deps: { ledger: SandboxLedger }) {
  const loadContext = createStep({
    id: FINANCE_FLOW_STEPS[0],
    inputSchema: FinanceWorkflowInputSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => emptyState(FinanceWorkflowInputSchema.parse(inputData)),
  });

  const reconcileStep = createStep({
    id: FINANCE_FLOW_STEPS[1],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => ({
      ...inputData,
      exceptions: reconcile(inputData.context.ledger, inputData.context.bank),
    }),
  });

  const detectExceptions = createStep({
    id: FINANCE_FLOW_STEPS[2],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => inputData,
  });

  const rcaStep = createStep({
    id: FINANCE_FLOW_STEPS[3],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => ({
      ...inputData,
      rca: inputData.exceptions.map(rca),
    }),
  });

  const specialistFanout = createStep({
    id: FINANCE_FLOW_STEPS[4],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => ({
      ...inputData,
      findings: inputData.exceptions.flatMap(specialistFindings),
    }),
  });

  const merge = createStep({
    id: FINANCE_FLOW_STEPS[5],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => inputData,
  });

  const auditStep = createStep({
    id: FINANCE_FLOW_STEPS[6],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    execute: async ({ inputData }) => {
      const posting = proposePosting(inputData.context.period, inputData.exceptions);
      const auditPack = audit(
        inputData.context.period,
        inputData.exceptions,
        inputData.findings,
        posting,
      );
      const next: FinanceRunState = {
        ...inputData,
        auditPack,
        halt: !auditPack.checks.every((check) => check.passed)
          ? "audit_failed"
          : posting === undefined
            ? "balanced_close"
            : "none",
      };
      if (posting !== undefined) {
        next.posting = posting;
        next.actionHash = postingHash(posting);
      }
      return next;
    },
  });

  const approval = createStep({
    id: FINANCE_FLOW_STEPS[7],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceRunStateSchema,
    resumeSchema: ApprovalResumeSchema,
    suspendSchema: ApprovalSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.halt !== "none") return inputData;
      const posting = inputData.posting;
      const actionHash = inputData.actionHash;
      if (posting === undefined || actionHash === undefined) {
        return { ...inputData, halt: "balanced_close" as const };
      }
      if (resumeData === undefined) {
        return await suspend({
          caseId: inputData.context.caseId,
          ticketKey: inputData.context.ticketKey,
          actionHash,
          posting,
        });
      }
      if (resumeData.decision !== "approved" || resumeData.receipt === undefined) {
        const next: FinanceRunState = {
          ...inputData,
          approvalDecision: resumeData.decision === "approved" ? "rejected" : resumeData.decision,
        };
        return next;
      }
      return {
        ...inputData,
        approvalDecision: "approved" as const,
        approvalReceipt: resumeData.receipt,
      };
    },
  });

  const sandboxPost = createStep({
    id: FINANCE_FLOW_STEPS[8],
    inputSchema: FinanceRunStateSchema,
    outputSchema: FinanceWorkflowOutputSchema,
    execute: async ({ inputData }) => {
      if (inputData.halt === "audit_failed") {
        return finalize(inputData, "escalated", ["escalation:audit_failed"], "audit_failed");
      }
      if (inputData.halt === "balanced_close") {
        return finalize(
          inputData,
          "awaiting_approval",
          ["recon:balanced"],
          "balanced_close_requires_review",
        );
      }
      if (
        inputData.approvalDecision !== "approved" ||
        inputData.approvalReceipt === undefined ||
        inputData.posting === undefined ||
        inputData.actionHash === undefined
      ) {
        const decision = inputData.approvalDecision ?? "rejected";
        return finalize(
          inputData,
          "escalated",
          [`escalation:approval_${decision}`],
          `approval_${decision}`,
        );
      }
      const posted = await deps.ledger.post({
        idempotencyKey: inputData.actionHash,
        approvalReceipt: inputData.approvalReceipt,
        posting: inputData.posting,
      });
      return finalize(inputData, "posted", [`approval:${inputData.actionHash}`, posted.artifact]);
    },
  });

  return createWorkflow({
    id: "financeFlow",
    inputSchema: FinanceWorkflowInputSchema,
    outputSchema: FinanceWorkflowOutputSchema,
    options: {
      validateInputs: true,
    },
  })
    .then(loadContext)
    .then(reconcileStep)
    .then(detectExceptions)
    .then(rcaStep)
    .then(specialistFanout)
    .then(merge)
    .then(auditStep)
    .then(approval)
    .then(sandboxPost)
    .commit();
}
