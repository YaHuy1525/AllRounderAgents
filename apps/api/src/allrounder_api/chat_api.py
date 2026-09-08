# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

from __future__ import annotations

import re
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthenticationError, BearerVerifier, Principal
from .board_chat import ChatCompleter, local_answer, sanitize_tickets, system_prompt
from .jira import JIRA_TICKET_KEY_PATTERN
from .logging import get_logger


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class ChatAsk(ApiModel):
    message: str = Field(min_length=1, max_length=2_000)
    selected_key: str | None = Field(default=None, max_length=40)
    tickets: list[dict[str, Any]] = Field(default_factory=list, max_length=40)


def build_chat_router(
    *,
    verifier: BearerVerifier,
    completer: ChatCompleter | None,
) -> APIRouter:
    router = APIRouter()
    logger = get_logger()

    async def principal(authorization: str | None = Header(default=None)) -> Principal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        try:
            return await verifier.verify(authorization[7:])
        except AuthenticationError as error:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials") from error

    @router.post("/chat")
    async def chat(
        request: ChatAsk,
        identity: Principal = Depends(principal),
    ) -> dict[str, str]:
        if identity.roles.isdisjoint({"viewer", "agent", "approver", "admin"}):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        tickets = sanitize_tickets(request.tickets)
        selected = request.selected_key
        if selected is not None and re.fullmatch(JIRA_TICKET_KEY_PATTERN, selected) is None:
            selected = None
        if completer is None:
            return {
                "reply": local_answer(request.message, tickets, selected),
                "source": "local",
            }
        try:
            reply = (await completer.complete(
                system_prompt(tickets, selected),
                request.message.strip(),
            )).strip()
            if not reply:
                raise ValueError("Empty model reply")
            return {"reply": reply[:8_000], "source": "model"}
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            logger.warning("board_chat_model_failed", tenant_id=identity.tenant_id)
            return {
                "reply": local_answer(request.message, tickets, selected),
                "source": "local",
            }

    return router
