import { z } from "zod";

export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const CentsSchema = z.number().int();

export const LedgerLineSchema = z
  .object({
    account: z.string().min(1).max(32),
    amountCents: CentsSchema,
    currency: CurrencySchema,
    externalRef: z.string().min(1).max(80),
  })
  .strict();

export const FinanceWorkflowInputSchema = z
  .object({
    caseId: z.string().min(1),
    tenantId: z.string().min(1),
    ticketKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    period: z.string().regex(/^\d{4}-\d{2}$/),
    ledger: z.array(LedgerLineSchema).min(1).max(10_000),
    bank: z.array(LedgerLineSchema).min(1).max(10_000),
  })
  .strict();

export const ExceptionTypeSchema = z.enum([
  "amount_mismatch",
  "unmatched_ledger",
  "unmatched_bank",
]);

export const FinanceExceptionSchema = z
  .object({
    type: ExceptionTypeSchema,
    account: z.string().min(1),
    currency: CurrencySchema,
    externalRef: z.string().min(1),
    ledgerCents: z.number().int().nullable(),
    bankCents: z.number().int().nullable(),
    deltaCents: z.number().int(),
  })
  .strict();

export const SpecialistFindingSchema = z
  .object({
    specialist: z.enum(["gl", "treasury", "tax"]),
    exceptionRef: z.string().min(1),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export const AuditCheckSchema = z
  .object({
    id: z.string().min(1),
    passed: z.boolean(),
    detail: z.string().min(1).max(2_000),
  })
  .strict();

export const AuditPackSchema = z
  .object({
    period: z.string(),
    balanced: z.boolean(),
    exceptionCount: z.number().int().nonnegative(),
    checks: z.array(AuditCheckSchema).min(1),
    findings: z.array(SpecialistFindingSchema),
  })
  .strict();

export const JournalLineSchema = z
  .object({
    account: z.string().min(1).max(32),
    amountCents: CentsSchema,
    currency: CurrencySchema,
    memo: z.string().min(1).max(500),
  })
  .strict();

export const PostingInstructionSchema = z
  .object({
    ledger: z.literal("sandbox"),
    period: z.string(),
    lines: z.array(JournalLineSchema).min(1).max(100),
  })
  .strict();

export const FinanceWorkflowOutputSchema = z
  .object({
    caseId: z.string(),
    ticketKey: z.string(),
    status: z.enum(["awaiting_approval", "posted", "escalated"]),
    exceptions: z.array(FinanceExceptionSchema),
    auditPack: AuditPackSchema,
    posting: PostingInstructionSchema.optional(),
    reason: z.string().optional(),
    evidence: z.array(z.string()),
  })
  .strict();

export type LedgerLine = z.infer<typeof LedgerLineSchema>;
export type FinanceWorkflowInput = z.infer<typeof FinanceWorkflowInputSchema>;
export type FinanceException = z.infer<typeof FinanceExceptionSchema>;
export type SpecialistFinding = z.infer<typeof SpecialistFindingSchema>;
export type AuditPack = z.infer<typeof AuditPackSchema>;
export type PostingInstruction = z.infer<typeof PostingInstructionSchema>;
export type FinanceWorkflowOutput = z.infer<typeof FinanceWorkflowOutputSchema>;
