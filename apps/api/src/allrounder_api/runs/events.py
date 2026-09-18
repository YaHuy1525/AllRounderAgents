"""Per-run SSE event bus namespaced by ``runId``.

Subscribers connect to ``run:{runId}``, get the buffered history first (so a
late joiner renders the current state), then live events. Every event carries
a per-run ``sequence`` so history/live overlap is de-duplicated.
"""

from __future__ import annotations

import asyncio
import json
from collections import deque
from collections.abc import AsyncIterator, Awaitable
from typing import Any, Protocol, cast

from redis.asyncio import Redis as AsyncRedis

_HISTORY_LIMIT = 200


class RunEventBus(Protocol):
    async def publish(self, run_id: str, event: dict[str, object]) -> dict[str, object]: ...

    def subscribe(self, run_id: str) -> AsyncIterator[dict[str, object]]: ...

    async def history(self, run_id: str) -> list[dict[str, object]]: ...


class InMemoryRunEventBus:
    def __init__(self, history_limit: int = _HISTORY_LIMIT) -> None:
        self._history_limit = history_limit
        self._history: dict[str, deque[dict[str, object]]] = {}
        self._sequences: dict[str, int] = {}
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, object]]]] = {}

    async def publish(self, run_id: str, event: dict[str, object]) -> dict[str, object]:
        sequence = self._sequences.get(run_id, 0) + 1
        self._sequences[run_id] = sequence
        enriched = {"runId": run_id, "sequence": sequence, **event}
        history = self._history.setdefault(run_id, deque(maxlen=self._history_limit))
        history.append(enriched)
        for queue in list(self._subscribers.get(run_id, ())):
            queue.put_nowait(enriched)
        return enriched

    async def history(self, run_id: str) -> list[dict[str, object]]:
        return list(self._history.get(run_id, ()))

    async def subscribe(self, run_id: str) -> AsyncIterator[dict[str, object]]:
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        subscribers = self._subscribers.setdefault(run_id, set())
        subscribers.add(queue)
        try:
            last_sequence = 0
            for event in await self.history(run_id):
                sequence = event.get("sequence")
                if isinstance(sequence, int):
                    last_sequence = max(last_sequence, sequence)
                yield event
            while True:
                event = await queue.get()
                sequence = event.get("sequence")
                if isinstance(sequence, int) and sequence <= last_sequence:
                    continue
                if isinstance(sequence, int):
                    last_sequence = sequence
                yield event
        finally:
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(run_id, None)

    async def close(self, run_id: str) -> None:
        subscribers = self._subscribers.pop(run_id, set())
        for queue in subscribers:
            queue.put_nowait({"runId": run_id, "sequence": -1, "type": "run.closed"})

    def clear(self, run_id: str) -> None:
        self._history.pop(run_id, None)
        self._sequences.pop(run_id, None)


class RedisRunEventBus:
    """PUBLISH/LPUSH fan-out so any API instance can serve a run's SSE."""

    def __init__(
        self,
        client: AsyncRedis,
        ttl_seconds: int = 86_400,
        history_limit: int = _HISTORY_LIMIT,
    ) -> None:
        self._client = client
        self._ttl = ttl_seconds
        self._history_limit = history_limit

    def _channel(self, run_id: str) -> str:
        return f"allrounder:runs:events:{run_id}"

    def _history_key(self, run_id: str) -> str:
        return f"allrounder:runs:events:{run_id}:history"

    def _sequence_key(self, run_id: str) -> str:
        return f"allrounder:runs:events:{run_id}:seq"

    async def publish(self, run_id: str, event: dict[str, object]) -> dict[str, object]:
        sequence = int(await self._client.incr(self._sequence_key(run_id)))
        await self._client.expire(self._sequence_key(run_id), self._ttl)
        enriched = {"runId": run_id, "sequence": sequence, **event}
        payload = json.dumps(enriched, separators=(",", ":"))
        async with self._client.pipeline(transaction=False) as pipe:
            pipe.lpush(self._history_key(run_id), payload)
            pipe.ltrim(self._history_key(run_id), 0, self._history_limit - 1)
            pipe.expire(self._history_key(run_id), self._ttl)
            pipe.publish(self._channel(run_id), payload)
            await pipe.execute()
        return enriched

    async def history(self, run_id: str) -> list[dict[str, object]]:
        raw_items = await cast(
            "Awaitable[list[str]]",
            self._client.lrange(self._history_key(run_id), 0, -1),
        )
        events: list[dict[str, object]] = []
        for raw in reversed(raw_items):
            value = json.loads(raw)
            if isinstance(value, dict):
                events.append(value)
        return events

    async def subscribe(self, run_id: str) -> AsyncIterator[dict[str, object]]:
        pubsub = self._client.pubsub()
        await pubsub.subscribe(self._channel(run_id))
        try:
            last_sequence = 0
            for buffered in await self.history(run_id):
                sequence = buffered.get("sequence")
                if isinstance(sequence, int):
                    last_sequence = max(last_sequence, sequence)
                yield buffered
            while True:
                message = await cast(
                    "Awaitable[dict[str, Any] | None]",
                    pubsub.get_message(ignore_subscribe_messages=True, timeout=5.0),
                )
                if message is None:
                    continue
                event = _load_event(message.get("data"))
                if event is None:
                    continue
                sequence = event.get("sequence")
                if isinstance(sequence, int) and sequence <= last_sequence:
                    continue
                if isinstance(sequence, int):
                    last_sequence = sequence
                yield event
        finally:
            await pubsub.unsubscribe(self._channel(run_id))
            await pubsub.close()

    async def close(self, run_id: str) -> None:
        await self.publish(run_id, {"type": "run.closed"})


def _load_event(data: object) -> dict[str, Any] | None:
    if isinstance(data, bytes):
        data = data.decode()
    if not isinstance(data, str):
        return None
    try:
        value = json.loads(data)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


__all__ = ["InMemoryRunEventBus", "RedisRunEventBus", "RunEventBus"]
