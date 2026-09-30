"""Best-effort Postgres mirror of terminal runs.

Redis keeps runs hot for a bounded TTL; the archive is the durable mirror so
``GET /runs?scope=history`` can still serve a run long after its Redis record
expired. Writes fire on terminal transitions only (completed, failed,
cancelled) — the moment a run's record stops changing. The archive never
raises into the run lifecycle: every write and read swallows its own failure
and logs, the same discipline the case-event trail follows.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any, Protocol

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ..logging import get_logger
from .models import TERMINAL_RUN_STATUSES, WorkflowRun

# Rows the history view reads back: enough to build the same summary shape
# ``runs.api`` serves for live runs, so both sources merge into one list.
_SELECT_COLUMNS = (
    "run_id, tenant_id, workflow, ticket_key, status, started_at, finished_at, steps"
)

# Full row set for pack reads: everything needed to rebuild a ``WorkflowRun``.
# The reviewed content rides inside the step artifacts, so no ``input`` column
# is read here.
_FULL_COLUMNS = (
    "run_id, tenant_id, workflow, ticket_key, case_id, status, outcome, "
    "cancel_reason, attempt, steps, side_effects, started_at, heartbeat_at, "
    "finished_at"
)


class RunArchive(Protocol):
    """Durable mirror seam: record terminal runs, list them back per tenant."""

    async def record(self, run: WorkflowRun) -> None: ...

    async def list_recent(
        self,
        tenant_id: str,
        *,
        limit: int = 50,
        workflow: str | None = None,
        status: str | None = None,
        before: str | None = None,
    ) -> list[dict[str, object]]: ...

    async def list_full(
        self,
        tenant_id: str,
        *,
        case_id_prefix: str,
        since: str | None = None,
        until: str | None = None,
        limit: int = 500,
    ) -> list[WorkflowRun]: ...

    async def open(self) -> None: ...

    async def close(self) -> None: ...


class NullRunArchive:
    """No-op archive for services without Postgres (dev + single-node tests)."""

    async def record(self, run: WorkflowRun) -> None:
        return None

    async def list_recent(
        self,
        tenant_id: str,
        *,
        limit: int = 50,
        workflow: str | None = None,
        status: str | None = None,
        before: str | None = None,
    ) -> list[dict[str, object]]:
        return []

    async def list_full(
        self,
        tenant_id: str,
        *,
        case_id_prefix: str,
        since: str | None = None,
        until: str | None = None,
        limit: int = 500,
    ) -> list[WorkflowRun]:
        return []

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None


def _iso(value: object) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return str(value)


def _archive_summary(record: Mapping[str, Any]) -> dict[str, object]:
    """One archived record as the shared run-summary shape (list rows)."""
    raw_steps = record.get("steps")
    steps = raw_steps if isinstance(raw_steps, list) else []
    done = sum(
        1
        for step in steps
        if isinstance(step, Mapping) and step.get("state") == "done"
    )
    finished = record.get("finished_at")
    return {
        "runId": str(record.get("run_id", "")),
        "workflow": str(record.get("workflow", "")),
        "ticketKey": str(record.get("ticket_key", "")),
        "status": str(record.get("status", "")),
        "queuePosition": None,
        "currentStepId": None,
        "stepCount": len(steps),
        "stepsDone": done,
        "startedAt": _iso(record.get("started_at", "")),
        "finishedAt": _iso(finished) if finished is not None else None,
    }


def _full_run(record: Mapping[str, Any]) -> WorkflowRun:
    """One archived row as a full ``WorkflowRun`` (pack reads only).

    The row carries every field the exporter needs; ``input`` is intentionally
    absent because the reviewed content lives in the step artifacts.
    """
    raw_steps = record.get("steps")
    steps = raw_steps if isinstance(raw_steps, list) else []
    side_effects = record.get("side_effects")
    finished = record.get("finished_at")
    return WorkflowRun.from_dict(
        {
            "runId": str(record.get("run_id", "")),
            "tenantId": str(record.get("tenant_id", "")),
            "workflow": str(record.get("workflow", "")),
            "ticketKey": str(record.get("ticket_key", "")),
            "caseId": str(record.get("case_id", "")),
            "input": {},
            "steps": steps,
            "status": str(record.get("status", "")),
            "attempt": int(record.get("attempt", 0) or 0),
            "outcome": record.get("outcome"),
            "cancelReason": record.get("cancel_reason"),
            "sideEffects": side_effects if isinstance(side_effects, dict) else {},
            "startedAt": record.get("started_at"),
            "heartbeatAt": record.get("heartbeat_at"),
            "finishedAt": finished,
        }
    )


class MemoryRunArchive:
    """In-process archive mirroring the Postgres table shape (dev + tests)."""

    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}

    @property
    def records(self) -> dict[str, dict[str, Any]]:
        """The stored rows (test introspection; treat as read-only)."""
        return self._records

    async def record(self, run: WorkflowRun) -> None:
        if run.status not in TERMINAL_RUN_STATUSES:
            return
        self._records[run.run_id] = {
            "run_id": run.run_id,
            "tenant_id": run.tenant_id,
            "workflow": run.workflow,
            "ticket_key": run.ticket_key,
            "case_id": run.case_id,
            "status": run.status,
            "outcome": run.outcome,
            "cancel_reason": run.cancel_reason,
            "attempt": run.attempt,
            "started_at": run.started_at.isoformat(),
            "heartbeat_at": run.heartbeat_at.isoformat(),
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "steps": [step.to_dict() for step in run.steps],
            "side_effects": run.side_effects,
        }

    async def list_recent(
        self,
        tenant_id: str,
        *,
        limit: int = 50,
        workflow: str | None = None,
        status: str | None = None,
        before: str | None = None,
    ) -> list[dict[str, object]]:
        rows = [
            record
            for record in self._records.values()
            if record["tenant_id"] == tenant_id
        ]
        if workflow is not None:
            rows = [row for row in rows if row["workflow"] == workflow]
        if status is not None:
            rows = [row for row in rows if row["status"] == status]
        if before is not None:
            rows = [row for row in rows if str(row["started_at"]) < before]
        rows.sort(key=lambda row: str(row["started_at"]), reverse=True)
        return [_archive_summary(row) for row in rows[:limit]]

    async def list_full(
        self,
        tenant_id: str,
        *,
        case_id_prefix: str,
        since: str | None = None,
        until: str | None = None,
        limit: int = 500,
    ) -> list[WorkflowRun]:
        rows = [
            record
            for record in self._records.values()
            if record["tenant_id"] == tenant_id
            and str(record["case_id"]).startswith(case_id_prefix)
        ]
        if since is not None:
            rows = [row for row in rows if str(row["started_at"]) >= since]
        if until is not None:
            rows = [row for row in rows if str(row["started_at"]) < until]
        rows.sort(key=lambda row: str(row["started_at"]))
        return [_full_run(row) for row in rows[:limit]]

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None


class PostgresRunArchive:
    """Durable mirror over the same Supabase direct Postgres URL as the cases
    store. Every operation is best-effort: failures log and degrade to an
    empty read / skipped write, never an exception into the run lifecycle."""

    def __init__(self, database_url: str) -> None:
        if not database_url:
            raise ValueError("DATABASE_URL is required for the run archive")
        self._pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = (
            AsyncConnectionPool(
                database_url,
                min_size=0,
                max_size=4,
                open=False,
                kwargs={"row_factory": dict_row},
            )
        )
        self._logger = get_logger()

    async def open(self) -> None:
        try:
            await self._pool.open()
        except Exception:
            self._logger.warning("run_archive_open_failed")

    async def close(self) -> None:
        with suppress(Exception):
            await self._pool.close()

    async def record(self, run: WorkflowRun) -> None:
        if run.status not in TERMINAL_RUN_STATUSES:
            return
        try:
            async with self._pool.connection() as connection:
                await connection.execute(
                    """
                    insert into public.run_archive
                      (run_id, tenant_id, workflow, ticket_key, case_id, status,
                       outcome, cancel_reason, attempt, steps, side_effects,
                       started_at, heartbeat_at, finished_at)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb,
                            %s::jsonb, %s, %s, %s)
                    on conflict (run_id) do update
                    set status = excluded.status,
                        outcome = excluded.outcome,
                        cancel_reason = excluded.cancel_reason,
                        attempt = excluded.attempt,
                        steps = excluded.steps,
                        side_effects = excluded.side_effects,
                        heartbeat_at = excluded.heartbeat_at,
                        finished_at = excluded.finished_at
                    """,
                    (
                        run.run_id,
                        run.tenant_id,
                        run.workflow,
                        run.ticket_key,
                        run.case_id,
                        run.status,
                        run.outcome,
                        run.cancel_reason,
                        run.attempt,
                        _dumps([step.to_dict() for step in run.steps]),
                        _dumps(run.side_effects),
                        run.started_at,
                        run.heartbeat_at,
                        run.finished_at,
                    ),
                )
        except Exception:
            self._logger.warning("run_archive_write_failed", run_id=run.run_id)

    async def list_recent(
        self,
        tenant_id: str,
        *,
        limit: int = 50,
        workflow: str | None = None,
        status: str | None = None,
        before: str | None = None,
    ) -> list[dict[str, object]]:
        clauses = ["tenant_id = %s"]
        parameters: list[object] = [tenant_id]
        if workflow is not None:
            clauses.append("workflow = %s")
            parameters.append(workflow)
        if status is not None:
            clauses.append("status = %s")
            parameters.append(status)
        if before is not None:
            clauses.append("started_at < %s::timestamptz")
            parameters.append(before)
        parameters.append(limit)
        query = (
            f"select {_SELECT_COLUMNS} from public.run_archive "
            f"where {' and '.join(clauses)} "
            "order by started_at desc limit %s"
        )
        try:
            async with self._pool.connection() as connection:
                cursor = await connection.execute(query, tuple(parameters))
                rows = await cursor.fetchall()
        except Exception:
            self._logger.warning("run_archive_read_failed", tenant_id=tenant_id)
            return []
        return [_archive_summary(row) for row in rows]

    async def list_full(
        self,
        tenant_id: str,
        *,
        case_id_prefix: str,
        since: str | None = None,
        until: str | None = None,
        limit: int = 500,
    ) -> list[WorkflowRun]:
        # ``starts_with`` sidesteps LIKE metacharacters in client refs, which
        # may contain dots and dashes (``msp-acme.support-482913``).
        clauses = ["tenant_id = %s", "starts_with(case_id, %s)"]
        parameters: list[object] = [tenant_id, case_id_prefix]
        if since is not None:
            clauses.append("started_at >= %s::timestamptz")
            parameters.append(since)
        if until is not None:
            clauses.append("started_at < %s::timestamptz")
            parameters.append(until)
        parameters.append(limit)
        query = (
            f"select {_FULL_COLUMNS} from public.run_archive "
            f"where {' and '.join(clauses)} "
            "order by started_at asc, run_id asc limit %s"
        )
        try:
            async with self._pool.connection() as connection:
                cursor = await connection.execute(query, tuple(parameters))
                rows = await cursor.fetchall()
        except Exception:
            self._logger.warning(
                "run_archive_pack_read_failed",
                tenant_id=tenant_id,
                case_id_prefix=case_id_prefix,
            )
            return []
        return [_full_run(row) for row in rows]


def _dumps(value: object) -> str:
    return json.dumps(value, default=str)


__all__ = [
    "MemoryRunArchive",
    "NullRunArchive",
    "PostgresRunArchive",
    "RunArchive",
]
