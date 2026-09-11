from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from allrounder_api.jira import JiraBoardIssue, JiraBoardSummary
from allrounder_api.jira_mcp import (
    McpJiraError,
    McpJiraTransport,
    McpJiraUnavailable,
    McpToolResult,
)

SITE = "https://example.atlassian.net"


class FakeMcpSession:
    """Records tool calls and replays canned results (JiraMcpSession seam)."""

    def __init__(self, script: list[McpToolResult] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._results = list(script or [])
        self.closed = False

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> McpToolResult:
        self.calls.append((name, dict(arguments)))
        if self._results:
            return self._results.pop(0)
        return McpToolResult(payload=None, text="", is_error=False)

    async def close(self) -> None:
        self.closed = True


def transport(session: FakeMcpSession, **kwargs: Any) -> McpJiraTransport:
    return McpJiraTransport(SITE, "user@example.com", "token", session=session, **kwargs)


def evidence_row(
    key: str,
    summary: str,
    *,
    issue_type: str | None = None,
    status: str | None = None,
    priority: str | None = None,
    assignee: dict[str, str] | None = None,
    labels: list[str] | None = None,
    updated: str | None = None,
) -> dict[str, Any]:
    fields: dict[str, Any] = {"summary": summary}
    if issue_type is not None:
        fields["issuetype"] = {"id": "10003", "name": issue_type}
    if status is not None:
        fields["status"] = {"name": status, "statusCategory": {"name": status}}
    if priority is not None:
        fields["priority"] = {"name": priority}
    fields["assignee"] = assignee
    fields["labels"] = labels or []
    fields["updated"] = updated or "2026-09-07T01:51:48.595+1000"
    return {"id": "10000", "key": key, "fields": fields}


def search_payload(*rows: dict[str, Any], token: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"issues": list(rows), "isLast": token is None}
    if token is not None:
        payload["nextPageToken"] = token
    return {"data": payload}


def test_mcp_comment_and_transition_map_args() -> None:
    session = FakeMcpSession()
    client = transport(session, cloud_id="a8e21b5d-e1e6-4d08-ab26-d309f1fddc76")
    try:
        client.add_comment("ENG-42", "hello board")
        client.transition("ENG-42", "31")
        client.transition("ENG-42", "In Progress")
    finally:
        client.close()

    assert session.calls == [
        (
            "addOrEditJiraIssueComment",
            {
                "cloudId": "a8e21b5d-e1e6-4d08-ab26-d309f1fddc76",
                "issueIdOrKey": "ENG-42",
                "commentBody": "hello board",
            },
        ),
        (
            "transitionJiraIssue",
            {
                "cloudId": "a8e21b5d-e1e6-4d08-ab26-d309f1fddc76",
                "issueIdOrKey": "ENG-42",
                "transitionId": "31",
            },
        ),
        (
            "transitionJiraIssue",
            {
                "cloudId": "a8e21b5d-e1e6-4d08-ab26-d309f1fddc76",
                "issueIdOrKey": "ENG-42",
                "transitionName": "In Progress",
            },
        ),
    ]
    assert session.closed


def test_mcp_writes_reject_untrusted_ticket_keys() -> None:
    session = FakeMcpSession()
    client = transport(session)
    try:
        with pytest.raises(ValueError, match="Invalid Jira ticket key"):
            client.add_comment("../admin", "unsafe")
        with pytest.raises(ValueError, match="Invalid Jira ticket key"):
            client.transition("ENG-0/../../admin", "31")
        with pytest.raises(ValueError, match="Invalid Jira project key"):
            client.search_issues('ENG" OR project != "ENG', 10)
    finally:
        client.close()
    assert session.calls == []


def test_mcp_error_subclasses_http_error() -> None:
    # The board router maps httpx.HTTPError onto 502 responses; keep the
    # transport error hierarchy compatible with that catch-all.
    assert issubclass(McpJiraUnavailable, McpJiraError)
    assert issubclass(McpJiraError, httpx.HTTPError)


def test_mcp_tool_rejection_degrades_to_rest_fallback() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(201, json={})

    session = FakeMcpSession(
        [
            McpToolResult(
                payload={"message": "You don't have permission to connect via API token"},
                text="",
                is_error=True,
            )
        ]
    )
    rest_client = httpx.Client(base_url=SITE, transport=httpx.MockTransport(handler))
    client = McpJiraTransport(
        SITE, "user@example.com", "token", client=rest_client, session=session
    )
    try:
        client.add_comment("ENG-42", "hello")  # falls back instead of raising
        client.transition("ENG-42", "31")  # degraded: skips MCP entirely
    finally:
        client.close()
        rest_client.close()

    assert seen == [
        f"{SITE}/rest/api/3/issue/ENG-42/comment",
        f"{SITE}/rest/api/3/issue/ENG-42/transitions",
    ]
    assert len(session.calls) == 1


def test_rest_fallback_failure_surfaces_as_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"errorMessages": ["Unauthorized"]})

    session = FakeMcpSession(
        [
            McpToolResult(
                payload={"message": "session token is missing the scope claim"},
                text="",
                is_error=True,
            )
        ]
    )
    rest_client = httpx.Client(base_url=SITE, transport=httpx.MockTransport(handler))
    client = McpJiraTransport(
        SITE, "user@example.com", "token", client=rest_client, session=session
    )
    try:
        with pytest.raises(httpx.HTTPError):
            client.add_comment("ENG-42", "hello")
    finally:
        client.close()
        rest_client.close()


