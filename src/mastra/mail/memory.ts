import { createHash } from "node:crypto";

import { MailError, type MailSendResult, type MailSender, type OutboundEmail } from "./types.js";

/**
 * In-memory mail sender: the sandbox the tests and the local host run
 * against. Idempotent by `idempotencyKey` — a replayed send returns the
 * stored result instead of posting a second message.
 */
export class MemoryMailSender implements MailSender {
  readonly address: string;
  private readonly byKey = new Map<string, MailSendResult>();
  private readonly messages: OutboundEmail[] = [];
  private readonly now: () => Date;

  constructor(options: { address?: string; now?: () => Date } = {}) {
    this.address = options.address ?? "service-desk@msp.local";
    this.now = options.now ?? (() => new Date());
  }

  /** Every message that actually went out, in order (replays excluded). */
  get outbox(): readonly OutboundEmail[] {
    return this.messages;
  }

  async send(mail: OutboundEmail): Promise<MailSendResult> {
    if (mail.idempotencyKey.trim() === "") {
      throw new MailError("invalid", "an outbound email needs a non-empty idempotency key");
    }
    const existing = this.byKey.get(mail.idempotencyKey);
    if (existing !== undefined) {
      return { ...existing, created: false };
    }
    const digest = createHash("sha256").update(mail.idempotencyKey).digest("hex");
    const result: MailSendResult = {
      artifact: `memory:${mail.idempotencyKey}`,
      messageId: `<${digest.slice(0, 24)}@memory.local>`,
      created: true,
      sentAt: this.now().toISOString(),
    };
    this.byKey.set(mail.idempotencyKey, result);
    this.messages.push({ ...mail });
    return result;
  }
}
