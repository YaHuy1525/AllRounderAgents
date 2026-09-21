import { z } from "zod";

export const DomainSchema = z.enum(["code", "finance", "marketing", "support", "security", "unknown"]);
export const GateSchema = z.enum(["auto", "approval", "refuse"]);

export const AttachmentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    mime: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const TicketSchema = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    project: z.string().min(1),
    issueType: z.string().min(1),
    labels: z.array(z.string()),
    priority: z.enum(["Highest", "High", "Medium", "Low", "Lowest"]),
    summary: z.string().min(1).max(500),
    description: z.string(),
    reporter: z.string().min(1),
    attachments: z.array(AttachmentSchema),
    eventId: z.string().min(1),
    receivedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const TriageVerdictSchema = z
  .object({
    domain: DomainSchema,
    confidence: z.number().min(0).max(1),
    urgency: z.number().int().min(1).max(5),
    needsHuman: z.boolean(),
    rationale: z.string().min(1),
  })
  .strict();

export const RiskScoreSchema = z
  .object({
    action: z.string().min(1),
    blastRadius: z.enum(["low", "med", "high"]),
    reversibility: z.enum(["reversible", "compensable", "irreversible"]),
    score: z.number().int().min(0).max(100),
    gate: GateSchema,
    reasons: z.array(z.string()),
  })
  .strict();

export const EvidencePackSchema = z
  .object({
    actions: z.array(
      z
        .object({
          tool: z.string(),
          argsRedacted: z.record(z.unknown()),
          status: z.string(),
          artifactUrls: z.array(z.string().url()),
        })
        .strict(),
    ),
    citations: z.array(
      z.object({ sourceId: z.string(), span: z.string() }).strict(),
    ),
    confidence: z.number().min(0).max(1),
    costUsdMicro: z.number().int().nonnegative(),
    transcriptRef: z.string().min(1),
    modelTrail: z.array(
      z
        .object({
          step: z.string(),
          model: z.string(),
          tokens: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type Domain = z.infer<typeof DomainSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;
export type RiskScore = z.infer<typeof RiskScoreSchema>;
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

