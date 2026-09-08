# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from .auth import AuthenticationError, BearerVerifier, Principal
from .jira import JIRA_PROJECT_KEY_PATTERN, JiraIssueReader
from .logging import get_logger

_VIEW_ROLES = frozenset({"viewer", "agent", "approver", "admin"})


def build_jira_board_router(
    *,
    verifier: BearerVerifier,
    reader: JiraIssueReader,
    default_project: str,
    tenant_project_allowlist: dict[str, list[str]],
    jira_site: str = "",
) -> APIRouter:
    router = APIRouter(prefix="/jira", tags=["jira-board"])
    logger = get_logger()

    async def principal(
        authorization: str | None = Header(default=None),
    ) -> Principal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        try:
            return await verifier.verify(authorization[7:])
        except AuthenticationError as error:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials") from error

    def _allowed_projects(identity: Principal) -> list[str]:
        if identity.roles.isdisjoint(_VIEW_ROLES):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        return tenant_project_allowlist.get(identity.tenant_id, [])

    @router.get("/workspace")
    async def workspace(identity: Principal = Depends(principal)) -> dict[str, object]:
        allowed_projects = _allowed_projects(identity)
        try:
            boards = await asyncio.to_thread(reader.list_boards, None)
        except (httpx.HTTPError, json.JSONDecodeError, OSError, ValueError):
            logger.exception("jira_workspace_fetch_failed", tenant_id=identity.tenant_id)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Jira workspace could not be loaded",
            ) from None
        visible = [board for board in boards if board.project in allowed_projects]
        return {
            "site": jira_site.rstrip("/"),
            "projects": allowed_projects,
            "boards": [asdict(board) for board in visible],
        }

    @router.get("/issues")
    async def list_issues(
        project: str | None = Query(
            default=None,
            min_length=1,
            max_length=20,
            pattern=JIRA_PROJECT_KEY_PATTERN,
        ),
        board_id: int | None = Query(default=None, ge=1, le=10_000_000),
        max_results: int = Query(default=100, ge=1, le=100),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        allowed_projects = _allowed_projects(identity)
        project_key = project or default_project
        selected_board_id = board_id
        if board_id is not None:
            try:
                boards = await asyncio.to_thread(reader.list_boards, None)
            except (httpx.HTTPError, json.JSONDecodeError, OSError, ValueError):
                logger.exception(
                    "jira_board_lookup_failed",
                    board_id=board_id,
                    tenant_id=identity.tenant_id,
                )
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "Jira issues could not be loaded",
                ) from None
            match = next((board for board in boards if board.id == board_id), None)
            if match is None or match.project not in allowed_projects:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
            if project_key and match.project != project_key:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
            project_key = match.project
            selected_board_id = match.id
        if not project_key:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Jira project is not configured",
            )
        if project_key not in allowed_projects:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        try:
            if selected_board_id is not None:
                issues = await asyncio.to_thread(
                    reader.search_board_issues,
                    selected_board_id,
                    max_results,
                )
            else:
                issues = await asyncio.to_thread(
                    reader.search_issues,
                    project_key,
                    max_results,
                )
        except (httpx.HTTPError, json.JSONDecodeError, OSError, ValueError):
            logger.exception(
                "jira_issue_fetch_failed",
                project=project_key,
                board_id=selected_board_id,
                tenant_id=identity.tenant_id,
            )
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Jira issues could not be loaded",
            ) from None
        return {
            "project": project_key,
            "board_id": selected_board_id,
            "total": len(issues),
            "issues": [asdict(issue) for issue in issues],
        }

    return router
