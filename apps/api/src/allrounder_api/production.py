from __future__ import annotations

from fastapi import FastAPI
from redis import Redis

from .app import create_app
from .approvals import ApprovalReceiptSigner
from .auth import SupabaseJWKSVerifier
from .coding_runs import PostgresCodingRunRepository
from .idempotency import RedisIdempotencyStore
from .jira import HttpJiraTransport, JiraTools
from .persistence import PostgresTicketQueue, PsycopgExecutor
from .repositories import (
    PostgresApprovalRepository,
    PostgresCaseRepository,
    PostgresRepositories,
    PostgresSupportSendRepository,
)
from .settings import Settings


def create_production_app() -> FastAPI:
    """Compose Phase 0 with real server-only adapters from environment settings."""

    settings = Settings()
    database_url = settings.database_url.get_secret_value()
    jira_token = settings.jira_api_token.get_secret_value()
    approval_secret = settings.approval_hmac_secret.get_secret_value()
    if not settings.webhook_secret.get_secret_value():
        raise ValueError("WEBHOOK_SECRET is required for production")
    if not jira_token:
        raise ValueError("JIRA_API_TOKEN is required for production")
    if not database_url:
        raise ValueError("DATABASE_URL is required for production")
    if len(approval_secret.encode()) < 32:
        raise ValueError("APPROVAL_HMAC_SECRET must contain at least 32 bytes")

    redis_client = Redis.from_url(settings.redis_url)
    executor = PsycopgExecutor(database_url)
    repositories = PostgresRepositories(database_url)
    jira_transport = HttpJiraTransport(
        settings.jira_base_url,
        settings.jira_email,
        jira_token,
    )
    app = create_app(
        settings=settings,
        dedupe=RedisIdempotencyStore(redis_client),
        queue=PostgresTicketQueue(executor),
        jira=JiraTools(
            jira_transport,
            RedisIdempotencyStore(redis_client),
        ),
        auth_verifier=SupabaseJWKSVerifier(
            jwks_url=settings.supabase_jwks_url,
            issuer=settings.supabase_jwt_issuer,
            audience=settings.supabase_jwt_audience,
        ),
        approval_repository=PostgresApprovalRepository(repositories),
        case_repository=PostgresCaseRepository(repositories),
        send_repository=PostgresSupportSendRepository(repositories),
        receipt_signer=ApprovalReceiptSigner(approval_secret.encode()),
        coding_runs=PostgresCodingRunRepository(repositories),
    )
    app.router.add_event_handler("startup", repositories.open)
    app.router.add_event_handler("shutdown", executor.close)
    app.router.add_event_handler("shutdown", repositories.close)
    app.router.add_event_handler("shutdown", jira_transport.close)
    app.router.add_event_handler("shutdown", redis_client.close)
    return app
