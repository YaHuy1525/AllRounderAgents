from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .logging import get_logger


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    webhook_secret: SecretStr = SecretStr("")
    max_webhook_bytes: int = Field(default=1_000_000, ge=1)
    dedupe_ttl_seconds: int = Field(default=86_400, ge=1)
    redis_url: str = "redis://localhost:6379/0"
    database_url: SecretStr = SecretStr("")
    supabase_service_role_key: SecretStr = SecretStr("")
    jira_base_url: str = "https://example.atlassian.net"
    jira_project_key: str = ""
    jira_email: str = ""
    jira_api_token: SecretStr = SecretStr("")
    # Jira backend selection: "mcp" routes comment/transition/search through the
    # Atlassian Rovo MCP server (org must enable API-token MCP access); "http"
    # keeps the legacy read/write REST transport. Board listing always uses
    # read-only REST GETs because Rovo has no agile-board tools.
    jira_transport: Literal["http", "mcp"] = "mcp"
    atlassian_mcp_url: str = "https://mcp.atlassian.com/v2/mcp"
    # Optional site UUID for the Atlassian cloudId argument; when empty the site
    # URL (jira_base_url) is sent, which the Rovo server resolves itself.
    jira_cloud_id: str = ""
    log_level: str = "INFO"
    approval_hmac_secret: SecretStr = SecretStr("")
    supabase_jwks_url: str = ""
    supabase_jwt_issuer: str = ""
    supabase_jwt_audience: str = "authenticated"
    cors_allow_origins: list[str] = []
    trusted_proxy_ips: list[str] = []
    rate_limit_per_minute: int = Field(default=120, ge=1, le=10_000)
    rate_limit_window_seconds: int = Field(default=60, ge=1, le=3_600)
    rate_limit_max_tracked_keys: int = Field(default=10_000, ge=100)
    model_base_url: str = "https://api.openai.com/v1"
    model_api_key: SecretStr = SecretStr("")
    model_name: str = ""
    embedding_model: str = ""
    # The current pgvector column is vector(1536). Changing this requires a migration.
    embedding_dimensions: int = Field(default=1536, ge=1536, le=1536)
    # Optional separate embeddings provider (OpenAI-compatible /embeddings),
    # e.g. the Cohere compatibility endpoint. Unset, the MODEL_* block above
    # serves embeddings too.
    embedding_base_url: str = ""
    embedding_api_key: SecretStr = SecretStr("")
    # Knowledge retrieval tuning: RRF smoothing (rrf_k), recall breadth per arm
    # before reranking (recall_k), the optional Cohere reranker model, and
    # optional per tenant overrides, e.g. {"tenant-a": {"recall_k": 50}}.
    retrieval_rrf_k: int = Field(default=60, ge=1, le=1_000)
    retrieval_recall_k: int = Field(default=30, ge=1, le=400)
    retrieval_rerank_model: str = "rerank-v3.5"
    retrieval_tenant_overrides: dict[str, dict[str, int]] = Field(default_factory=dict)
    # Service-to-service knowledge search (`POST /knowledge/search`) for the
    # Mastra host: one shared bearer token. Empty keeps the route unmounted
    # and MSP reply drafts escalate (empty retrieval) instead of grounding.
    knowledge_service_token: SecretStr = SecretStr("")
    github_repository_allowlist: list[str] = []
    github_base_branch: str = "main"
    github_path_allowlist: list[str] = ["src/**", "tests/**", "config/**", "docs/**"]
    github_path_denylist: list[str] = [".github/workflows/**", "infra/prod/**"]
    github_destructive_paths: list[str] = ["migrations/**", "infra/**"]
    github_max_patch_files: int = Field(default=10, ge=1, le=100)
    github_max_patch_bytes: int = Field(default=250_000, ge=1, le=5_000_000)
    github_request_timeout_seconds: float = Field(default=10.0, gt=0, le=60)
    github_token: SecretStr = SecretStr("")
    github_app_id: str = ""
    github_app_installation_id: str = ""
    github_app_private_key: SecretStr = SecretStr("")
    jira_tenant_project_allowlist: dict[str, list[str]] = Field(default_factory=dict)
    # Parallel-safe run infrastructure. Ceilings are hard caps; over-cap runs
    # queue with a visible position instead of being dropped.
    mastra_base_url: str = "http://localhost:4111"
    mastra_request_timeout_seconds: float = Field(default=60.0, gt=0, le=600)
    runs_max_concurrent: int = Field(default=5, ge=1, le=100)
    runs_max_concurrent_applies: int = Field(default=2, ge=1, le=20)
    runs_max_concurrent_model_calls: int = Field(default=4, ge=1, le=20)
    runs_lock_ttl_seconds: int = Field(default=900, ge=30, le=86_400)
    # Signed approval-token expiry (``RunServiceConfig.receipt_ttl_seconds``):
    # a receipt is a single-use human decision and must lapse.
    runs_approval_token_ttl_seconds: int = Field(default=3_600, ge=60, le=86_400)
    # Idempotency-record life for the Redis run receipt store: the record is
    # the effect-once guard and must outlive the run it protects, so its
    # default is the store's own 24 hours, not the token's one hour.
    runs_receipt_record_ttl_seconds: int = Field(default=86_400, ge=3_600, le=2_592_000)
    # Deprecated pre-split name of the token TTL. Kept as an alias so an
    # existing deployment keeps its exact current behavior; the validator
    # below maps it onto the token setting and warns. Never read elsewhere.
    runs_receipt_ttl_seconds: int | None = Field(default=None, ge=60, le=86_400)
    # Sweep budget for a running run measured from its last serving-plane
    # progress event (``heartbeat_at``), never from start time: a run
    # advancing through steps is not reaped for total elapsed time, and a
    # queued run waiting on a ceiling FIFO queue is exempt.
    runs_max_seconds: int = Field(default=1_800, ge=60, le=86_400)
    # The liveness sweep runs by default; ``0`` stays legal so an operator
    # can still disable it.
    runs_sweep_interval_seconds: int = Field(default=60, ge=0, le=86_400)
    runs_registry_ttl_seconds: int = Field(default=604_800, ge=3_600, le=2_592_000)
    runs_max_regenerations_per_step: int = Field(default=1, ge=0, le=10)
    # Optional override for the governance policy directory (risk.yaml +
    # tools.yaml). Empty means the loader walks up from the package, which
    # finds the repo-root `policy/` in dev and `/app/policy` in the container.
    policy_dir: str = ""
    # Judge-based eval harness (scripts/judge-eval.py). Eval-only credentials:
    # the judge never powers product lanes. Jev (System One typed decisions)
    # is the judge of record; the chat judge is the fallback implementation
    # and the failure explainer. Empty keys disable the relevant judge.
    judge_provider: Literal["jev", "chat"] = "jev"
    judge_model: str = "jev-latest"
    jev_api_key: SecretStr = SecretStr("")
    judge_chat_base_url: str = "https://openrouter.ai/api/v1"
    judge_chat_model: str = ""
    judge_chat_api_key: SecretStr = SecretStr("")
    judge_timeout_seconds: float = Field(default=60.0, gt=0, le=600)

    @model_validator(mode="after")
    def _check_run_time_relationships(self) -> "Settings":
        """Fail at startup on run-time settings that contradict each other.

        Three relationships, each computed against a reaper that now runs by
        default:

        * the deprecated ``RUNS_RECEIPT_TTL_SECONDS`` still means the token
          TTL (its historical meaning), so it is mapped onto
          ``runs_approval_token_ttl_seconds`` and a startup warning tells the
          operator about ``RUNS_RECEIPT_RECORD_TTL_SECONDS``;
        * ``runs_max_seconds`` may not be shorter than the in-flight Mastra
          pass timeout it can reap — a healthy pass inside its own timeout
          must never be reaped for being alive;
        * ``runs_sweep_interval_seconds`` may not exceed ``runs_max_seconds``,
          or a stalled run would keep its slots for several budgets before
          the first sweep looks at it (``0`` disables the sweep and stays
          legal).
        """
        if self.runs_receipt_ttl_seconds is not None:
            if "runs_approval_token_ttl_seconds" not in self.model_fields_set:
                self.runs_approval_token_ttl_seconds = self.runs_receipt_ttl_seconds
            get_logger().warning(
                "deprecated_setting",
                setting="RUNS_RECEIPT_TTL_SECONDS",
                detail=(
                    "RUNS_RECEIPT_TTL_SECONDS now only sets the approval-token TTL; "
                    "the idempotency-record life is RUNS_RECEIPT_RECORD_TTL_SECONDS"
                ),
            )
        if self.runs_max_seconds < self.mastra_request_timeout_seconds:
            raise ValueError(
                "RUNS_MAX_SECONDS must not be shorter than MASTRA_REQUEST_TIMEOUT_SECONDS: "
                "the sweeper would reap passes that are still inside their own timeout"
            )
        if self.runs_sweep_interval_seconds > self.runs_max_seconds:
            raise ValueError(
                "RUNS_SWEEP_INTERVAL_SECONDS must be <= RUNS_MAX_SECONDS "
                "(0 keeps the sweeper disabled)"
            )
        return self

