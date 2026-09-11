from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

import httpx

from .context import RequestContext
from .idempotency import IdempotencyStore
from .resilience import retry_sync

JIRA_PROJECT_KEY_PATTERN = r"^[A-Z][A-Z0-9_]{0,19}$"
JIRA_TICKET_KEY_PATTERN = r"^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9}$"


def _validate_ticket_key(ticket_key: str) -> None:
    if re.fullmatch(JIRA_TICKET_KEY_PATTERN, ticket_key) is None:
        raise ValueError("Invalid Jira ticket key")


@dataclass(frozen=True, slots=True)
class ToolReceipt:
    action: str
    ticket_key: str
    idempotency_key: str
    status: str = "succeeded"


@dataclass(frozen=True, slots=True)
class JiraComment:
    ticket_key: str
    body: str


@dataclass(frozen=True, slots=True)
class JiraTransition:
    ticket_key: str
    transition: str


@dataclass(frozen=True, slots=True)
class JiraBoardIssue:
    key: str
    project: str
    summary: str
    issue_type: str
    priority: str
    status: str
    assignee: str | None
    labels: tuple[str, ...]
    updated: str
    browse_url: str


@dataclass(frozen=True, slots=True)
class JiraBoardSummary:
    id: int
    name: str
    type: str
    project: str


class JiraIssueReader(Protocol):
    """Synchronous reader contract; ASGI callers must offload it to a worker thread."""

    def search_issues(self, project: str, max_results: int) -> list[JiraBoardIssue]: ...

    def list_boards(self, project: str | None) -> list[JiraBoardSummary]: ...

    def search_board_issues(self, board_id: int, max_results: int) -> list[JiraBoardIssue]: ...


class JiraTransport(Protocol):
    def add_comment(self, ticket_key: str, body: str) -> None: ...

    def transition(self, ticket_key: str, transition: str) -> None: ...


