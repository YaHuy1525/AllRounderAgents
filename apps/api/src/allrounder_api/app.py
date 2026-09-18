from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import secrets
import time
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from .approvals import ApprovalReceiptSigner
from .auth import BearerVerifier, FakeBearerVerifier
from .board_chat import ChatCompleter
from .coding_runs import CodingRunRepository, InMemoryCodingRunRepository
from .context import RequestContext
from .dispatcher import DeterministicDispatcher, normalize_jira_payload
from .finance_runs import FinanceRunRepository, InMemoryFinanceRunRepository
from .idempotency import IdempotencyStore, MemoryIdempotencyStore
from .jira import FakeJiraTransport, JiraIssueReader, JiraTools
from .logging import configure_logging, get_logger
from .metrics import METRICS_CONTENT_TYPE, MetricsRegistry
from .queueing import MemoryQueue, TicketQueue
from .rate_limit import WINDOW_SECONDS, InMemoryRateLimiter, RateLimiter
from .repositories import (
    ApprovalRepository,
    CaseRepository,
    FeedbackRepository,
    GithubAccountRepository,
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
    InMemoryFeedbackRepository,
    InMemoryGithubAccountRepository,
    InMemorySupportSendRepository,
    SupportSendRepository,
)
from .runs import RunService, RunServiceConfig, build_memory_run_service
from .runs.api import build_runs_router
from .settings import Settings


def create_app(
    *,
    settings: Settings | None = None,
    dedupe: IdempotencyStore | None = None,
    queue: TicketQueue | None = None,
    jira: JiraTools | None = None,
    jira_reader: JiraIssueReader | None = None,
    dispatcher: DeterministicDispatcher | None = None,
    auth_verifier: BearerVerifier | None = None,
    approval_repository: ApprovalRepository | None = None,
    case_repository: CaseRepository | None = None,
    send_repository: SupportSendRepository | None = None,
    feedback_repository: FeedbackRepository | None = None,
    receipt_signer: ApprovalReceiptSigner | None = None,
    coding_runs: CodingRunRepository | None = None,
    finance_runs: FinanceRunRepository | None = None,
    chat_completer: ChatCompleter | None = None,
    metrics: MetricsRegistry | None = None,
    rate_limiter: RateLimiter | None = None,
    runs_service: RunService | None = None,
    github_client: httpx.AsyncClient | None = None,
    github_accounts: GithubAccountRepository | None = None,
) -> FastAPI:
    config = settings or Settings()
    configure_logging(config.log_level)
    logger = get_logger()
    dedupe_store = dedupe or MemoryIdempotencyStore()
    ticket_queue = queue or MemoryQueue()
    jira_tools = jira or JiraTools(FakeJiraTransport(), MemoryIdempotencyStore())
    board_reader = jira_reader or FakeJiraTransport()
    router = dispatcher or DeterministicDispatcher()
    app = FastAPI(title="AllRounderAgent API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_allow_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    limiter = rate_limiter or InMemoryRateLimiter(config.rate_limit_per_minute)

    @app.middleware("http")
    async def security_boundary(request: Request, call_next: Any) -> Any:
        started = time.perf_counter()
        key = _rate_limit_key(request, config.trusted_proxy_ips)
        if not limiter.allow(key):
            response = JSONResponse({"detail": "Too many requests"}, status_code=429)
            response.headers["Retry-After"] = str(WINDOW_SECONDS)
        else:
            response = await call_next(request)
        if metrics is not None:
            route = request.scope.get("route")
            route_path = getattr(route, "path", None)
            metrics.record_request(
                request.method,
                route_path if isinstance(route_path, str) else "unmatched",
                response.status_code,
                time.perf_counter() - started,
            )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Strict-Transport-Security"] = (
            "max-age=63072000; includeSubDomains"
        )
        return response

    from .chat_api import build_chat_router
    from .github_api import build_github_router
    from .jira_board_api import build_jira_board_router
    from .phase1_api import build_phase1_router
    from .phase2_api import build_phase2_router
    from .phase3_api import build_phase3_router

    verifier = auth_verifier or FakeBearerVerifier({})
    approvals = approval_repository or InMemoryApprovalRepository()
    cases = case_repository or InMemoryCaseRepository()
    sends = send_repository or InMemorySupportSendRepository()
    feedback = feedback_repository or InMemoryFeedbackRepository()
    signer = receipt_signer or _receipt_signer(config, secrets.token_bytes(32))

    app.include_router(
        build_phase1_router(
            verifier=verifier,
            approvals=approvals,
            cases=cases,
            sends=sends,
            signer=signer,
            metrics=metrics,
        )
    )
    app.include_router(
        build_phase2_router(
            verifier=verifier,
            runs=coding_runs or InMemoryCodingRunRepository(),
            repository_allowlist=config.github_repository_allowlist,
            base_branch=config.github_base_branch,
        )
    )
    app.include_router(
        build_phase3_router(
            verifier=verifier,
            runs=finance_runs or InMemoryFinanceRunRepository(),
            approvals=approvals,
            sends=sends,
            signer=signer,
        )
    )
    app.include_router(
        build_jira_board_router(
            verifier=verifier,
            reader=board_reader,
            default_project=config.jira_project_key,
            tenant_project_allowlist=config.jira_tenant_project_allowlist,
            jira_site=config.jira_base_url,
        )
    )
    app.include_router(
        build_github_router(
            verifier=verifier,
            repository_allowlist=config.github_repository_allowlist,
            accounts=github_accounts or InMemoryGithubAccountRepository(),
            token=config.github_token.get_secret_value(),
            client=github_client,
        )
    )
    app.include_router(
        build_chat_router(
            verifier=verifier,
            completer=chat_completer,
            feedback=feedback,
            metrics=metrics,
        )
    )
    run_service = runs_service or build_memory_run_service(
        signer=signer,
        approvals=approvals,
        cases=cases,
        mastra_base_url=config.mastra_base_url,
        mastra_timeout_seconds=config.mastra_request_timeout_seconds,
        max_concurrent=config.runs_max_concurrent,
        max_concurrent_applies=config.runs_max_concurrent_applies,
        config=RunServiceConfig(
            lock_ttl_seconds=config.runs_lock_ttl_seconds,
            receipt_ttl_seconds=config.runs_receipt_ttl_seconds,
            max_run_seconds=config.runs_max_seconds,
            max_regenerations_per_step=config.runs_max_regenerations_per_step,
        ),
        metrics=metrics,
    )
    app.include_router(build_runs_router(verifier=verifier, service=run_service))
    if config.runs_sweep_interval_seconds > 0:
        _schedule_run_sweeper(app, run_service, config.runs_sweep_interval_seconds)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/metrics")
    def metrics_exposition() -> Response:
        content = metrics.render() if metrics is not None else b""
        return Response(content, media_type=METRICS_CONTENT_TYPE)

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
        _verify_signature(body, _webhook_signature_header(request), config)
        payload = _decode_payload(body)
        try:
            ticket = normalize_jira_payload(payload)
        except (ValidationError, ValueError, KeyError) as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid Jira payload"
            ) from error
        context = RequestContext.for_webhook(ticket.event_id)
        if not dedupe_store.claim(ticket.event_id, config.dedupe_ttl_seconds):
            if metrics is not None:
                metrics.record_webhook(deduped=True)
            logger.info(
                "jira_webhook_deduped",
                request_id=context.request_id,
                correlation_id=context.correlation_id,
                ticket_key=ticket.key,
            )
            return {"ticketKey": ticket.key, "deduped": True}

        if metrics is not None:
            metrics.record_webhook(deduped=False)
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


