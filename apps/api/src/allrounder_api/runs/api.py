# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""HTTP surface for runs: start, inspect, stream (SSE), decide, cancel."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..auth import AuthenticationError, BearerVerifier, Principal
from ..directory import EmployeeDirectory
from ..jira import JIRA_TICKET_KEY_PATTERN
from .definitions import WORKFLOW_DEFINITIONS
from .models import (
    TERMINAL_RUN_STATUSES,
    WorkflowRun,
    run_pills,
    run_snapshot,
    run_summary,
    run_topology,
)
from .prefill import missing_payload, prefill_start_fields, suggestion_payload
from .service import RunConflictError, RunService, UnknownWorkflowError
from .start_inputs import describe_problems, start_problems

_SSE_HEADERS = {"X-Accel-Buffering": "no", "Cache-Control": "no-store"}


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class RunStart(ApiModel):
    workflow: str = Field(min_length=1, max_length=40)
    ticket_key: str = Field(pattern=JIRA_TICKET_KEY_PATTERN)
    case_id: str = Field(min_length=1, max_length=100)
    input: dict[str, object] = Field(default_factory=dict)


class DecisionRequest(ApiModel):
    action: Literal["proceed", "edit", "regenerate", "back", "abort", "retry_lock"]
    edits: dict[str, object] | None = None
    guidance: str | None = Field(default=None, max_length=2_000)
    comment: str | None = Field(default=None, max_length=500)


class CancelRequest(ApiModel):
    reason: str | None = Field(default=None, max_length=500)


class PrefillAsk(ApiModel):
    """What the console already knows before it asks the directory.

    ``values`` is what the message parser already found, so a suggestion never
    overwrites something the user typed.
    """

    workflow: str = Field(min_length=1, max_length=40)
    ticket_key: str | None = Field(default=None, pattern=JIRA_TICKET_KEY_PATTERN)
    ticket_summary: str = Field(default="", max_length=500)
    text: str = Field(default="", max_length=2_000)
    values: dict[str, object] = Field(default_factory=dict)


