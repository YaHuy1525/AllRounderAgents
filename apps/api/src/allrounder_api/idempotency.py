from __future__ import annotations

import time
from collections.abc import Callable
from threading import Lock
from typing import Protocol

from redis import Redis


class IdempotencyStore(Protocol):
    def claim(self, key: str, ttl_seconds: int = 86_400) -> bool: ...


class MemoryIdempotencyStore:
    def __init__(self, clock: Callable[[], float] | None = None) -> None:
        self._expires: dict[str, float] = {}
        self._clock = clock or time.monotonic
        self._lock = Lock()

    def claim(self, key: str, ttl_seconds: int = 86_400) -> bool:
        with self._lock:
            now = self._clock()
            self._expires = {
                item: expiry for item, expiry in self._expires.items() if expiry > now
            }
            if key in self._expires:
                return False
            self._expires[key] = now + ttl_seconds
            return True


class RedisIdempotencyStore:
    def __init__(self, client: Redis) -> None:
        self._client = client

    def claim(self, key: str, ttl_seconds: int = 86_400) -> bool:
        return bool(self._client.set(f"allrounder:idempotency:{key}", "1", nx=True, ex=ttl_seconds))