def _schedule_run_sweeper(app: FastAPI, service: RunService, interval_seconds: int) -> None:
    """Background sweeper: time out over-budget passes, unblock stale locks."""

    async def sweep_loop() -> None:
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                await service.sweep_expired()
            except Exception:  # pragma: no cover - defensive background loop
                get_logger().exception("run_sweeper_failed")

    async def start_sweeper() -> None:  # pragma: no cover - lifecycle hook
        app.state.run_sweeper = asyncio.create_task(sweep_loop())

    async def stop_sweeper() -> None:  # pragma: no cover - lifecycle hook
        sweeper = getattr(app.state, "run_sweeper", None)
        if sweeper is not None:
            sweeper.cancel()

    app.router.add_event_handler("startup", start_sweeper)
    app.router.add_event_handler("shutdown", stop_sweeper)


def _webhook_signature_header(request: Request) -> str | None:
    jira_header = request.headers.get("x-hub-signature")
    legacy_header = request.headers.get("x-hub-signature-256")
    if jira_header and legacy_header and jira_header != legacy_header:
        return None
    return jira_header or legacy_header


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


def _rate_limit_key(request: Request, trusted_proxy_ips: list[str]) -> str:
    peer = request.client.host if request.client else "unknown"
    if peer not in trusted_proxy_ips:
        return peer
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    try:
        return str(ipaddress.ip_address(forwarded))
    except ValueError:
        return peer

