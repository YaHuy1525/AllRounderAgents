import { z } from "zod";

export const MarketingBriefSchema = z
  .object({
    caseId: z.string().min(1),
    tenantId: z.string().min(1),
    ticketKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    brief: z.string().min(1).max(20_000),
  })
  .strict();

export type MarketingBrief = z.infer<typeof MarketingBriefSchema>;
