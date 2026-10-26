"""Lane-filtered ticket search behind the chat's "list all HR tickets".

The rule vocabulary is a port of ``KEYWORD_WORKFLOW_RULES`` in
apps/approval-ui/src/lib/runs.ts, so the agent tool and the UI list answer from one
rule set, and ``test_ticket_search.py`` fails CI when the two drift. Nothing here
writes or authenticates, and each caller passes the tenant's allowlisted projects, so
a query can never widen the view.
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
    key: str = "",
    per_project: int = 100,
    limit: int = MAX_TICKETS,
) -> list[LaneTicket]:
    """Tickets across ``projects`` that match any lane in ``workflows``.

    A non-empty ``workflows`` keeps only tickets whose matched lanes intersect
    it; ``text`` is a case-insensitive substring over summary plus labels; ``key``
    is an exact Jira ticket key, so a caller can resolve one ticket (for example
    ``SCRUM-10``) and read the lanes its own text matches. At least one of the
    three must be given: an unfiltered listing would dump whole projects into a
    chat answer. Jira's per-project order (rank, then updated) is preserved, and
    keys are deduplicated across projects.
    """

    wanted = set(workflows)
    needle = text.strip().lower()
    wanted_key = key.strip().upper()
    if not wanted and needle == "" and wanted_key == "":
        raise ValueError("a ticket query needs workflows, text, or a key")
    found: list[LaneTicket] = []
    seen: set[str] = set()
    for project in projects:
        if len(found) >= limit:
            break
        for issue in reader.search_issues(project, min(per_project, MAX_TICKETS)):
            if wanted_key != "" and issue.key.upper() != wanted_key:
                continue
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
