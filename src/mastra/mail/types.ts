import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * The mail seam: inbound client email is normalized into one shape, replies
 * leave through one sender interface (MSP plan section 5, channels beyond
 * tickets). The forwarding address is the v0.1 intake channel; Microsoft 365
 * or Gmail senders plug in behind `MailSender` later without touching the
 * flow. Senders are idempotent by `idempotencyKey`, so a replayed send never
 * posts twice.
 */

export const InboundEmailSchema = z
  .object({
    messageId: z.string().min(1).max(300),
    from: z.string().min(3).max(320),
    fromName: z.string().min(1).max(200).optional(),
    to: z.string().min(3).max(320),
    subject: z.string().min(1).max(500),
    text: z.string().min(1).max(20_000),
    receivedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type InboundEmail = z.infer<typeof InboundEmailSchema>;

export interface OutboundEmail {
  /** Stable replay key (the flow hashes its exact action into this). */
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly from?: string;
}

export interface MailSendResult {
  /** Where the message was recorded ("outbox:acme-1.eml", "memory:..."). */
  readonly artifact: string;
  readonly messageId: string;
  /** false when the idempotency key replayed an earlier send. */
  readonly created: boolean;
  readonly sentAt: string;
}

export interface MailSender {
  /** The mailbox replies leave from (shown on the send checkpoint). */
  readonly address: string;
  send(mail: OutboundEmail): Promise<MailSendResult>;
}

export type MailErrorCode = "invalid" | "unsupported" | "unreachable";

export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly retryable: boolean;

  constructor(code: MailErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(`mail: ${message}`);
    this.name = "MailError";
    this.code = code;
    this.retryable = options.retryable ?? code === "unreachable";
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Collapse untrusted values to one line before they enter prompts. */
export function flatten(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function deriveMessageId(parts: {
  from: string;
  subject: string;
  receivedAt: string;
  text: string;
}): string {
  const digest = createHash("sha256")
    .update(`${parts.from}|${parts.subject}|${parts.receivedAt}|${parts.text}`)
    .digest("hex");
  return `derived-${digest.slice(0, 24)}`;
}

/**
 * Normalize one inbound email payload into `InboundEmail`. Accepts the camel,
 * snake and Postmark-ish key spellings the intake route, the forwarder
 * webhook and the tests speak; a missing message id is derived from the
 * content so a replayed delivery always lands on the same id.
 */
export function normalizeInboundEmail(
  payload: unknown,
  options: { now?: () => Date } = {},
): InboundEmail {
  if (!isRecord(payload)) {
    throw new MailError("invalid", "inbound email payload must be an object");
  }
  const from = asText(pick(payload, ["from", "From", "from_email", "fromEmail", "sender"]));
  const to = asText(pick(payload, ["to", "To", "to_email", "toEmail", "recipient"]));
  if (!EMAIL_PATTERN.test(from)) {
    throw new MailError("invalid", `inbound email has no valid sender address (${from || "empty"})`);
  }
  if (!EMAIL_PATTERN.test(to)) {
    throw new MailError("invalid", `inbound email has no valid recipient address (${to || "empty"})`);
  }
  const subjectRaw = asText(pick(payload, ["subject", "Subject", "title"]));
  const textRaw = asText(
    pick(payload, ["text", "Text", "textBody", "TextBody", "text_body", "body", "Body"]),
  );
  if (textRaw === "") {
    throw new MailError("invalid", "inbound email has no text body");
  }
  const receivedRaw = asText(
    pick(payload, ["receivedAt", "received_at", "Date", "date", "timestamp"]),
  );
  const receivedAt = new Date(
    receivedRaw === "" ? options.now?.() ?? new Date() : receivedRaw,
  );
  if (Number.isNaN(receivedAt.getTime())) {
    throw new MailError("invalid", `inbound email has an invalid received date (${receivedRaw})`);
  }
  const fromName = asText(pick(payload, ["fromName", "from_name", "FromName"]));
  const messageIdRaw = asText(
    pick(payload, ["messageId", "message_id", "MessageID", "MessageId", "id"]),
  );
  const subject = subjectRaw === "" ? "(no subject)" : flatten(subjectRaw).slice(0, 500);
  const receivedIso = receivedAt.toISOString();
  return InboundEmailSchema.parse({
    messageId:
      messageIdRaw === ""
        ? deriveMessageId({ from, subject, receivedAt: receivedIso, text: textRaw })
        : messageIdRaw.slice(0, 300),
    from,
    ...(fromName === "" ? {} : { fromName: flatten(fromName).slice(0, 200) }),
    to,
    subject,
    text: textRaw,
    receivedAt: receivedIso,
  });
}

/**
 * The client a per-client ingest address belongs to: the local part before
 * any plus-suffix, lowercased ("acme+vpn@in.msp.example" -> "acme"). Falls
 * back to "client" so a generic forwarder address still yields a stable ref.
 */
export function clientRefFor(address: string): string {
  const local = address.split("@")[0] ?? "";
  const base = (local.split("+")[0] ?? "").trim().toLowerCase();
  const cleaned = base.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "client" : cleaned.slice(0, 80);
}
