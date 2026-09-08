from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from .repositories import redact

if TYPE_CHECKING:
    from .repositories import PostgresRepositories


@dataclass
class FinanceRunRecord:
    id: str
    case_id: str
    tenant_id: str
    ticket_key: str
    period: str
    ledger: list[dict[str, object]]
    bank: list[dict[str, object]]
    exceptions: list[dict[str, object]]
    audit_pack: dict[str, object]
    posting: dict[str, object] | None
    idempotency_key: str
    status: str = "awaiting_approval"
    artifact: str | None = None


class FinanceRunRepository(Protocol):
    async def create(self, run: FinanceRunRecord) -> FinanceRunRecord: ...
    async def get(self, run_id: str, tenant_id: str) -> FinanceRunRecord: ...
    async def post_sandbox(
        self,
        run_id: str,
        tenant_id: str,
        action_hash: str,
        receipt_id: str,
        posting: dict[str, object],
    ) -> dict[str, object]: ...


def _safe_run(run: FinanceRunRecord) -> FinanceRunRecord:
    safe = deepcopy(run)
    ledger = redact(safe.ledger)
    bank = redact(safe.bank)
    exceptions = redact(safe.exceptions)
    pack = redact(safe.audit_pack)
    posting = redact(safe.posting)
    if (
        not isinstance(ledger, list)
        or not isinstance(bank, list)
        or not isinstance(exceptions, list)
    ):
        raise TypeError("Invalid finance artifacts")
    if not isinstance(pack, dict):
        raise TypeError("Invalid audit pack")
    safe.ledger = ledger
    safe.bank = bank
    safe.exceptions = exceptions
    safe.audit_pack = pack
    safe.posting = posting if isinstance(posting, dict) else None
    return safe


class InMemoryFinanceRunRepository:
    def __init__(self) -> None:
        self._runs: dict[str, FinanceRunRecord] = {}
        self._idempotency: dict[tuple[str, str, str, str], str] = {}
        self._postings: dict[tuple[str, str], dict[str, object]] = {}

    async def create(self, run: FinanceRunRecord) -> FinanceRunRecord:
        key = (run.tenant_id, run.ticket_key, run.period, run.idempotency_key)
        existing_id = self._idempotency.get(key)
        if existing_id is not None:
            return deepcopy(self._runs[existing_id])
        if run.id in self._runs:
            raise ValueError("Finance run already exists")
        safe = _safe_run(run)
        checks = safe.audit_pack.get("checks", [])
        if not isinstance(checks, list) or not all(
            isinstance(check, dict) and check.get("passed") for check in checks
        ):
            safe.status = "escalated"
        elif safe.posting is None:
            safe.status = "awaiting_approval"
        self._runs[safe.id] = safe
        self._idempotency[key] = safe.id
        return deepcopy(safe)

    async def get(self, run_id: str, tenant_id: str) -> FinanceRunRecord:
        run = self._runs.get(run_id)
        if run is None or run.tenant_id != tenant_id:
            raise KeyError("Finance run not found")
        return deepcopy(run)

    async def post_sandbox(
        self,
        run_id: str,
        tenant_id: str,
        action_hash: str,
        receipt_id: str,
        posting: dict[str, object],
    ) -> dict[str, object]:
        del receipt_id
        run = self._runs.get(run_id)
        if run is None or run.tenant_id != tenant_id:
            raise KeyError("Finance run not found")
        if posting.get("ledger") != "sandbox":
            raise ValueError("Sandbox ledger required")
        existing = self._postings.get((tenant_id, action_hash))
        if existing is not None:
            return deepcopy(existing)
        artifact = f"sandbox-post:{action_hash}"
        saved = deepcopy(posting)
        saved["artifact"] = artifact
        self._postings[(tenant_id, action_hash)] = saved
        run.status = "posted"
        run.artifact = artifact
        return deepcopy(saved)


