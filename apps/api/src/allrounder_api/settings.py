from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    model_base_url: str = "https://api.openai.com/v1"
    model_api_key: SecretStr = SecretStr("")
    model_name: str = ""
    embedding_model: str = ""
    # The current pgvector column is vector(1536). Changing this requires a migration.
    embedding_dimensions: int = Field(default=1536, ge=1536, le=1536)
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
    runs_lock_ttl_seconds: int = Field(default=900, ge=30, le=86_400)
    runs_receipt_ttl_seconds: int = Field(default=3_600, ge=60, le=86_400)
    runs_max_seconds: int = Field(default=1_800, ge=60, le=86_400)
    runs_sweep_interval_seconds: int = Field(default=0, ge=0, le=86_400)
    runs_registry_ttl_seconds: int = Field(default=604_800, ge=3_600, le=2_592_000)
    runs_max_regenerations_per_step: int = Field(default=1, ge=0, le=10)
    # Optional override for the governance policy directory (risk.yaml +
    # tools.yaml). Empty means the loader walks up from the package, which
    # finds the repo-root `policy/` in dev and `/app/policy` in the container.
    policy_dir: str = ""

