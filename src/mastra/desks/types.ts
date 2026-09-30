import { z } from "zod";

/**
 * The desk seam: one provider-neutral interface every ticket-system adapter
 * implements (MSP plan section 5). The MSP flow talks only to this surface,
 * so Jira Cloud is the first implementation and HaloPSA, ConnectWise or
 * Autotask arrive later as adapters, not a refactor. Method names mirror the
 * provider-neutral `desk.*` policy family in policy/tools.yaml:
 * createTicket -> desk.create-ticket, addComment -> desk.comment,
 * setStatus -> desk.transition, attachEvidence -> desk.attach and
 * readTicket -> desk.read.
 */

/** What a desk can do; the flow degrades (and records the fallback) when a
 * flag is false: comment instead of transition, link instead of attach. */
export interface DeskCapabilities {
  readonly create: boolean;
  readonly comment: boolean;
  readonly transition: boolean;
  readonly attach: boolean;
  readonly webhook: boolean;
  readonly polling: boolean;
}

/** Reference to one ticket in the desk (the system of record owns the key). */
export const DeskTicketRefSchema = z
  .object({
    key: z.string().min(1).max(200),
    id: z.string().min(1).max(200).optional(),
    url: z.string().min(1).max(500).optional(),
  })
  .strict();

export type DeskTicketRef = z.infer<typeof DeskTicketRefSchema>;

/** The fields the flow supplies when a ticket is created. */
export interface DeskTicketDraft {
  readonly clientRef: string;
  readonly title: string;
  readonly body: string;
  /** Stable correlation token; adapters that can dedupe replay on it. */
  readonly correlationId: string;
  readonly labels?: readonly string[];
}

/** One post back to the desk, with the evidence references it carries. */
export interface DeskComment {
  readonly body: string;
  readonly evidenceRefs?: readonly string[];
}

export interface DeskCommentResult {
  readonly commentId: string;
  /** false when the adapter recognised the post as a replay. */
  readonly created: boolean;
  readonly url?: string;
}

/** Reconciliation view; `exists: false` when the desk no longer has it. */
export interface DeskTicketState {
  readonly ref: DeskTicketRef;
  readonly exists: boolean;
  readonly status?: string;
  readonly summary?: string;
}

/** Text evidence (an audit artifact or receipt) attached to a ticket. */
export interface DeskAttachment {
  readonly fileName: string;
  readonly mediaType: string;
  readonly content: string;
  readonly evidenceRef: string;
}

export interface DeskAdapter {
  /** Provider id ("memory", "jira", ...) recorded in the trail. */
  readonly provider: string;
  capabilities(): DeskCapabilities;
  createTicket(draft: DeskTicketDraft): Promise<DeskTicketRef>;
  addComment(ref: DeskTicketRef, comment: DeskComment): Promise<DeskCommentResult>;
  setStatus(ref: DeskTicketRef, status: string): Promise<DeskTicketRef>;
  attachEvidence(ref: DeskTicketRef, attachment: DeskAttachment): Promise<DeskTicketRef>;
  readTicket(ref: DeskTicketRef): Promise<DeskTicketState>;
}

export type DeskErrorCode =
  | "auth"
  | "not-found"
  | "rate-limited"
  | "rejected"
  | "unsupported"
  | "unreachable";

/**
 * Every adapter failure is a DeskError with a stable code, so the flow and
 * the trail can tell an unreachable desk (retry) from a rejected write
 * (fix the input) without parsing messages.
 */
export class DeskError extends Error {
  readonly provider: string;
  readonly code: DeskErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    provider: string,
    code: DeskErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(`${provider} desk: ${message}`);
    this.name = "DeskError";
    this.provider = provider;
    this.code = code;
    this.status = options.status ?? null;
    this.retryable =
      options.retryable ?? (code === "rate-limited" || code === "unreachable");
  }
}
