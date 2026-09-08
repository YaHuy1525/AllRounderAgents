from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.jira import (
    FakeJiraTransport,
    HttpJiraTransport,
    JiraBoardIssue,
    JiraBoardSummary,
)
from allrounder_api.production import assert_default_project_is_allowlisted
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient


def board_client() -> TestClient:
    verifier = FakeBearerVerifier(
        {
            "viewer": Principal("user-1", "tenant-a", frozenset({"viewer"})),
            "unscoped": Principal("user-2", "tenant-a", frozenset()),
            "other": Principal("user-3", "tenant-b", frozenset({"viewer"})),
        }
    )
    reader = FakeJiraTransport(
        [
            JiraBoardIssue(
                key="ENG-42",
                project="ENG",
                summary="Fix ticket board",
                issue_type="Story",
                priority="High",
                status="In Progress",
                assignee="Alex",
                labels=("agent",),
                updated=datetime.now(UTC).isoformat(),
                browse_url="https://example.atlassian.net/browse/ENG-42",
            ),
            JiraBoardIssue(
                key="OPS-1",
                project="OPS",
                summary="Other project",
                issue_type="Task",
                priority="Low",
                status="To Do",
                assignee=None,
                labels=(),
                updated=datetime.now(UTC).isoformat(),
                browse_url="https://example.atlassian.net/browse/OPS-1",
            ),
        ],
        boards=[
            JiraBoardSummary(id=1, name="ENG board", type="simple", project="ENG"),
            JiraBoardSummary(id=9, name="OPS board", type="scrum", project="OPS"),
        ],
    )
    return TestClient(
        create_app(
            settings=Settings(
                webhook_secret="test",
                jira_project_key="ENG",
                jira_base_url="https://example.atlassian.net",
                jira_tenant_project_allowlist={"tenant-a": ["ENG"]},
            ),
            auth_verifier=verifier,
            jira_reader=reader,
        )
    )


def test_board_fetch_is_authenticated_scoped_and_bounded() -> None:
    client = board_client()
    assert client.get("/jira/issues").status_code == 401
    assert client.get(
        "/jira/issues",
        headers={"Authorization": "Bearer unscoped"},
    ).status_code == 403
    assert client.get(
        "/jira/issues",
        headers={"Authorization": "Bearer other"},
    ).status_code == 403

    response = client.get(
        "/jira/issues",
        headers={"Authorization": "Bearer viewer"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["project"] == "ENG"
    assert payload["total"] == 1
    assert payload["issues"][0]["key"] == "ENG-42"


def test_board_project_validation_blocks_jql_injection() -> None:
    client = board_client()
    response = client.get(
        "/jira/issues",
        params={"project": 'ENG" OR project != "ENG'},
        headers={"Authorization": "Bearer viewer"},
    )
    assert response.status_code == 422


def test_http_jira_reader_normalizes_search_results() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["jql"].startswith('project = "ENG"')
        return httpx.Response(
            200,
            json={
                "issues": [
                    {
                        "key": "ENG-9",
                        "fields": {
                            "summary": "Fetched from Jira",
                            "issuetype": {"name": "Bug"},
                            "priority": {"name": "Highest"},
                            "status": {"name": "Ready for Dev"},
                            "assignee": {"displayName": "Taylor"},
                            "labels": ["agent", "ui"],
                            "updated": "2026-09-07T01:00:00Z",
                        },
                    },
                    {"malformed": True},
                ]
            },
        )

    with httpx.Client(
        base_url="https://example.atlassian.net",
        transport=httpx.MockTransport(handler),
    ) as client:
        reader = HttpJiraTransport(
            "https://ignored.example",
            "user@example.com",
            "token",
            client=client,
        )
        issues = reader.search_issues("ENG", 10)
        reader.close()

    assert len(issues) == 1
    assert issues[0].key == "ENG-9"
    assert issues[0].issue_type == "Bug"
    assert issues[0].assignee == "Taylor"
    assert issues[0].browse_url.endswith("/browse/ENG-9")


def test_http_jira_reader_parses_agile_boards() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "/rest/agile/1.0/board" in str(request.url)
        return httpx.Response(
            200,
            json={
                "values": [
                    {
                        "id": 1,
                        "name": "SCRUM board",
                        "type": "simple",
                        "location": {"projectKey": "SCRUM"},
                    },
                    {"id": "bad", "name": "Nope"},
                ]
            },
        )

    with httpx.Client(
        base_url="https://example.atlassian.net",
        transport=httpx.MockTransport(handler),
    ) as client:
        reader = HttpJiraTransport("", "", "", client=client)
        boards = reader.list_boards(None)
        reader.close()

    assert boards == [
        JiraBoardSummary(id=1, name="SCRUM board", type="simple", project="SCRUM"),
    ]


def test_http_jira_reader_rejects_untrusted_project_keys() -> None:
    with httpx.Client(base_url="https://example.atlassian.net") as client:
        reader = HttpJiraTransport("", "", "", client=client)
        try:
            reader.search_issues('ENG" OR project != "ENG', 10)
        except ValueError as error:
            assert str(error) == "Invalid Jira project key"
        else:
            raise AssertionError("Unsafe project key was accepted")


def test_http_jira_writer_rejects_untrusted_ticket_keys() -> None:
    with httpx.Client(base_url="https://example.atlassian.net") as client:
        transport = HttpJiraTransport("", "", "", client=client)
        with pytest.raises(ValueError):
            transport.add_comment("../admin", "unsafe")
        with pytest.raises(ValueError):
            transport.transition("ENG-0/../../admin", "31")


def test_workspace_lists_allowlisted_projects_and_boards() -> None:
    client = board_client()
    assert client.get("/jira/workspace").status_code == 401
    response = client.get(
        "/jira/workspace",
        headers={"Authorization": "Bearer viewer"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["site"] == "https://example.atlassian.net"
    assert payload["projects"] == ["ENG"]
    assert payload["boards"] == [
        {"id": 1, "name": "ENG board", "type": "simple", "project": "ENG"},
    ]


def test_board_issues_are_scoped_to_an_allowlisted_board() -> None:
    client = board_client()
    denied = client.get(
        "/jira/issues",
        params={"board_id": 9},
        headers={"Authorization": "Bearer viewer"},
    )
    assert denied.status_code == 403
    response = client.get(
        "/jira/issues",
        params={"board_id": 1},
        headers={"Authorization": "Bearer viewer"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["project"] == "ENG"
    assert payload["board_id"] == 1
    assert payload["issues"][0]["key"] == "ENG-42"


def test_default_project_must_appear_in_tenant_allowlist() -> None:
    with pytest.raises(ValueError, match="JIRA_PROJECT_KEY must be listed"):
        assert_default_project_is_allowlisted("SCRUM", {"tenant-a": ["ENG"]})
    assert_default_project_is_allowlisted("SCRUM", {"tenant-a": ["SCRUM", "ENG"]})
