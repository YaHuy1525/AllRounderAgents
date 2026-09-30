/**
 * Console keyboard shortcuts, kept as pure resolvers so the key handling can
 * be unit-tested without a DOM. The Console window listener feeds each
 * keydown through :func:`resolveShortcut`; list navigation (j/k) uses
 * :func:`moveIndex` inside the runs view.
 */

export type ShortcutAction = "board" | "runs" | "workflows" | "new-tab";

export type ShortcutResolution =
  | { kind: "pending" } // `g` seen; the next key decides the destination
  | { kind: "clear" } // nothing to do; drop any pending `g`
  | { kind: "action"; action: ShortcutAction };

export function resolveShortcut(
  key: string,
  pendingG: boolean,
  options: { modifier?: boolean } = {},
): ShortcutResolution {
  if (options.modifier) return { kind: "clear" };
  if (key === "Escape") return { kind: "clear" };
  if (pendingG) {
    if (key === "b") return { kind: "action", action: "board" };
    if (key === "r") return { kind: "action", action: "runs" };
    if (key === "w") return { kind: "action", action: "workflows" };
    return { kind: "clear" };
  }
  if (key === "g") return { kind: "pending" };
  if (key === "+") return { kind: "action", action: "new-tab" };
  return { kind: "clear" };
}

/**
 * j/k list movement. Returns the next row index clamped to the list bounds,
 * or -1 when the list is empty; a cursor outside the list (-1) enters from
 * the matching end.
 */
export function moveIndex(current: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : length - 1;
  return Math.min(Math.max(current + direction, 0), length - 1);
}

/** True when the event target swallows typing (inputs, editors, selects). */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { isContentEditable?: unknown; tagName?: unknown };
  if (element.isContentEditable === true) return true;
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
