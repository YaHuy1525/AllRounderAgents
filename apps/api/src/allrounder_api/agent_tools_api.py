"""Read-only tool routes for the Mastra console agent.

The chat agent runs in the Mastra plane, so tenant data reaches it only through
this surface. The shared service token is the only credential it accepts, which
is the same bridge ``/knowledge/search`` and ``/msp/vendors/lookup`` use: no
console session can call these routes, and nothing here writes.

That is deliberate. The agent may look a person up, may resolve the values a
run needs, and may list the tenant's lane-matched tickets, but starting a run
stays the human's confirm in the console, which calls ``POST /runs`` with a
user credential. A model that could start a run itself would be a second
writer with no receipt.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import re

import httpx
from fastapi import APIRouter, Header, HTTPException, status
from pydantic import Field, field_validator

from .directory import EmployeeDirectory, employee_payload
from .jira import JIRA_TICKET_KEY_PATTERN, JiraIssueReader
from .logging import get_logger
from .runs import WORKFLOW_DEFINITIONS
from .runs.api import ApiModel
from .runs.prefill import missing_payload, prefill_start_fields, suggestion_payload
from .ticket_search import MAX_TICKETS, search_lane_tickets, ticket_payload

# A lookup answers a question, not a listing: enough rows to disambiguate.
MAX_EMPLOYEES = 5

# Workflow ids are short kebab tokens; the pattern keeps a model-supplied
# list from smuggling anything the lane rules could not name anyway.
_WORKFLOW_ID_PATTERN = r"^[a-z][a-z-]{0,39}$"


class AgentStartFieldsAsk(ApiModel):
    tenant_id: str = Field(min_length=1, max_length=100)
    workflow: str = Field(min_length=1, max_length=40)
    ticket_key: str | None = Field(default=None, pattern=JIRA_TICKET_KEY_PATTERN)
    ticket_summary: str = Field(default="", max_length=500)
    text: str = Field(default="", max_length=2_000)


class AgentEmployeeAsk(ApiModel):
    tenant_id: str = Field(min_length=1, max_length=100)
    query: str = Field(min_length=1, max_length=200)


class AgentTicketsAsk(ApiModel):
    tenant_id: str = Field(min_length=1, max_length=100)
    workflows: list[str] = Field(default_factory=list, max_length=8)
    text: str = Field(default="", max_length=200)
    max_results: int = Field(default=30, ge=1, le=MAX_TICKETS)

    @field_validator("workflows")
    @classmethod
    def _workflow_ids(cls, value: list[str]) -> list[str]:
        if any(re.fullmatch(_WORKFLOW_ID_PATTERN, item) is None for item in value):
            raise ValueError("workflow ids must be lowercase kebab tokens")
        return value


def authorize_service_token(authorization: str | None, service_token: str) -> None:
    """The only credential the agent-tools surface accepts.

    Shared with ``qa_defects_api`` so the governed write route cannot grow a
    second, subtly different check.
    """

    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    if not hmac.compare_digest(authorization[7:], service_token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")


def build_agent_tools_router(
    *,
    service_token: str,
    directory: EmployeeDirectory,
    reader: JiraIssueReader,
    tenant_project_allowlist: dict[str, list[str]],
) -> APIRouter:
    router = APIRouter(prefix="/agent-tools", tags=["agent-tools"])
    logger = get_logger()

    def _authorize(authorization: str | None) -> None:
        authorize_service_token(authorization, service_token)

    @router.post("/start-fields")
    async def start_fields(
        payload: AgentStartFieldsAsk,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """Resolve what a workflow needs, with the source of every value.

        An unknown workflow answers ``ok: false`` rather than a 404: the model
        can read that sentence, correct its workflow id, and retry, where a bare
        HTTP error would only reach it as a failed tool call.
        """

        _authorize(authorization)
        definition = WORKFLOW_DEFINITIONS.get(payload.workflow)
        if definition is None:
            return {"ok": False, "error": f"unknown workflow: {payload.workflow}"}
        logger.info(
            "agent_tool_start_fields",
            tenant_id=payload.tenant_id,
            workflow=definition.id,
        )
        result = prefill_start_fields(
            definition,
            text=payload.text,
            ticket_summary=payload.ticket_summary,
            employees=directory,
        )
        return {
            "ok": True,
            "workflow": definition.id,
            "workflowLabel": definition.title,
            "fields": [suggestion_payload(item) for item in result.suggestions],
            "missing": [missing_payload(item) for item in result.missing],
        }

    @router.post("/employees")
    async def employees(
        payload: AgentEmployeeAsk,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """Look one person up by id or name; empty means the directory has none."""

        _authorize(authorization)
        logger.info("agent_tool_employees", tenant_id=payload.tenant_id)
        exact = directory.get(payload.query)
        if exact is not None:
            return {"ok": True, "employees": [employee_payload(exact)]}
        found = directory.search(payload.query)[:MAX_EMPLOYEES]
        return {"ok": True, "employees": [employee_payload(item) for item in found]}

    @router.post("/tickets")
    async def tickets(
        payload: AgentTicketsAsk,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """List the tenant's tickets that match the named workflow lanes.

        The tenant id arrives on the turn's request context, and the projects
        it may see come from the same allowlist the console board uses: the
        agent cannot widen the view by asking. An unknown tenant answers
        empty, because "I found none" is the honest sentence for a tenant
        with no projects, and listing beyond them is not this route's to do.
        """

        _authorize(authorization)
        if not payload.workflows and payload.text.strip() == "":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "a ticket query needs workflows or text",
            )
        projects = tenant_project_allowlist.get(payload.tenant_id, [])
        if not projects:
            return {"ok": True, "count": 0, "tickets": []}
        logger.info(
            "agent_tool_tickets",
            tenant_id=payload.tenant_id,
            workflows=len(payload.workflows),
        )
        try:
            found = await asyncio.to_thread(
                search_lane_tickets,
                reader,
                projects,
                workflows=payload.workflows,
                text=payload.text,
                limit=payload.max_results,
            )
        except (httpx.HTTPError, json.JSONDecodeError, OSError, ValueError):
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Jira tickets could not be loaded",
            ) from None
        return {
            "ok": True,
            "count": len(found),
            "tickets": [ticket_payload(item) for item in found],
        }

    return router


__all__ = [
    "MAX_EMPLOYEES",
    "authorize_service_token",
    "build_agent_tools_router",
]
