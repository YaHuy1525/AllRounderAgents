# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""HTTP surface for runs: start, inspect, stream (SSE), decide, cancel."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..auth import AuthenticationError, BearerVerifier, Principal
from ..jira import JIRA_TICKET_KEY_PATTERN
from .models import TERMINAL_RUN_STATUSES, WorkflowRun, run_snapshot, run_summary
from .service import RunConflictError, RunService, UnknownWorkflowError

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


def build_runs_router(
    *,
    verifier: BearerVerifier,
    service: RunService,
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

    return router


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