class HttpJiraTransport:
    def __init__(
        self,
        base_url: str,
        email: str,
        api_token: str,
        client: httpx.Client | None = None,
    ) -> None:
        self._owns_client = client is None
        self._client = client or httpx.Client(
            base_url=base_url.rstrip("/"),
            auth=(email, api_token),
            headers={"accept": "application/json", "content-type": "application/json"},
            timeout=10,
        )

    def add_comment(self, ticket_key: str, body: str) -> None:
        _validate_ticket_key(ticket_key)
        self._request(
            "POST",
            f"/rest/api/3/issue/{ticket_key}/comment",
            json={
                "body": {
                    "type": "doc",
                    "version": 1,
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": body}],
                        }
                    ],
                }
            },
        )

    def transition(self, ticket_key: str, transition: str) -> None:
        _validate_ticket_key(ticket_key)
        self._request(
            "POST",
            f"/rest/api/3/issue/{ticket_key}/transitions",
            json={"transition": {"id": transition}},
        )

    def search_issues(self, project: str, max_results: int) -> list[JiraBoardIssue]:
        if re.fullmatch(JIRA_PROJECT_KEY_PATTERN, project) is None:
            raise ValueError("Invalid Jira project key")
        response = self._request(
            "GET",
            "/rest/api/3/search/jql",
            params={
                "jql": f'project = "{project}" ORDER BY rank ASC, updated DESC',
                "maxResults": max_results,
                "fields": (
                    "summary,issuetype,priority,status,assignee,labels,updated"
                ),
            },
        )
        payload = response.json()
        raw_issues = payload.get("issues", []) if isinstance(payload, dict) else []
        return [
            issue
            for raw in raw_issues
            if isinstance(raw, dict) and (issue := self._parse_board_issue(raw, project))
        ]

    def list_boards(self, project: str | None) -> list[JiraBoardSummary]:
        if project is not None and re.fullmatch(JIRA_PROJECT_KEY_PATTERN, project) is None:
            raise ValueError("Invalid Jira project key")
        params: dict[str, str | int] = {"maxResults": 50}
        if project is not None:
            params["projectKeyOrId"] = project
        response = self._request("GET", "/rest/agile/1.0/board", params=params)
        payload = response.json()
        raw_boards = payload.get("values", []) if isinstance(payload, dict) else []
        return [
            board
            for raw in raw_boards
            if isinstance(raw, dict) and (board := self._parse_board(raw))
        ]

    def search_board_issues(self, board_id: int, max_results: int) -> list[JiraBoardIssue]:
        if board_id < 1:
            raise ValueError("Invalid Jira board id")
        meta = self._request("GET", f"/rest/agile/1.0/board/{board_id}")
        payload = meta.json()
        board = self._parse_board(payload if isinstance(payload, dict) else {})
        if board is None:
            return []
        response = self._request(
            "GET",
            f"/rest/agile/1.0/board/{board_id}/issue",
            params={
                "maxResults": max_results,
                "fields": (
                    "summary,issuetype,priority,status,assignee,labels,updated"
                ),
            },
        )
        payload = response.json()
        raw_issues = payload.get("issues", []) if isinstance(payload, dict) else []
        return [
            issue
            for raw in raw_issues
            if isinstance(raw, dict) and (issue := self._parse_board_issue(raw, board.project))
        ]

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        """Send one logical request with bounded retries for transient failures."""

        def send() -> httpx.Response:
            response = self._client.request(method, path, **kwargs)
            response.raise_for_status()
            return response

        return retry_sync(send)

    def _parse_board(self, raw: dict[str, Any]) -> JiraBoardSummary | None:
        board_id = raw.get("id")
        name = raw.get("name")
        board_type = raw.get("type")
        location = raw.get("location")
        project = (
            location.get("projectKey")
            if isinstance(location, dict) and isinstance(location.get("projectKey"), str)
            else None
        )
        if (
            not isinstance(board_id, int)
            or board_id < 1
            or not isinstance(name, str)
            or not isinstance(board_type, str)
            or not isinstance(project, str)
            or re.fullmatch(JIRA_PROJECT_KEY_PATTERN, project) is None
        ):
            return None
        return JiraBoardSummary(id=board_id, name=name, type=board_type, project=project)

    def _parse_board_issue(
        self,
        raw: dict[str, Any],
        project: str,
    ) -> JiraBoardIssue | None:
        key = raw.get("key")
        fields = raw.get("fields")
        if (
            not isinstance(key, str)
            or re.fullmatch(JIRA_TICKET_KEY_PATTERN, key) is None
            or not isinstance(fields, dict)
        ):
            return None

        def named(name: str, fallback: str) -> str:
            value = fields.get(name)
            if isinstance(value, dict) and isinstance(value.get("name"), str):
                return str(value["name"])
            return fallback

        assignee = fields.get("assignee")
        assignee_name = (
            assignee.get("displayName")
            if isinstance(assignee, dict)
            and isinstance(assignee.get("displayName"), str)
            else None
        )
        labels = fields.get("labels")
        return JiraBoardIssue(
            key=key,
            project=project,
            summary=str(fields.get("summary", "")),
            issue_type=named("issuetype", "Task"),
            priority=named("priority", "Medium"),
            status=named("status", "To Do"),
            assignee=assignee_name,
            labels=tuple(str(label) for label in labels) if isinstance(labels, list) else (),
            updated=str(fields.get("updated", datetime.min.isoformat())),
            browse_url=f"{self._client.base_url}/browse/{key}",
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()


class FakeJiraTransport:
    def __init__(
        self,
        issues: list[JiraBoardIssue] | None = None,
        boards: list[JiraBoardSummary] | None = None,
    ) -> None:
        self.comments: list[JiraComment] = []
        self.transitions: list[JiraTransition] = []
        self.issues = issues or []
        self.boards = boards or []

    def add_comment(self, ticket_key: str, body: str) -> None:
        self.comments.append(JiraComment(ticket_key, body))

    def transition(self, ticket_key: str, transition: str) -> None:
        self.transitions.append(JiraTransition(ticket_key, transition))

    def search_issues(self, project: str, max_results: int) -> list[JiraBoardIssue]:
        return [issue for issue in self.issues if issue.project == project][:max_results]

    def list_boards(self, project: str | None) -> list[JiraBoardSummary]:
        if project is None:
            return list(self.boards)
        return [board for board in self.boards if board.project == project]

    def search_board_issues(self, board_id: int, max_results: int) -> list[JiraBoardIssue]:
        board = next((item for item in self.boards if item.id == board_id), None)
        if board is None:
            return []
        return self.search_issues(board.project, max_results)


class JiraTools:
    def __init__(self, transport: JiraTransport, idempotency: IdempotencyStore) -> None:
        self._transport = transport
        self._idempotency = idempotency
        self._receipts: dict[str, ToolReceipt] = {}

    def comment(
        self,
        context: RequestContext,
        ticket_key: str,
        body: str,
        *,
        idempotency_key: str,
    ) -> ToolReceipt:
        del context
        receipt = self._receipts.get(idempotency_key)
        if receipt:
            return receipt
        if self._idempotency.claim(f"jira:comment:{idempotency_key}"):
            self._transport.add_comment(ticket_key, body)
        receipt = ToolReceipt("jira_comment", ticket_key, idempotency_key)
        self._receipts[idempotency_key] = receipt
        return receipt

    def transition(
        self,
        context: RequestContext,
        ticket_key: str,
        transition: str,
        *,
        idempotency_key: str,
    ) -> ToolReceipt:
        del context
        receipt = self._receipts.get(idempotency_key)
        if receipt:
            return receipt
        if self._idempotency.claim(f"jira:transition:{idempotency_key}"):
            self._transport.transition(ticket_key, transition)
        receipt = ToolReceipt("jira_transition", ticket_key, idempotency_key)
        self._receipts[idempotency_key] = receipt
        return receipt

