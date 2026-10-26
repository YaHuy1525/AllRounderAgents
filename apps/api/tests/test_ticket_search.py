"""Ticket search behind the chat: ``POST /agent-tools/tickets`` and
``GET /jira/tickets``.

The goal contract is the operator's sentence "list all HR tickets": the lane
vocabulary that decides membership lives in the console's
``KEYWORD_WORKFLOW_RULES`` (apps/approval-ui/src/lib/runs.ts), so one test here
pins the Python port against that TS source, exactly like the governance suite
pins the console tool ids. Both doors read the same service; neither writes.
"""

from __future__ import annotations

import re

import pytest
from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.jira import FakeJiraTransport, JiraBoardIssue
from allrounder_api.settings import Settings
from allrounder_api.ticket_search import (
    KEYWORD_LANE_RULES,
    match_workflows_from_text,
    search_lane_tickets,
)
from fastapi.testclient import TestClient

TOKEN = "agent-tools-service-token-for-tests"
AGENT_HEADERS = {"Authorization": f"Bearer {TOKEN}"}
CONSOLE_TOKEN = "console-session-token-for-tests"
CONSOLE_HEADERS = {"Authorization": f"Bearer {CONSOLE_TOKEN}"}


def issue(
    key: str,
    summary: str,
    *,
    project: str = "HR",
    issue_type: str = "Task",
    status: str = "To Do",
    labels: tuple[str, ...] = (),
) -> JiraBoardIssue:
    return JiraBoardIssue(
        key=key,
        project=project,
        summary=summary,
        issue_type=issue_type,
        priority="Medium",
        status=status,
        assignee="Jordan Avery",
        labels=labels,
        updated="2026-10-01T00:00:00Z",
        browse_url=f"https://example.atlassian.net/browse/{key}",
    )


HR_ISSUES = [
    issue("HR-1", "Annual leave request for PTO in December"),
    issue("HR-2", "New hire onboarding for the finance analyst"),
    issue("HR-3", "Handbook question: parental policy lookup", labels=("policy question",)),
    issue("HR-4", "Refactor the billing cron job"),
    issue("SEC-1", "Phishing alert on the VPN gateway", project="SCRUM"),
    issue("OPS-9", "Vendor onboarding: Nordic Logistics", project="SCRUM"),
]


def _transport() -> FakeJiraTransport:
    return FakeJiraTransport(issues=list(HR_ISSUES))


def _agent_app(
    *,
    token: str | None = TOKEN,
    reader: FakeJiraTransport | None = None,
) -> TestClient:
    app = create_app(
        settings=Settings(
            webhook_secret="test",
            jira_tenant_project_allowlist={"t1": ["HR", "SCRUM"]},
        ),
        knowledge_service_token=token,
        jira_reader=reader if reader is not None else _transport(),
    )
    return TestClient(app)


def _console_app() -> TestClient:
    app = create_app(
        settings=Settings(
            webhook_secret="test",
            jira_tenant_project_allowlist={"t1": ["HR", "SCRUM"]},
        ),
        auth_verifier=FakeBearerVerifier(
            {
                CONSOLE_TOKEN: Principal(
                    subject="op-1", tenant_id="t1", roles=frozenset({"viewer"})
                )
            }
        ),
        jira_reader=_transport(),
    )
    return TestClient(app)


# ----------------------------------------------------------------- lane rules


def test_keyword_rules_match_in_rule_order_without_duplicates() -> None:
    assert match_workflows_from_text("Annual leave and vacation plan") == ["leave"]
    assert match_workflows_from_text("fix: bug in the dependen loader") == [
        "issues",
        "dependencies",
    ]
    # The "soc " token keeps its trailing space: "social" must not trip SOC.
    assert match_workflows_from_text("a social media handbook question") == ["hr-help"]


def test_search_filters_by_workflow_intersection_across_projects() -> None:
    found = search_lane_tickets(
        _transport(),
        ["HR", "SCRUM"],
        workflows=["leave", "hr-help", "onboarding", "offboarding", "screening"],
    )
    keys = [ticket.key for ticket in found]
    # OPS-9 belongs too: "Vendor onboarding" trips the onboarding rule, which
    # is precisely how the console board matcher already routes it.
    assert keys == ["HR-1", "HR-2", "HR-3", "OPS-9"]
    assert found[0].matched == ("leave",)
    assert "onboarding" in found[1].matched


def test_search_text_filter_matches_summary_and_labels() -> None:
    found = search_lane_tickets(_transport(), ["HR", "SCRUM"], text="phishing")
    assert [ticket.key for ticket in found] == ["SEC-1"]


def test_search_requires_workflows_or_text() -> None:
    with pytest.raises(ValueError):
        search_lane_tickets(_transport(), ["HR"])


def test_search_by_key_returns_one_ticket_with_its_lanes() -> None:
    # One key, no lanes and no needle: the guard accepts it, and the row still
    # reports every lane its own text tripped so the console can limit the tab.
    found = search_lane_tickets(_transport(), ["HR", "SCRUM"], key="sec-1")
    assert [ticket.key for ticket in found] == ["SEC-1"]
    assert found[0].matched == ("security",)


