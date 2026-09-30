# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""Email intake: one inbound mail becomes one MSP or bills run.

The MSP and bills lanes' front door. A forwarder (or a smoke script) POSTs an
inbound email here; the route normalizes it into the exact input shape the
flow validates, derives the client or vendor reference and a deterministic
ticket key, and starts an ``msp`` or ``bills`` run — which parks on its first
checkpoint, because both flows treat every step as human-reviewed.

Determinism: the same delivery always normalizes to the same message id,
client/vendor ref, ticket key and case id, so a replay (or a retry after a
lost response) is claimed by the dedupe store instead of doubling the case.
The case row is written before the run starts, because the run's
``run_started`` case event hangs off it.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status

from .auth import AuthenticationError, BearerVerifier, Principal
from .idempotency import IdempotencyStore
from .logging import get_logger
from .repositories import CaseRecord, CaseRepository
from .runs import RunService, UnknownWorkflowError

_EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+$")
_WHITESPACE_PATTERN = re.compile(r"\s+")
_CLIENT_REF_PATTERN = re.compile(r"[^a-z0-9._-]+")
_VENDOR_SLUG_PATTERN = re.compile(r"[^a-z0-9]+")


def flatten(value: str) -> str:
    """Collapse untrusted text to one line before it enters prompts."""
    return _WHITESPACE_PATTERN.sub(" ", value).strip()


def derive_message_id(
    *, from_address: str, subject: str, received_at: str, text: str
) -> str:
    """Content digest fallback for a delivery without a message id."""
    digest = hashlib.sha256(
        f"{from_address}|{subject}|{received_at}|{text}".encode()
    ).hexdigest()
    return f"derived-{digest[:24]}"


def _pick(source: dict[str, Any], keys: tuple[str, ...]) -> object:
    for key in keys:
        value = source.get(key)
        if value is not None:
            return value
    return None


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _received_iso(value: object, *, now: datetime | None) -> str:
    raw = _text(value)
    if raw == "":
        moment = now or datetime.now(UTC)
        return (moment if moment.tzinfo else moment.replace(tzinfo=UTC)).isoformat()
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        try:
            moment = parsedate_to_datetime(raw)
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"inbound email has an invalid received date ({raw})"
            ) from error
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.isoformat()


def normalize_inbound_email(
    payload: object, *, now: datetime | None = None
) -> dict[str, str]:
    """Normalize one inbound-email payload into the flow's input shape.

    Accepts the camel, snake and Postmark-ish key spellings the forwarder,
    the mail seam's ``normalizeInboundEmail`` and the tests speak. A missing
    message id is derived from the content so a replayed delivery keeps the
    same id. Raises ``ValueError`` with a caller-safe reason for anything the
    flow's input schema would reject.
    """
    if not isinstance(payload, dict):
        raise ValueError("inbound email payload must be an object")
    from_address = _text(
        _pick(payload, ("from", "From", "from_email", "fromEmail", "sender"))
    )
    to_address = _text(_pick(payload, ("to", "To", "to_email", "toEmail", "recipient")))
    if _EMAIL_PATTERN.fullmatch(from_address) is None:
        raise ValueError(
            f"inbound email has no valid sender address ({from_address or 'empty'})"
        )
    if _EMAIL_PATTERN.fullmatch(to_address) is None:
        raise ValueError(
            f"inbound email has no valid recipient address ({to_address or 'empty'})"
        )
    if len(from_address) > 320 or len(to_address) > 320:
        raise ValueError("inbound email addresses exceed 320 characters")
    subject_raw = _text(_pick(payload, ("subject", "Subject", "title")))
    text_raw = _text(
        _pick(
            payload,
            ("text", "Text", "textBody", "TextBody", "text_body", "body", "Body"),
        )
    )
    if text_raw == "":
        raise ValueError("inbound email has no text body")
    if len(text_raw) > 20_000:
        raise ValueError("inbound email text exceeds 20000 characters")
    subject = flatten(subject_raw)[:500] if subject_raw else "(no subject)"
    received_at = _received_iso(
        _pick(payload, ("receivedAt", "received_at", "Date", "date", "timestamp")),
        now=now,
    )
    from_name = _text(_pick(payload, ("fromName", "from_name", "FromName")))
    message_id_raw = _text(
        _pick(payload, ("messageId", "message_id", "MessageID", "MessageId", "id"))
    )
    client_ref = _text(_pick(payload, ("clientRef", "client_ref")))
    normalized = {
        "messageId": message_id_raw[:300]
        if message_id_raw
        else derive_message_id(
            from_address=from_address,
            subject=subject,
            received_at=received_at,
            text=text_raw,
        ),
        "from": from_address,
        "to": to_address,
        "subject": subject,
        "text": text_raw,
        "receivedAt": received_at,
    }
    if from_name:
        normalized["fromName"] = flatten(from_name)[:200]
    if client_ref:
        normalized["clientRef"] = flatten(client_ref)[:80]
    return normalized


