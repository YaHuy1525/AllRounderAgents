# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""Connector registry + vault (N2): Settings -> Connections.

The catalog comes from ``policy/tools.yaml`` (``connectors:``) and is merged
with the tenant's vault rows. Connecting registers the tenant's credential —
it never grants a tool: execution permissions stay in the tool matrix, and no
run gains a new execution path from a connection. Secrets are write-only from
the browser: responses carry a last-four hint only.
"""

from __future__ import annotations

from datetime import UTC

from fastapi import APIRouter, Depends, Header, HTTPException, Path, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import AuthenticationError, BearerVerifier, Principal
from .logging import get_logger
from .policy import PROVIDER_PATTERN, ConnectorPermission, ToolMatrix, default_tool_matrix
from .repositories import ConnectorVaultRecord, ConnectorVaultRepository

_VIEW_ROLES = frozenset({"viewer", "agent", "approver", "admin"})
_WRITE_ROLES = frozenset({"agent", "admin"})


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class ConnectorConnect(ApiModel):
    """Connect/rotate payload: the provider credential, write-only server-side."""

    secret: str = Field(min_length=8, max_length=500)

    @field_validator("secret")
    @classmethod
    def strip(cls, value: str) -> str:
        stripped = value.strip()
        if len(stripped) < 8:
            raise ValueError("Secret is required")
        return stripped


def _connector_dict(
    entry: ConnectorPermission, ref: ConnectorVaultRecord | None
) -> dict[str, object]:
    """Catalog entry merged with this tenant's status; the secret itself never
    leaves the server — a connected row carries a last-four hint only."""

    secret_hint = ""
    connected_at: str | None = None
    if ref is not None:
        tail = ref.secret_ref[-4:] if len(ref.secret_ref) >= 4 else ""
        secret_hint = f"…{tail}" if tail else ""
        connected_at = ref.connected_at.astimezone(UTC).isoformat()
    return {
        "provider": entry.provider,
        "description": entry.description,
        "scope": entry.scope,
        "class": entry.approval_class.value,
        "connected": ref is not None,
        "secretHint": secret_hint,
        "connectedAt": connected_at,
    }


def build_connectors_router(
    *,
    verifier: BearerVerifier,
    vault: ConnectorVaultRepository,
    catalog: ToolMatrix | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/connectors", tags=["connectors"])
    logger = get_logger()
    matrix = catalog or default_tool_matrix()
    by_provider = {entry.provider: entry for entry in matrix.connectors}

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

    def _catalog_entry(provider: str) -> ConnectorPermission:
        entry = by_provider.get(provider)
        if entry is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector provider not found")
        return entry

    @router.get("")
    async def list_connectors(identity: Principal = Depends(principal)) -> dict[str, object]:
        """The connectable catalog in reviewed order, each entry carrying this
        tenant's connection status (never the secret)."""

        _require_view(identity)
        refs = {ref.provider: ref for ref in await vault.list(identity.tenant_id)}
        return {
            "connectors": [
                _connector_dict(entry, refs.get(entry.provider))
                for entry in matrix.connectors
            ]
        }

    @router.post("/{provider}/connect")
    async def connect(
        request: ConnectorConnect,
        provider: str = Path(min_length=1, max_length=60, pattern=PROVIDER_PATTERN),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Connect (or rotate the credential of) one provider for the tenant."""

        _require_write(identity)
        entry = _catalog_entry(provider)
        ref = await vault.connect(
            ConnectorVaultRecord(
                tenant_id=identity.tenant_id,
                provider=entry.provider,
                secret_ref=request.secret,
            )
        )
        logger.info(
            "connector_connected",
            tenant_id=identity.tenant_id,
            provider=entry.provider,
        )
        return _connector_dict(entry, ref)

    @router.delete("/{provider}", status_code=status.HTTP_204_NO_CONTENT)
    async def disconnect(
        provider: str = Path(min_length=1, max_length=60, pattern=PROVIDER_PATTERN),
        identity: Principal = Depends(principal),
    ) -> None:
        """Disconnect one provider: the vault row is deleted, so the badge
        disappears from the steps it served."""

        _require_write(identity)
        entry = _catalog_entry(provider)
        try:
            await vault.disconnect(identity.tenant_id, entry.provider)
        except KeyError:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Connector is not connected"
            ) from None
        logger.info(
            "connector_disconnected",
            tenant_id=identity.tenant_id,
            provider=entry.provider,
        )

    return router
