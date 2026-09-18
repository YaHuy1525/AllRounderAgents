"""Resource ceilings: hard caps with a visible queue behind them.

Over-cap work is never dropped — it waits in FIFO order and reports its
position (``queued #2``). Slots are released on completion, failure, timeout,
or cancel, and the next queued item is promoted atomically.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from threading import Lock as ThreadLock
from typing import Protocol, cast

from redis import Redis

RUN_SLOT = "run"
APPLY_SLOT = "apply"

_ACQUIRE_SCRIPT = """
local slot_key = KEYS[1]
local queue_key = KEYS[2]
local limit = tonumber(ARGV[1])
local run_id = ARGV[2]
local now = tonumber(ARGV[3])
if redis.call('ZSCORE', slot_key, run_id) then
  return 0
end
if redis.call('ZCARD', slot_key) < limit then
  redis.call('ZADD', slot_key, now, run_id)
  redis.call('ZREM', queue_key, run_id)
  return 0
end
redis.call('ZADD', queue_key, now, run_id)
local rank = redis.call('ZRANK', queue_key, run_id)
return rank + 1
"""

_RELEASE_SCRIPT = """
local slot_key = KEYS[1]
local queue_key = KEYS[2]
local run_id = ARGV[1]
redis.call('ZREM', slot_key, run_id)
local removed = redis.call('ZREM', queue_key, run_id)
if removed == 1 then
  return ''
end
local next_items = redis.call('ZRANGE', queue_key, 0, 0)
if #next_items == 0 then
  return ''
end
local promoted = next_items[1]
redis.call('ZREM', queue_key, promoted)
redis.call('ZADD', slot_key, ARGV[2], promoted)
return promoted
"""


class ConcurrencyCeiling(Protocol):
    async def acquire(self, run_id: str, kind: str = RUN_SLOT) -> int | None:
        """None when a slot was granted; otherwise the 1-based queue position."""
        ...

    async def release(self, run_id: str, kind: str = RUN_SLOT) -> str | None:
        """Free the slot; returns the promoted run id, if any."""
        ...

    async def position(self, run_id: str, kind: str = RUN_SLOT) -> int | None: ...

    async def active_count(self, kind: str = RUN_SLOT) -> int: ...


class MemoryConcurrencyCeiling:
    def __init__(
        self,
        limits: dict[str, int],
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._limits = limits
        self._clock = clock or time.monotonic
        self._active: dict[str, list[str]] = {kind: [] for kind in limits}
        self._queued: dict[str, list[str]] = {kind: [] for kind in limits}
        self._lock = ThreadLock()

    def _kind(self, kind: str) -> int:
        return self._limits.get(kind, 1)

    async def acquire(self, run_id: str, kind: str = RUN_SLOT) -> int | None:
        with self._lock:
            active = self._active.setdefault(kind, [])
            queued = self._queued.setdefault(kind, [])
            if run_id in active:
                return None
            if len(active) < self._kind(kind):
                active.append(run_id)
                if run_id in queued:
                    queued.remove(run_id)
                return None
            if run_id not in queued:
                queued.append(run_id)
            return queued.index(run_id) + 1

    async def release(self, run_id: str, kind: str = RUN_SLOT) -> str | None:
        with self._lock:
            active = self._active.setdefault(kind, [])
            queued = self._queued.setdefault(kind, [])
            was_active = run_id in active
            if was_active:
                active.remove(run_id)
            if run_id in queued:
                queued.remove(run_id)
                return None
            if not was_active:
                return None
            if not queued or len(active) >= self._kind(kind):
                return None
            promoted = queued.pop(0)
            active.append(promoted)
            return promoted

    async def position(self, run_id: str, kind: str = RUN_SLOT) -> int | None:
        with self._lock:
            queued = self._queued.setdefault(kind, [])
            if run_id not in queued:
                return None
            return queued.index(run_id) + 1

    async def active_count(self, kind: str = RUN_SLOT) -> int:
        with self._lock:
            return len(self._active.setdefault(kind, []))


class RedisConcurrencyCeiling:
    """Multi-process safe via two Lua scripts (acquire / release+promote)."""

    def __init__(self, client: Redis, limits: dict[str, int]) -> None:
        self._client = client
        self._limits = limits
        self._acquire = client.register_script(_ACQUIRE_SCRIPT)
        self._release = client.register_script(_RELEASE_SCRIPT)

    def _slot_key(self, kind: str) -> str:
        return f"allrounder:runs:slots:{kind}"

    def _queue_key(self, kind: str) -> str:
        return f"allrounder:runs:queue:{kind}"

    async def acquire(self, run_id: str, kind: str = RUN_SLOT) -> int | None:
        result = self._acquire(
            keys=[self._slot_key(kind), self._queue_key(kind)],
            args=[self._limits.get(kind, 1), run_id, time.time()],
        )
        position = int(cast("int", result))
        return position if position > 0 else None

    async def release(self, run_id: str, kind: str = RUN_SLOT) -> str | None:
        promoted = self._release(
            keys=[self._slot_key(kind), self._queue_key(kind)],
            args=[run_id, time.time()],
        )
        text = promoted.decode() if isinstance(promoted, bytes) else str(promoted)
        return text or None

    async def position(self, run_id: str, kind: str = RUN_SLOT) -> int | None:
        rank = cast("int | None", self._client.zrank(self._queue_key(kind), run_id))
        return int(rank) + 1 if rank is not None else None

    async def active_count(self, kind: str = RUN_SLOT) -> int:
        return int(cast("int", self._client.zcard(self._slot_key(kind))))


__all__ = [
    "APPLY_SLOT",
    "RUN_SLOT",
    "ConcurrencyCeiling",
    "MemoryConcurrencyCeiling",
    "RedisConcurrencyCeiling",
]
