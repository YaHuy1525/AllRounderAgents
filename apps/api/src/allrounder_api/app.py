from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
import time
from collections import OrderedDict
from typing import Any

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .approvals import ApprovalReceiptSigner
from .auth import BearerVerifier, FakeBearerVerifier
from .coding_runs import CodingRunRepository, InMemoryCodingRunRepository
from .context import RequestContext
from .dispatcher import DeterministicDispatcher, normalize_jira_payload
from .idempotency import IdempotencyStore, MemoryIdempotencyStore
from .jira import FakeJiraTransport, JiraTools
from .logging import configure_logging, get_logger
from .queueing import MemoryQueue, TicketQueue
from .repositories import (
    ApprovalRepository,
    CaseRepository,
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
    InMemorySupportSendRepository,
    SupportSendRepository,
)
from .settings import Settings


def create_app(
    *,
    settings: Settings | None = None,
    dedupe: IdempotencyStore | None = None,
    queue: TicketQueue | None = None,
    jira: JiraTools | None = None,
    dispatcher: DeterministicDispatcher | None = None,
    auth_verifier: BearerVerifier | None = None,
    approval_repository: ApprovalRepository | None = None,
    case_repository: CaseRepository | None = None,
    send_repository: SupportSendRepository | None = None,
    receipt_signer: ApprovalReceiptSigner | None = None,
    coding_runs: CodingRunRepository | None = None,
) -> FastAPI:
    config = settings or Settings()
    configure_logging(config.log_level)
    logger = get_logger()
    dedupe_store = dedupe or MemoryIdempotencyStore()
    ticket_queue = queue or MemoryQueue()
    jira_tools = jira or JiraTools(FakeJiraTransport(), MemoryIdempotencyStore())
    router = dispatcher or DeterministicDispatcher()
    app = FastAPI(title="AllRounderAgent API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_allow_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    windows: OrderedDict[str, list[float]] = OrderedDict()

    @app.middleware("http")
    async def security_boundary(request: Request, call_next: Any) -> Any:
        now = time.monotonic()
        key = request.client.host if request.client else "unknown"
        bucket = [seen for seen in windows.get(key, []) if now - seen < 60]
        if key in windows:
            windows.move_to_end(key)
        if len(bucket) >= config.rate_limit_per_minute:
            response = JSONResponse({"detail": "Too many requests"}, status_code=429)
        else:
            bucket.append(now)
            windows[key] = bucket
            while len(windows) > 10_000:
                windows.popitem(last=False)
            response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Strict-Transport-Security"] = (
            "max-age=63072000; includeSubDomains"
        )
        return response

    from .phase1_api import build_phase1_router

    app.include_router(
        build_phase1_router(
            verifier=auth_verifier or FakeBearerVerifier({}),
            approvals=approval_repository or InMemoryApprovalRepository(),
            cases=case_repository or InMemoryCaseRepository(),
            sends=send_repository or InMemorySupportSendRepository(),
            signer=receipt_signer or _receipt_signer(config, secrets.token_bytes(32)),
        )
    )

    from .phase2_api import build_phase2_router

    app.include_router(
        build_phase2_router(
            verifier=auth_verifier or FakeBearerVerifier({}),
            runs=coding_runs or InMemoryCodingRunRepository(),
            repository_allowlist=config.github_repository_allowlist,
            base_branch=config.github_base_branch,
        )
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/webhooks/jira")
    async def jira_webhook(request: Request) -> dict[str, str | bool]:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError as error:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, "Invalid Content-Length header"
                ) from error
            if declared_length > config.max_webhook_bytes:
                raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Webhook payload too large")
        body = await request.body()
        if len(body) > config.max_webhook_bytes:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Webhook payload too large")
        _verify_signature(body, request.headers.get("x-hub-signature-256"), config)
        payload = _decode_payload(body)
        try:
            ticket = normalize_jira_payload(payload)
        except (ValidationError, ValueError, KeyError) as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid Jira payload"
            ) from error
        context = RequestContext.for_webhook(ticket.event_id)
        if not dedupe_store.claim(ticket.event_id, config.dedupe_ttl_seconds):
            logger.info(
                "jira_webhook_deduped",
                request_id=context.request_id,
                correlation_id=context.correlation_id,
                ticket_key=ticket.key,
            )
            return {"ticketKey": ticket.key, "deduped": True}

        routed = router.dispatch(ticket)
        try:
            await asyncio.to_thread(ticket_queue.enqueue, routed)
        except Exception as error:
            await asyncio.to_thread(
                ticket_queue.dead_letter,
                ticket,
                "enqueue_failed",
                error,
            )
            logger.exception(
                "jira_webhook_delivery_failed",
                request_id=context.request_id,
                correlation_id=context.correlation_id,
                ticket_key=ticket.key,
            )
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "Ticket retained in dead-letter queue"
            ) from error
        comment = _routing_comment(routed.verdict.domain.value, routed.verdict.rationale)
        try:
            await asyncio.to_thread(
                jira_tools.comment,
                context,
                ticket.key,
                comment,
                idempotency_key=f"{ticket.event_id}:routed-comment",
            )
        except Exception:
            logger.exception(
                "jira_routing_comment_failed",
                request_id=context.request_id,
                correlation_id=context.correlation_id,
                ticket_key=ticket.key,
            )
        logger.info(
            "jira_webhook_accepted",
            request_id=context.request_id,
            correlation_id=context.correlation_id,
            ticket_key=ticket.key,
            domain=routed.verdict.domain.value,
            gate=routed.gate.value,
        )
        return {"ticketKey": ticket.key, "deduped": False}

    return app


def _verify_signature(body: bytes, supplied: str | None, settings: Settings) -> None:
    secret = settings.webhook_secret.get_secret_value()
    if not secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Webhook verification is not configured"
        )
    expected = "sha256=" + hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    if supplied is None or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid webhook signature")


def _decode_payload(body: bytes) -> dict[str, Any]:
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Malformed JSON") from error
    if not isinstance(value, dict):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Expected JSON object")
    return value


def _routing_comment(domain: str, rationale: str) -> str:
    if domain == "unknown":
        return f"Escalated to a human because the ticket could not be routed safely. {rationale}"
    return (
        f"Routed to the {domain} comment-only workflow. "
        f"No external action was performed. {rationale}"
    )


def _receipt_signer(settings: Settings, fallback: bytes) -> ApprovalReceiptSigner:
    configured = settings.approval_hmac_secret.get_secret_value().encode()
    if len(configured) >= 32:
        return ApprovalReceiptSigner(configured)
    get_logger().warning(
        "ephemeral_approval_signer",
        detail="APPROVAL_HMAC_SECRET is missing; receipts will not survive restart",
    )
    return ApprovalReceiptSigner(fallback)

