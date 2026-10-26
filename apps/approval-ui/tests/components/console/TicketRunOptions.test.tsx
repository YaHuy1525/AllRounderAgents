import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StartRunCard } from "@/components/console/RunPanel";
import type { JiraIssue } from "@/lib/board";
import { RUNNABLE_WORKFLOWS, workflowsForTicket } from "@/lib/runs";

/**
 * The ticket tab hands the launcher a filtered option list rather than the
 * whole catalog. These pins cover both halves of that contract: the list the
 * tab computes from a ticket, and the select the card renders from the list.
 */

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "SCRUM-70",
    project: "SCRUM",
    summary: "Feature: export the reconciliation table as CSV",
    issue_type: "Task",
    priority: "Medium",
    status: "To Do",
    assignee: null,
    labels: ["coding", "feature"],
    updated: "2026-10-20T10:00:00Z",
    browse_url: "https://example.atlassian.net/browse/SCRUM-70",
    ...overrides,
  };
}

function optionsFor(ticket: JiraIssue) {
  const supported = workflowsForTicket({
    issueType: ticket.issue_type,
    summary: ticket.summary,
    labels: ticket.labels,
  });
  return RUNNABLE_WORKFLOWS.filter((item) => supported.includes(item.id));
}

function renderCard(ticket: JiraIssue): string {
  return renderToString(
    <StartRunCard
      issue={ticket}
      caseId={null}
      workflowOptions={optionsFor(ticket)}
      onStarted={() => {}}
    />,
  );
}

const TECH = ["review", "issues", "features", "dependencies", "accessibility"];
const HR = ["leave", "onboarding", "offboarding", "screening", "hr-help"];

function labelsOf(ids: string[]): string[] {
  return RUNNABLE_WORKFLOWS.filter((item) => ids.includes(item.id)).map((item) => item.label);
}

describe("ticket launcher workflow options", () => {
  it("offers the tech lanes and none of the HR lanes for a tech ticket", () => {
    const html = renderCard(issue());
    expect(html).toContain(">Feature Implementation</option>");
    expect(html).toContain(">PR Review</option>");
    for (const label of labelsOf(HR)) {
      expect(html).not.toContain(`>${label}</option>`);
    }
  });

  it("lists every lane a ticket matched, in match order", () => {
    const html = renderCard(
      issue({
        key: "SCRUM-74",
        summary: "Accessibility audit and dependency refresh for the console",
        labels: ["accessibility", "dependency"],
      }),
    );
    expect(html).toContain(">Accessibility Audit</option>");
    expect(html).toContain(">Dependency Update</option>");
    expect(html).not.toContain(">Leave Request</option>");
  });

  it("offers only the HR lanes for an HR ticket", () => {
    const html = renderCard(
      issue({
        key: "SCRUM-71",
        summary: "Leave: overlapping November bookings for Pavel Novak",
        labels: ["leave", "sim"],
      }),
    );
    for (const label of labelsOf(TECH)) {
      expect(html).not.toContain(`>${label}</option>`);
    }
    expect(html).toContain(">Leave Request</option>");
    expect(html).not.toContain(">PR Review</option>");
    expect(html).not.toContain(">Feature Implementation</option>");
  });

  it("starts on the most relevant lane, not on the first catalog entry", () => {
    const html = renderCard(
      issue({
        key: "SCRUM-72",
        summary: "HR help: is the training budget still current",
        labels: ["hr-help", "handbook"],
      }),
    );
    expect(html).toContain('selected="">HR Help');
    expect(html).not.toContain('selected="">PR Review');
  });

  it("never lists a lane the console does not start", () => {
    const html = renderCard(
      issue({ key: "SCRUM-73", summary: "Vendor onboarding pack", labels: ["vendor"] }),
    );
    expect(html).not.toContain(">Vendor Onboarding</option>");
    expect(html).not.toContain(">SOC Alert Triage</option>");
  });
});
