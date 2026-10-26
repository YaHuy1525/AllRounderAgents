# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""U7 doc-snap API: snap a paper document into an editable draft.

``POST /cases/{case_id}/doc-snaps`` lands a draft on the case trail with the extracted
fields and check flags, and ``GET`` lists the drafts the case holds. Nothing here
touches a run: turning a draft into a change still goes through the edit decision and
its receipt gate, so snap never posts. View roles may list, and only
agent/approver/admin may snap.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Path, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthenticationError, BearerVerifier, Principal
from .doc_snap import (
    DocSnapError,
    DocSnapExtractor,
    DocSnapTooLarge,
    HeuristicDocSnapExtractor,
    build_doc_snap,
    decode_snap_content,
    doc_snap_source_hashes,
)
from .logging import get_logger
from .repositories import CaseRecord, CaseRepository

_VIEW_ROLES = frozenset({"viewer", "agent", "approver", "admin"})
_SNAP_ROLES = frozenset({"agent", "approver", "admin"})
# Case ids are slugs minted by intake or the run service (``msp-acme-482913``,
# ``case-smartac-scrum-27``); the same pattern pack_api uses.
_CASE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
# 2 MiB of content is ~2.8M base64 chars; caps model parsing above the
# decode-time size check.
_MAX_BASE64_CHARS = 4_000_000


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class DocSnapRequest(ApiModel):
    """One snapped document: filename, content type, and base64 content."""

    filename: str = Field(min_length=1, max_length=200)
    content_type: str = Field(default="application/octet-stream", max_length=120)
    content_base64: str = Field(min_length=1, max_length=_MAX_BASE64_CHARS)


def build_doc_snap_router(
    *,
    verifier: BearerVerifier,
    cases: CaseRepository,
    extractor: DocSnapExtractor | None = None,
) -> APIRouter:
    router = APIRouter(tags=["doc-snaps"])
    logger = get_logger()
    active_extractor = extractor or HeuristicDocSnapExtractor()

    async def principal(
        authorization: str | None = Header(default=None),
    ) -> Principal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        try:
            return await verifier.verify(authorization[7:])
        except AuthenticationError as error:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials") from error

    def require_role(identity: Principal, *roles: str) -> None:
        if identity.roles.isdisjoint(roles):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")

    async def load_case(case_id: str, identity: Principal) -> CaseRecord:
        try:
            return await cases.get(case_id, identity.tenant_id)
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found") from None

    @router.post("/cases/{case_id}/doc-snaps", status_code=status.HTTP_201_CREATED)
    async def create_doc_snap(
        request: DocSnapRequest,
        case_id: str = Path(min_length=1, max_length=200, pattern=_CASE_ID_PATTERN),
        identity: Principal = Depends(principal),
    ) -> JSONResponse:
        """Snap one document: extract fields, run the checks, save the draft."""

        require_role(identity, *_SNAP_ROLES)
        case = await load_case(case_id, identity)
        try:
            data = decode_snap_content(request.content_base64)
        except DocSnapTooLarge as error:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, str(error)) from error
        except DocSnapError as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)
            ) from error
        extraction = await active_extractor.extract(
            filename=request.filename,
            content_type=request.content_type,
            data=data,
        )
        draft = build_doc_snap(
            filename=request.filename,
            content_type=request.content_type,
            data=data,
            extraction=extraction,
            extractor=active_extractor.name,
            prior_sha256s=doc_snap_source_hashes(
                event.payload for event in case.events if event.kind == "doc_snap"
            ),
        )
        payload = draft.to_payload()
        # The draft is evidence on the case trail — never a run mutation.
        await cases.append_event(case.id, actor="human", kind="doc_snap", payload=payload)
        logger.info(
            "doc_snap_recorded",
            tenant_id=identity.tenant_id,
            case_id=case.id,
            snap_id=draft.snap_id,
            doc_type=draft.doc_type,
            flags=len(draft.flags),
        )
        return JSONResponse(payload, status_code=status.HTTP_201_CREATED)

    @router.get("/cases/{case_id}/doc-snaps")
    async def list_doc_snaps(
        case_id: str = Path(min_length=1, max_length=200, pattern=_CASE_ID_PATTERN),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Every draft the case holds, newest first."""

        require_role(identity, *_VIEW_ROLES)
        case = await load_case(case_id, identity)
        drafts = [event.payload for event in case.events if event.kind == "doc_snap"]
        drafts.reverse()
        return {"docSnaps": drafts}

    return router


__all__ = [
    "DocSnapRequest",
    "build_doc_snap_router",
]
