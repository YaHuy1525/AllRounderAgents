import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatShell } from "./ChatShell";

/**
 * Node-side markup assertions, the convention this app already uses. Effects do
 * not run under SSR, so the thread list is empty and the composer carries the
 * not-signed-in copy — both are structure, and both are worth pinning. Actual
 * streaming, clicking, and focus are proven by the live browser pass only.
 */
const props = {
  tickets: [],
  selectedKey: undefined,
  onOpenRun: () => {},
  onOpenTicket: () => {},
  onOpenInbox: () => {},
};

describe("chat shell", () => {
  it("renders the composer and the send control with no intent UI", () => {
    const html = renderToString(<ChatShell {...props} />);
    expect(html).toContain('id="chat-input"');
    expect(html).toContain('id="chat-send"');
    expect(html).toContain("Ask anything about this console");
    // The old lane picker and quick-action pad are gone: one assistant, no routing.
    expect(html).not.toContain("agent-picker");
    expect(html).not.toContain("Triage assistant");
    expect(html).not.toContain("quick-chips");
    expect(html).not.toContain("List blockers");
  });

  it("disables the composer when the account carries no tenant", () => {
    const html = renderToString(<ChatShell {...props} unusable />);
    expect(html).toContain("disabled");
    expect(html).toContain("no tenant");
  });

  it("keeps the conversation sidebar reachable", () => {
    const html = renderToString(<ChatShell {...props} />);
    expect(html).toContain('aria-label="Conversations"');
    expect(html).toContain("New chat");
  });
});
