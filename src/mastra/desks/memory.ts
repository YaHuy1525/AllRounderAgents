import {
  DeskError,
  type DeskAdapter,
  type DeskAttachment,
  type DeskCapabilities,
  type DeskComment,
  type DeskCommentResult,
  type DeskTicketDraft,
  type DeskTicketRef,
  type DeskTicketState,
} from "./types.js";

interface MemoryTicket {
  readonly ref: DeskTicketRef;
  readonly clientRef: string;
  readonly correlationId: string;
  readonly title: string;
  readonly body: string;
  status: string;
  readonly comments: Array<{ id: string; body: string; evidenceRefs: string[] }>;
  readonly attachments: string[];
}

/**
 * In-memory desk: the sandbox the tests and the local host run against. Every
 * ticket keeps its correlation id, so a create replay with the same id
 * returns the original ref instead of a duplicate ticket — the reference
 * behaviour for adapters whose desk can dedupe.
 */
export class MemoryDeskAdapter implements DeskAdapter {
  readonly provider = "memory";
  private readonly project: string;
  private readonly tickets = new Map<string, MemoryTicket>();
  private readonly byCorrelation = new Map<string, string>();
  private sequence = 0;

  constructor(options: { project?: string } = {}) {
    this.project = options.project ?? "MSP";
  }

  capabilities(): DeskCapabilities {
    return {
      create: true,
      comment: true,
      transition: true,
      attach: true,
      webhook: false,
      polling: false,
    };
  }

  async createTicket(draft: DeskTicketDraft): Promise<DeskTicketRef> {
    const replayedKey = this.byCorrelation.get(draft.correlationId);
    if (replayedKey !== undefined) {
      return { ...this.require(replayedKey).ref };
    }
    this.sequence += 1;
    const key = `${this.project}-${this.sequence}`;
    const ticket: MemoryTicket = {
      ref: { key, id: `mem-${this.sequence}`, url: `memory://${key}` },
      clientRef: draft.clientRef,
      correlationId: draft.correlationId,
      title: draft.title,
      body: draft.body,
      status: "Open",
      comments: [],
      attachments: [],
    };
    this.tickets.set(key, ticket);
    this.byCorrelation.set(draft.correlationId, key);
    return { ...ticket.ref };
  }

  async addComment(ref: DeskTicketRef, comment: DeskComment): Promise<DeskCommentResult> {
    const ticket = this.require(ref.key);
    const existing = ticket.comments.find(
      (item) =>
        item.body === comment.body &&
        item.evidenceRefs.join("|") === (comment.evidenceRefs ?? []).join("|"),
    );
    if (existing !== undefined) {
      return { commentId: existing.id, created: false };
    }
    const commentId = `c-${ticket.comments.length + 1}`;
    ticket.comments.push({
      id: commentId,
      body: comment.body,
      evidenceRefs: [...(comment.evidenceRefs ?? [])],
    });
    return { commentId, created: true };
  }

  async setStatus(ref: DeskTicketRef, status: string): Promise<DeskTicketRef> {
    const ticket = this.require(ref.key);
    ticket.status = status;
    return { ...ticket.ref };
  }

  async attachEvidence(
    ref: DeskTicketRef,
    attachment: DeskAttachment,
  ): Promise<DeskTicketRef> {
    const ticket = this.require(ref.key);
    ticket.attachments.push(`${attachment.fileName}#${attachment.evidenceRef}`);
    return { ...ticket.ref };
  }

  async readTicket(ref: DeskTicketRef): Promise<DeskTicketState> {
    const ticket = this.tickets.get(ref.key);
    if (ticket === undefined) {
      return { ref: { ...ref }, exists: false };
    }
    return {
      ref: { ...ticket.ref },
      exists: true,
      status: ticket.status,
      summary: ticket.title,
    };
  }

  private require(key: string): MemoryTicket {
    const ticket = this.tickets.get(key);
    if (ticket === undefined) {
      throw new DeskError(this.provider, "not-found", `ticket ${key} is not in the memory desk`);
    }
    return ticket;
  }
}