def test_mcp_session_failure_degrades_to_rest() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(201, json={})

    class BoomSession(FakeMcpSession):
        async def call_tool(self, name: str, arguments: dict[str, Any]) -> McpToolResult:
            await super().call_tool(name, arguments)
            raise RuntimeError("connection reset")

    session = BoomSession()
    rest_client = httpx.Client(base_url=SITE, transport=httpx.MockTransport(handler))
    client = McpJiraTransport(
        SITE, "user@example.com", "token", client=rest_client, session=session
    )
    try:
        client.add_comment("ENG-42", "hello")  # wrapped as MCP failure, then REST
    finally:
        client.close()
        rest_client.close()

    assert seen == [f"{SITE}/rest/api/3/issue/ENG-42/comment"]


def test_mcp_timeout_degrades_to_rest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("allrounder_api.jira_mcp._MCP_CALL_TIMEOUT", 0.05)
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"issues": []})

    class HangingSession(FakeMcpSession):
        async def call_tool(self, name: str, arguments: dict[str, Any]) -> McpToolResult:
            self.calls.append((name, dict(arguments)))
            await asyncio.sleep(1)
            raise AssertionError("unreachable")

    session = HangingSession()
    rest_client = httpx.Client(base_url=SITE, transport=httpx.MockTransport(handler))
    client = McpJiraTransport(
        SITE, "user@example.com", "token", client=rest_client, session=session
    )
    try:
        first = client.search_issues("SCRUM", 10)
        second = client.search_issues("SCRUM", 10)  # degraded: straight to REST
    finally:
        client.close()
        rest_client.close()

    assert first == [] and second == []
    assert len(session.calls) == 2  # first search retried once before degrading
    assert len(seen) == 2
    assert all("/rest/api/3/search/jql" in url for url in seen)


def test_mcp_transient_failure_retries_once_before_degrading() -> None:
    class FlakySession(FakeMcpSession):
        async def call_tool(self, name: str, arguments: dict[str, Any]) -> McpToolResult:
            self.calls.append((name, dict(arguments)))
            if len(self.calls) == 1:
                raise RuntimeError("connection reset")
            return McpToolResult(payload=None, text="", is_error=False)

    session = FlakySession()
    client = transport(session)
    try:
        client.add_comment("ENG-42", "hello")
    finally:
        client.close()

    assert [name for name, _ in session.calls] == [
        "addOrEditJiraIssueComment",
        "addOrEditJiraIssueComment",
    ]
    assert client._degraded_to_rest is False


