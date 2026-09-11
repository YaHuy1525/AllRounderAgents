from __future__ import annotations

from fastapi import FastAPI
from redis import Redis

from .app import create_app
from .approvals import ApprovalReceiptSigner
from .auth import SupabaseJWKSVerifier
from .coding_runs import PostgresCodingRunRepository
from .finance_runs import PostgresFinanceRunRepository
from .idempotency import RedisIdempotencyStore
from .jira import HttpJiraTransport, JiraTools
from .jira_mcp import McpJiraTransport
from .knowledge import OpenAICompatibleAdapter
from .metrics import MetricsRegistry
from .persistence import PostgresTicketQueue, PsycopgExecutor
from .rate_limit import RedisRateLimiter
from .repositories import (
    PostgresApprovalRepository,
    PostgresCaseRepository,
    PostgresFeedbackRepository,
    PostgresRepositories,
    PostgresSupportSendRepository,
)
from .settings import Settings


def assert_default_project_is_allowlisted(
    project_key: str,
    allowlist: dict[str, list[str]],
) -> None:
    allowed = {project for projects in allowlist.values() for project in projects}
    if project_key not in allowed:
        raise ValueError("JIRA_PROJECT_KEY must be listed in JIRA_TENANT_PROJECT_ALLOWLIST")


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
    if not settings.jira_project_key:
        raise ValueError("JIRA_PROJECT_KEY is required for production")
    if not settings.jira_tenant_project_allowlist:
        raise ValueError("JIRA_TENANT_PROJECT_ALLOWLIST is required for production")
    assert_default_project_is_allowlisted(
        settings.jira_project_key,
        settings.jira_tenant_project_allowlist,
    )
    if not database_url:
        raise ValueError("DATABASE_URL is required for production")
    if len(approval_secret.encode()) < 32:
        raise ValueError("APPROVAL_HMAC_SECRET must contain at least 32 bytes")

    redis_client = Redis.from_url(settings.redis_url)
    executor = PsycopgExecutor(database_url)
    repositories = PostgresRepositories(database_url)
    jira_transport: HttpJiraTransport | McpJiraTransport
    if settings.jira_transport == "mcp":
        # MCP-native writes/search against the Rovo server (JIRA_TRANSPORT=mcp,
        # the default); board listing stays on read-only REST GETs inside the
        # transport. Requires API-token MCP access enabled by the org admin.
        jira_transport = McpJiraTransport(
            settings.jira_base_url,
            settings.jira_email,
            jira_token,
            mcp_url=settings.atlassian_mcp_url,
            cloud_id=settings.jira_cloud_id,
        )
    else:
        jira_transport = HttpJiraTransport(
            settings.jira_base_url,
            settings.jira_email,
            jira_token,
        )
    model_key = settings.model_api_key.get_secret_value()
    chat_completer = None
    if settings.model_name and model_key:
        chat_completer = OpenAICompatibleAdapter(
            base_url=settings.model_base_url,
            api_key=model_key,
            embedding_model=settings.embedding_model or settings.model_name,
            dimensions=settings.embedding_dimensions,
            chat_model=settings.model_name,
        )
    app = create_app(
        settings=settings,
        dedupe=RedisIdempotencyStore(redis_client),
        queue=PostgresTicketQueue(executor),
        jira=JiraTools(
            jira_transport,
            RedisIdempotencyStore(redis_client),
        ),
        jira_reader=jira_transport,
        auth_verifier=SupabaseJWKSVerifier(
            jwks_url=settings.supabase_jwks_url,
            issuer=settings.supabase_jwt_issuer,
            audience=settings.supabase_jwt_audience,
        ),
        approval_repository=PostgresApprovalRepository(repositories),
        case_repository=PostgresCaseRepository(repositories),
        send_repository=PostgresSupportSendRepository(repositories),
        feedback_repository=PostgresFeedbackRepository(repositories),
        receipt_signer=ApprovalReceiptSigner(approval_secret.encode()),
        coding_runs=PostgresCodingRunRepository(repositories),
        finance_runs=PostgresFinanceRunRepository(repositories),
        chat_completer=chat_completer,
        metrics=MetricsRegistry(),
        rate_limiter=RedisRateLimiter(redis_client, settings.rate_limit_per_minute),
    )
    app.router.add_event_handler("startup", repositories.open)
    app.router.add_event_handler("shutdown", executor.close)
    app.router.add_event_handler("shutdown", repositories.close)
    app.router.add_event_handler("shutdown", jira_transport.close)
    app.router.add_event_handler("shutdown", redis_client.close)
    if chat_completer is not None:
        app.router.add_event_handler("shutdown", chat_completer.close)
    return app
