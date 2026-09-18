# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

from __future__ import annotations

from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import AuthenticationError, BearerVerifier, Principal
from .logging import get_logger
from .repositories import GithubAccountRecord, GithubAccountRepository

_VIEW_ROLES = frozenset({"viewer", "agent", "approver", "admin"})
_WRITE_ROLES = frozenset({"agent", "admin"})
_GITHUB_API_BASE = "https://api.github.com"
_SEGMENT_PATTERN = r"^[A-Za-z0-9_.-]+$"
# Repository discovery is capped at five pages of one hundred — enough for a
# personal account without letting a single request fan out unbounded.
_API_PAGE_SIZE = 100
_API_MAX_PAGES = 5


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(item.title() for item in value.split("_")[1:]),
        populate_by_name=True,
    )


class GithubAccountCreate(ApiModel):
    """Settings payload: label + token, with an optional display username."""

    label: str = Field(min_length=1, max_length=60)
    username: str = Field(default="", max_length=100)
    token: str = Field(min_length=8, max_length=500)

    @field_validator("label", "username", "token")
    @classmethod
    def strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("label")
    @classmethod
    def label_required(cls, value: str) -> str:
        if not value:
            raise ValueError("Label is required")
        return value


def _account_dict(account: GithubAccountRecord) -> dict[str, object]:
    """List-shaped account: the token itself never leaves the server."""

    hint = account.token[-4:] if len(account.token) >= 4 else ""
    return {
        "id": account.id,
        "label": account.label,
        "username": account.username,
        "isDefault": account.is_default,
        "tokenHint": f"…{hint}" if hint else "",
    }


def _pull_request(item: object) -> dict[str, object] | None:
    """Map one GitHub pull-request payload onto the console picker shape."""
    if not isinstance(item, dict):
        return None
    number = item.get("number")
    if not isinstance(number, int):
        return None
    head = item.get("head")
    base = item.get("base")
    user = item.get("user")
    return {
        "number": number,
        "title": str(item.get("title", "")),
        "headRef": str(head.get("ref", "")) if isinstance(head, dict) else "",
        "baseRef": str(base.get("ref", "")) if isinstance(base, dict) else "",
        "author": str(user.get("login", "")) if isinstance(user, dict) else "",
        "draft": bool(item.get("draft", False)),
        "url": str(item.get("html_url", "")),
    }