def test_mcp_search_parses_evidence_rows_with_fallbacks() -> None:
    rows = [
        evidence_row("SCRUM-1", "Task 1", issue_type="Task", status="To Do", assignee=None),
        evidence_row(
            "SCRUM-5",
            "Reconcile ledger",
            issue_type="Task",
            status="To Do",
            priority="Medium",
            assignee={"displayName": "Taylor"},
            labels=["finance", "ledger"],
        ),
        {"malformed": True},
    ]
    session = FakeMcpSession(
        [McpToolResult(payload=search_payload(*rows), text="", is_error=False)]
    )
    client = transport(session)
    try:
        issues = client.search_issues("SCRUM", 10)
    finally:
        client.close()

    assert [issue.key for issue in issues] == ["SCRUM-1", "SCRUM-5"]
    first, second = issues
    assert first.project == "SCRUM"
    assert first.summary == "Task 1"
    assert first.issue_type == "Task"
    assert first.priority == "Medium"  # absent on the wire -> REST-parser fallback
    assert first.status == "To Do"
    assert first.assignee is None
    assert first.labels == ()
    assert first.browse_url == f"{SITE}/browse/SCRUM-1"
    assert second.assignee == "Taylor"
    assert second.labels == ("finance", "ledger")
    assert session.calls[0][0] == "searchJiraIssuesUsingJql"
    assert session.calls[0][1]["jql"].startswith('project = "SCRUM" ORDER BY rank')
    assert session.calls[0][1]["view"] == "evidence"
    assert session.calls[0][1]["maxResults"] == 10


def test_mcp_search_paginates_with_next_page_token() -> None:
    session = FakeMcpSession(
        [
            McpToolResult(
                payload=search_payload(
                    evidence_row("SCRUM-1", "Task 1", issue_type="Task", status="To Do"),
                    token="page-token",
                ),
                text="",
                is_error=False,
            ),
            McpToolResult(
                payload=search_payload(
                    evidence_row("SCRUM-9", "Tenant schema", issue_type="Task", status="To Do")
                ),
                text="",
                is_error=False,
            ),
        ]
    )
    client = transport(session)
    try:
        issues = client.search_issues("SCRUM", 5)
    finally:
        client.close()

    assert [issue.key for issue in issues] == ["SCRUM-1", "SCRUM-9"]
    assert session.calls[1][1]["nextPageToken"] == "page-token"
    assert session.calls[1][1]["maxResults"] == 4  # remaining budget, not the original


def test_mcp_search_caps_page_size_and_does_not_hang_when_empty() -> None:
    session = FakeMcpSession(
        [McpToolResult(payload=search_payload(), text="", is_error=False)]
    )
    client = transport(session)
    try:
        issues = client.search_issues("SCRUM", 250)
    finally:
        client.close()

    assert issues == []
    assert session.calls[0][1]["maxResults"] == 100


def test_mcp_search_jql_passthrough_for_seed_dedupe() -> None:
    session = FakeMcpSession(
        [
            McpToolResult(
                payload=search_payload(
                    evidence_row("SCRUM-5", "Reconcile ledger", issue_type="Task", status="To Do")
                ),
                text="",
                is_error=False,
            )
        ]
    )
    client = transport(session)
    try:
        issues = client.search_jql('project = "SCRUM" AND summary ~ "Reconcile"', 1)
    finally:
        client.close()

    assert [issue.key for issue in issues] == ["SCRUM-5"]
    assert session.calls[0][1]["jql"] == 'project = "SCRUM" AND summary ~ "Reconcile"'
    assert session.calls[0][1]["maxResults"] == 1


def test_mcp_create_issue_extracts_key_from_payload_variants() -> None:
    cases: list[tuple[dict[str, Any] | None, str, str]] = [
        ({"data": {"id": "10100", "key": "SCRUM-11"}}, "", "SCRUM-11"),
        ({"data": {"url": f"{SITE}/browse/SCRUM-12"}}, "", "SCRUM-12"),
        (
            None,
            '{"id": "10100", "url": "https://omnidewalt.atlassian.net/browse/SCRUM-13"}',
            "SCRUM-13",
        ),
    ]
    for payload, text, expected in cases:
        session = FakeMcpSession([McpToolResult(payload=payload, text=text, is_error=False)])
        client = transport(session)
        try:
            key = client.create_issue(
                "SCRUM",
                "Summary",
                issue_type="Task",
                labels=["finance"],
                description="Body",
            )
        finally:
            client.close()
        assert key == expected
        call_name, arguments = session.calls[0]
        assert call_name == "createJiraIssue"
        assert arguments["projectKey"] == "SCRUM"
        assert arguments["issueType"] == "Task"
        assert arguments["labels"] == ["finance"]
        assert arguments["description"] == "Body"
        assert arguments["cloudId"] == SITE


