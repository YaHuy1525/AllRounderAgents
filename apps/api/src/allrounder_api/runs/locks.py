"""Target locks: one owner run per shared target (manifest, PR, tax id).

A conflicting run pauses with a "locked by run X" banner instead of racing;
the lock carries a TTL and is released when the owner finishes, cancels, or
expires.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock as ThreadLock
from typing import Protocol, cast

from redis import Redis

_COMPARE_DELETE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""

_COMPARE_EXPIRE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""


@dataclass(frozen=True)
class LockInfo:
    target: str
    owner_run_id: str


class TargetLockStore(Protocol):
    async def acquire(self, target: str, run_id: str, ttl_seconds: int) -> LockInfo | None:
        """Grant the lock to ``run_id``; returns None when another run owns it."""
        ...

    async def inspect(self, target: str) -> LockInfo | None: ...

    async def release(self, target: str, run_id: str) -> None: ...

    async def refresh(self, target: str, run_id: str, ttl_seconds: int) -> bool: ...


class MemoryTargetLockStore:
    def __init__(self, clock: Callable[[], float] | None = None) -> None:
        self._clock = clock or time.monotonic
        self._locks: dict[str, tuple[str, float]] = {}
        self._lock = ThreadLock()

    def _live(self, target: str) -> tuple[str, float] | None:
        entry = self._locks.get(target)
        if entry is None:
            return None
        if entry[1] <= self._clock():
            del self._locks[target]
            return None
        return entry

    async def acquire(self, target: str, run_id: str, ttl_seconds: int) -> LockInfo | None:
        with self._lock:
            entry = self._live(target)
            if entry is not None and entry[0] != run_id:
                return None
            self._locks[target] = (run_id, self._clock() + ttl_seconds)
            return LockInfo(target=target, owner_run_id=run_id)

    async def inspect(self, target: str) -> LockInfo | None:
        with self._lock:
            entry = self._live(target)
            return None if entry is None else LockInfo(target=target, owner_run_id=entry[0])

    async def release(self, target: str, run_id: str) -> None:
        with self._lock:
            entry = self._live(target)
            if entry is not None and entry[0] == run_id:
                del self._locks[target]

    async def refresh(self, target: str, run_id: str, ttl_seconds: int) -> bool:
        with self._lock:
            entry = self._live(target)
            if entry is None or entry[0] != run_id:
                return False
            self._locks[target] = (run_id, self._clock() + ttl_seconds)
            return True


class RedisTargetLockStore:
    """``SET NX EX`` acquire; Lua compare-and-delete/expire for ownership."""

    def __init__(self, client: Redis) -> None:
        self._client = client
        self._compare_delete = client.register_script(_COMPARE_DELETE)
        self._compare_expire = client.register_script(_COMPARE_EXPIRE)

    def _key(self, target: str) -> str:
        return f"allrounder:runs:lock:{target}"

    async def acquire(self, target: str, run_id: str, ttl_seconds: int) -> LockInfo | None:
        granted = self._client.set(self._key(target), run_id, nx=True, ex=ttl_seconds)
        if granted:
            return LockInfo(target=target, owner_run_id=run_id)
        owner = cast("bytes | str | None", self._client.get(self._key(target)))
        if owner is not None and _text(owner) == run_id:
            self._client.expire(self._key(target), ttl_seconds)
            return LockInfo(target=target, owner_run_id=run_id)
        return None

    async def inspect(self, target: str) -> LockInfo | None:
        owner = cast("bytes | str | None", self._client.get(self._key(target)))
        if owner is None:
            return None
        return LockInfo(target=target, owner_run_id=_text(owner))

    async def release(self, target: str, run_id: str) -> None:
        self._compare_delete(keys=[self._key(target)], args=[run_id])

    async def refresh(self, target: str, run_id: str, ttl_seconds: int) -> bool:
        return bool(self._compare_expire(keys=[self._key(target)], args=[run_id, ttl_seconds]))


def _text(raw: bytes | str) -> str:
    return raw.decode() if isinstance(raw, bytes) else raw


__all__ = ["LockInfo", "MemoryTargetLockStore", "RedisTargetLockStore", "TargetLockStore"]
