# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

from __future__ import annotations

import json
import re
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthenticationError, BearerVerifier, Principal
from .board_chat import (
    ChatCompleter,
    ChatStreamer,
    local_answer,
    sanitize_tickets,
    system_prompt,
)
from .jira import JIRA_TICKET_KEY_PATTERN
from .logging import get_logger
from .metrics import MetricsRegistry
from .repositories import FeedbackRecord, FeedbackRepository


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


class ChatFeedback(ApiModel):
    message_sha256: str = Field(pattern=r"(?i)^[a-f0-9]{64}$")
    rating: Literal["up", "down", "report"]
    reason: str | None = Field(default=None, max_length=200)


def build_chat_router(
    *,
    verifier: BearerVerifier,
    completer: ChatCompleter | None,
    feedback: FeedbackRepository,
    metrics: MetricsRegistry | None = None,
) -> APIRouter:
    router = APIRouter()
    logger = get_logger()

    def record_chat(source: str) -> None:
        if metrics is not None:
            metrics.record_chat(source)

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
            record_chat("local")
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
            record_chat("model")
            return {"reply": reply[:8_000], "source": "model"}
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            logger.warning("board_chat_model_failed", tenant_id=identity.tenant_id)
            record_chat("local")
            return {
                "reply": local_answer(request.message, tickets, selected),
                "source": "local",
            }

    @router.post("/chat/stream")
    async def chat_stream(
        payload: ChatAsk,
        request: Request,
        identity: Principal = Depends(principal),
    ) -> StreamingResponse:
        if identity.roles.isdisjoint({"viewer", "agent", "approver", "admin"}):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        tickets = sanitize_tickets(payload.tickets)
        selected = payload.selected_key
        if selected is not None and re.fullmatch(JIRA_TICKET_KEY_PATTERN, selected) is None:
            selected = None
        prompt = system_prompt(tickets, selected)
        message = payload.message.strip()

        async def events() -> AsyncIterator[str]:
            streamer = completer if isinstance(completer, ChatStreamer) else None
            started = time.perf_counter()
            recorded_first_token = False
            source = "local"
            emitted = False
            interrupted = False
            if streamer is not None:
                try:
                    async for delta in streamer.stream(prompt, message):
                        if await request.is_disconnected():
                            return
                        if not delta:
                            continue
                        emitted = True
                        source = "model"
                        if not recorded_first_token:
                            recorded_first_token = True
                            if metrics is not None:
                                metrics.record_chat_stream(
                                    "model", time.perf_counter() - started
                                )
                        yield _sse_event({"delta": delta})
                except Exception:
                    logger.warning(
                        "board_chat_stream_failed",
                        tenant_id=identity.tenant_id,
                        mid_stream=emitted,
                    )
                    interrupted = emitted
            if not emitted:
                source = "local"
                interrupted = False
                for chunk in _text_chunks(local_answer(message, tickets, selected)):
                    if await request.is_disconnected():
                        return
                    if not recorded_first_token:
                        recorded_first_token = True
                        if metrics is not None:
                            metrics.record_chat_stream(
                                "local", time.perf_counter() - started
                            )
                    yield _sse_event({"delta": chunk})
            record_chat(source)
            yield _sse_event({"done": True, "source": source, "interrupted": interrupted})

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"},
        )

    @router.post("/chat/feedback")
    async def chat_feedback(
        payload: ChatFeedback,
        identity: Principal = Depends(principal),
    ) -> dict[str, bool]:
        if identity.roles.isdisjoint({"viewer", "agent", "approver", "admin"}):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        reason = payload.reason.strip() if payload.reason is not None else None
        if not reason:
            reason = None
        await feedback.store(
            FeedbackRecord(
                tenant_id=identity.tenant_id,
                message_sha256=payload.message_sha256.lower(),
                rating=payload.rating,
                reason=reason,
            )
        )
        logger.info(
            "chat_feedback_stored",
            tenant_id=identity.tenant_id,
            rating=payload.rating,
        )
        return {"stored": True}

    return router


def _sse_event(payload: dict[str, object]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _text_chunks(text: str, size: int = 160) -> list[str]:
    chunks = [text[index : index + size] for index in range(0, len(text), size)]
    return chunks or [""]
