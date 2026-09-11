import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TicketCard } from "@/components/console/TicketCard";
import type { JiraIssue } from "@/lib/board";

const maliciousIssue: JiraIssue = {
  key: "ENG-9",
  project: "ENG",
  summary: '<script>alert("xss")</script> & <img src=x onerror=alert(1)>',
  issue_type: "Bug",
  priority: "High",
  status: "Open",
  assignee: null,
  labels: ["security"],
  updated: "2026-09-10T10:00:00Z",
  browse_url: "https://example.atlassian.net/browse/ENG-9",
};

describe("ticket card rendering", () => {
  it("renders a malicious summary as text, never as markup", () => {
    const html = renderToString(<TicketCard issue={maliciousIssue} onOpenDetails={() => {}} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("alert");
  });

  it("keeps the ticket key and a Details action for opening the tab", () => {
    const html = renderToString(<TicketCard issue={maliciousIssue} onOpenDetails={() => {}} />);
    expect(html).toContain("ENG-9");
    expect(html).toContain("Details");
  });
});
