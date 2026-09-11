from __future__ import annotations

from typing import Any

from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier
from allrounder_api.rate_limit import InMemoryRateLimiter, RedisRateLimiter
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient
from redis.exceptions import RedisError


class FakePipeline:
    def __init__(self, store: dict[str, int]) -> None:
        self._store = store
        self._operations: list[tuple[str, str, int]] = []

    def incr(self, key: str) -> None:
        self._operations.append(("incr", key, 1))

    def expire(self, key: str, ttl: int) -> None:
        self._operations.append(("expire", key, ttl))

    def execute(self) -> list[Any]:
        results: list[Any] = []
        for operation, key, value in self._operations:
            if operation == "incr":
                self._store[key] = self._store.get(key, 0) + value
                results.append(self._store[key])
            else:
                results.append(True)
        self._operations.clear()
        return results

    def __enter__(self) -> FakePipeline:
        return self

    def __exit__(self, *args: object) -> None:
        return None


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, int] = {}
        self.failing = False

    def pipeline(self) -> FakePipeline:
        if self.failing:
            raise RedisError("redis down")
        return FakePipeline(self.store)


def test_in_memory_limiter_enforces_limit_and_resets_after_the_window() -> None:
    now = {"seconds": 0.0}
    limiter = InMemoryRateLimiter(2, clock=lambda: now["seconds"])
    assert limiter.allow("ip")
    assert limiter.allow("ip")
    assert not limiter.allow("ip")
    now["seconds"] += 61
    assert limiter.allow("ip")


def test_redis_limiter_enforces_limit_and_resets_on_rollover() -> None:
    client = FakeRedis()
    now = {"seconds": 1000.0}
    limiter = RedisRateLimiter(client, 2, clock=lambda: now["seconds"])
    assert limiter.allow("ip")
    assert limiter.allow("ip")
    assert not limiter.allow("ip")
    now["seconds"] += 60
    assert limiter.allow("ip")


def test_redis_failure_falls_back_to_memory() -> None:
    client = FakeRedis()
    limiter = RedisRateLimiter(client, 2)
    assert limiter.allow("ip")  # counted in Redis (1 of 2)
    client.failing = True
    assert limiter.allow("ip")  # in-memory fallback (1 of 2)
    assert limiter.allow("ip")  # in-memory fallback (2 of 2)
    assert not limiter.allow("ip")  # fallback keeps enforcing during the outage


def test_app_returns_429_when_the_limiter_denies() -> None:
    client = TestClient(
        create_app(
            settings=Settings(webhook_secret="test"),
            auth_verifier=FakeBearerVerifier({}),
            rate_limiter=InMemoryRateLimiter(1),
        )
    )
    assert client.get("/health").status_code == 200
    denied = client.get("/health")
    assert denied.status_code == 429
    assert denied.json() == {"detail": "Too many requests"}
    assert denied.headers["retry-after"] == "60"