def test_search_by_key_misses_answer_empty_rather_than_error() -> None:
    assert search_lane_tickets(_transport(), ["HR", "SCRUM"], key="HR-404") == []


def test_search_honours_the_result_limit() -> None:
    found = search_lane_tickets(
        _transport(), ["HR", "SCRUM"], text="", workflows=["leave"], limit=0
    )
    assert found == []


# ------------------------------------------------------- agent tool door (A)


def test_agent_door_mounts_only_with_the_service_token() -> None:
    denied = _agent_app(token=None).post("/agent-tools/tickets", json={"tenantId": "t1"})
    assert denied.status_code == 404
    wrong = _agent_app().post(
        "/agent-tools/tickets",
        json={"tenantId": "t1", "workflows": ["leave"]},
        headers={"Authorization": "Bearer not-the-token"},
    )
    assert wrong.status_code == 401


def test_agent_door_lists_hr_tickets_for_the_tenant() -> None:
    response = _agent_app().post(
        "/agent-tools/tickets",
        headers=AGENT_HEADERS,
        json={
            "tenantId": "t1",
            "workflows": ["leave", "onboarding", "offboarding", "screening", "hr-help"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert [row["key"] for row in body["tickets"]] == ["HR-1", "HR-2", "HR-3", "OPS-9"]
    assert body["tickets"][0]["matchedWorkflows"] == ["leave"]
    assert body["tickets"][0]["issueType"] == "Task"


def test_agent_door_unknown_tenant_answers_empty_not_error() -> None:
    response = _agent_app().post(
        "/agent-tools/tickets",
        headers=AGENT_HEADERS,
        json={"tenantId": "no-such-tenant", "workflows": ["leave"]},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "count": 0, "tickets": []}


def test_agent_door_refuses_a_query_with_neither_workflows_nor_text() -> None:
    response = _agent_app().post(
        "/agent-tools/tickets", headers=AGENT_HEADERS, json={"tenantId": "t1"}
    )
    assert response.status_code == 422


def test_agent_door_resolves_one_ticket_from_just_a_key() -> None:
    # The execute path: one key in, one row out, with the lanes the row matched.
    response = _agent_app().post(
        "/agent-tools/tickets",
        headers=AGENT_HEADERS,
        json={"tenantId": "t1", "key": "HR-1"},
    )
    assert response.status_code == 200
    body = response.json()
    assert [row["key"] for row in body["tickets"]] == ["HR-1"]
    assert body["tickets"][0]["matchedWorkflows"] == ["leave"]


def test_agent_door_key_miss_answers_empty() -> None:
    response = _agent_app().post(
        "/agent-tools/tickets",
        headers=AGENT_HEADERS,
        json={"tenantId": "t1", "key": "HR-404"},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "count": 0, "tickets": []}


def test_agent_door_rejects_a_malformed_key() -> None:
    response = _agent_app().post(
        "/agent-tools/tickets",
        headers=AGENT_HEADERS,
        json={"tenantId": "t1", "key": "not a key"},
    )
    assert response.status_code == 422


# ------------------------------------------------------ console door (B)


def test_console_door_requires_a_session_and_a_filter() -> None:
    assert _console_app().get("/jira/tickets").status_code == 401
    assert _console_app().get("/jira/tickets", headers=CONSOLE_HEADERS).status_code == 422


def test_console_door_returns_lane_filtered_tickets() -> None:
    response = _console_app().get(
        "/jira/tickets",
        headers=CONSOLE_HEADERS,
        params={"workflows": "security,vendors"},
    )
    assert response.status_code == 200
    body = response.json()
    assert [row["key"] for row in body["tickets"]] == ["HR-2", "SEC-1", "OPS-9"]
    # "Vendor onboarding" trips both keyword rules, in rule order, from either
    # side of the intersection: the row reports every lane its text matched.
    assert body["tickets"][0]["matchedWorkflows"] == ["onboarding", "vendors"]
    assert body["tickets"][1]["matchedWorkflows"] == ["security"]


# -------------------------------------------------------------- governance pin


def test_python_lane_rules_are_pinned_to_the_console_vocabulary() -> None:
    """The TS keyword table is the single source; the Python port may not drift.

    Reads ``KEYWORD_WORKFLOW_RULES`` out of runs.ts the same way
    ``test_governance.py`` reads tool ids out of console-tools.ts.
    """

    from allrounder_api.policy import policy_dir

    source = policy_dir().parent / "apps" / "approval-ui" / "src" / "lib" / "runs.ts"
    if not source.is_file():
        pytest.skip("the console source tree is not present in this checkout")
    text = source.read_text(encoding="utf-8")
    block = re.search(
        r"KEYWORD_WORKFLOW_RULES[^=]*=[^\[]*\[(.*?)\n\];", text, re.S
    )
    assert block is not None, "KEYWORD_WORKFLOW_RULES not found in runs.ts"
    entries = re.findall(
        r'\{\s*id:\s*"([^"]+)",\s*tokens:\s*\[(.*?)\]\s*,?\s*\}', block.group(1), re.S
    )
    ts_rules = [
        (rule_id, tuple(re.findall(r'"([^"]+)"', tokens))) for rule_id, tokens in entries
    ]
    assert tuple(ts_rules) == KEYWORD_LANE_RULES