def test_mcp_create_issue_raises_without_key() -> None:
    session = FakeMcpSession(
        [McpToolResult(payload={"data": {"id": "10100"}}, text="", is_error=False)]
    )
    client = transport(session)
    try:
        with pytest.raises(McpJiraError, match="no issue key"):
            client.create_issue(
                "SCRUM",
                "Summary",
                issue_type="Task",
                labels=[],
                description="Body",
            )
    finally:
        client.close()


def test_board_methods_stay_on_readonly_rest_gets() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if "/rest/agile/1.0/board/" in str(request.url) and "/issue" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "issues": [
                        {
                            "key": "SCRUM-42",
                            "fields": {
                                "summary": "On the board",
                                "issuetype": {"name": "Story"},
                                "priority": {"name": "High"},
                                "status": {"name": "In Progress"},
                                "assignee": {"displayName": "Taylor"},
                                "labels": ["agent"],
                                "updated": "2026-09-07T01:00:00Z",
                            },
                        }
                    ]
                },
            )
        if "/rest/agile/1.0/board/1" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "id": 1,
                    "name": "SCRUM board",
                    "type": "scrum",
                    "location": {"projectKey": "SCRUM"},
                },
            )
        if "/rest/agile/1.0/board" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "values": [
                        {
                            "id": 1,
                            "name": "SCRUM board",
                            "type": "scrum",
                            "location": {"projectKey": "SCRUM"},
                        }
                    ]
                },
            )
        raise AssertionError(f"unexpected request {request.url}")

    session = FakeMcpSession()
    rest_client = httpx.Client(
        base_url=SITE,
        transport=httpx.MockTransport(handler),
    )
    client = McpJiraTransport(
        SITE,
        "user@example.com",
        "token",
        client=rest_client,
        session=session,
    )
    try:
        boards = client.list_boards(None)
        issues = client.search_board_issues(1, 10)
    finally:
        client.close()
        rest_client.close()

    assert boards == [
        JiraBoardSummary(id=1, name="SCRUM board", type="scrum", project="SCRUM")
    ]
    assert issues == [
        JiraBoardIssue(
            key="SCRUM-42",
            project="SCRUM",
            summary="On the board",
            issue_type="Story",
            priority="High",
            status="In Progress",
            assignee="Taylor",
            labels=("agent",),
            updated="2026-09-07T01:00:00Z",
            browse_url=f"{SITE}/browse/SCRUM-42",
        )
    ]
    assert session.calls == []  # boards never touch the MCP session
    assert any("/rest/agile/1.0/board/1" in url for url in seen)
    assert any("/rest/agile/1.0/board/1/issue" in url for url in seen)


def test_mcp_loop_starts_lazily_and_close_is_idempotent() -> None:
    session = FakeMcpSession()
    client = transport(session)
    assert client._thread is None  # no network work before the first tool call
    client.close()
    client.close()
    assert session.closed


def test_mcp_tools_return_realistic_updated_parse() -> None:
    updated = datetime.now(UTC).isoformat()
    row = evidence_row(
        "ENG-9",
        "Fetched from Jira",
        issue_type="Bug",
        status="Ready for Dev",
        priority="Highest",
        assignee={"displayName": "Taylor"},
        labels=["agent", "ui"],
        updated=updated,
    )
    session = FakeMcpSession([McpToolResult(payload=search_payload(row), text="", is_error=False)])
    client = transport(session)
    try:
        issues = client.search_issues("ENG", 10)
    finally:
        client.close()
    assert issues[0].updated == updated
    assert issues[0].browse_url.endswith("/browse/ENG-9")
