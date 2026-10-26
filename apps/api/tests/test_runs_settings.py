"""Fix-wave items 1 and 3: two run lifetimes, and a sweep that runs by default.

The single ``RUNS_RECEIPT_TTL_SECONDS`` used to feed two unrelated consumers:
the signed approval-token expiry (``RunServiceConfig.receipt_ttl_seconds``) and
the Redis idempotency record's life (``RedisRunReceiptStore``), so production
minted effect-once records that expired with the one-hour token. These tests
pin the split: each lifetime has its own default, the deprecated alias moves
only the token (and says so in the log), the explicit token setting wins over
the alias, and the Redis composition receives the record TTL.

Item 3 sits in the same validator, so it is pinned here too: the liveness
sweep now defaults to 60 seconds, ``0`` stays legal (disabled), and the two
startup relationships (pass timeout versus run budget, sweep interval versus
run budget) fail at import of settings rather than in production.

Every construction uses ``Settings(_env_file=None)`` so a developer's local
``.env`` cannot leak in, and the autouse fixture clears the ambient
environment for exactly the variables these tests pin.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

import pytest
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.production import create_production_app
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import RunServiceConfig, build_redis_run_service
from allrounder_api.runs.receipts import RedisRunReceiptStore
from allrounder_api.settings import Settings
from pydantic import ValidationError
from structlog.testing import capture_logs

SECRET = b"settings-receipt-secret-for-tests-0123456789"

# The variables this file's tests pin; anything else ambient stays irrelevant
# because none of these fields derive from it.
_ENV_KEYS = (
    "RUNS_APPROVAL_TOKEN_TTL_SECONDS",
    "RUNS_RECEIPT_RECORD_TTL_SECONDS",
    "RUNS_RECEIPT_TTL_SECONDS",
    "RUNS_SWEEP_INTERVAL_SECONDS",
    "RUNS_MAX_SECONDS",
    "MASTRA_REQUEST_TIMEOUT_SECONDS",
)


@pytest.fixture(autouse=True)
def _clear_run_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    """Build settings from a clean environment plus exactly these variables."""
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Settings(_env_file=None)


class ConstructionOnlyRedis:
    """Stand-in client for a composition that never touches the network.

    ``build_redis_run_service`` only hands the client to the Redis adapters,
    and their constructors call exactly one command-family method,
    ``register_script``. Nothing in this test executes a command, so the stub
    stops there and fails loudly if the factory ever starts talking live.
    """

    def register_script(self, script: str) -> Callable[..., object]:
        def runner(*, keys: list[str], args: list[Any]) -> object:
            raise AssertionError("the construction-only client runs no commands")

        return runner


# ------------------------------------------------------- 1. the two lifetimes


def test_each_lifetime_has_its_own_default(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(monkeypatch)
    assert settings.runs_approval_token_ttl_seconds == 3_600
    assert settings.runs_receipt_record_ttl_seconds == 86_400
    # The deprecated alias has no value of its own any more: it only exists to
    # catch a deployment that still sets the old name.
    assert settings.runs_receipt_ttl_seconds is None
    assert settings.runs_sweep_interval_seconds == 60


def test_the_deprecated_alias_moves_only_the_token_lifetime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, RUNS_RECEIPT_TTL_SECONDS="7200")
    assert settings.runs_approval_token_ttl_seconds == 7200
    # The record keeps its own 24 hours: an old deployment that only set the
    # historical name gets exactly the behavior it had, no shorter records.
    assert settings.runs_receipt_record_ttl_seconds == 86_400


def test_the_deprecated_alias_is_announced_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Nothing to announce while the old name stays unset.
    with capture_logs() as quiet:
        _settings(monkeypatch)
    assert [entry["event"] for entry in quiet] == []

    with capture_logs() as logs:
        _settings(monkeypatch, RUNS_RECEIPT_TTL_SECONDS="7200")
    events = [entry for entry in logs if entry["event"] == "deprecated_setting"]
    assert len(events) == 1
    assert events[0]["log_level"] == "warning"
    assert events[0]["setting"] == "RUNS_RECEIPT_TTL_SECONDS"
    assert "RUNS_RECEIPT_RECORD_TTL_SECONDS" in str(events[0]["detail"])


def test_an_explicit_token_ttl_wins_over_the_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(
        monkeypatch,
        RUNS_RECEIPT_TTL_SECONDS="7200",
        RUNS_APPROVAL_TOKEN_TTL_SECONDS="600",
    )
    assert settings.runs_approval_token_ttl_seconds == 600
    assert settings.runs_receipt_record_ttl_seconds == 86_400


def test_the_record_lifetime_set_on_its_own(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(monkeypatch, RUNS_RECEIPT_RECORD_TTL_SECONDS="172800")
    assert settings.runs_receipt_record_ttl_seconds == 172_800
    assert settings.runs_approval_token_ttl_seconds == 3_600


# --------------------------------------------------- 2. the composition wiring


def test_the_redis_composition_receives_the_record_ttl_not_the_token() -> None:
    """The factory path production uses, driven with the settings defaults.

    Stubbed: the Redis client (``ConstructionOnlyRedis``, because no server
    runs in the dev set) and the approval repository, both only held by the
    adapters. The assertion reads the attribute the store actually sets its
    expiry from, so a wiring mistake (passing the token TTL here) fails.
    """
    settings = Settings(_env_file=None)
    service = build_redis_run_service(
        client=ConstructionOnlyRedis(),  # type: ignore[arg-type] - construction only
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        config=RunServiceConfig(receipt_ttl_seconds=settings.runs_approval_token_ttl_seconds),
        receipt_ttl_seconds=settings.runs_receipt_record_ttl_seconds,
    )
    store = service._receipts
    assert isinstance(store, RedisRunReceiptStore)
    assert store._ttl == 86_400
    assert service._config.receipt_ttl_seconds == 3_600


def test_the_alias_still_cannot_shorten_the_record(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(monkeypatch, RUNS_RECEIPT_TTL_SECONDS="7200")
    service = build_redis_run_service(
        client=ConstructionOnlyRedis(),  # type: ignore[arg-type] - construction only
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        config=RunServiceConfig(receipt_ttl_seconds=settings.runs_approval_token_ttl_seconds),
        receipt_ttl_seconds=settings.runs_receipt_record_ttl_seconds,
    )
    assert service._config.receipt_ttl_seconds == 7200  # the token moved
    assert service._receipts._ttl == 86_400  # type: ignore[attr-defined]


def test_production_wires_each_lifetime_to_its_own_consumer() -> None:
    """Source-level pin of the two call sites (no production app here: it
    demands a database, Jira credentials and a live Redis)."""
    source = inspect.getsource(create_production_app)
    assert "receipt_ttl_seconds=settings.runs_approval_token_ttl_seconds" in source
    assert "receipt_ttl_seconds=settings.runs_receipt_record_ttl_seconds" in source
    assert "settings.runs_receipt_ttl_seconds" not in source


# ------------------------------------------------------------ 3. the sweep


def test_the_sweep_runs_by_default_and_zero_stays_legal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert _settings(monkeypatch).runs_sweep_interval_seconds == 60
    disabled = _settings(monkeypatch, RUNS_SWEEP_INTERVAL_SECONDS="0")
    assert disabled.runs_sweep_interval_seconds == 0


def test_the_validator_rejects_a_budget_below_the_pass_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValidationError, match="MASTRA_REQUEST_TIMEOUT_SECONDS"):
        _settings(monkeypatch, MASTRA_REQUEST_TIMEOUT_SECONDS="600", RUNS_MAX_SECONDS="120")


def test_the_validator_rejects_a_sweep_longer_than_the_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValidationError, match="RUNS_SWEEP_INTERVAL_SECONDS"):
        _settings(monkeypatch, RUNS_SWEEP_INTERVAL_SECONDS="3600")
