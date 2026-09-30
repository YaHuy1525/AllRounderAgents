import { describe, expect, it } from "vitest";

import { isTypingTarget, moveIndex, resolveShortcut } from "./shortcuts.js";

describe("console shortcut resolver", () => {
  it("resolves g-prefixed navigation", () => {
    expect(resolveShortcut("g", false)).toEqual({ kind: "pending" });
    expect(resolveShortcut("b", true)).toEqual({ kind: "action", action: "board" });
    expect(resolveShortcut("r", true)).toEqual({ kind: "action", action: "runs" });
    expect(resolveShortcut("w", true)).toEqual({ kind: "action", action: "workflows" });
  });

  it("clears an unknown or escaped g chord", () => {
    expect(resolveShortcut("x", true)).toEqual({ kind: "clear" });
    expect(resolveShortcut("Escape", true)).toEqual({ kind: "clear" });
    expect(resolveShortcut("g", false, { modifier: true })).toEqual({ kind: "clear" });
    expect(resolveShortcut("b", true, { modifier: true })).toEqual({ kind: "clear" });
  });

  it("opens a new tab on +", () => {
    expect(resolveShortcut("+", false)).toEqual({ kind: "action", action: "new-tab" });
    expect(resolveShortcut("a", false)).toEqual({ kind: "clear" });
  });
});

describe("list movement", () => {
  it("moves and clamps within the list", () => {
    expect(moveIndex(0, 3, 1)).toBe(1);
    expect(moveIndex(2, 3, 1)).toBe(2);
    expect(moveIndex(0, 3, -1)).toBe(0);
    expect(moveIndex(-1, 3, 1)).toBe(0);
    expect(moveIndex(-1, 3, -1)).toBe(2);
    expect(moveIndex(0, 0, 1)).toBe(-1);
  });
});

describe("typing targets", () => {
  it("recognizes inputs, textareas, selects and editors", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
