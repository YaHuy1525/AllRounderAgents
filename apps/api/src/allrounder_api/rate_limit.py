"""Rate limiting for the serving plane.

One interface, two implementations: an in-process sliding window (default;
used by unit tests and single-process runs) and a Redis fixed window
(``INCR`` + ``EXPIRE``) for multi-replica deployments. The Redis limiter
falls back to its in-memory twin after a Redis error so a dead cache never
opens the floodgates, and logs the degradation once per process.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Protocol

from redis import Redis
from redis.exceptions import RedisError

from .logging import get_logger

WINDOW_SECONDS = 60
MAX_TRACKED_KEYS = 10_000


class RateLimiter(Protocol):
    window_seconds: int

    def allow(self, key: str) -> bool: ...


class InMemoryRateLimiter:
    """Sliding-window limiter; mirrors the original middleware semantics."""

    def __init__(
        self,
        limit_per_minute: int,
        *,
        window_seconds: int = WINDOW_SECONDS,
        max_tracked_keys: int = MAX_TRACKED_KEYS,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._limit = limit_per_minute
        self.window_seconds = window_seconds
        self._max_tracked_keys = max_tracked_keys
        self._clock = clock or time.monotonic
        self._windows: OrderedDict[str, list[float]] = OrderedDict()

    def allow(self, key: str) -> bool:
        now = self._clock()
        bucket = [
            seen
            for seen in self._windows.get(key, [])
            if now - seen < self.window_seconds
        ]
        if key in self._windows:
            self._windows.move_to_end(key)
        if len(bucket) >= self._limit:
            self._windows[key] = bucket
            return False
        bucket.append(now)
        self._windows[key] = bucket
        while len(self._windows) > self._max_tracked_keys:
            self._windows.popitem(last=False)
        return True


class RedisRateLimiter:
    """Fixed-window limiter sharing counters across replicas."""

    def __init__(
        self,
        client: Redis,
        limit_per_minute: int,
        *,
        window_seconds: int = WINDOW_SECONDS,
        max_tracked_keys: int = MAX_TRACKED_KEYS,
        fallback: RateLimiter | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._client = client
        self._limit = limit_per_minute
        self.window_seconds = window_seconds
        self._fallback = fallback or InMemoryRateLimiter(
            limit_per_minute,
            window_seconds=window_seconds,
            max_tracked_keys=max_tracked_keys,
            clock=clock,
        )
        self._clock = clock or time.time
        self._logged_degradation = False

    def allow(self, key: str) -> bool:
        window = int(self._clock()) // self.window_seconds
        window_key = f"allrounder:rate:{key}:{window}"
        try:
            with self._client.pipeline() as pipe:
                pipe.incr(window_key)
                pipe.expire(window_key, self.window_seconds + 1)
                count, _ = pipe.execute()
            return int(count) <= self._limit
        except RedisError as error:
            if not self._logged_degradation:
                self._logged_degradation = True
                get_logger().warning(
                    "rate_limit_redis_unavailable_using_memory_fallback",
                    error=str(error),
                )
            return self._fallback.allow(key)
