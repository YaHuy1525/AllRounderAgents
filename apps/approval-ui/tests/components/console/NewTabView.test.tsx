import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DescribeRunForm, NewTabView, describedIssue } from "@/components/console/NewTabView";
import { RUNNABLE_WORKFLOWS } from "@/lib/runs";

type NewTabProps = ComponentProps<typeof NewTabView>;

const TICKET: NewTabProps["issues"][number] = {
  key: "SCRUM-38",
  project: "SCRUM",
  summary: "Review Draft PR #2 against the usage guide",
  issue_type: "Task",
  priority: "Medium",
  status: "To Do",
  assignee: null,
  labels: ["review", "coding"],
  updated: "2026-09-12T10:00:00Z",
  browse_url: "https://example.atlassian.net/browse/SCRUM-38",
};

function renderNewTab(overrides: Partial<NewTabProps> = {}): string {
  const props: NewTabProps = {
    issues: [TICKET],
    status: "1 ticket",
    onOpenTicket: () => {},
    ...overrides,
  };
  return renderToString(<NewTabView {...props} />);
}

describe("new tab intake modes", () => {
  it("renders the intake toggle with the ticket mode selected by default", () => {
    const html = renderNewTab();
    expect(html).toContain(">From a ticket</button>");
    expect(html).toContain(">Describe it</button>");
    expect(html).toContain('aria-selected="true" class="selected">From a ticket');
    expect(html).toContain('aria-selected="false" class="">Describe it');
  });

  it("keeps the ticket picker as the default pane", () => {
    const html = renderNewTab();
    expect(html).toContain('id="new-tab-search"');
    expect(html).toContain("Choose a ticket");
    expect(html).toContain("Select a ticket to see the workflows you can run.");
    // The describe pane stays unmounted until its tab is picked.
    expect(html).not.toContain("Describe the run");
  });

  it("renders the describe form with title, description, and every runnable workflow", () => {
    const html = renderToString(<DescribeRunForm />);
    expect(html).toContain("Describe the run");
    expect(html).toContain(">Title</span>");
    expect(html).toContain(">Description</span>");
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('maxLength="2000"');
    for (const workflow of RUNNABLE_WORKFLOWS) {
      expect(html).toContain(`>${workflow.label}</option>`);
    }
    // The disabled card explains the title gate, not the role rule.
    expect(html).toContain("Add a title with at least 3 characters to start the run.");
    expect(html).not.toContain("Starting runs requires the agent or admin role.");
  });

  it("builds a local pseudo-issue for described runs", () => {
    const issue = describedIssue("TASK-123456789", "  Tidy the retry logs  ");
    expect(issue.key).toMatch(/^TASK-[1-9][0-9]{8}$/);
    expect(issue.project).toBe("TASK");
    expect(issue.summary).toBe("Tidy the retry logs");
    expect(issue.labels).toEqual(["described"]);
    expect(issue.browse_url).toBe("");
    expect(describedIssue("TASK-123456789", "   ").summary).toBe("Described run");
  });
});
