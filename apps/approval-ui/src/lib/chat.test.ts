import { describe, expect, it } from "vitest";

import {
  addContextChip,
  buildChatRequest,
  CHAT_AGENTS,
  QUICK_PROMPTS,
  removeContextChip,
} from "./chat.js";

describe("assistant context chips", () => {
  it("adds chips keyed by uppercase ticket key", () => {
    const chips = addContextChip([], { key: "eng-7", summary: "Refund flow" });
    expect(chips).toEqual([{ key: "ENG-7", summary: "Refund flow" }]);
  });

  it("removes chips by key", () => {
    const chips = addContextChip(
      addContextChip([], { key: "ENG-1", summary: "A" }),
      { key: "ENG-2", summary: "B" },
    );
    expect(removeContextChip(chips, "ENG-1").map((chip) => chip.key)).toEqual(["ENG-2"]);
    expect(removeContextChip(chips, "NOPE-1")).toEqual(chips);
  });

  it("ignores payloads that are not ticket keys", () => {
    expect(addContextChip([], { key: "<script>", summary: "x" })).toEqual([]);
    expect(addContextChip([], { key: "not a key", summary: "x" })).toEqual([]);
  });

  it("deduplicates chips and moves the latest to the front", () => {
    const chips = addContextChip(
      addContextChip([], { key: "ENG-1", summary: "old" }),
      { key: "ENG-1", summary: "new" },
    );
    expect(chips).toEqual([{ key: "ENG-1", summary: "new" }]);
  });
});

describe("chat payload", () => {
  it("sends the agent, chips, and board snapshot", () => {
    const payload = buildChatRequest({
      message: "  status?  ",
      agent: CHAT_AGENTS[2].id,
      chips: [{ key: "ENG-1", summary: "A" }],
      tickets: [
        { key: "ENG-1", summary: "A" },
        { key: "ENG-2", summary: "B" },
      ],
    });
    expect(payload.message).toBe("status?");
    expect(payload.agent).toBe("coding");
    expect(payload.selectedKey).toBe("ENG-1");
    expect(payload.tickets.map((ticket) => ticket.key)).toEqual(["ENG-1", "ENG-2"]);
  });

  it("caps the ticket payload at the server limit", () => {
    const tickets = Array.from({ length: 60 }, (_, index) => ({
      key: `ENG-${index + 1}`,
      summary: "x",
    }));
    const payload = buildChatRequest({ message: "hi", agent: "triage", chips: [], tickets });
    expect(payload.tickets).toHaveLength(40);
  });

  it("falls back to the board selection when no chip is attached", () => {
    const payload = buildChatRequest({
      message: "hi",
      agent: "triage",
      chips: [],
      tickets: [],
      selectedKey: "ENG-9",
    });
    expect(payload.selectedKey).toBe("ENG-9");
  });

  it("exposes the quick actions", () => {
    expect(QUICK_PROMPTS.map((quick) => quick.label)).toEqual([
      "Current Sprint Status",
      "Project Status Review",
    ]);
  });
});
