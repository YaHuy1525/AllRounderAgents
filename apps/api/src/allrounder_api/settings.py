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
    jira_email: str = ""
    jira_api_token: SecretStr = SecretStr("")
    log_level: str = "INFO"
    approval_hmac_secret: SecretStr = SecretStr("")
    supabase_jwks_url: str = ""
    supabase_jwt_issuer: str = ""
    supabase_jwt_audience: str = "authenticated"
    cors_allow_origins: list[str] = []
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

