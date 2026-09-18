# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Path, status
from pydantic import BaseModel, ConfigDict, Field

from .approvals import ApprovalReceiptSigner, ReceiptError, action_hash
from .auth import AuthenticationError, BearerVerifier, Principal
from .logging import get_logger
from .metrics import MetricsRegistry
from .repositories import (
    ApprovalRecord,
    ApprovalRepository,
    CaseRecord,
    CaseRepository,
    SupportSendRepository,
)
from .support import SupportService


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=lambda value: _camel(value), populate_by_name=True)


def _camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(item.title() for item in rest)


class CitationInput(ApiModel):
    source_id: str = Field(min_length=1, max_length=200)
    span: str = Field(pattern=r"^\d+-\d+$")


class ApprovalCreate(ApiModel):
    case_id: str = Field(min_length=1, max_length=100)
    tenant_id: str = Field(min_length=1, max_length=100)
    action: dict[str, object]
    evidence: list[CitationInput] = Field(min_length=1, max_length=100)
    approver: str = Field(min_length=1, max_length=200)
    scope: str = Field(pattern=r"^[a-z]+:[a-z]+$")
    expires_at: datetime


class ApprovalDecision(ApiModel):
    decision: str = Field(pattern=r"^(approved|rejected)$")
    comment: str | None = Field(default=None, max_length=2000)


class SupportDraft(ApiModel):
    case_id: str = Field(min_length=1, max_length=100)
    tenant_id: str = Field(min_length=1, max_length=100)
    ticket_key: str = Field(pattern=r"^[A-Z][A-Z0-9_]*-\d+$")
    draft: str = Field(min_length=1, max_length=20_000)
    citations: list[CitationInput] = Field(max_length=100)


class CaseOpen(ApiModel):
    ticket_key: str = Field(pattern=r"^[A-Z][A-Z0-9_]*-\d+$")


class SupportSend(ApiModel):
    approval_id: str = Field(min_length=1, max_length=100)
    case_id: str = Field(min_length=1, max_length=100)
    ticket_key: str = Field(pattern=r"^[A-Z][A-Z0-9_]*-\d+$")
    action: dict[str, object]
    receipt: str = Field(min_length=1, max_length=10_000)


