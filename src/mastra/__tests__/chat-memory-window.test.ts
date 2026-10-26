import { describe, expect, it } from "vitest";

import { chatLastMessages } from "../mastra.js";

/**
 * The window is a clamp, not a guess: a long thread must never send the whole
 * history to the model, and a mistyped env value must not collapse the
 * conversation to zero turns.
 */
describe("chat last-messages window", () => {
  it("defaults to 40 when unset", () => {
    expect(chatLastMessages(undefined)).toBe(40);
    expect(chatLastMessages("")).toBe(40);
    expect(chatLastMessages("   ")).toBe(40);
  });

  it("accepts a number in range", () => {
    expect(chatLastMessages("10")).toBe(10);
    expect(chatLastMessages("1")).toBe(1);
    expect(chatLastMessages("200")).toBe(200);
  });

  it("clamps out-of-range and unparseable values", () => {
    expect(chatLastMessages("0")).toBe(1);
    expect(chatLastMessages("-5")).toBe(1);
    expect(chatLastMessages("5000")).toBe(200);
    expect(chatLastMessages("abc")).toBe(40);
    expect(chatLastMessages("2.5")).toBe(40);
  });
});
