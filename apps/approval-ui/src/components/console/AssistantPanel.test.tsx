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

describe("assistant panel shell (U8)", () => {
  it("renders the shell, the agent picker, and the send control", () => {
    const html = renderPanel();
    expect(html).toContain("What would you like to work on?");
    expect(html).toContain("Triage assistant");
    expect(html).toContain("Support assistant");
    expect(html).toContain("Coding assistant");
    expect(html).toContain('id="chat-send"');
    expect(html).toContain("Send");
  });

  it("renders the lane quick actions for the selected ticket", () => {
    const html = renderPanel();
    expect(html).toContain("List blockers");
    expect(html).toContain("Create task");
    // Effects do not run in SSR, so the run context (and the run-only
    // action plus the context strip that hang off it) stays hidden.
    expect(html).not.toContain("Summarize this run");
    expect(html).not.toContain("chat-run-context");
  });

  it("hides the quick actions without a selected ticket", () => {
    const html = renderPanel({ selectedKey: undefined });
    expect(html).toContain("What would you like to work on?");
    expect(html).not.toContain("List blockers");
    expect(html).not.toContain("Create task");
  });

  it("keeps the drop-a-ticket hint in the empty log", () => {
    const html = renderPanel();
    expect(html).toContain("drag a ticket here for context");
    expect(html).toContain("pick a quick action below");
  });
});
