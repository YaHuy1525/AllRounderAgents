# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""MSP surface: connection settings (console) and the audit pack download.

``GET/PUT /msp/connections`` and ``POST/DELETE /msp/clients`` mirror the
``msp_connections``/``msp_clients`` tables the onboarding script also writes.
``GET /msp/audit-pack`` serves the per-client per-month proof artifact, JSON
or PDF, built by :class:`allrounder_api.audit_pack.AuditPackBuilder` from the
immutable trail only.

``GET/POST/DELETE /msp/vendors`` mirror the ``msp_vendors`` table (the bills
lane's registry), and ``POST /msp/vendors/lookup`` is the service-to-service
sender lookup the Mastra host calls before it posts anything: it accepts the
shared service token only and answers the registered vendor or ``null``.
"""

from __future__ import annotations

import hmac
import re

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .audit_pack import CLIENT_REF_RE, AuditPackBuilder, render_pdf
from .auth import AuthenticationError, BearerVerifier, Principal
from .logging import get_logger
from .repositories import (
    MspClientRecord,
    MspConnectionRecord,
    MspConnectionsRepository,
    MspVendorRecord,
)

_VIEW_ROLES = frozenset({"viewer", "agent", "approver", "admin"})
_WRITE_ROLES = frozenset({"agent", "admin"})
_DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")
VENDOR_REF_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class MspConnectionUpsert(ApiModel):
    """Settings payload: the inbound domain the desk watches for this tenant."""

    inbound_domain: str = Field(min_length=3, max_length=253)
    display_name: str = Field(default="", max_length=100)

    @field_validator("inbound_domain", "display_name")
    @classmethod
    def strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("inbound_domain", mode="before")
    @classmethod
    def lowercase(cls, value: object) -> object:
        return value.lower() if isinstance(value, str) else value

    @field_validator("inbound_domain")
    @classmethod
    def sane_domain(cls, value: str) -> str:
        if _DOMAIN_RE.fullmatch(value) is None or "." not in value:
            raise ValueError("Inbound domain must be a lowercase hostname")
        return value


class MspClientUpsert(ApiModel):
    """One client ref plus its desk mapping."""

    client_ref: str = Field(min_length=1, max_length=64, pattern=CLIENT_REF_RE.pattern)
    display_name: str = Field(default="", max_length=100)
    contact_email: str = Field(default="", max_length=320)
    desk_project: str = Field(default="", max_length=60)

    @field_validator("client_ref", mode="before")
    @classmethod
    def lowercase(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("display_name", "contact_email", "desk_project")
    @classmethod
    def strip(cls, value: str) -> str:
        return value.strip()


class MspVendorUpsert(ApiModel):
    """One vendor: the ref the bills lane derives plus the registered details."""

    vendor_ref: str = Field(min_length=1, max_length=40, pattern=VENDOR_REF_RE.pattern)
    name: str = Field(default="", max_length=200)
    emails: list[str] = Field(min_length=1, max_length=10)
    account_name: str = Field(default="", max_length=200)
    bsb: str = Field(default="", max_length=20)
    account_number: str = Field(default="", max_length=40)

    @field_validator("vendor_ref", mode="before")
    @classmethod
    def lowercase(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("emails", mode="before")
    @classmethod
    def normalize_emails(cls, value: object) -> object:
        if not isinstance(value, list):
            return value
        normalized: list[str] = []
        for item in value:
            if not isinstance(item, str):
                raise ValueError("Vendor emails must be strings")
            email = item.strip().lower()
            if "@" not in email or len(email) > 320:
                raise ValueError("Vendor emails must be valid addresses")
            if email not in normalized:
                normalized.append(email)
        return normalized

    @field_validator("name", "account_name", "bsb", "account_number")
    @classmethod
    def strip(cls, value: str) -> str:
        return value.strip()


class MspVendorLookup(ApiModel):
    """One scoped sender lookup from the Mastra host."""

    tenant_id: str = Field(min_length=1, max_length=64)
    email: str = Field(min_length=3, max_length=320)


def _connection_dict(record: MspConnectionRecord) -> dict[str, object]:
    return {
        "inboundDomain": record.inbound_domain,
        "displayName": record.display_name,
        "createdAt": record.created_at.isoformat(),
        "updatedAt": record.updated_at.isoformat(),
    }


def _client_dict(record: MspClientRecord) -> dict[str, object]:
    return {
        "clientRef": record.client_ref,
        "displayName": record.display_name,
        "contactEmail": record.contact_email,
        "deskProject": record.desk_project,
        "createdAt": record.created_at.isoformat(),
        "updatedAt": record.updated_at.isoformat(),
    }


def _vendor_dict(record: MspVendorRecord) -> dict[str, object]:
    return {
        "vendorRef": record.vendor_ref,
        "name": record.name,
        "emails": list(record.emails),
        "accountName": record.account_name,
        "bsb": record.bsb,
        "accountNumber": record.account_number,
        "createdAt": record.created_at.isoformat(),
        "updatedAt": record.updated_at.isoformat(),
    }


def _vendor_lookup_dict(record: MspVendorRecord) -> dict[str, object]:
    """The lookup payload the bills lane's VendorRecord contract parses: an
    unstated detail is null, never an empty string, and the name falls back to
    the ref so the record always parses."""

    return {
        "ref": record.vendor_ref,
        "name": record.name or record.vendor_ref,
        "accountName": record.account_name or None,
        "bsb": record.bsb or None,
        "accountNumber": record.account_number or None,
    }


def build_msp_router(
    *,
    verifier: BearerVerifier,
    connections: MspConnectionsRepository,
    audit_packs: AuditPackBuilder,
    service_token: str | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/msp", tags=["msp"])
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

    def _require_write(identity: Principal) -> None:
        if identity.roles.isdisjoint(_WRITE_ROLES):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")

    @router.get("/connections")
    async def get_connections(
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """The tenant's MSP connection (null until configured) and its clients."""

        _require_view(identity)
        try:
            connection = await connections.get_connection(identity.tenant_id)
            connection_payload: dict[str, object] | None = _connection_dict(connection)
        except KeyError:
            connection_payload = None
        clients = await connections.list_clients(identity.tenant_id)
        return {
            "connection": connection_payload,
            "clients": [_client_dict(item) for item in clients],
        }

    @router.put("/connections")
    async def upsert_connection(
        request: MspConnectionUpsert,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        _require_write(identity)
        record = await connections.upsert_connection(
            MspConnectionRecord(
                tenant_id=identity.tenant_id,
                inbound_domain=request.inbound_domain,
                display_name=request.display_name,
            )
        )
        logger.info(
            "msp_connection_upserted",
            tenant_id=identity.tenant_id,
            inbound_domain=record.inbound_domain,
        )
        return _connection_dict(record)

    @router.post("/clients")
    async def upsert_client(
        request: MspClientUpsert,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Register (or update) one client ref; idempotent by clientRef."""

        _require_write(identity)
        try:
            record = await connections.upsert_client(
                MspClientRecord(
                    tenant_id=identity.tenant_id,
                    client_ref=request.client_ref,
                    display_name=request.display_name,
                    contact_email=request.contact_email,
                    desk_project=request.desk_project,
                )
            )
        except KeyError:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Configure the MSP connection before adding clients",
            ) from None
        logger.info(
            "msp_client_upserted",
            tenant_id=identity.tenant_id,
            client_ref=record.client_ref,
        )
        return _client_dict(record)

    @router.delete("/clients/{client_ref}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_client(
        client_ref: str = Path(min_length=1, max_length=64, pattern=CLIENT_REF_RE.pattern),
        identity: Principal = Depends(principal),
    ) -> None:
        _require_write(identity)
        try:
            await connections.delete_client(identity.tenant_id, client_ref)
        except KeyError:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "MSP client not found"
            ) from None
        logger.info(
            "msp_client_deleted",
            tenant_id=identity.tenant_id,
            client_ref=client_ref,
        )

    @router.get("/vendors")
    async def list_vendors(
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Every registered vendor of the tenant, ordered by ref."""

        _require_view(identity)
        vendors = await connections.list_vendors(identity.tenant_id)
        return {"vendors": [_vendor_dict(item) for item in vendors]}

    @router.post("/vendors")
    async def upsert_vendor(
        request: MspVendorUpsert,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Register (or update) one vendor; idempotent by vendorRef."""

        _require_write(identity)
        try:
            record = await connections.upsert_vendor(
                MspVendorRecord(
                    tenant_id=identity.tenant_id,
                    vendor_ref=request.vendor_ref,
                    name=request.name,
                    emails=list(request.emails),
                    account_name=request.account_name,
                    bsb=request.bsb,
                    account_number=request.account_number,
                )
            )
        except KeyError:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Configure the MSP connection before adding vendors",
            ) from None
        logger.info(
            "msp_vendor_upserted",
            tenant_id=identity.tenant_id,
            vendor_ref=record.vendor_ref,
        )
        return _vendor_dict(record)

    @router.delete("/vendors/{vendor_ref}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_vendor(
        vendor_ref: str = Path(min_length=1, max_length=40, pattern=VENDOR_REF_RE.pattern),
        identity: Principal = Depends(principal),
    ) -> None:
        _require_write(identity)
        try:
            await connections.delete_vendor(identity.tenant_id, vendor_ref)
        except KeyError:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "MSP vendor not found"
            ) from None
        logger.info(
            "msp_vendor_deleted",
            tenant_id=identity.tenant_id,
            vendor_ref=vendor_ref,
        )

    if service_token is not None and service_token != "":
        # Service-to-service lookup for the Mastra host's bills lane; mounted
        # only when the shared token is configured. Same credential the
        # knowledge route accepts, so no console role can reach it.
        def _authorize_service(authorization: str | None) -> None:
            if authorization is None or not authorization.startswith("Bearer "):
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
            if not hmac.compare_digest(authorization[7:], service_token):
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

        @router.post("/vendors/lookup")
        async def lookup_vendor(
            request: MspVendorLookup,
            authorization: str | None = Header(default=None),
        ) -> dict[str, object]:
            """The registered vendor for one sender address, or null."""

            _authorize_service(authorization)
            record = await connections.find_vendor_by_email(
                request.tenant_id, request.email
            )
            return {
                "vendor": None if record is None else _vendor_lookup_dict(record)
            }

    @router.get("/audit-pack")
    async def audit_pack(
        client_ref: str = Query(
            alias="clientRef", min_length=1, max_length=64, pattern=CLIENT_REF_RE.pattern
        ),
        month: str = Query(min_length=7, max_length=7),
        format: str = Query(default="json", pattern="^(json|pdf)$"),
        identity: Principal = Depends(principal),
    ) -> Response:
        """Per-client per-month audit pack; ``format=pdf`` downloads it."""

        _require_view(identity)
        try:
            pack = await audit_packs.build(
                tenant_id=identity.tenant_id, client_ref=client_ref, month=month
            )
        except ValueError as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)
            ) from None
        logger.info(
            "msp_audit_pack_built",
            tenant_id=identity.tenant_id,
            client_ref=client_ref,
            month=month,
            format=format,
        )
        if format == "pdf":
            filename = f"audit-pack-{client_ref}-{month}.pdf"
            return Response(
                render_pdf(pack),
                media_type="application/pdf",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )
        return JSONResponse(pack)

    return router


__all__ = [
    "MspClientUpsert",
    "MspConnectionUpsert",
    "MspVendorLookup",
    "MspVendorUpsert",
    "build_msp_router",
]
