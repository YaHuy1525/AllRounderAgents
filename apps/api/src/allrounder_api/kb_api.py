# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""Console knowledge base (upgrade U5).

The Knowledge page reads and ingests through this router. Reads are
role-gated like the command bar (any signed-in console role); uploads are
admin-only because a document changes what every lane's grounding can cite.
Ingestion reuses the store's existing ``ingest`` path unchanged: one
document, one ``source_version``, a ``stale_after`` review horizon, and a
``canonical`` flag that the search toggle filters on. No agent runs here and
no run state is touched, so the only write on the surface stays a document
upsert.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Protocol

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthenticationError, BearerVerifier, Principal
from .knowledge import (
    DocumentSummary,
    DomainSummary,
    KnowledgeDocument,
    RetrievalResult,
)
from .logging import get_logger

_READ_ROLES = ("viewer", "approver", "agent", "admin")
_UPLOAD_ROLES = ("admin",)

# Mirrors the kb_documents domain check: the phase-1 partitions plus the
# `msp:<clientRef>` and `hr:<lane>` prefix families.
_DOMAIN_PATTERN = re.compile(
    r"^(?:code|finance|marketing|support)$|^(?:msp|hr):[a-z0-9][a-z0-9._-]*$"
)

# Uploads without an explicit review horizon go stale after a year, matching
# the HR fixture corpus's review window.
DEFAULT_STALE_DAYS = 365


class KnowledgeConsole(Protocol):
    """The read + ingest slice of the knowledge stores the page needs."""

    async def retrieve(
        self,
        tenant_id: str,
        domain: str,
        query: str,
        k: int,
        *,
        now: datetime | None = None,
        canonical: bool = False,
    ) -> RetrievalResult: ...

    async def list_domains(
        self, tenant_id: str, *, now: datetime | None = None
    ) -> list[DomainSummary]: ...

    async def list_documents(
        self, tenant_id: str, domain: str, *, now: datetime | None = None
    ) -> list[DocumentSummary]: ...

    async def ingest(
        self, document: KnowledgeDocument, *, chunk_size: int = 800, overlap: int = 100
    ) -> int: ...


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class UploadDocument(ApiModel):
    """One versioned document upload from the console."""

    domain: str = Field(min_length=1, max_length=64)
    source_id: str = Field(
        min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]*$"
    )
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=200_000)
    source_version: str = Field(
        min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
    )
    stale_after: datetime | None = None
    canonical: bool = True
    source_uri: str | None = Field(default=None, max_length=500)


def build_kb_router(
    *,
    verifier: BearerVerifier,
    knowledge: KnowledgeConsole | None = None,
) -> APIRouter:
    """Console reads plus the admin-only document upload; one write total."""

    router = APIRouter(prefix="/kb", tags=["kb"])
    logger = get_logger()

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

    def require_store() -> KnowledgeConsole:
        if knowledge is None:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Knowledge store is not configured",
            )
        return knowledge

    def valid_domain(domain: str) -> bool:
        return _DOMAIN_PATTERN.fullmatch(domain) is not None

    @router.get("/domains")
    async def domains(
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Tenant partitions with document, stale, and canonical roll-ups."""

        require_role(identity, *_READ_ROLES)
        if knowledge is None:
            return {"domains": [], "configured": False}
        summaries = await knowledge.list_domains(identity.tenant_id)
        return {
            "domains": [
                {
                    "domain": item.domain,
                    "documents": item.documents,
                    "stale": item.stale,
                    "canonical": item.canonical,
                    "updatedAt": item.updated_at.isoformat() if item.updated_at else None,
                }
                for item in summaries
            ],
            "configured": True,
        }

    @router.get("/documents")
    async def documents(
        domain: str = Query(min_length=1, max_length=64),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Every version row of one partition; an empty partition is normal."""

        require_role(identity, *_READ_ROLES)
        if not valid_domain(domain):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Unsupported knowledge domain"
            )
        if knowledge is None:
            return {"documents": [], "configured": False}
        summaries = await knowledge.list_documents(identity.tenant_id, domain)
        return {
            "documents": [
                {
                    "sourceId": item.source_id,
                    "title": item.title,
                    "sourceVersion": item.source_version,
                    "sourceUri": item.source_uri,
                    "stale": item.stale,
                    "staleAfter": item.stale_after.isoformat(),
                    "canonical": item.canonical,
                    "chunks": item.chunks,
                    "createdAt": item.created_at.isoformat() if item.created_at else None,
                }
                for item in summaries
            ],
            "configured": True,
        }

    @router.get("/search")
    async def search(
        q: str = Query(min_length=1, max_length=200),
        domain: str = Query(min_length=1, max_length=64),
        k: int = Query(default=8, ge=1, le=20),
        canonical: bool = False,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Hybrid retrieval inside one partition; an empty scope is a 200."""

        require_role(identity, *_READ_ROLES)
        if not valid_domain(domain):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Unsupported knowledge domain"
            )
        if knowledge is None:
            return {"passages": [], "degraded": False, "configured": False}
        try:
            result = await knowledge.retrieve(
                identity.tenant_id,
                domain,
                q.strip(),
                k,
                canonical=canonical,
            )
        except LookupError:
            # EmptyRetrievalError is a LookupError: nothing scoped matches yet.
            return {"passages": [], "degraded": False, "configured": True}
        except Exception:  # noqa: BLE001 -- a store outage degrades, never fails
            logger.warning("kb_search_failed", domain=domain)
            return {"passages": [], "degraded": True, "configured": True}
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
                    "domain": domain,
                }
                for passage in result.passages
            ],
            "degraded": False,
            "configured": True,
        }

    @router.post("/documents")
    async def upload(
        request: UploadDocument,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Ingest one versioned document; the only write on this router."""

        require_role(identity, *_UPLOAD_ROLES)
        store = require_store()
        if not valid_domain(request.domain):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Unsupported knowledge domain"
            )
        stale_after = request.stale_after or (
            datetime.now(UTC) + timedelta(days=DEFAULT_STALE_DAYS)
        )
        if stale_after.tzinfo is None:
            stale_after = stale_after.replace(tzinfo=UTC)
        chunks = await store.ingest(
            KnowledgeDocument(
                source_id=request.source_id,
                tenant_id=identity.tenant_id,
                domain=request.domain,
                title=request.title,
                content=request.content,
                source_version=request.source_version,
                stale_after=stale_after,
                metadata={
                    "canonical": request.canonical,
                    "source_uri": request.source_uri or f"kb://{request.source_id}",
                    "uploaded_by": identity.subject,
                },
            )
        )
        return {
            "sourceId": request.source_id,
            "domain": request.domain,
            "sourceVersion": request.source_version,
            "chunks": chunks,
        }

    return router


__all__ = [
    "DEFAULT_STALE_DAYS",
    "KnowledgeConsole",
    "UploadDocument",
    "build_kb_router",
]
