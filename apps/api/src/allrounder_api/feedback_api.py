# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthenticationError, BearerVerifier, Principal
from .logging import get_logger
from .repositories import FeedbackRecord, FeedbackRepository


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class ChatFeedback(ApiModel):
    message_sha256: str = Field(pattern=r"(?i)^[a-f0-9]{64}$")
    rating: Literal["up", "down", "report"]
    reason: str | None = Field(default=None, max_length=200)


def build_feedback_router(
    *,
    verifier: BearerVerifier,
    feedback: FeedbackRepository,
) -> APIRouter:
    """Reply ratings only. The chat itself lives on the Mastra host now, but a
    thumbs up or down still belongs to the API that owns the feedback table."""
    router = APIRouter()
    logger = get_logger()

    async def principal(authorization: str | None = Header(default=None)) -> Principal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        try:
            return await verifier.verify(authorization[7:])
        except AuthenticationError as error:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials") from error

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
