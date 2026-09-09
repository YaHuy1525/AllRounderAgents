"""Atlassian Rovo MCP transport for the Jira board and tool protocols.

McpJiraTransport implements the existing JiraTransport (comment/transition)
and JiraIssueReader (search_issues/list_boards/search_board_issues) protocols
over the official Atlassian Rovo MCP server instead of the Jira REST API:

- comment/transition/search go through the MCP tools
  addOrEditJiraIssueComment / transitionJiraIssue / searchJiraIssuesUsingJql
  with a headless ``Authorization: Basic base64(email:api_token)`` header
  (the org admin must enable API-token MCP access on the site);
- board listing stays on read-only REST GETs (HttpJiraTransport) because the
  Rovo server is issue-centric and exposes no agile-board tools.

The official ``mcp`` Python SDK is asyncio-only, so the transport owns a
dedicated event-loop thread and sync callers (FastAPI worker threads) bridge
with ``run_coroutine_threadsafe`` - the call-site signatures stay unchanged.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import re
import threading
from collections.abc import Coroutine
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol, TypeVar

import httpx

from .jira import (
    JIRA_PROJECT_KEY_PATTERN,
    JIRA_TICKET_KEY_PATTERN,
    HttpJiraTransport,
    JiraBoardIssue,
    JiraBoardSummary,
)

DEFAULT_ATLASSIAN_MCP_URL = "https://mcp.atlassian.com/v2/mcp"

# Tools the transport depends on. Discovery-driven mapping: on first connect
# the session lists the live tool surface and fails fast when any is missing.
REQUIRED_MCP_TOOLS: frozenset[str] = frozenset(
    {
        "searchJiraIssuesUsingJql",
        "addOrEditJiraIssueComment",
        "transitionJiraIssue",
        "createJiraIssue",
    }
)

_ISSUE_VIEW = "evidence"
_PAGE_LIMIT = 100


class McpJiraError(httpx.HTTPError):
    """The Rovo MCP server rejected or could not serve an operation.

    Subclasses httpx.HTTPError so existing error handling (board router 502
    mapping, tool-call catch-alls) keeps working unchanged.
    """


@dataclass(frozen=True, slots=True)
class McpToolResult:
    """Normalized tool result handed from a session to the transport."""

    payload: Any
    text: str
    is_error: bool = False


class JiraMcpSession(Protocol):
    """Async MCP session seam; tests inject a fake recording session."""

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> McpToolResult: ...

    async def close(self) -> None: ...


def _basic_auth(email: str, api_token: str) -> str:
    credentials = f"{email}:{api_token}".encode()
    return "Basic " + base64.b64encode(credentials).decode()


def _unwrap_data(payload: Any) -> Any:
    """Rovo wraps tool payloads in a single ``data`` key; unwrap when present."""
    if isinstance(payload, dict) and isinstance(payload.get("data"), (dict, list)):
        return payload["data"]
    return payload


def _issue_rows(payload: Any) -> list[dict[str, Any]]:
    unwrapped = _unwrap_data(payload)
    if not isinstance(unwrapped, dict):
        return []
    rows = unwrapped.get("issues")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


class SdkJiraMcpSession:
    """Real session backed by the official ``mcp`` Python SDK (asyncio-only)."""

    def __init__(self, mcp_url: str, email: str, api_token: str) -> None:
        self._mcp_url = mcp_url
        self._authorization = _basic_auth(email, api_token)
        self._client: httpx.AsyncClient | None = None
        self._context: Any = None
        self._session: Any = None
        self._tools: frozenset[str] = frozenset()

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> McpToolResult:
        if self._session is None:
            await self._connect()
        result = await self._session.call_tool(name, arguments)
        payload: Any = None
        text = self._content_text(result.content)
        if isinstance(result.structuredContent, dict):
            payload = result.structuredContent
        else:
            payload = self._parse_text(text)
        return McpToolResult(payload=payload, text=text, is_error=bool(result.isError))

    async def close(self) -> None:
        if self._context is not None:
            await self._context.__aexit__(None, None, None)
            self._context = None
            self._session = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _connect(self) -> None:
        from mcp import ClientSession  # local import keeps module import light
        from mcp.client.streamable_http import streamable_http_client

        # Streamable HTTP merges MCP headers over the httpx client defaults, so
        # auth and timeouts are configured on the AsyncClient itself. The SSE
        # read window must outlive a slow tool response (long polls).
        client = httpx.AsyncClient(
            headers={"Authorization": self._authorization},
            timeout=httpx.Timeout(30.0, read=180.0),
        )
        context = streamable_http_client(self._mcp_url, http_client=client)
        read, write, _session_id = await context.__aenter__()
        session = ClientSession(read, write)
        await session.initialize()
        tools = await session.list_tools()
        self._tools = frozenset(tool.name for tool in tools.tools)
        missing = REQUIRED_MCP_TOOLS - self._tools
        if missing:
            await context.__aexit__(None, None, None)
            await client.aclose()
            raise McpJiraError(
                "Jira MCP server is missing required tools: "
                + ", ".join(sorted(missing))
            )
        self._client = client
        self._context = context
        self._session = session

    @staticmethod
    def _content_text(content: Any) -> str:
        parts: list[str] = []
        for block in content or []:
            if getattr(block, "type", None) == "text" and isinstance(block.text, str):
                parts.append(block.text)
        return "\n".join(parts)

    @staticmethod
    def _parse_text(text: str) -> Any:
        if not text:
            return None
        for chunk in (text, text.splitlines()[0]) if "\n" in text else (text,):
            try:
                return json.loads(chunk)
            except json.JSONDecodeError:
                continue
        return None


_T = TypeVar("_T")


class McpJiraTransport:
    """Jira transport routing writes and issue search over the Rovo MCP server.

    Sync facade over the asyncio SDK session: a dedicated event-loop thread is
    started lazily on the first MCP call and stopped by :meth:`close`.
    """

    def __init__(
        self,
        base_url: str,
        email: str,
        api_token: str,
        *,
        mcp_url: str = DEFAULT_ATLASSIAN_MCP_URL,
        cloud_id: str = "",
        client: httpx.Client | None = None,
        session: JiraMcpSession | None = None,
    ) -> None:
        self._site_url = base_url.rstrip("/")
        # The Rovo cloudId argument accepts either the site UUID or the site
        # URL; an explicit cloud_id (setting) wins, otherwise the URL is sent.
        self._cloud_id = cloud_id or self._site_url
        self._rest = HttpJiraTransport(base_url, email, api_token, client=client)
        self._session = session or SdkJiraMcpSession(mcp_url, email, api_token)
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._closed = False

    # -- JiraTransport ----------------------------------------------------

    def add_comment(self, ticket_key: str, body: str) -> None:
        self._validate_ticket_key(ticket_key)
        self._call_tool(
            "addOrEditJiraIssueComment",
            {
                "cloudId": self._cloud_id,
                "issueIdOrKey": ticket_key,
                "commentBody": body,
            },
        )

    def transition(self, ticket_key: str, transition: str) -> None:
        self._validate_ticket_key(ticket_key)
        arguments: dict[str, Any] = {
            "cloudId": self._cloud_id,
            "issueIdOrKey": ticket_key,
        }
        # REST used {"transition": {"id": transition}}; MCP takes either a
        # numeric transition id or a transition name - accept both.
        if transition.isdecimal():
            arguments["transitionId"] = transition
        else:
            arguments["transitionName"] = transition
        self._call_tool("transitionJiraIssue", arguments)

    # -- JiraIssueReader --------------------------------------------------

    def search_issues(self, project: str, max_results: int) -> list[JiraBoardIssue]:
        if re.fullmatch(JIRA_PROJECT_KEY_PATTERN, project) is None:
            raise ValueError("Invalid Jira project key")
        jql = f'project = "{project}" ORDER BY rank ASC, updated DESC'
        return self.search_jql(jql, max_results)

    def list_boards(self, project: str | None) -> list[JiraBoardSummary]:
        # Read-only REST fallback (D5): Rovo exposes no agile-board tools.
        return self._rest.list_boards(project)

    def search_board_issues(self, board_id: int, max_results: int) -> list[JiraBoardIssue]:
        return self._rest.search_board_issues(board_id, max_results)

    # -- MCP-only helpers used by jira_seed.py ------------------------------

    def search_jql(self, jql: str, max_results: int) -> list[JiraBoardIssue]:
        """Issue search for an arbitrary JQL string (seed dedupe path)."""
        issues: list[JiraBoardIssue] = []
        next_page_token: str | None = None
        while max_results > len(issues):
            arguments: dict[str, Any] = {
                "cloudId": self._cloud_id,
                "jql": jql,
                "maxResults": min(max_results - len(issues), _PAGE_LIMIT),
                "view": _ISSUE_VIEW,
            }
            if next_page_token is not None:
                arguments["nextPageToken"] = next_page_token
            result = self._call_tool("searchJiraIssuesUsingJql", arguments)
            payload = _unwrap_data(result.payload)
            for row in _issue_rows(payload):
                issue = self._parse_issue(row)
                if issue is not None:
                    issues.append(issue)
            if not isinstance(payload, dict):
                break
            next_page_token = payload.get("nextPageToken")
            if not isinstance(next_page_token, str) or not next_page_token:
                break
            if payload.get("isLast") is True:
                break
        return issues[:max_results]

    def create_issue(
        self,
        project_key: str,
        summary: str,
        *,
        issue_type: str,
        labels: list[str],
        description: str,
    ) -> str:
        """Create a ticket through the Rovo MCP server; returns the issue key."""
        result = self._call_tool(
            "createJiraIssue",
            {
                "cloudId": self._cloud_id,
                "projectKey": project_key,
                "summary": summary,
                "issueType": issue_type,
                "labels": labels,
                "description": description,
            },
        )
        key = self._extract_key(result)
        if key is None:
            snippet = result.text[:300]
            raise McpJiraError(
                "Jira MCP create_issue succeeded but no issue key was "
                f"returned: {snippet}"
            )
        return key

    # -- Internals -----------------------------------------------------------

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            loop, thread = self._loop, self._thread
            self._loop, self._thread = None, None
        if loop is not None and loop.is_running():
            # Teardown the live session on its own loop, then stop the loop.
            with contextlib.suppress(Exception):
                asyncio.run_coroutine_threadsafe(
                    self._session.close(), loop
                ).result(timeout=15)
            loop.call_soon_threadsafe(loop.stop)
        elif self._session is not None:
            # Never connected: run the teardown on a fresh one-shot loop so
            # close() stays deterministic before the first tool call.
            with contextlib.suppress(Exception):
                self._run(self._session.close())
            with self._lock:
                fresh_loop, fresh_thread = self._loop, self._thread
                self._loop, self._thread = None, None
            if fresh_loop is not None and fresh_loop.is_running():
                fresh_loop.call_soon_threadsafe(fresh_loop.stop)
            if fresh_thread is not None:
                fresh_thread.join(timeout=5)
        if thread is not None:
            thread.join(timeout=5)
        self._rest.close()

    def _validate_ticket_key(self, ticket_key: str) -> None:
        if re.fullmatch(JIRA_TICKET_KEY_PATTERN, ticket_key) is None:
            raise ValueError("Invalid Jira ticket key")

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> McpToolResult:
        try:
            result = self._run(self._session.call_tool(name, arguments))
        except McpJiraError:
            raise
        except Exception as error:
            raise McpJiraError(f"Jira MCP {name} call failed: {error}") from error
        if result.is_error:
            message = f"Jira MCP {name} failed"
            if isinstance(result.payload, dict) and isinstance(
                result.payload.get("message"), str
            ):
                message += f": {result.payload['message']}"
            elif result.text:
                message += f": {result.text[:300]}"
            raise McpJiraError(message)
        return result

    def _run(self, coro: Coroutine[Any, Any, _T]) -> _T:
        with self._lock:
            if self._loop is None:
                self._loop = asyncio.new_event_loop()
                self._thread = threading.Thread(
                    target=self._loop.run_forever,
                    name="atlassian-mcp-loop",
                    daemon=True,
                )
                self._thread.start()
            loop = self._loop
        return asyncio.run_coroutine_threadsafe(coro, loop).result()

    def _parse_issue(self, raw: dict[str, Any]) -> JiraBoardIssue | None:
        """Evidence-view row mapping, mirroring HttpJiraTransport field parsing."""
        key = raw.get("key")
        fields = raw.get("fields")
        if (
            not isinstance(key, str)
            or re.fullmatch(JIRA_TICKET_KEY_PATTERN, key) is None
            or not isinstance(fields, dict)
        ):
            return None
        return JiraBoardIssue(
            key=key,
            project=self._project_of(key),
            summary=str(fields.get("summary", "")),
            issue_type=self._named(fields, "issuetype", "Task"),
            priority=self._named(fields, "priority", "Medium"),
            status=self._named(fields, "status", "To Do"),
            assignee=self._assignee(fields.get("assignee")),
            labels=self._labels(fields.get("labels")),
            updated=str(fields.get("updated", datetime.min.isoformat())),
            browse_url=f"{self._site_url}/browse/{key}",
        )

    @staticmethod
    def _project_of(key: str) -> str:
        return key.split("-", 1)[0]

    @staticmethod
    def _named(fields: dict[str, Any], name: str, fallback: str) -> str:
        value = fields.get(name)
        if isinstance(value, dict) and isinstance(value.get("name"), str):
            return str(value["name"])
        return fallback

    @staticmethod
    def _assignee(value: Any) -> str | None:
        if not isinstance(value, dict):
            return None
        display = value.get("displayName")
        if isinstance(display, str) and display:
            return display
        return None

    @staticmethod
    def _labels(value: Any) -> tuple[str, ...]:
        if not isinstance(value, list):
            return ()
        return tuple(str(label) for label in value)

    @staticmethod
    def _extract_key(result: McpToolResult) -> str | None:
        payload = _unwrap_data(result.payload)
        if isinstance(payload, dict):
            for candidate in ("key", "issueKey"):
                value = payload.get(candidate)
                if isinstance(value, str) and re.fullmatch(JIRA_TICKET_KEY_PATTERN, value):
                    return value
            url = payload.get("url")
            if isinstance(url, str):
                match = re.search(r"/browse/([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9})/?$", url)
                if match is not None:
                    return match.group(1)
        # Tolerant scan of the raw text for a ticket key; the anchored pattern
        # above only matches whole strings, so use its unanchored core here.
        match = re.search(r"[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9}", result.text)
        return match.group(0) if match is not None else None
