# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""Per-case audit pack (U6): the MSP pack pattern generalized to every lane.

``GET /cases/{case_id}/pack`` serves one case's proof artifact — decisions,
receipts, cited sources, changed files, and cost — JSON or PDF, built by
:class:`allrounder_api.audit_pack.AuditPackBuilder` from the immutable trail
only. Read-only: every console view role may download it, and a case outside
the caller's tenant answers 404 like any other console read.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, status
from fastapi.responses import JSONResponse, Response

from .audit_pack import AuditPackBuilder, render_pdf
from .auth import AuthenticationError, BearerVerifier, Principal
from .logging import get_logger

_VIEW_ROLES = frozenset({"viewer", "agent", "approver", "admin"})
# Case ids are slugs minted by intake or the run service (``msp-acme-482913``,
# ``case-smartac-scrum-27``); the pattern also keeps the id safe to echo in a
# Content-Disposition header.
_CASE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"


def build_pack_router(
    *,
    verifier: BearerVerifier,
    audit_packs: AuditPackBuilder,
) -> APIRouter:
    router = APIRouter(tags=["packs"])
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

    def _require_view(identity: Principal) -> None:
        if identity.roles.isdisjoint(_VIEW_ROLES):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")

    @router.get("/cases/{case_id}/pack")
    async def case_pack(
        case_id: str = Path(min_length=1, max_length=200, pattern=_CASE_ID_PATTERN),
        format: str = Query(default="json", pattern="^(json|pdf)$"),
        identity: Principal = Depends(principal),
    ) -> Response:
        """One case's audit pack; ``format=pdf`` downloads it."""

        _require_view(identity)
        try:
            pack = await audit_packs.build_case(tenant_id=identity.tenant_id, case_id=case_id)
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found") from None
        logger.info(
            "case_pack_built",
            tenant_id=identity.tenant_id,
            case_id=case_id,
            format=format,
        )
        if format == "pdf":
            ticket = pack.get("ticketKey")
            stem = re.sub(r"[^A-Za-z0-9._-]+", "-", ticket if isinstance(ticket, str) else "")
            filename = f"case-pack-{stem or case_id}.pdf"
            return Response(
                render_pdf(pack),
                media_type="application/pdf",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )
        return JSONResponse(pack)

    return router


__all__ = [
    "build_pack_router",
]