def client_ref_for(address: str) -> str:
    """Client slug for an ingest address; mirrors the mail seam's helper.

    The local part before any plus-suffix, lowercased, with anything outside
    ``[a-z0-9._-]`` collapsed to "-". Falls back to "client" so a generic
    forwarder address still yields a stable ref.
    """
    local = address.split("@", 1)[0]
    base = local.split("+", 1)[0].strip().lower()
    cleaned = _CLIENT_REF_PATTERN.sub("-", base).strip("-")
    return cleaned[:80] if cleaned else "client"


def vendor_ref_for(address: str) -> str:
    """Vendor slug for a sender address; mirrors the bills flow's helper.

    The sender domain's first label, lowercased, with anything outside
    ``[a-z0-9]`` collapsed to "-". Falls back to "vendor" so an odd address
    still yields a stable ref (the registry lookup fails closed either way).
    """
    domain = address.split("@", 1)[1] if "@" in address else ""
    label = domain.split(".", 1)[0].strip().lower()
    cleaned = _VENDOR_SLUG_PATTERN.sub("-", label).strip("-")
    return cleaned[:40] if cleaned else "vendor"


def clean_vendor_ref(value: str) -> str:
    """Normalize a caller-provided vendor ref the same way the flow derives one."""

    cleaned = _VENDOR_SLUG_PATTERN.sub("-", value.strip().lower()).strip("-")
    return cleaned[:40]


def _case_digits(message_id: str) -> str:
    # Six digits and never zero-padded: the run lane's Jira key pattern wants
    # a leading non-zero digit.
    digest = hashlib.sha256(message_id.encode()).hexdigest()
    return str(100_000 + int(digest[:12], 16) % 900_000)


def ticket_key_for(message_id: str) -> str:
    """Deterministic desk key for one delivery ("MSP-" plus six digits).

    Stable across replays, so a redelivery maps to the same case instead of
    minting a second ticket.
    """
    return f"MSP-{_case_digits(message_id)}"


def case_id_for(client_ref: str, message_id: str) -> str:
    """Case id shared by the run, the console and the desk comment."""
    return f"msp-{client_ref}-{_case_digits(message_id)}"


def bill_ticket_key_for(message_id: str) -> str:
    """Deterministic bill key for one delivery ("BILL-" plus six digits)."""

    return f"BILL-{_case_digits(message_id)}"


def bill_case_id_for(vendor_ref: str, message_id: str) -> str:
    """Case id shared by the bills run, the console and the posting receipt."""
    return f"bill-{vendor_ref}-{_case_digits(message_id)}"


