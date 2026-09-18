"""Run registry: the single source of truth for active and historical runs.

Every record is keyed by ``runId`` and tenant-scoped for reads. The Redis
implementation stores one JSON blob per run plus a per-ticket index for the
History view.
"""

from __future__ import annotations

import json
from typing import Any, Protocol, cast

from redis import Redis

from .models import TERMINAL_RUN_STATUSES, WorkflowRun

_TENANT_INDEX_CAP = 200


class RunRegistry(Protocol):
    async def save(self, run: WorkflowRun) -> None: ...
    async def get(self, run_id: str, tenant_id: str) -> WorkflowRun: ...
    async def get_internal(self, run_id: str) -> WorkflowRun: ...
    async def list_for_ticket(
        self, ticket_key: str, tenant_id: str, limit: int = 50
    ) -> list[WorkflowRun]: ...
    async def list_active(self) -> list[WorkflowRun]: ...


def _clone(run: WorkflowRun) -> WorkflowRun:
    return WorkflowRun.from_dict(run.to_dict())


class InMemoryRunRegistry:
    def __init__(self) -> None:
        self._runs: dict[str, WorkflowRun] = {}
        self._order: dict[tuple[str, str], list[str]] = {}

    async def save(self, run: WorkflowRun) -> None:
        self._runs[run.run_id] = _clone(run)
        key = (run.tenant_id, run.ticket_key)
        history = self._order.setdefault(key, [])
        if run.run_id not in history:
            history.insert(0, run.run_id)
            del history[_TENANT_INDEX_CAP:]

    async def get(self, run_id: str, tenant_id: str) -> WorkflowRun:
        run = self._runs.get(run_id)
        if run is None or run.tenant_id != tenant_id:
            raise KeyError("Run not found")
        return _clone(run)

    async def get_internal(self, run_id: str) -> WorkflowRun:
        run = self._runs.get(run_id)
        if run is None:
            raise KeyError("Run not found")
        return _clone(run)

    async def list_for_ticket(
        self, ticket_key: str, tenant_id: str, limit: int = 50
    ) -> list[WorkflowRun]:
        ids = self._order.get((tenant_id, ticket_key), [])
        runs = [self._runs[run_id] for run_id in ids[:limit] if run_id in self._runs]
        return [_clone(run) for run in runs]

    async def list_active(self) -> list[WorkflowRun]:
        return [
            _clone(run)
            for run in self._runs.values()
            if run.status not in TERMINAL_RUN_STATUSES
        ]


class RedisRunRegistry:
    """JSON-blob registry. Reads/writes are small and single-key scoped."""

    def __init__(self, client: Redis, ttl_seconds: int = 604_800) -> None:
        self._client = client
        self._ttl = ttl_seconds

    def _key(self, run_id: str) -> str:
        return f"allrounder:runs:record:{run_id}"

    def _index_key(self, tenant_id: str, ticket_key: str) -> str:
        return f"allrounder:runs:index:{tenant_id}:{ticket_key}"

    def _active_key(self) -> str:
        return "allrounder:runs:active"

    async def save(self, run: WorkflowRun) -> None:
        payload = json.dumps(run.to_dict(), separators=(",", ":"))
        with self._client.pipeline() as pipe:
            pipe.set(self._key(run.run_id), payload, ex=self._ttl)
            index = self._index_key(run.tenant_id, run.ticket_key)
            pipe.lrem(index, 0, run.run_id)
            pipe.lpush(index, run.run_id)
            pipe.ltrim(index, 0, _TENANT_INDEX_CAP - 1)
            pipe.expire(index, self._ttl)
            if run.status in TERMINAL_RUN_STATUSES:
                pipe.srem(self._active_key(), run.run_id)
            else:
                pipe.sadd(self._active_key(), run.run_id)
            pipe.execute()

    async def get(self, run_id: str, tenant_id: str) -> WorkflowRun:
        raw = cast("bytes | str | None", self._client.get(self._key(run_id)))
        if raw is None:
            raise KeyError("Run not found")
        run = WorkflowRun.from_dict(_loads(raw))
        if run.tenant_id != tenant_id:
            raise KeyError("Run not found")
        return run

    async def get_internal(self, run_id: str) -> WorkflowRun:
        raw = cast("bytes | str | None", self._client.get(self._key(run_id)))
        if raw is None:
            raise KeyError("Run not found")
        return WorkflowRun.from_dict(_loads(raw))

    async def list_for_ticket(
        self, ticket_key: str, tenant_id: str, limit: int = 50
    ) -> list[WorkflowRun]:
        ids = cast(
            "list[bytes]",
            self._client.lrange(self._index_key(tenant_id, ticket_key), 0, limit - 1),
        )
        runs = []
        for raw_id in ids:
            raw = cast("bytes | str | None", self._client.get(self._key(_text(raw_id))))
            if raw is not None:
                runs.append(WorkflowRun.from_dict(_loads(raw)))
        return runs

    async def list_active(self) -> list[WorkflowRun]:
        runs = []
        for raw_id in cast("set[bytes]", self._client.smembers(self._active_key())):
            raw = cast("bytes | str | None", self._client.get(self._key(_text(raw_id))))
            if raw is None:
                self._client.srem(self._active_key(), raw_id)
                continue
            run = WorkflowRun.from_dict(_loads(raw))
            if run.status not in TERMINAL_RUN_STATUSES:
                runs.append(run)
        return runs


def _loads(raw: bytes | str) -> dict[str, Any]:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Invalid run record")
    return value


def _text(raw: bytes | str) -> str:
    return raw.decode() if isinstance(raw, bytes) else raw


__all__ = ["RunRegistry", "InMemoryRunRegistry", "RedisRunRegistry"]