class PostgresFinanceRunRepository:
    def __init__(self, database: PostgresRepositories) -> None:
        self._database = database

    async def create(self, run: FinanceRunRecord) -> FinanceRunRecord:
        safe = _safe_run(run)
        async with self._database.pool.connection() as connection:
            cursor = await connection.execute(
                """
                insert into public.finance_runs
                  (id, case_id, tenant_id, ticket_key, period, ledger, bank, exceptions,
                   audit_pack, posting, status, idempotency_key)
                values (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
                        %s::jsonb, %s, %s)
                on conflict (tenant_id, ticket_key, period, idempotency_key)
                do update set idempotency_key = excluded.idempotency_key
                returning *
                """,
                (
                    safe.id,
                    safe.case_id,
                    safe.tenant_id,
                    safe.ticket_key,
                    safe.period,
                    json.dumps(safe.ledger),
                    json.dumps(safe.bank),
                    json.dumps(safe.exceptions),
                    json.dumps(safe.audit_pack),
                    json.dumps(safe.posting),
                    safe.status,
                    safe.idempotency_key,
                ),
            )
            row = await cursor.fetchone()
        if row is None:
            raise RuntimeError("Finance run upsert returned no row")
        return _run_from_row(row)

    async def get(self, run_id: str, tenant_id: str) -> FinanceRunRecord:
        async with self._database.pool.connection() as connection:
            cursor = await connection.execute(
                """
                select r.*, p.artifact
                from public.finance_runs r
                left join public.finance_postings p
                    on p.finance_run_id = r.id and p.tenant_id = r.tenant_id
                where r.id = %s and r.tenant_id = %s
                """,
                (run_id, tenant_id),
            )
            row = await cursor.fetchone()
        if row is None:
            raise KeyError("Finance run not found")
        return _run_from_row(row)

    async def post_sandbox(
        self,
        run_id: str,
        tenant_id: str,
        action_hash: str,
        receipt_id: str,
        posting: dict[str, object],
    ) -> dict[str, object]:
        if posting.get("ledger") != "sandbox":
            raise ValueError("Sandbox ledger required")
        artifact = f"sandbox-post:{action_hash}"
        async with self._database.pool.connection() as connection:
            cursor = await connection.execute(
                """
                insert into public.finance_postings
                  (finance_run_id, tenant_id, ledger, period, action_hash, receipt_id,
                   lines, artifact)
                select id, tenant_id, %s, %s, %s, %s, %s::jsonb, %s
                from public.finance_runs
                where id = %s and tenant_id = %s
                on conflict (tenant_id, action_hash)
                do update set artifact = excluded.artifact
                returning *
                """,
                (
                    "sandbox",
                    str(posting.get("period", "")),
                    action_hash,
                    receipt_id,
                    json.dumps(posting.get("lines", [])),
                    artifact,
                    run_id,
                    tenant_id,
                ),
            )
            posted = await cursor.fetchone()
            updated = await connection.execute(
                """
                update public.finance_runs
                set status = 'posted'
                where id = %s and tenant_id = %s
                returning id
                """,
                (run_id, tenant_id),
            )
        if posted is None or await updated.fetchone() is None:
            raise KeyError("Finance run not found")
        result = deepcopy(posting)
        result["artifact"] = str(posted.get("artifact", artifact))
        return result


def _run_from_row(row: dict[str, object]) -> FinanceRunRecord:
    ledger = row.get("ledger")
    bank = row.get("bank")
    exceptions = row.get("exceptions")
    pack = row.get("audit_pack")
    posting = row.get("posting")
    artifact = row.get("artifact")
    return FinanceRunRecord(
        id=str(row["id"]),
        case_id=str(row["case_id"]),
        tenant_id=str(row["tenant_id"]),
        ticket_key=str(row["ticket_key"]),
        period=str(row["period"]),
        ledger=ledger if isinstance(ledger, list) else [],
        bank=bank if isinstance(bank, list) else [],
        exceptions=exceptions if isinstance(exceptions, list) else [],
        audit_pack=pack if isinstance(pack, dict) else {},
        posting=posting if isinstance(posting, dict) else None,
        idempotency_key=str(row["idempotency_key"]),
        status=str(row["status"]),
        artifact=str(artifact) if artifact is not None else None,
    )