def build_intake_router(
    *,
    verifier: BearerVerifier,
    service: RunService,
    dedupe: IdempotencyStore,
    dedupe_ttl_seconds: int,
    cases: CaseRepository,
) -> APIRouter:
    router = APIRouter(prefix="/intake")
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

    @router.post("/email", status_code=status.HTTP_201_CREATED)
    async def intake_email(
        payload: dict[str, Any],
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        require_role(identity, "agent", "admin")
        try:
            email = normalize_inbound_email(payload)
        except ValueError as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)
            ) from None
        client_ref = email.get("clientRef") or client_ref_for(email["to"])
        ticket_key = ticket_key_for(email["messageId"])
        case_id = case_id_for(client_ref, email["messageId"])
        if not dedupe.claim(f"msp-intake:{email['messageId']}", dedupe_ttl_seconds):
            return {"ticketKey": ticket_key, "caseId": case_id, "deduped": True}
        # The run's case events hang off the case row, so the ledger anchor is
        # written first. A replay whose dedupe claim expired lands on an
        # existing row and reattaches to the original case instead of failing.
        try:
            await cases.create(
                CaseRecord(
                    id=case_id,
                    tenant_id=identity.tenant_id,
                    ticket_key=ticket_key,
                    domain="msp",
                    status="open",
                )
            )
        except ValueError:
            logger.info("msp_case_replayed", case_id=case_id)
        except Exception:  # pragma: no cover - ledger failures never block intake
            logger.exception("msp_case_create_failed", case_id=case_id)
        # Always send the resolved ref, so the case id and the intake artifact
        # cannot drift apart. The tenant comes from the caller, never the body,
        # and scopes the knowledge lookup that grounds the reply draft.
        run_input: dict[str, object] = {
            **email,
            "clientRef": client_ref,
            "tenantId": identity.tenant_id,
        }
        try:
            run = await service.start(
                workflow="msp",
                ticket_key=ticket_key,
                case_id=case_id,
                run_input=run_input,
                principal=identity,
            )
        except UnknownWorkflowError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown workflow") from None
        return {
            "runId": run.run_id,
            "ticketKey": ticket_key,
            "caseId": case_id,
            "deduped": False,
        }

    @router.post("/vendor-email", status_code=status.HTTP_201_CREATED)
    async def intake_vendor_email(
        payload: dict[str, Any],
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """One inbound vendor email becomes one parked bills run.

        The vendor ref comes from the payload when the forwarder already
        knows it, otherwise it derives from the sender domain the same way the
        flow's intake step does. The tenant comes from the caller, never the
        body, and scopes the vendor registry lookup.
        """

        require_role(identity, "agent", "admin")
        try:
            email = normalize_inbound_email(payload)
        except ValueError as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)
            ) from None
        requested = _text(_pick(payload, ("vendorRef", "vendor_ref")))
        vendor_ref = clean_vendor_ref(requested) or vendor_ref_for(email["from"])
        ticket_key = bill_ticket_key_for(email["messageId"])
        case_id = bill_case_id_for(vendor_ref, email["messageId"])
        if not dedupe.claim(f"bills-intake:{email['messageId']}", dedupe_ttl_seconds):
            return {"ticketKey": ticket_key, "caseId": case_id, "deduped": True}
        # Same ordering as the MSP intake: the case row is the ledger anchor
        # the run's case events hang off, so it is written before the start.
        try:
            await cases.create(
                CaseRecord(
                    id=case_id,
                    tenant_id=identity.tenant_id,
                    ticket_key=ticket_key,
                    domain="bills",
                    status="open",
                )
            )
        except ValueError:
            logger.info("bills_case_replayed", case_id=case_id)
        except Exception:  # pragma: no cover - ledger failures never block intake
            logger.exception("bills_case_create_failed", case_id=case_id)
        run_input: dict[str, object] = {
            **email,
            "vendorRef": vendor_ref,
            "tenantId": identity.tenant_id,
        }
        try:
            run = await service.start(
                workflow="bills",
                ticket_key=ticket_key,
                case_id=case_id,
                run_input=run_input,
                principal=identity,
            )
        except UnknownWorkflowError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown workflow") from None
        return {
            "runId": run.run_id,
            "ticketKey": ticket_key,
            "caseId": case_id,
            "deduped": False,
        }

    return router


__all__ = [
    "bill_case_id_for",
    "bill_ticket_key_for",
    "build_intake_router",
    "case_id_for",
    "clean_vendor_ref",
    "client_ref_for",
    "derive_message_id",
    "flatten",
    "normalize_inbound_email",
    "ticket_key_for",
    "vendor_ref_for",
]
