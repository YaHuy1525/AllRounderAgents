# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from .approvals import ApprovalReceiptSigner, ReceiptError, action_hash
from .auth import AuthenticationError, BearerVerifier, Principal
from .finance import exception_dict, run_reconciliation
from .finance_runs import FinanceRunRecord, FinanceRunRepository
from .logging import get_logger
from .repositories import ApprovalRepository, SupportSendRepository


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class LedgerLineInput(ApiModel):
    account: str = Field(min_length=1, max_length=32)
    amount_cents: StrictInt
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    external_ref: str = Field(min_length=1, max_length=80)


class FinanceRunStart(ApiModel):
    case_id: str = Field(min_length=1, max_length=100)
    ticket_key: str = Field(pattern=r"^[A-Z][A-Z0-9_]*-\d+$")
    period: str = Field(pattern=r"^\d{4}-\d{2}$")
    ledger: list[LedgerLineInput] = Field(min_length=1, max_length=10_000)
    bank: list[LedgerLineInput] = Field(min_length=1, max_length=10_000)
    idempotency_key: str = Field(min_length=1, max_length=250)


class FinancePost(ApiModel):
    approval_id: str = Field(min_length=1, max_length=100)
    case_id: str = Field(min_length=1, max_length=100)
    action: dict[str, object]
    receipt: str = Field(min_length=1, max_length=10_000)


def build_phase3_router(
    *,
    verifier: BearerVerifier,
    runs: FinanceRunRepository,
    approvals: ApprovalRepository,
    sends: SupportSendRepository,
    signer: ApprovalReceiptSigner,
) -> APIRouter:
    router = APIRouter(prefix="/finance")
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

    @router.post("/runs", status_code=status.HTTP_201_CREATED)
    async def start_run(
        request: FinanceRunStart,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "agent", "admin")
        ledger = [item.model_dump(by_alias=True) for item in request.ledger]
        bank = [item.model_dump(by_alias=True) for item in request.bank]
        exceptions, audit_pack, posting = run_reconciliation(request.period, ledger, bank)
        checks = audit_pack.get("checks", [])
        status_value = "awaiting_approval"
        if not isinstance(checks, list) or not all(
            isinstance(check, dict) and check.get("passed") for check in checks
        ):
            status_value = "escalated"
        run = FinanceRunRecord(
            id=str(uuid4()),
            case_id=request.case_id,
            tenant_id=identity.tenant_id,
            ticket_key=request.ticket_key,
            period=request.period,
            ledger=ledger,
            bank=bank,
            exceptions=[exception_dict(item) for item in exceptions],
            audit_pack=audit_pack,
            posting=posting,
            idempotency_key=request.idempotency_key,
            status=status_value,
        )
        try:
            return _run_dict(await runs.create(run))
        except (KeyError, ValueError, TypeError):
            logger.warning(
                "finance_run_start_conflict",
                tenant_id=identity.tenant_id,
                ticket_key=request.ticket_key,
            )
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Finance run could not be started"
            ) from None

    @router.get("/runs/{run_id}")
    async def get_run(
        run_id: str,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "viewer", "approver", "admin")
        try:
            return _run_dict(await runs.get(run_id, identity.tenant_id))
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Resource not found") from None

    @router.post("/runs/{run_id}/post")
    async def post_run(
        run_id: str,
        request: FinancePost,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "approver", "admin")
        try:
            run = await runs.get(run_id, identity.tenant_id)
            if run.case_id != request.case_id or run.posting != request.action:
                raise ReceiptError("Invalid receipt")
            if run.status == "posted" and run.artifact:
                return {"status": "posted", "artifact": run.artifact, **_run_dict(run)}
            approval = await approvals.get(request.approval_id, identity.tenant_id)
            if approval.decision != "approved":
                raise ReceiptError("Invalid receipt")
            claims = signer.validate(
                request.receipt,
                approval_id=request.approval_id,
                case_id=request.case_id,
                action=request.action,
                scope="finance:post",
            )
            if action_hash(approval.action) != claims.action_hash:
                raise ReceiptError("Invalid receipt")
            if run.artifact is None:
                await sends.consume_receipt(
                    claims.receipt_id,
                    approval.id,
                    approval.case_id,
                    claims.action_hash,
                )
            posted = await runs.post_sandbox(
                run_id,
                identity.tenant_id,
                claims.action_hash,
                claims.receipt_id,
                request.action,
            )
            updated = await runs.get(run_id, identity.tenant_id)
            return {"status": "posted", "artifact": posted["artifact"], **_run_dict(updated)}
        except (KeyError, ReceiptError, ValueError, TypeError):
            logger.warning(
                "finance_post_denied",
                run_id=run_id,
                approval_id=request.approval_id,
                case_id=request.case_id,
            )
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Action not authorized") from None

    return router


def _run_dict(run: FinanceRunRecord) -> dict[str, object]:
    return {
        "id": run.id,
        "caseId": run.case_id,
        "tenantId": run.tenant_id,
        "ticketKey": run.ticket_key,
        "period": run.period,
        "ledger": run.ledger,
        "bank": run.bank,
        "exceptions": run.exceptions,
        "auditPack": run.audit_pack,
        "posting": run.posting,
        "status": run.status,
        "artifact": run.artifact,
    }
