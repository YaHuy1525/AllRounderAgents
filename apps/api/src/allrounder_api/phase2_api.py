# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import AuthenticationError, BearerVerifier, Principal
from .coding_runs import CodingRunRecord, CodingRunRepository
from .logging import get_logger


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class CodingRunStart(ApiModel):
    case_id: str = Field(min_length=1, max_length=100)
    ticket_key: str = Field(pattern=r"^[A-Z][A-Z0-9_]*-\d+$")
    repository: str = Field(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
    base_branch: str = Field(min_length=1, max_length=250)
    source_sha: str = Field(pattern=r"^[a-f0-9]{40,64}$")
    branch: str = Field(pattern=r"^[A-Za-z0-9._/-]+$", max_length=250)
    problem: str = Field(min_length=1, max_length=20_000)
    idempotency_key: str = Field(min_length=1, max_length=250)

    @field_validator("branch")
    @classmethod
    def validate_branch(cls, value: str) -> str:
        segments = value.split("/")
        if (
            value.startswith(("/", "."))
            or value.endswith(("/", "."))
            or ".." in value
            or any(not segment for segment in segments)
            or any(segment.endswith(".lock") for segment in segments)
        ):
            raise ValueError("Branch name is not a safe Git reference")
        return value


def build_phase2_router(
    *,
    verifier: BearerVerifier,
    runs: CodingRunRepository,
    repository_allowlist: list[str],
    base_branch: str,
) -> APIRouter:
    router = APIRouter(prefix="/coding")
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
        request: CodingRunStart,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "agent", "admin")
        if request.repository not in repository_allowlist or request.base_branch != base_branch:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        run = CodingRunRecord(
            id=str(uuid4()),
            case_id=request.case_id,
            tenant_id=identity.tenant_id,
            ticket_key=request.ticket_key,
            repository=request.repository,
            base_branch=request.base_branch,
            source_sha=request.source_sha,
            branch=request.branch,
            problem=request.problem,
            idempotency_key=request.idempotency_key,
        )
        try:
            return _run_dict(await runs.create(run))
        except (KeyError, ValueError):
            logger.warning(
                "coding_run_start_conflict",
                tenant_id=identity.tenant_id,
                repository=request.repository,
                ticket_key=request.ticket_key,
            )
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Coding run could not be started"
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

    return router


def _run_dict(run: CodingRunRecord) -> dict[str, object]:
    return {
        "id": run.id,
        "caseId": run.case_id,
        "tenantId": run.tenant_id,
        "ticketKey": run.ticket_key,
        "repository": run.repository,
        "baseBranch": run.base_branch,
        "sourceSha": run.source_sha,
        "branch": run.branch,
        "problem": run.problem,
        "status": run.status,
        "rcaEvidence": run.rca_evidence,
        "patchManifest": run.patch_manifest,
        "validationResult": run.validation_result,
        "prReceipt": run.pr_receipt,
    }
