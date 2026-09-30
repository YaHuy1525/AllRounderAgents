import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MailError, type MailSendResult, type MailSender, type OutboundEmail } from "./types.js";

export interface OutboxMailSenderOptions {
  /** Directory the .eml files land in (created on first send). */
  readonly dir: string;
  /** The mailbox replies leave from. */
  readonly address: string;
  readonly now?: () => Date;
}

/**
 * Outbox mail sender for the M1 demo: every reply lands as a standards-shaped
 * .eml file in a directory the MSP can open or sync. The file name derives
 * from the idempotency key, so a replayed send finds the existing file and
 * reports `created: false` instead of writing a second copy. SMTP or
 * Microsoft Graph senders replace this behind the same `MailSender` seam.
 */
export class OutboxMailSender implements MailSender {
  readonly address: string;
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(options: OutboxMailSenderOptions) {
    this.dir = options.dir;
    this.address = options.address;
    this.now = options.now ?? (() => new Date());
  }

  async send(mail: OutboundEmail): Promise<MailSendResult> {
    if (mail.idempotencyKey.trim() === "") {
      throw new MailError("invalid", "an outbound email needs a non-empty idempotency key");
    }
    const fileName = `${sanitizeKey(mail.idempotencyKey)}.eml`;
    const path = join(this.dir, fileName);
    const existing = await this.readExisting(path, mail.idempotencyKey);
    if (existing !== null) {
      return existing;
    }
    const messageId = messageIdFor(mail.idempotencyKey);
    const sentAt = this.now().toISOString();
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path, buildEml(mail, messageId, this.address, sentAt), "utf8");
    } catch (error) {
      throw new MailError(
        "unreachable",
        `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      artifact: `outbox:${fileName}`,
      messageId,
      created: true,
      sentAt,
    };
  }

  private async readExisting(path: string, key: string): Promise<MailSendResult | null> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new MailError(
        "unreachable",
        `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const recorded = content.match(/^Message-ID: <(.+)>$/m)?.[1];
    return {
      artifact: `outbox:${sanitizeKey(key)}.eml`,
      messageId: recorded === undefined ? messageIdFor(key) : `<${recorded}>`,
      created: false,
      sentAt: this.now().toISOString(),
    };
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** File-system-safe idempotency key; keeps the mapping obvious in the dir. */
function sanitizeKey(key: string): string {
  const cleaned = key
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned === "" ? "message" : cleaned;
}

function messageIdFor(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return `<${digest.slice(0, 24)}@outbox.local>`;
}

/** Minimal RFC 5322 message with CRLF line endings. */
function buildEml(mail: OutboundEmail, messageId: string, from: string, sentAt: string): string {
  const headers = [
    `From: ${mail.from ?? from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject.replace(/[\r\n]+/g, " ")}`,
    `Date: ${new Date(sentAt).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(mail.inReplyTo === undefined ? [] : [`In-Reply-To: ${mail.inReplyTo.replace(/[\r\n]+/g, " ")}`]),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
  ];
  const body = mail.body.replace(/\r?\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}
