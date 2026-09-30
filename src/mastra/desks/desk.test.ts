import { describe, expect, it } from "vitest";

import { deskConformance } from "./conformance.js";
import { MemoryDeskAdapter } from "./memory.js";
import { DeskError, type DeskTicketDraft } from "./types.js";

deskConformance("MemoryDeskAdapter", {
  createDesk: () => new MemoryDeskAdapter(),
  dedupes: true,
});

const DRAFT: DeskTicketDraft = {
  clientRef: "acme",
  title: "VPN outage for three users",
  body: "Since 9am our Sydney office cannot reach the VPN.",
  correlationId: "corr-1",
};

describe("MemoryDeskAdapter", () => {
  it("replays a same-correlation create onto one ticket", async () => {
    const desk = new MemoryDeskAdapter();
    const first = await desk.createTicket(DRAFT);
    const replay = await desk.createTicket({ ...DRAFT, title: "ignored on replay" });
    expect(replay.key).toBe(first.key);
    const other = await desk.createTicket({ ...DRAFT, correlationId: "corr-2" });
    expect(other.key).not.toBe(first.key);
  });

  it("records comment replays instead of posting twice", async () => {
    const desk = new MemoryDeskAdapter();
    const ref = await desk.createTicket(DRAFT);
    const first = await desk.addComment(ref, { body: "Reply sent.", evidenceRefs: ["r-1"] });
    const second = await desk.addComment(ref, { body: "Reply sent.", evidenceRefs: ["r-1"] });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.commentId).toBe(first.commentId);
  });

  it("keeps every write behind a DeskError when the ticket is gone", async () => {
    const desk = new MemoryDeskAdapter();
    await expect(desk.setStatus({ key: "MSP-404" }, "Done")).rejects.toMatchObject({
      name: "DeskError",
      code: "not-found",
    });
    await expect(
      desk.attachEvidence(
        { key: "MSP-404" },
        { fileName: "f.json", mediaType: "application/json", content: "{}", evidenceRef: "r" },
      ),
    ).rejects.toBeInstanceOf(DeskError);
  });
});
