from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import jwt
from jwt import PyJWKClient


class AuthenticationError(ValueError):
    pass


@dataclass(frozen=True)
class Principal:
    subject: str
    tenant_id: str
    roles: frozenset[str]


class BearerVerifier(Protocol):
    async def verify(self, token: str) -> Principal: ...


class FakeBearerVerifier:
    def __init__(self, tokens: dict[str, Principal]) -> None:
        self._tokens = tokens

    async def verify(self, token: str) -> Principal:
        principal = self._tokens.get(token)
        if principal is None:
            raise AuthenticationError("Invalid credentials")
        return principal


class SupabaseJWKSVerifier:
    """Validates Supabase Auth JWTs; authorization uses signed app_metadata only."""

    def __init__(self, *, jwks_url: str, issuer: str, audience: str) -> None:
        if not jwks_url or not issuer or not audience:
            raise ValueError("JWKS URL, issuer, and audience are required")
        self._jwks = PyJWKClient(jwks_url)
        self._issuer = issuer
        self._audience = audience

    async def verify(self, token: str) -> Principal:
        try:
            signing_key = self._jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256", "ES256"],
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "iat", "sub", "iss", "aud"]},
            )
            metadata = claims.get("app_metadata", {})
            if not isinstance(metadata, dict):
                raise AuthenticationError("Invalid credentials")
            tenant_id = metadata.get("tenant_id")
            roles = metadata.get("roles", [])
            if not isinstance(tenant_id, str) or not isinstance(roles, list):
                raise AuthenticationError("Invalid credentials")
            trusted_roles = frozenset(role for role in roles if isinstance(role, str))
            return Principal(str(claims["sub"]), tenant_id, trusted_roles)
        except (jwt.PyJWTError, ValueError) as error:
            raise AuthenticationError("Invalid credentials") from error