def build_phase1_router(
    *, verifier: BearerVerifier, approvals: ApprovalRepository,
    cases: CaseRepository, sends: SupportSendRepository,
    signer: ApprovalReceiptSigner, metrics: MetricsRegistry | None = None,
) -> APIRouter:
    router = APIRouter()
    support = SupportService()
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

    def require_role(identity: Principal, *roles: str) -> None:
        if identity.roles.isdisjoint(roles):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")

    @router.post("/approvals", status_code=status.HTTP_201_CREATED)
    async def create_approval(
        request: ApprovalCreate, identity: Principal = Depends(principal)
    ) -> dict[str, object]:
        require_role(identity, "approver", "admin")
        if request.tenant_id != identity.tenant_id or request.approver != identity.subject:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        approval = ApprovalRecord(
            id=str(uuid4()), case_id=request.case_id, tenant_id=identity.tenant_id,
            action=request.action,
            evidence=[item.model_dump(by_alias=True) for item in request.evidence],
            approver=identity.subject, scope=request.scope, expires_at=request.expires_at,
        )
        return _approval_dict(await approvals.create(approval))

    @router.get("/approvals")
    async def list_approvals(
        identity: Principal = Depends(principal)
    ) -> list[dict[str, object]]:
        require_role(identity, "approver", "admin")
        return [_approval_dict(item) for item in await approvals.list(identity.tenant_id)]

    @router.get("/approvals/{approval_id}")
    async def get_approval(
        approval_id: str, identity: Principal = Depends(principal)
    ) -> dict[str, object]:
        require_role(identity, "approver", "admin")
        try:
            return _approval_dict(await approvals.get(approval_id, identity.tenant_id))
        except KeyError as error:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from error

    @router.post("/approvals/{approval_id}/decision")
    async def decide_approval(
        approval_id: str, request: ApprovalDecision,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "approver", "admin")
        try:
            approval = await approvals.get(approval_id, identity.tenant_id)
            if approval.approver != identity.subject and "admin" not in identity.roles:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
            decided = await approvals.decide(
                approval_id, identity.tenant_id, request.decision, request.comment
            )
        except KeyError as error:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from error
        except ValueError as error:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Approval is no longer pending"
            ) from error
        if metrics is not None:
            metrics.record_gate_decision(decided.scope)
            metrics.record_approval_decision(request.decision)
        response = _approval_dict(decided)
        if decided.decision == "approved":
            response["receipt"] = signer.issue(
                approval_id=decided.id, case_id=decided.case_id, action=decided.action,
                approver=decided.approver, scope=decided.scope,
                decision=decided.decision, expires_at=decided.expires_at,
            )
        return response

    @router.get("/cases/{case_id}")
    async def get_case(
        case_id: str = Path(min_length=1, max_length=100),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "viewer", "approver", "admin")
        try:
            return asdict(await cases.get(case_id, identity.tenant_id))
        except KeyError as error:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from error

    @router.get("/tickets/{ticket_key}/status")
    async def ticket_status(
        ticket_key: str = Path(pattern=r"^[A-Z][A-Z0-9_]*-\d+$"),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "viewer", "approver", "admin")
        try:
            case = await cases.get_by_ticket(ticket_key, identity.tenant_id)
            return {
                "ticketKey": case.ticket_key, "caseId": case.id,
                "status": case.status, "costUsdMicro": case.cost_usd_micro,
            }
        except KeyError as error:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from error

    @router.post("/cases")
    async def open_case(
        request: CaseOpen, identity: Principal = Depends(principal)
    ) -> dict[str, object]:
        require_role(identity, "agent", "admin")
        try:
            existing = await cases.get_by_ticket(request.ticket_key, identity.tenant_id)
        except KeyError:
            existing = None
        if existing is not None:
            return {
                "caseId": existing.id, "ticketKey": existing.ticket_key,
                "status": existing.status, "created": False,
            }
        case = await cases.create(
            CaseRecord(
                id=str(uuid4()), tenant_id=identity.tenant_id,
                ticket_key=request.ticket_key, domain="unknown", status="open",
            )
        )
        return {
            "caseId": case.id, "ticketKey": case.ticket_key,
            "status": case.status, "created": True,
        }

    @router.post("/support/drafts/start")
    async def start_support_draft(
        request: SupportDraft, identity: Principal = Depends(principal)
    ) -> dict[str, object]:
        require_role(identity, "agent", "approver", "admin")
        if request.tenant_id != identity.tenant_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        citations = [item.model_dump(by_alias=True) for item in request.citations]
        result = support.validate_draft(request.draft, citations)
        return {
            "caseId": request.case_id, "ticketKey": request.ticket_key,
            "status": "ready_for_approval" if result.valid else "escalated",
            "reason": result.reason, "citations": citations,
        }

    @router.post("/support/send")
    async def send_support_reply(
        request: SupportSend, identity: Principal = Depends(principal)
    ) -> dict[str, object]:
        require_role(identity, "approver", "admin")
        try:
            approval = await approvals.get(request.approval_id, identity.tenant_id)
            if approval.decision != "approved":
                raise ReceiptError("Invalid receipt")
            claims = signer.validate(
                request.receipt, approval_id=request.approval_id, case_id=request.case_id,
                action=request.action, scope="support:send",
            )
            if not action_hash(approval.action) == claims.action_hash:
                raise ReceiptError("Invalid receipt")
            body = request.action.get("draft")
            if not isinstance(body, str):
                raise ReceiptError("Invalid receipt")
            sent = await sends.authorize_and_send(
                claims.receipt_id,
                approval.id,
                approval.case_id,
                claims.action_hash,
                request.ticket_key,
                body,
            )
            return asdict(sent)
        except (KeyError, ReceiptError, ValueError):
            logger.warning(
                "support_send_denied",
                approval_id=request.approval_id,
                case_id=request.case_id,
            )
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Action not authorized") from None

    return router


def _approval_dict(value: ApprovalRecord) -> dict[str, object]:
    return {
        "id": value.id,
        "caseId": value.case_id,
        "tenantId": value.tenant_id,
        "action": value.action,
        "evidence": value.evidence,
        "approver": value.approver,
        "scope": value.scope,
        "expiresAt": value.expires_at.isoformat(),
        "decision": value.decision,
        "comment": value.comment,
        "decidedAt": value.decided_at.isoformat() if value.decided_at else None,
    }
