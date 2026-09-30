import { describe, expect, it } from "vitest";

import { DeskError, type DeskAdapter, type DeskTicketDraft } from "./types.js";

export interface DeskConformanceOptions {
  /** A fresh adapter per test so no state leaks between cases. */
  readonly createDesk: () => DeskAdapter | Promise<DeskAdapter>;
  /**
   * True when a create replay with the same correlation id returns the
   * original ticket; false when every create lands a new ticket (the flow's
   * effect map then carries the replay guard).
   */
  readonly dedupes: boolean;
}

const DRAFT: DeskTicketDraft = {
  clientRef: "acme",
  title: "VPN outage for three users",
  body: "Hi team, since 9am our Sydney office cannot reach the VPN.",
  correlationId: "corr-conformance-1",
  labels: ["email-intake"],
};

/**
 * Shared conformance suite every desk adapter must pass before it merges
 * (MSP plan section 5): capability declarations, create and replay, comment,
 * transition and attach paths, and loud failures on unknown tickets.
 * Recorded fixtures and transport-specific tests live next to each adapter;
 * the invariants here are the seam itself.
 */
export function deskConformance(name: string, options: DeskConformanceOptions): void {
  describe(`desk conformance: ${name}`, () => {
    it("declares every capability flag as a boolean", async () => {
      const desk = await options.createDesk();
      expect(desk.provider.length).toBeGreaterThan(0);
      const flags = desk.capabilities();
      for (const flag of [
        "create",
        "comment",
        "transition",
        "attach",
        "webhook",
        "polling",
      ] as const) {
        expect(typeof flags[flag], flag).toBe("boolean");
      }
      // The seam cannot work without creation; the rest may degrade.
      expect(flags.create).toBe(true);
    });

    it("creates a ticket that reads back by key", async () => {
      const desk = await options.createDesk();
      const ref = await desk.createTicket(DRAFT);
      expect(ref.key).not.toBe("");
      const state = await desk.readTicket(ref);
      expect(state.exists).toBe(true);
    });

    it("replays or restates a same-correlation create", async () => {
      const desk = await options.createDesk();
      const first = await desk.createTicket(DRAFT);
      const second = await desk.createTicket({ ...DRAFT });
      if (options.dedupes) {
        expect(second.key).toBe(first.key);
      } else {
        expect(second.key).not.toBe(first.key);
        expect((await desk.readTicket(second)).exists).toBe(true);
      }
    });

    it("posts comments with evidence refs when comments are supported", async () => {
      const desk = await options.createDesk();
      if (!desk.capabilities().comment) return;
      const ref = await desk.createTicket(DRAFT);
      const result = await desk.addComment(ref, {
        body: "Approved reply sent.",
        evidenceRefs: ["receipt:abc123"],
      });
      expect(result.commentId).not.toBe("");
      expect(result.created).toBe(true);
    });

    it("moves status when transitions are supported", async () => {
      const desk = await options.createDesk();
      if (!desk.capabilities().transition) return;
      const ref = await desk.createTicket(DRAFT);
      await desk.setStatus(ref, "In Progress");
      const state = await desk.readTicket(ref);
      expect(state.status).toBe("In Progress");
    });

    it("attaches evidence when attachments are supported", async () => {
      const desk = await options.createDesk();
      if (!desk.capabilities().attach) return;
      const ref = await desk.createTicket(DRAFT);
      await expect(
        desk.attachEvidence(ref, {
          fileName: "receipt.json",
          mediaType: "application/json",
          content: '{"receipt":"abc123"}',
          evidenceRef: "receipt:abc123",
        }),
      ).resolves.toMatchObject({ key: ref.key });
    });

    it("fails loudly on unknown tickets", async () => {
      const desk = await options.createDesk();
      const ghost = { key: "GHOST-999" };
      if (desk.capabilities().comment) {
        await expect(desk.addComment(ghost, { body: "hi" })).rejects.toBeInstanceOf(
          DeskError,
        );
      }
      const state = await desk.readTicket(ghost);
      expect(state.exists).toBe(false);
    });

    it("throws DeskError unsupported when a capability is off", async () => {
      const desk = await options.createDesk();
      const flags = desk.capabilities();
      if (!flags.comment) {
        await expect(desk.addComment({ key: "X-1" }, { body: "hi" })).rejects.toMatchObject(
          { name: "DeskError", code: "unsupported" },
        );
      }
      if (!flags.transition) {
        await expect(desk.setStatus({ key: "X-1" }, "Done")).rejects.toMatchObject({
          name: "DeskError",
          code: "unsupported",
        });
      }
      if (!flags.attach) {
        await expect(
          desk.attachEvidence(
            { key: "X-1" },
            {
              fileName: "f.json",
              mediaType: "application/json",
              content: "{}",
              evidenceRef: "receipt:r",
            },
          ),
        ).rejects.toMatchObject({ name: "DeskError", code: "unsupported" });
      }
    });
  });
}