def _github_headers(token: str) -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "allrounder-agent",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def build_github_router(
    *,
    verifier: BearerVerifier,
    repository_allowlist: list[str],
    accounts: GithubAccountRepository,
    token: str = "",
    client: httpx.AsyncClient | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/github", tags=["github"])
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

    async def resolve_token(identity: Principal, account_id: str | None) -> str:
        """Account token when ``accountId`` is given, else the environment token."""

        if account_id is None:
            resolved = token
        else:
            try:
                account = await accounts.get(account_id, identity.tenant_id)
            except KeyError:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "GitHub account not found"
                ) from None
            resolved = account.token
        if not resolved:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "GitHub token is not configured",
            )
        return resolved

    @router.get("/repositories")
    async def repositories(
        account_id: str | None = Query(
            default=None, alias="accountId", min_length=1, max_length=100
        ),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Repositories a run may target — every repository the resolved GitHub
        token can see (``accountId`` picks a registered account, otherwise the
        environment token is used), with the server allowlist kept as a floor.
        The console turns this into a picker."""

        _require_view(identity)
        resolved_token = await resolve_token(identity, account_id)
        api_client = client or httpx.AsyncClient(
            base_url=_GITHUB_API_BASE,
            timeout=httpx.Timeout(10.0),
        )
        discovered: list[str] = []
        try:
            for page in range(1, _API_MAX_PAGES + 1):
                response = await api_client.get(
                    "/user/repos",
                    params={
                        "per_page": _API_PAGE_SIZE,
                        "sort": "pushed",
                        "direction": "desc",
                        "page": page,
                    },
                    headers=_github_headers(resolved_token),
                )
                response.raise_for_status()
                payload = response.json()
                items = payload if isinstance(payload, list) else []
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    full_name = item.get("full_name")
                    if isinstance(full_name, str) and full_name:
                        discovered.append(full_name)
                if len(items) < _API_PAGE_SIZE:
                    break
        except (httpx.HTTPError, ValueError):
            logger.exception(
                "github_repository_fetch_failed",
                tenant_id=identity.tenant_id,
            )
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "GitHub repositories could not be loaded",
            ) from None
        finally:
            if client is None:
                await api_client.aclose()
        return {
            "repositories": list(dict.fromkeys([*discovered, *repository_allowlist]))
        }

    @router.get("/accounts")
    async def list_accounts(identity: Principal = Depends(principal)) -> dict[str, object]:
        """Accounts set up in Settings; responses carry a token hint only."""

        _require_view(identity)
        records = await accounts.list(identity.tenant_id)
        return {"accounts": [_account_dict(account) for account in records]}

    @router.post("/accounts", status_code=status.HTTP_201_CREATED)
    async def create_account(
        request: GithubAccountCreate,
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        _require_write(identity)
        try:
            account = await accounts.create(
                GithubAccountRecord(
                    id=str(uuid4()),
                    tenant_id=identity.tenant_id,
                    label=request.label,
                    username=request.username,
                    token=request.token,
                )
            )
        except ValueError:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "An account with this label already exists",
            ) from None
        logger.info(
            "github_account_created",
            tenant_id=identity.tenant_id,
            account_id=account.id,
            label=account.label,
        )
        return _account_dict(account)

    @router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_account(
        account_id: str = Path(min_length=1, max_length=100),
        identity: Principal = Depends(principal),
    ) -> None:
        _require_write(identity)
        try:
            await accounts.delete(account_id, identity.tenant_id)
        except KeyError:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "GitHub account not found"
            ) from None
        logger.info(
            "github_account_deleted",
            tenant_id=identity.tenant_id,
            account_id=account_id,
        )

    @router.post("/accounts/{account_id}/default")
    async def set_default_account(
        account_id: str = Path(min_length=1, max_length=100),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        _require_write(identity)
        try:
            account = await accounts.set_default(account_id, identity.tenant_id)
        except KeyError:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "GitHub account not found"
            ) from None
        return _account_dict(account)

    @router.get("/repositories/{owner}/{name}/pull-requests")
    async def pull_requests(
        owner: str = Path(min_length=1, max_length=100, pattern=_SEGMENT_PATTERN),
        name: str = Path(min_length=1, max_length=100, pattern=_SEGMENT_PATTERN),
        account_id: str | None = Query(
            default=None, alias="accountId", min_length=1, max_length=100
        ),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Open pull requests for one repository the token can access, newest first.

        ``accountId`` selects a registered GitHub identity; when omitted the
        environment token is used."""

        _require_view(identity)
        repository = f"{owner}/{name}"
        resolved_token = await resolve_token(identity, account_id)
        api_client = client or httpx.AsyncClient(
            base_url=_GITHUB_API_BASE,
            timeout=httpx.Timeout(10.0),
        )
        try:
            response = await api_client.get(
                f"/repos/{repository}/pulls",
                params={
                    "state": "open",
                    "sort": "updated",
                    "direction": "desc",
                    "per_page": 50,
                },
                headers=_github_headers(resolved_token),
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            logger.exception(
                "github_pull_request_fetch_failed",
                repository=repository,
                tenant_id=identity.tenant_id,
            )
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "GitHub pull requests could not be loaded",
            ) from None
        finally:
            if client is None:
                await api_client.aclose()
        items = payload if isinstance(payload, list) else []
        return {
            "repository": repository,
            "pullRequests": [
                mapped for item in items if (mapped := _pull_request(item)) is not None
            ],
        }

    return router
