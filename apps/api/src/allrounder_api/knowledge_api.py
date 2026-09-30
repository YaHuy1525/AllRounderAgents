# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""Service-to-service knowledge search.

The Mastra host grounds the MSP draft step through this route: it posts a
tenant, a domain (``msp:<clientRef>`` for the MSP lane) and the query, and
receives the hybrid-retrieval passages with their citations. The route is
mounted only when a retriever and a service token are configured, and it
accepts one credential: the shared ``KNOWLEDGE_SERVICE_TOKEN`` bearer, so no
console role can reach it. Retrieval is read-only (``knowledge.retrieve`` in
policy/tools.yaml) and an empty scope is a normal outcome, never an error.
"""

from __future__ import annotations

import hmac
from datetime import datetime
from typing import Protocol

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from .knowledge import EmptyRetrievalError, RetrievalResult


class KnowledgeRetriever(Protocol):
    """The read-only slice of the knowledge stores this route needs."""

    async def retrieve(
        self,
        tenant_id: str,
        domain: str,
        query: str,
        k: int,
        *,
        now: datetime | None = None,
    ) -> RetrievalResult: ...


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class KnowledgeSearch(ApiModel):
    """One scoped retrieval request from the Mastra host."""

    tenant_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    domain: str = Field(
        min_length=1, max_length=128, pattern=r"^[a-z0-9][a-z0-9:._-]*$"
    )
    query: str = Field(min_length=1, max_length=1_000)
    k: int = Field(default=5, ge=1, le=20)


def build_knowledge_router(
    *,
    retriever: KnowledgeRetriever,
    service_token: str,
) -> APIRouter:
    router = APIRouter(prefix="/knowledge", tags=["knowledge"])

    def _authorize(authorization: str | None) -> None:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        presented = authorization[7:]
        if not hmac.compare_digest(presented, service_token):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

    @router.post("/search")
    async def search(
        request: KnowledgeSearch,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """Hybrid retrieval over one tenant + domain partition, citations included."""

        _authorize(authorization)
        try:
            result = await retriever.retrieve(
                request.tenant_id, request.domain, request.query, request.k
            )
        except EmptyRetrievalError:
            # Nothing scoped matches yet: the caller's escalation ladder
            # handles this, so an empty scope is a 200 with no passages.
            return {
                "passages": [],
                "embeddingModel": None,
                "rerankModel": None,
                "rerankDegraded": False,
            }
        return {
            "passages": [
                {
                    "sourceId": passage.citation.source_id,
                    "span": passage.citation.span,
                    "title": passage.title,
                    "text": passage.content,
                    "score": passage.score,
                    "stale": passage.stale,
                    "sourceVersion": passage.source_version,
                }
                for passage in result.passages
            ],
            "embeddingModel": result.embedding_model,
            "rerankModel": result.rerank_model,
            "rerankDegraded": result.rerank_degraded,
        }

    return router


__all__ = [
    "KnowledgeRetriever",
    "KnowledgeSearch",
    "build_knowledge_router",
]
