from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Protocol

import psycopg
from psycopg.rows import TupleRow
from psycopg_pool import ConnectionPool

from .contracts import RoutedTicket, Ticket


class SqlExecutor(Protocol):
    """Small server-only persistence seam that is straightforward to fake in tests."""

    def execute(self, statement: str, parameters: Sequence[object]) -> None: ...


class PsycopgExecutor:
    """Execute statements over a direct hosted Postgres DATABASE_URL."""

    def __init__(self, database_url: str) -> None:
        if not database_url:
            raise ValueError("DATABASE_URL is required for Postgres persistence")
        self._pool: ConnectionPool[psycopg.Connection[TupleRow]] = ConnectionPool(
            conninfo=database_url,
            min_size=0,
            max_size=10,
            open=True,
        )

    def execute(self, statement: str, parameters: Sequence[object]) -> None:
        with self._pool.connection() as connection:
            connection.execute(statement, parameters)

    def close(self) -> None:
        self._pool.close()


class PostgresTicketQueue:
    """Durable Phase 0 dispatcher queue backed by Supabase hosted Postgres."""

    def __init__(self, executor: SqlExecutor) -> None:
        self._executor = executor

    def enqueue(self, routed: RoutedTicket) -> None:
        ticket_payload = json.dumps(routed.ticket.model_dump(mode="json", by_alias=True))
        routed_payload = json.dumps(routed.model_dump(mode="json", by_alias=True))
        self._executor.execute(
            """
            with persisted_ticket as (
                insert into public.tickets
                    (first_event_id, latest_event_id, ticket_key, project, issue_type,
                     domain, status, normalized_payload, received_at)
                values (%s, %s, %s, %s, %s, %s, 'routed', %s::jsonb, %s)
                on conflict (ticket_key) do update
                set latest_event_id = excluded.latest_event_id,
                    domain = excluded.domain,
                    status = excluded.status,
                    normalized_payload = excluded.normalized_payload,
                    updated_at = now()
                returning latest_event_id
            )
            insert into public.dispatcher_jobs
                (event_id, ticket_key, domain, gate, workflow, payload)
            select %s, %s, %s, %s, %s, %s::jsonb
            from persisted_ticket
            on conflict (event_id) do nothing
            """,
            (
                routed.ticket.event_id,
                routed.ticket.event_id,
                routed.ticket.key,
                routed.ticket.project,
                routed.ticket.issue_type,
                routed.verdict.domain.value,
                ticket_payload,
                routed.ticket.received_at,
                routed.ticket.event_id,
                routed.ticket.key,
                routed.verdict.domain.value,
                routed.gate.value,
                routed.workflow,
                routed_payload,
            ),
        )

    def dead_letter(self, ticket: Ticket, reason: str, error: Exception) -> None:
        self._executor.execute(
            """
            insert into public.dead_letters (event_id, ticket_key, reason, error, payload)
            values (%s, %s, %s, %s, %s::jsonb)
            on conflict (event_id) do update
            set reason = excluded.reason,
                error = excluded.error,
                payload = excluded.payload,
                updated_at = now()
            """,
            (
                ticket.event_id,
                ticket.key,
                reason,
                str(error),
                json.dumps(ticket.model_dump(mode="json", by_alias=True)),
            ),
        )
