"""Step idempotency: every side-effecting step carries ``(runId, stepId,
actionHash)`` and a replay returns the originally recorded result.

The run service records each accepted decision under this key before a Mastra
pass can execute anything; replayed decisions (double-click, retry, or a
restart pass that re-derives the same action) return the original record and
never produce duplicate side effects.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from threading import Lock as ThreadLock
from typing import Protocol, cast

from redis import Redis


class RunReceiptStore(Protocol):
    async def remember(
        self, run_id: str, step_id: str, action_hash: str, record: dict[str, object]
    ) -> dict[str, object]: ...

    async def replay(
        self, run_id: str, step_id: str, action_hash: str
    ) -> dict[str, object] | None: ...


class MemoryRunReceiptStore:
    def __init__(self, clock: Callable[[], float] | None = None) -> None:
        self._clock = clock or time.monotonic
        self._records: dict[tuple[str, str, str], tuple[float, dict[str, object]]] = {}
        self._lock = ThreadLock()

    async def remember(
        self, run_id: str, step_id: str, action_hash: str, record: dict[str, object]
    ) -> dict[str, object]:
        with self._lock:
            key = (run_id, step_id, action_hash)
            existing = self._records.get(key)
            if existing is not None and existing[0] > self._clock():
                return existing[1]
            self._records[key] = (self._clock() + 86_400, record)
            return record

    async def replay(
        self, run_id: str, step_id: str, action_hash: str
    ) -> dict[str, object] | None:
        with self._lock:
            entry = self._records.get((run_id, step_id, action_hash))
            if entry is None or entry[0] <= self._clock():
                return None
            return entry[1]


class RedisRunReceiptStore:
    def __init__(self, client: Redis, ttl_seconds: int = 86_400) -> None:
        self._client = client
        self._ttl = ttl_seconds

    def _key(self, run_id: str, step_id: str, action_hash: str) -> str:
        return f"allrounder:runs:{run_id}:step:{step_id}:{action_hash}"

    async def remember(
        self, run_id: str, step_id: str, action_hash: str, record: dict[str, object]
    ) -> dict[str, object]:
        payload = json.dumps(record, separators=(",", ":"))
        stored = self._client.set(
            self._key(run_id, step_id, action_hash), payload, nx=True, ex=self._ttl
        )
        if stored:
            return record
        key = self._key(run_id, step_id, action_hash)
        existing = cast("bytes | str | None", self._client.get(key))
        if existing is None:
            return record
        value = json.loads(existing)
        return value if isinstance(value, dict) else record

    async def replay(
        self, run_id: str, step_id: str, action_hash: str
    ) -> dict[str, object] | None:
        raw = cast(
            "bytes | str | None",
            self._client.get(self._key(run_id, step_id, action_hash)),
        )
        if raw is None:
            return None
        value = json.loads(raw)
        return value if isinstance(value, dict) else None


__all__ = ["MemoryRunReceiptStore", "RedisRunReceiptStore", "RunReceiptStore"]
