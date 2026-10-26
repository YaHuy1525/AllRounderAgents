"""Lane-filtered ticket search behind the chat's "list all HR tickets".

The console already decides which workflows a ticket supports from its summary
and labels (``KEYWORD_WORKFLOW_RULES`` in apps/approval-ui/src/lib/runs.ts).
This module is the server-side port of that vocabulary so both doors, the
agent tool and the UI list, answer from one rule set instead of two.
``test_ticket_search.py`` pins the port against the TS source: an edited token
that is not mirrored here fails CI, exactly like the console tool id pin.

Nothing here writes and nothing here authenticates. Each caller passes the
tenant's already-allowlisted projects, so a query can never widen the view
beyond what the session (or the service-bridged agent turn) is allowed to see.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .jira import JiraIssueReader

# Ported verbatim, in rule order, from KEYWORD_WORKFLOW_RULES in runs.ts.
# The order is part of the contract: "matched" is built in rule order and the
# first entry is what callers treat as the ticket's primary lane.
KEYWORD_LANE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("issues", ("fix:", "bug")),
    ("onboarding", ("new hire", "new-hire", "onboarding", "new starter", "new employee")),
    (
        "offboarding",
        ("offboard", "off-board", "termination", "resignation", "departure", "last day"),
    ),
    ("screening", ("screen", "candidate", "recruit", "interview", "requisition")),
    ("hr-help", ("hr help", "hr-help", "handbook", "policy question", "policy lookup")),
    (
        "security",
        (
            "security",
            "soc ",
            "alert",
            "ioc",
            "malware",
            "phishing",
            "ransomware",
            "siem",
            "edr",
            "intrusion",
            "mitre",
            "cve",
            "exploit",
        ),
    ),
    ("vendors", ("vendor", "onboard")),
    ("accessibility", ("accessib", "a11y")),
    ("dependencies", ("dependen", "upgrade", "bump")),
    ("leave", ("leave", "time-off", "time off", "pto", "vacation")),
)

MAX_TICKETS = 100


@dataclass(frozen=True, slots=True)
class LaneTicket:
    """One ticket plus every lane its text matched, in rule order."""

    key: str
    project: str
    summary: str
    issue_type: str
    priority: str
    status: str
    assignee: str | None
    labels: tuple[str, ...]
    matched: tuple[str, ...]


def match_workflows_from_text(text: str) -> list[str]:
    """Workflow ids whose keyword tokens appear in ``text``, in rule order."""

    haystack = text.lower()
    matched: list[str] = []
    for rule_id, tokens in KEYWORD_LANE_RULES:
        if rule_id in matched:
            continue
        if any(token in haystack for token in tokens):
            matched.append(rule_id)
    return matched


def ticket_payload(ticket: LaneTicket) -> dict[str, object]:
    """The camelCase wire shape both doors and the console list share."""

    return {
        "key": ticket.key,
        "project": ticket.project,
        "summary": ticket.summary,
        "issueType": ticket.issue_type,
        "priority": ticket.priority,
        "status": ticket.status,
        "assignee": ticket.assignee,
        "labels": list(ticket.labels),
        "matchedWorkflows": list(ticket.matched),
    }


def search_lane_tickets(
    reader: JiraIssueReader,
    projects: Sequence[str],
    *,
    workflows: Sequence[str] = (),
    text: str = "",
    per_project: int = 100,
    limit: int = MAX_TICKETS,
) -> list[LaneTicket]:
    """Tickets across ``projects`` that match any lane in ``workflows``.

    A non-empty ``workflows`` keeps only tickets whose matched lanes intersect
    it; ``text`` is a case-insensitive substring over summary plus labels. At
    least one of the two must be given: an unfiltered listing would dump whole
    projects into a chat answer. Jira's per-project order (rank, then updated)
    is preserved, and keys are deduplicated across projects.
    """

    wanted = set(workflows)
    needle = text.strip().lower()
    if not wanted and needle == "":
        raise ValueError("a ticket query needs workflows or text")
    found: list[LaneTicket] = []
    seen: set[str] = set()
    for project in projects:
        if len(found) >= limit:
            break
        for issue in reader.search_issues(project, min(per_project, MAX_TICKETS)):
            haystack = f"{issue.summary} {' '.join(issue.labels)}"
            matched = match_workflows_from_text(haystack)
            if wanted and wanted.isdisjoint(matched):
                continue
            if needle != "" and needle not in haystack.lower():
                continue
            if issue.key in seen:
                continue
            seen.add(issue.key)
            found.append(
                LaneTicket(
                    key=issue.key,
                    project=issue.project,
                    summary=issue.summary,
                    issue_type=issue.issue_type,
                    priority=issue.priority,
                    status=issue.status,
                    assignee=issue.assignee,
                    labels=tuple(issue.labels),
                    matched=tuple(matched),
                )
            )
            if len(found) >= limit:
                break
    return found
