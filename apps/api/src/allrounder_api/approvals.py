from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime


class ReceiptError(ValueError):
    pass


def action_hash(action: dict[str, object]) -> str:
    encoded = json.dumps(action, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class ApprovalReceiptClaims:
    receipt_id: str
    approval_id: str
    case_id: str
    action_hash: str
    approver: str
    scope: str
    decision: str
    expires_at: str


class ApprovalReceiptSigner:
    """HMAC-SHA256, exact-action-bound, single-use approval receipts."""

    def __init__(
        self,
        secret: bytes,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if len(secret) < 32:
            raise ValueError("APPROVAL_HMAC_SECRET must contain at least 32 bytes")
        self._secret = secret
        self._clock = clock or (lambda: datetime.now(UTC))

    def issue(
        self, *, approval_id: str, case_id: str, action: dict[str, object],
        approver: str, scope: str, decision: str, expires_at: datetime,
    ) -> str:
        if decision != "approved":
            raise ReceiptError("Only approved decisions can produce receipts")
        claims = ApprovalReceiptClaims(
            receipt_id=secrets.token_urlsafe(18),
            approval_id=approval_id,
            case_id=case_id,
            action_hash=action_hash(action),
            approver=approver,
            scope=scope,
            decision=decision,
            expires_at=expires_at.astimezone(UTC).isoformat(),
        )
        payload = json.dumps(asdict(claims), sort_keys=True, separators=(",", ":")).encode()
        signature = hmac.new(self._secret, payload, hashlib.sha256).digest()
        return f"{_encode(payload)}.{_encode(signature)}"

    def validate(
        self, token: str, *, approval_id: str, case_id: str,
        action: dict[str, object], scope: str, now: datetime | None = None,
    ) -> ApprovalReceiptClaims:
        try:
            encoded_payload, encoded_signature = token.split(".", 1)
            payload = _decode(encoded_payload)
            signature = _decode(encoded_signature)
            expected = hmac.new(self._secret, payload, hashlib.sha256).digest()
            if not hmac.compare_digest(signature, expected):
                raise ReceiptError("Invalid receipt")
            raw = json.loads(payload)
            claims = ApprovalReceiptClaims(**raw)
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            raise ReceiptError("Invalid receipt") from error
        checks = (
            hmac.compare_digest(claims.approval_id, approval_id),
            hmac.compare_digest(claims.case_id, case_id),
            hmac.compare_digest(claims.action_hash, action_hash(action)),
            hmac.compare_digest(claims.scope, scope),
            hmac.compare_digest(claims.decision, "approved"),
        )
        if not all(checks):
            raise ReceiptError("Invalid receipt")
        expires_at = datetime.fromisoformat(claims.expires_at)
        if expires_at <= (now or self._clock()):
            raise ReceiptError("Invalid receipt")
        return claims


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
