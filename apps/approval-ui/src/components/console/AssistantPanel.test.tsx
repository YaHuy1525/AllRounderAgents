import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantPanel } from "@/components/console/AssistantPanel";

type PanelProps = ComponentProps<typeof AssistantPanel>;

const TICKET: PanelProps["tickets"][number] = {
  key: "ACME-7",
  summary: "Chase the W-9 from Ben",
  status: "In Progress",
  issue_type: "Task",
  priority: "High",
  assignee: "Ben",
  labels: ["vendors"],
};

function renderPanel(overrides: Partial<PanelProps> = {}): string {
  const props: PanelProps = {
    tickets: [TICKET],
    selectedKey: TICKET.key,
    onOpenRun: () => {},
    onOpenTicket: () => {},
    onOpenInbox: () => {},
    ...overrides,
  };
  return renderToString(<AssistantPanel {...props} />);
}

describe("assistant panel shell", () => {
  it("keeps the rail header and hosts the conversation", () => {
    const html = renderPanel();
    expect(html).toContain("assistant-panel");
    expect(html).toContain("What would you like to work on?");
    expect(html).toContain('id="chat-input"');
    expect(html).toContain('id="chat-send"');
    expect(html).toContain('aria-label="Conversations"');
  });

  it("contains no lane picker and no quick-action pad", () => {
    const html = renderPanel();
    for (const gone of [
      "agent-picker",
      "Triage assistant",
      "Support assistant",
      "Coding assistant",
      "quick-chips",
      "List blockers",
      "Create task",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  it("holds no regex-driven intent copy anywhere in the panel", () => {
    expect(renderPanel()).not.toContain("pick a quick action below");
  });
});