def build_runs_router(
    *,
    verifier: BearerVerifier,
    service: RunService,
    directory: EmployeeDirectory | None = None,
    repositories: Sequence[str] = (),
) -> APIRouter:
    router = APIRouter(prefix="/runs")

    async def principal(authorization: str | None = Header(default=None)) -> Principal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        try:
            return await verifier.verify(authorization[7:])
        except AuthenticationError as error:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials") from error

    def require_role(identity: Principal, *roles: str) -> None:
        if identity.roles.isdisjoint(roles):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")

    @router.post("", status_code=status.HTTP_201_CREATED)
    async def start_run(
        payload: RunStart,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "agent", "admin")
        # The catalog publishes what each run needs before step one; enforce
        # the same declaration here so an incomplete start is refused with the
        # offending fields named, instead of a run that fails inside the drive
        # loop (or parks on a step whose gate it cannot compute).
        problems = _start_problems(payload.workflow, payload.input)
        if problems:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "message": describe_problems(problems),
                    "workflow": payload.workflow,
                    "fields": problems,
                },
            )
        try:
            run = await service.start(
                workflow=payload.workflow,
                ticket_key=payload.ticket_key,
                case_id=payload.case_id,
                run_input=payload.input,
                principal=identity,
            )
        except UnknownWorkflowError:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Unknown workflow"
            ) from None
        return _run_detail(run)

    @router.get("")
    async def list_runs(
        ticket: str | None = None,
        scope: Literal["active", "history"] = "active",
        workflow: str | None = None,
        status: Literal[
            "queued",
            "running",
            "awaiting_human",
            "blocked",
            "completed",
            "failed",
            "cancelled",
        ]
        | None = None,
        limit: int = Query(default=50, ge=1, le=200),
        cursor: str | None = None,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "viewer", "approver", "agent", "admin")
        if ticket is not None:
            runs = await service.list_for_ticket(ticket, identity.tenant_id, limit)
            rows = _filter_summaries(
                [_run_summary(run) for run in runs], workflow=workflow, status=status
            )
            return {"runs": rows[:limit], "nextCursor": None}
        if scope == "history":
            rows, next_cursor = await service.list_history(
                identity.tenant_id,
                workflow=workflow,
                status=status,
                limit=limit,
                cursor=cursor,
            )
            return {"runs": rows, "nextCursor": next_cursor}
        runs = await service.list_active(identity.tenant_id)
        rows = _filter_summaries(
            [_run_summary(run) for run in runs], workflow=workflow, status=status
        )
        return {"runs": rows[:limit], "nextCursor": None}

    @router.get("/{run_id}")
    async def get_run(
        run_id: str,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "viewer", "approver", "agent", "admin")
        try:
            run = await service.get(run_id, identity.tenant_id)
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from None
        return _run_detail(run)

    @router.get("/{run_id}/topology")
    async def get_run_topology(
        run_id: str,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        # Derived read model for the console's view switcher: live step state
        # plus the static satellites/receipt/lock summaries from one payload.
        require_role(identity, "viewer", "approver", "agent", "admin")
        try:
            run = await service.get(run_id, identity.tenant_id)
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from None
        return run_topology(run, WORKFLOW_DEFINITIONS.get(run.workflow))

    @router.get("/{run_id}/pills")
    async def get_run_pills(
        run_id: str,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        # Data-pill catalog (N3): the earlier outputs a downstream field can
        # reference as ``{{ref}}`` tokens, picker-facing and read-only.
        require_role(identity, "viewer", "approver", "agent", "admin")
        try:
            run = await service.get(run_id, identity.tenant_id)
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from None
        return run_pills(run)

    @router.get("/{run_id}/events")
    async def run_events(
        run_id: str,
        request: Request,
        identity: Principal = Depends(principal),
    ) -> StreamingResponse:
        require_role(identity, "viewer", "approver", "agent", "admin")
        try:
            run = await service.get(run_id, identity.tenant_id)
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from None

        if run.terminal:
            # A finished run's history is final: replay it and close, so
            # clients get a finite stream instead of a subscription that can
            # never produce another event.
            async def replay() -> AsyncIterator[str]:
                for event in await service.history(run_id):
                    yield _sse_event(event)

            return StreamingResponse(
                replay(), media_type="text/event-stream", headers=_SSE_HEADERS
            )

        async def events() -> AsyncIterator[str]:
            async for event in service.subscribe(run_id):
                if await request.is_disconnected():
                    return
                yield _sse_event(event)
                if (
                    event.get("type") == "run.status"
                    and event.get("status") in TERMINAL_RUN_STATUSES
                ):
                    return

        return StreamingResponse(
            events(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    @router.post("/{run_id}/steps/{step_id}/decision")
    async def decide_step(
        run_id: str,
        step_id: str,
        payload: DecisionRequest,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "agent", "approver", "admin")
        try:
            result = await service.decide(
                run_id=run_id,
                step_id=step_id,
                action=payload.action,
                principal=identity,
                edits=payload.edits,
                guidance=payload.guidance,
                comment=payload.comment,
            )
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from None
        except RunConflictError as error:
            raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from None
        return {
            "run": _run_detail(result.run),
            "receipt": result.receipt,
            "replayed": result.replayed,
        }

    @router.post("/{run_id}/cancel")
    async def cancel_run(
        run_id: str,
        payload: CancelRequest,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "agent", "approver", "admin")
        reason = (payload.reason or "").strip() or f"cancelled by {identity.subject}"
        try:
            run = await service.cancel(
                run_id=run_id, tenant_id=identity.tenant_id, reason=reason
            )
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from None
        return _run_detail(run)

    @router.post("/prefill")
    async def prefill_start(
        payload: PrefillAsk,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """The values a record can prove, plus what is still missing.

        Read-only: the caller renders the confirm card and the human still
        starts the run through ``POST /runs``. An unknown workflow keeps the
        same 404 the start route answers.
        """

        require_role(identity, "viewer", "agent", "approver", "admin")
        definition = WORKFLOW_DEFINITIONS.get(payload.workflow)
        if definition is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown workflow")
        result = prefill_start_fields(
            definition,
            text=payload.text,
            ticket_summary=payload.ticket_summary,
            values=payload.values,
            employees=directory,
            repositories=repositories,
        )
        return {
            "workflow": definition.id,
            "fields": [suggestion_payload(item) for item in result.suggestions],
            "missing": [missing_payload(item) for item in result.missing],
        }

    return router


def _start_problems(
    workflow: str, run_input: dict[str, object]
) -> list[dict[str, str]]:
    # An unknown workflow has no declaration to check: the service still owns
    # the 404, so a typo keeps answering "Unknown workflow" rather than 422.
    definition = WORKFLOW_DEFINITIONS.get(workflow)
    if definition is None:
        return []
    return start_problems(definition, run_input)


def _filter_summaries(
    rows: list[dict[str, object]],
    *,
    workflow: str | None,
    status: str | None,
) -> list[dict[str, object]]:
    if workflow is not None:
        rows = [row for row in rows if row["workflow"] == workflow]
    if status is not None:
        rows = [row for row in rows if row["status"] == status]
    return rows


def _run_summary(run: WorkflowRun) -> dict[str, object]:
    # Shared with the history merge so every list row has one shape.
    return run_summary(run)


def _run_detail(run: WorkflowRun) -> dict[str, object]:
    # Same shape the enriched SSE events embed under "run" (runs.models).
    return run_snapshot(run)


def _sse_event(payload: dict[str, object]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


__all__ = ["build_runs_router"]
