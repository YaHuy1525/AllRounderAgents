import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryMailSender } from "./memory.js";
import { OutboxMailSender } from "./outbox.js";
import {
  MailError,
  clientRefFor,
  normalizeInboundEmail,
  type OutboundEmail,
} from "./types.js";

const FIXED_NOW = new Date("2026-09-30T09:00:00.000Z");

const OUTBOUND: OutboundEmail = {
  idempotencyKey: "msp-send:case-1:MS-1",
  to: "client@acme.com.au",
  subject: "Re: VPN outage for three users",
  body: "Thanks for the report. We can see the session limit and are increasing it now.",
  inReplyTo: "<original@acme.com.au>",
};

describe("normalizeInboundEmail", () => {
  it("accepts camelCase payloads", () => {
    const email = normalizeInboundEmail(
      {
        messageId: "mail-1",
        from: "sam@acme.com.au",
        fromName: "Sam Turner",
        to: "acme@in.msp.example",
        subject: "VPN outage",
        text: "Hi, the VPN is down for three users.",
        receivedAt: "2026-09-30T08:55:00.000Z",
      },
      { now: () => FIXED_NOW },
    );
    expect(email).toEqual({
      messageId: "mail-1",
      from: "sam@acme.com.au",
      fromName: "Sam Turner",
      to: "acme@in.msp.example",
      subject: "VPN outage",
      text: "Hi, the VPN is down for three users.",
      receivedAt: "2026-09-30T08:55:00.000Z",
    });
  });

  it("accepts Postmark-style and snake_case payloads", () => {
    const postmark = normalizeInboundEmail(
      {
        From: "sam@acme.com.au",
        FromName: "Sam Turner",
        To: "acme@in.msp.example",
        Subject: "  VPN   outage  ",
        TextBody: "The VPN is down.",
        MessageID: "mail-2",
        Date: "Wed, 30 Sep 2026 08:55:00 +1000",
      },
      { now: () => FIXED_NOW },
    );
    expect(postmark.messageId).toBe("mail-2");
    expect(postmark.subject).toBe("VPN outage");
    expect(postmark.receivedAt).toBe("2026-09-29T22:55:00.000Z");

    const snake = normalizeInboundEmail(
      {
        message_id: "mail-3",
        from_email: "sam@acme.com.au",
        to_email: "acme@in.msp.example",
        subject: "Locked out",
        text_body: "Cannot log in.",
        received_at: "2026-09-30T08:55:00.000Z",
      },
      { now: () => FIXED_NOW },
    );
    expect(snake.messageId).toBe("mail-3");
  });

  it("derives a deterministic message id when none is supplied", () => {
    const payload = {
      from: "sam@acme.com.au",
      to: "acme@in.msp.example",
      subject: "VPN outage",
      text: "The VPN is down.",
      receivedAt: "2026-09-30T08:55:00.000Z",
    };
    const first = normalizeInboundEmail(payload, { now: () => FIXED_NOW });
    const second = normalizeInboundEmail(payload, { now: () => FIXED_NOW });
    expect(first.messageId).toMatch(/^derived-/);
    expect(second.messageId).toBe(first.messageId);
  });

  it("fills the received time from the clock and a missing subject", () => {
    const email = normalizeInboundEmail(
      {
        from: "sam@acme.com.au",
        to: "acme@in.msp.example",
        text: "The VPN is down.",
      },
      { now: () => FIXED_NOW },
    );
    expect(email.receivedAt).toBe(FIXED_NOW.toISOString());
    expect(email.subject).toBe("(no subject)");
  });

  it("rejects payloads without an address or a body", () => {
    expect(() => normalizeInboundEmail({ to: "a@b.co", text: "hi" }, { now: () => FIXED_NOW })).toThrow(
      MailError,
    );
    expect(() =>
      normalizeInboundEmail(
        { from: "sam@acme.com.au", to: "acme@in.msp.example", text: "  " },
        { now: () => FIXED_NOW },
      ),
    ).toThrow(/no text body/);
    expect(() => normalizeInboundEmail("nope")).toThrow(MailError);
  });
});

describe("clientRefFor", () => {
  it("reads the client from the per-client ingest address", () => {
    expect(clientRefFor("acme@in.msp.example")).toBe("acme");
    expect(clientRefFor("acme+vpn@in.msp.example")).toBe("acme");
    expect(clientRefFor("Acme.Pty@in.msp.example")).toBe("acme.pty");
    expect(clientRefFor("support@msp.example")).toBe("support");
    expect(clientRefFor("+++@msp.example")).toBe("client");
  });
});

describe("MemoryMailSender", () => {
  it("replays by idempotency key", async () => {
    const sender = new MemoryMailSender({ now: () => FIXED_NOW });
    const first = await sender.send(OUTBOUND);
    expect(first.created).toBe(true);
    expect(sender.outbox).toHaveLength(1);
    const replay = await sender.send({ ...OUTBOUND });
    expect(replay.created).toBe(false);
    expect(replay.messageId).toBe(first.messageId);
    expect(sender.outbox).toHaveLength(1);
  });

  it("requires a non-empty idempotency key", async () => {
    const sender = new MemoryMailSender();
    await expect(sender.send({ ...OUTBOUND, idempotencyKey: " " })).rejects.toMatchObject({
      name: "MailError",
      code: "invalid",
    });
  });
});

describe("OutboxMailSender", () => {
  it("writes one .eml file and replays onto it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "msp-outbox-"));
    const sender = new OutboxMailSender({
      dir,
      address: "service-desk@msp.example",
      now: () => FIXED_NOW,
    });
    const first = await sender.send(OUTBOUND);
    expect(first.created).toBe(true);
    expect(first.artifact).toBe("outbox:msp-send-case-1-MS-1.eml");

    const files = await readdir(dir);
    expect(files).toEqual(["msp-send-case-1-MS-1.eml"]);
    const content = await readFile(join(dir, files[0]!), "utf8");
    expect(content).toContain("From: service-desk@msp.example\r\n");
    expect(content).toContain("To: client@acme.com.au\r\n");
    expect(content).toContain("Subject: Re: VPN outage for three users\r\n");
    expect(content).toContain(`Message-ID: ${first.messageId}\r\n`);
    expect(content).toContain("In-Reply-To: <original@acme.com.au>\r\n");
    expect(content).toContain("\r\n\r\nThanks for the report.");

    const replay = await sender.send({ ...OUTBOUND });
    expect(replay.created).toBe(false);
    expect(replay.messageId).toBe(first.messageId);
    expect(await readdir(dir)).toHaveLength(1);

    const second = await sender.send({ ...OUTBOUND, idempotencyKey: "msp-send:case-1:MS-2" });
    expect(second.created).toBe(true);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it("creates the outbox directory on first send", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "msp-outbox-")), "nested", "outbox");
    const sender = new OutboxMailSender({ dir, address: "service-desk@msp.example" });
    await sender.send(OUTBOUND);
    expect(await readdir(dir)).toHaveLength(1);
  });
});
