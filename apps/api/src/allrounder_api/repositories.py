from __future__ import annotations

import json
import re
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

_EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_SECRET_KEY = re.compile(r"(api[_-]?key|token|secret|password)", re.IGNORECASE)
_SECRET_VALUE = re.compile(
    r"\b(?:(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|pat)[-_][A-Za-z0-9_-]{6,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b",
    re.IGNORECASE,
)
# Account/card-shaped digit runs only when a finance keyword introduces them,
# so ticket keys and money totals are never caught by accident.
_ACCOUNT = re.compile(
    r"\b(?:account|acct|iban|card|routing)[\s#:.-]*\d[\d\s-]{5,}\d\b",
    re.IGNORECASE,
)

# Clause ids cited by audit-first redaction. Every masked value names the
# clause that masked it; case events carry the citations (RTI pattern).
CLAUSE_SECRET_KEY = "secrets/api-key"
CLAUSE_SECRET_VALUE = "secrets/token-value"
CLAUSE_EMAIL = "pii/email"
CLAUSE_ACCOUNT = "pii/finance-account"
REDACTION_CLAUSES: frozenset[str] = frozenset(
    {CLAUSE_SECRET_KEY, CLAUSE_SECRET_VALUE, CLAUSE_EMAIL, CLAUSE_ACCOUNT}
)


@dataclass(frozen=True)
class RedactionEntry:
    """One masked value, cited by the policy clause that masked it."""

    path: str
    clause: str


@dataclass(frozen=True)
class RedactionReport:
    """A redacted value plus the citations explaining what was masked."""

    value: object
    entries: tuple[RedactionEntry, ...]


def redact(value: object, key: str = "") -> object:
    """Mask secrets/PII in place; see :func:`audit_redaction` for citations."""

    return audit_redaction(value, key=key).value


def audit_redaction(value: object, *, path: str = "", key: str = "") -> RedactionReport:
    """Redact and cite: every masked value reports its clause and path."""

    if _SECRET_KEY.search(key):
        return RedactionReport(
            value="[REDACTED]",
            entries=(RedactionEntry(path=path or key, clause=CLAUSE_SECRET_KEY),),
        )
    if isinstance(value, str):
        text, clauses = _redact_text(value)
        return RedactionReport(
            value=text,
            entries=tuple(RedactionEntry(path=path, clause=clause) for clause in clauses),
        )
    if isinstance(value, dict):
        output: dict[str, object] = {}
        entries: list[RedactionEntry] = []
        for item_key, item in value.items():
            child = audit_redaction(item, path=_child_path(path, str(item_key)), key=str(item_key))
            output[str(item_key)] = child.value
            entries.extend(child.entries)
        return RedactionReport(value=output, entries=tuple(entries))
    if isinstance(value, list):
        items: list[object] = []
        entries = []
        for index, item in enumerate(value):
            child = audit_redaction(item, path=_child_path(path, str(index)))
            items.append(child.value)
            entries.extend(child.entries)
        return RedactionReport(value=items, entries=tuple(entries))
    return RedactionReport(value=value, entries=())


def _redact_text(value: str) -> tuple[str, tuple[str, ...]]:
    text = value
    clauses: list[str] = []
    if _SECRET_VALUE.search(text):
        text = _SECRET_VALUE.sub("[REDACTED]", text)
        clauses.append(CLAUSE_SECRET_VALUE)
    if _EMAIL.search(text):
        text = _EMAIL.sub("[REDACTED_EMAIL]", text)
        clauses.append(CLAUSE_EMAIL)
    if _ACCOUNT.search(text):
        text = _ACCOUNT.sub("[REDACTED_ACCOUNT]", text)
        clauses.append(CLAUSE_ACCOUNT)
    return text, tuple(clauses)


def _child_path(path: str, segment: str) -> str:
    return f"{path}.{segment}" if path else segment


@dataclass
class CaseEvent:
    actor: str
    kind: str
    payload: dict[str, object]
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


# Mirrors the case_events_actor_check constraint from the Phase 1 migration so
# in-memory runs reject unknown actors the same way Postgres does.
CASE_EVENT_ACTORS: frozenset[str] = frozenset({"agent", "human", "system"})


def _check_case_event_actor(actor: str) -> None:
    if actor not in CASE_EVENT_ACTORS:
        allowed = ", ".join(sorted(CASE_EVENT_ACTORS))
        raise ValueError(f"actor must be one of {allowed}")


@dataclass
class CaseRecord:
    id: str
    tenant_id: str
    ticket_key: str
    domain: str
    status: str
    events: list[CaseEvent] = field(default_factory=list)
    cost_usd_micro: int = 0
    outcome: str | None = None


@dataclass
class ApprovalRecord:
    id: str
    case_id: str
    tenant_id: str
    action: dict[str, object]
    evidence: list[dict[str, object]]
    approver: str
    scope: str
    expires_at: datetime
    decision: str | None = None
    comment: str | None = None
    decided_at: datetime | None = None


@dataclass(frozen=True)
class SupportSendReceipt:
    idempotency_key: str
    case_id: str
    ticket_key: str
    status: str
    sent_at: datetime


@dataclass(frozen=True)
class FeedbackRecord:
    tenant_id: str
    message_sha256: str
    rating: str
    reason: str | None = None


@dataclass
class GithubAccountRecord:
    """A console-registered GitHub identity. The token is write-only from
    the browser: list endpoints return a hint, never the secret."""

    id: str
    tenant_id: str
    label: str
    token: str
    username: str = ""
    is_default: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class CaseRepository(Protocol):
    async def create(self, case: CaseRecord) -> CaseRecord: ...
    async def append_event(
        self, case_id: str, *, actor: str, kind: str, payload: dict[str, object]
    ) -> None: ...
    async def get(self, case_id: str, tenant_id: str) -> CaseRecord: ...
    async def get_by_ticket(self, ticket_key: str, tenant_id: str) -> CaseRecord: ...


class ApprovalRepository(Protocol):
    async def create(self, approval: ApprovalRecord) -> ApprovalRecord: ...
    async def list(self, tenant_id: str) -> list[ApprovalRecord]: ...
    async def get(self, approval_id: str, tenant_id: str) -> ApprovalRecord: ...
    async def decide(
        self, approval_id: str, tenant_id: str, decision: str, comment: str | None
    ) -> ApprovalRecord: ...


class SupportSendRepository(Protocol):
    async def authorize_and_send(
        self,
        receipt_id: str,
        approval_id: str,
        case_id: str,
        action_hash: str,
        ticket_key: str,
        body: str,
    ) -> SupportSendReceipt: ...

    async def consume_receipt(
        self, receipt_id: str, approval_id: str, case_id: str, action_hash: str
    ) -> None: ...

    async def send_once(
        self, idempotency_key: str, case_id: str, ticket_key: str, body: str
    ) -> SupportSendReceipt: ...


class FeedbackRepository(Protocol):
    async def store(self, feedback: FeedbackRecord) -> None: ...


class GithubAccountRepository(Protocol):
    async def list(self, tenant_id: str) -> list[GithubAccountRecord]: ...
    async def get(self, account_id: str, tenant_id: str) -> GithubAccountRecord: ...
    async def create(self, account: GithubAccountRecord) -> GithubAccountRecord: ...
    async def delete(self, account_id: str, tenant_id: str) -> None: ...
    async def set_default(self, account_id: str, tenant_id: str) -> GithubAccountRecord: ...


class InMemoryCaseRepository:
    def __init__(self) -> None:
        self._cases: dict[str, CaseRecord] = {}

    async def create(self, case: CaseRecord) -> CaseRecord:
        if case.id in self._cases:
            raise ValueError("Case already exists")
        safe = deepcopy(case)
        self._cases[case.id] = safe
        return deepcopy(safe)

    async def append_event(
        self, case_id: str, *, actor: str, kind: str, payload: dict[str, object]
    ) -> None:
        case = self._cases.get(case_id)
        if case is None:
            raise KeyError("Case not found")
        _check_case_event_actor(actor)
        report = audit_redaction(payload)
        safe = report.value
        if not isinstance(safe, dict):
            raise TypeError("Event payload must be an object")
        if report.entries:
            safe["redactions"] = [
                {"path": entry.path, "clause": entry.clause} for entry in report.entries
            ]
        cost = safe.get("costUsdMicro", 0)
        if not isinstance(cost, int) or isinstance(cost, bool) or cost < 0:
            raise ValueError("costUsdMicro must be a non-negative integer")
        case.cost_usd_micro += cost
        case.events.append(CaseEvent(actor=actor, kind=kind, payload=safe))

    async def get(self, case_id: str, tenant_id: str) -> CaseRecord:
        case = self._cases.get(case_id)
        if case is None or case.tenant_id != tenant_id:
            raise KeyError("Case not found")
        return deepcopy(case)

    async def get_by_ticket(self, ticket_key: str, tenant_id: str) -> CaseRecord:
        for case in self._cases.values():
            if case.ticket_key == ticket_key and case.tenant_id == tenant_id:
                return deepcopy(case)
        raise KeyError("Case not found")


class InMemoryApprovalRepository:
    def __init__(self, clock: Callable[[], datetime] | None = None) -> None:
        self._approvals: dict[str, ApprovalRecord] = {}
        self._clock = clock or (lambda: datetime.now(UTC))

    async def create(self, approval: ApprovalRecord) -> ApprovalRecord:
        if approval.id in self._approvals:
            raise ValueError("Approval already exists")
        safe = deepcopy(approval)
        redacted_action = redact(safe.action)
        redacted_evidence = redact(safe.evidence)
        if not isinstance(redacted_action, dict) or not isinstance(redacted_evidence, list):
            raise TypeError("Approval payload is invalid")
        safe.action = redacted_action
        safe.evidence = redacted_evidence
        self._approvals[safe.id] = safe
        return deepcopy(safe)

    async def list(self, tenant_id: str) -> list[ApprovalRecord]:
        return [
            deepcopy(value) for value in self._approvals.values()
            if value.tenant_id == tenant_id
        ]

    async def get(self, approval_id: str, tenant_id: str) -> ApprovalRecord:
        approval = self._approvals.get(approval_id)
        if approval is None or approval.tenant_id != tenant_id:
            raise KeyError("Approval not found")
        if approval.decision is None and approval.expires_at <= self._clock():
            approval.decision = "expired"
            approval.decided_at = self._clock()
        return deepcopy(approval)

    async def decide(
        self, approval_id: str, tenant_id: str, decision: str, comment: str | None
    ) -> ApprovalRecord:
        approval = await self.get(approval_id, tenant_id)
        if approval.decision is not None:
            raise ValueError("Approval is no longer pending")
        stored = self._approvals[approval_id]
        stored.decision = decision
        stored.comment = str(redact(comment)) if comment is not None else None
        stored.decided_at = self._clock()
        return deepcopy(stored)


class InMemorySupportSendRepository:
    def __init__(self) -> None:
        self.sent: dict[str, SupportSendReceipt] = {}
        self._used_receipts: set[str] = set()

    async def consume_receipt(
        self, receipt_id: str, approval_id: str, case_id: str, action_hash: str
    ) -> None:
        del approval_id, case_id, action_hash
        if receipt_id in self._used_receipts:
            raise ValueError("Receipt already consumed")
        self._used_receipts.add(receipt_id)

    async def authorize_and_send(
        self,
        receipt_id: str,
        approval_id: str,
        case_id: str,
        action_hash: str,
        ticket_key: str,
        body: str,
    ) -> SupportSendReceipt:
        await self.consume_receipt(receipt_id, approval_id, case_id, action_hash)
        return await self.send_once(receipt_id, case_id, ticket_key, body)

    async def send_once(
        self, idempotency_key: str, case_id: str, ticket_key: str, body: str
    ) -> SupportSendReceipt:
        del body
        existing = self.sent.get(idempotency_key)
        if existing is not None:
            return existing
        receipt = SupportSendReceipt(
            idempotency_key, case_id, ticket_key, "sent", datetime.now(UTC)
        )
        self.sent[idempotency_key] = receipt
        return receipt


class InMemoryFeedbackRepository:
    """In-process feedback store; mirrors the Postgres redaction of free text."""

    def __init__(self) -> None:
        self.entries: list[FeedbackRecord] = []

    async def store(self, feedback: FeedbackRecord) -> None:
        reason = str(redact(feedback.reason)) if feedback.reason is not None else None
        self.entries.append(
            FeedbackRecord(
                tenant_id=feedback.tenant_id,
                message_sha256=feedback.message_sha256,
                rating=feedback.rating,
                reason=reason,
            )
        )


class InMemoryGithubAccountRepository:
    def __init__(self) -> None:
        self._accounts: dict[str, GithubAccountRecord] = {}

    async def list(self, tenant_id: str) -> list[GithubAccountRecord]:
        rows = [
            deepcopy(account)
            for account in self._accounts.values()
            if account.tenant_id == tenant_id
        ]
        rows.sort(key=lambda account: (not account.is_default, account.created_at, account.id))
        return rows

    async def get(self, account_id: str, tenant_id: str) -> GithubAccountRecord:
        account = self._accounts.get(account_id)
        if account is None or account.tenant_id != tenant_id:
            raise KeyError("GitHub account not found")
        return deepcopy(account)

    async def create(self, account: GithubAccountRecord) -> GithubAccountRecord:
        if account.id in self._accounts:
            raise ValueError("GitHub account already exists")
        for existing in self._accounts.values():
            if (
                existing.tenant_id == account.tenant_id
                and existing.label.lower() == account.label.lower()
            ):
                raise ValueError("GitHub account label already exists")
        first = not any(
            existing.tenant_id == account.tenant_id for existing in self._accounts.values()
        )
        safe = deepcopy(account)
        safe.is_default = account.is_default or first
        self._accounts[safe.id] = safe
        return deepcopy(safe)

    async def delete(self, account_id: str, tenant_id: str) -> None:
        account = await self.get(account_id, tenant_id)
        del self._accounts[account_id]
        if not account.is_default:
            return
        remaining = [
            item for item in self._accounts.values() if item.tenant_id == tenant_id
        ]
        if remaining:
            oldest = min(remaining, key=lambda item: (item.created_at, item.id))
            oldest.is_default = True

    async def set_default(self, account_id: str, tenant_id: str) -> GithubAccountRecord:
        await self.get(account_id, tenant_id)
        for existing in self._accounts.values():
            if existing.tenant_id == tenant_id:
                existing.is_default = existing.id == account_id
        return deepcopy(self._accounts[account_id])


class PostgresRepositories:
    """Parameterized async repositories over the Supabase direct Postgres URL."""

    def __init__(self, database_url: str) -> None:
        if not database_url:
            raise ValueError("DATABASE_URL is required")
        self.pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = AsyncConnectionPool(
            database_url, min_size=0, max_size=10, open=False,
            kwargs={"row_factory": dict_row},
        )

    async def open(self) -> None:
        await self.pool.open()

    async def close(self) -> None:
        await self.pool.close()

    async def create_case(self, case: CaseRecord) -> CaseRecord:
        async with self.pool.connection() as connection:
            await connection.execute(
                """
                insert into public.cases
                  (id, tenant_id, ticket_key, domain, status, cost_usd_micro, outcome)
                values (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    case.id, case.tenant_id, case.ticket_key, case.domain, case.status,
                    case.cost_usd_micro, redact(case.outcome),
                ),
            )
        return case

    async def append_case_event(
        self, case_id: str, *, actor: str, kind: str, payload: dict[str, object]
    ) -> None:
        _check_case_event_actor(actor)
        report = audit_redaction(payload)
        safe = report.value
        if not isinstance(safe, dict):
            raise TypeError("Event payload must be an object")
        if report.entries:
            safe["redactions"] = [
                {"path": entry.path, "clause": entry.clause} for entry in report.entries
            ]
        cost = safe.get("costUsdMicro", 0)
        if not isinstance(cost, int) or isinstance(cost, bool) or cost < 0:
            raise ValueError("costUsdMicro must be a non-negative integer")
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                """
                insert into public.case_events (case_id, actor, kind, payload, cost_usd_micro)
                values (%s, %s, %s, %s::jsonb, %s)
                """,
                (case_id, actor, kind, json.dumps(safe), cost),
            )
            await connection.execute(
                """
                update public.cases
                set cost_usd_micro = cost_usd_micro + %s, updated_at = now()
                where id = %s
                """,
                (cost, case_id),
            )

    async def create_approval(self, approval: ApprovalRecord) -> ApprovalRecord:
        async with self.pool.connection() as connection:
            await connection.execute(
                """
                insert into public.approvals
                  (id, case_id, tenant_id, payload, action, evidence,
                   approver, scope, expires_at)
                values (%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s)
                """,
                (
                    approval.id, approval.case_id, approval.tenant_id,
                    json.dumps(
                        {"action": redact(approval.action), "evidence": redact(approval.evidence)}
                    ),
                    json.dumps(redact(approval.action)), json.dumps(redact(approval.evidence)),
                    approval.approver, approval.scope, approval.expires_at,
                ),
            )
        return approval

    async def authorize_and_send(
        self,
        receipt_id: str,
        approval_id: str,
        case_id: str,
        action_hash: str,
        ticket_key: str,
        body: str,
    ) -> SupportSendReceipt:
        async with self.pool.connection() as connection, connection.transaction():
            receipt_cursor = await connection.execute(
                """
                insert into public.approval_receipt_uses
                  (receipt_id, approval_id, case_id, action_hash)
                values (%s, %s, %s, %s)
                on conflict (receipt_id) do nothing
                returning receipt_id
                """,
                (receipt_id, approval_id, case_id, action_hash),
            )
            if await receipt_cursor.fetchone() is None:
                raise ValueError("Receipt already consumed")
            send_cursor = await connection.execute(
                """
                insert into public.support_sends
                  (idempotency_key, case_id, ticket_key, body_redacted, status)
                values (%s, %s, %s, %s, 'sent')
                on conflict (idempotency_key) do update
                set idempotency_key = excluded.idempotency_key
                returning sent_at
                """,
                (receipt_id, case_id, ticket_key, str(redact(body))),
            )
            row = await send_cursor.fetchone()
            if row is None:
                raise RuntimeError("Send upsert returned no receipt")
        return SupportSendReceipt(receipt_id, case_id, ticket_key, "sent", row["sent_at"])

    async def send_once(
        self, idempotency_key: str, case_id: str, ticket_key: str, body: str
    ) -> SupportSendReceipt:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                insert into public.support_sends
                  (idempotency_key, case_id, ticket_key, body_redacted, status)
                values (%s, %s, %s, %s, 'sent')
                on conflict (idempotency_key) do update
                set idempotency_key = excluded.idempotency_key
                returning sent_at
                """,
                (idempotency_key, case_id, ticket_key, str(redact(body))),
            )
            row = await cursor.fetchone()
        if row is None:
            raise RuntimeError("Send upsert returned no receipt")
        return SupportSendReceipt(idempotency_key, case_id, ticket_key, "sent", row["sent_at"])

    async def consume_receipt(
        self, receipt_id: str, approval_id: str, case_id: str, action_hash: str
    ) -> None:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                insert into public.approval_receipt_uses
                  (receipt_id, approval_id, case_id, action_hash)
                values (%s, %s, %s, %s)
                on conflict (receipt_id) do nothing
                returning receipt_id
                """,
                (receipt_id, approval_id, case_id, action_hash),
            )
            row = await cursor.fetchone()
        if row is None:
            raise ValueError("Receipt already consumed")

    async def store_feedback(self, feedback: FeedbackRecord) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                """
                insert into public.chat_feedback
                  (tenant_id, message_sha256, rating, reason)
                values (%s, %s, %s, %s)
                """,
                (
                    feedback.tenant_id, feedback.message_sha256, feedback.rating,
                    str(redact(feedback.reason)) if feedback.reason is not None else None,
                ),
            )

    async def list_github_accounts(self, tenant_id: str) -> list[GithubAccountRecord]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                select id, tenant_id, label, username, token, is_default, created_at
                from public.github_accounts
                where tenant_id = %s
                order by is_default desc, created_at, id
                """,
                (tenant_id,),
            )
            rows = await cursor.fetchall()
        return [_github_account_from_row(row) for row in rows]

    async def get_github_account(self, account_id: str, tenant_id: str) -> GithubAccountRecord:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                select id, tenant_id, label, username, token, is_default, created_at
                from public.github_accounts
                where id = %s and tenant_id = %s
                """,
                (account_id, tenant_id),
            )
            row = await cursor.fetchone()
        if row is None:
            raise KeyError("GitHub account not found")
        return _github_account_from_row(row)

    async def create_github_account(self, account: GithubAccountRecord) -> GithubAccountRecord:
        async with self.pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                """
                select id from public.github_accounts
                where tenant_id = %s and lower(label) = lower(%s)
                """,
                (account.tenant_id, account.label),
            )
            if await cursor.fetchone() is not None:
                raise ValueError("GitHub account label already exists")
            cursor = await connection.execute(
                "select id from public.github_accounts where tenant_id = %s limit 1",
                (account.tenant_id,),
            )
            is_default = account.is_default or await cursor.fetchone() is None
            await connection.execute(
                """
                insert into public.github_accounts
                  (id, tenant_id, label, username, token, is_default, created_at)
                values (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    account.id, account.tenant_id, account.label, account.username,
                    account.token, is_default, account.created_at,
                ),
            )
        stored = deepcopy(account)
        stored.is_default = is_default
        return stored

    async def delete_github_account(self, account_id: str, tenant_id: str) -> None:
        async with self.pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                """
                delete from public.github_accounts
                where id = %s and tenant_id = %s
                returning is_default
                """,
                (account_id, tenant_id),
            )
            row = await cursor.fetchone()
            if row is None:
                raise KeyError("GitHub account not found")
            if bool(row["is_default"]):
                await connection.execute(
                    """
                    update public.github_accounts set is_default = true
                    where id = (
                        select id from public.github_accounts
                        where tenant_id = %s order by created_at, id limit 1
                    )
                    """,
                    (tenant_id,),
                )

    async def set_default_github_account(
        self, account_id: str, tenant_id: str
    ) -> GithubAccountRecord:
        async with self.pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                "select id from public.github_accounts where id = %s and tenant_id = %s",
                (account_id, tenant_id),
            )
            if await cursor.fetchone() is None:
                raise KeyError("GitHub account not found")
            await connection.execute(
                "update public.github_accounts set is_default = (id = %s) where tenant_id = %s",
                (account_id, tenant_id),
            )
        return await self.get_github_account(account_id, tenant_id)


class PostgresCaseRepository:
    def __init__(self, database: PostgresRepositories) -> None:
        self._database = database

    async def create(self, case: CaseRecord) -> CaseRecord:
        return await self._database.create_case(case)

    async def append_event(
        self, case_id: str, *, actor: str, kind: str, payload: dict[str, object]
    ) -> None:
        await self._database.append_case_event(case_id, actor=actor, kind=kind, payload=payload)

    async def get(self, case_id: str, tenant_id: str) -> CaseRecord:
        return await self._fetch_case(
            """
            select c.id, c.tenant_id, c.ticket_key, c.domain, c.status,
                   c.cost_usd_micro, c.outcome
            from public.cases c
            where c.id = %s and c.tenant_id = %s
            order by c.created_at desc limit 1
            """,
            (case_id, tenant_id),
        )

    async def get_by_ticket(self, ticket_key: str, tenant_id: str) -> CaseRecord:
        return await self._fetch_case(
            """
            select c.id, c.tenant_id, c.ticket_key, c.domain, c.status,
                   c.cost_usd_micro, c.outcome
            from public.cases c
            where c.ticket_key = %s and c.tenant_id = %s
            order by c.created_at desc limit 1
            """,
            (ticket_key, tenant_id),
        )

    async def _fetch_case(
        self,
        statement: str,
        parameters: tuple[str, str],
    ) -> CaseRecord:
        async with self._database.pool.connection() as connection:
            cursor = await connection.execute(statement, parameters)
            row = await cursor.fetchone()
            if row is None:
                raise KeyError("Case not found")
            event_cursor = await connection.execute(
                """
                select actor, kind, payload, created_at
                from public.case_events where case_id = %s order by created_at, id
                """,
                (row["id"],),
            )
            event_rows = await event_cursor.fetchall()
        return CaseRecord(
            id=str(row["id"]), tenant_id=row["tenant_id"], ticket_key=row["ticket_key"],
            domain=row["domain"], status=row["status"],
            events=[
                CaseEvent(
                    actor=item["actor"], kind=item["kind"], payload=item["payload"],
                    created_at=item["created_at"],
                )
                for item in event_rows
            ],
            cost_usd_micro=int(row["cost_usd_micro"]), outcome=row["outcome"],
        )


class PostgresApprovalRepository:
    def __init__(self, database: PostgresRepositories) -> None:
        self._database = database

    async def create(self, approval: ApprovalRecord) -> ApprovalRecord:
        return await self._database.create_approval(approval)

    async def list(self, tenant_id: str) -> list[ApprovalRecord]:
        async with (
            self._database.pool.connection() as connection,
            connection.transaction(),
        ):
            cursor = await connection.execute(
                """
                update public.approvals set decision = 'expired', decided_at = now()
                where tenant_id = %s and decision is null and expires_at <= now()
                returning id
                """,
                (tenant_id,),
            )
            await cursor.fetchall()
            cursor = await connection.execute(
                """
                select * from public.approvals where tenant_id = %s
                order by created_at desc limit 200
                """,
                (tenant_id,),
            )
            rows = await cursor.fetchall()
        return [_approval_from_row(row) for row in rows]

    async def get(self, approval_id: str, tenant_id: str) -> ApprovalRecord:
        async with self._database.pool.connection() as connection, connection.transaction():
            await connection.execute(
                """
                update public.approvals set decision = 'expired', decided_at = now()
                where id = %s and tenant_id = %s and decision is null and expires_at <= now()
                """,
                (approval_id, tenant_id),
            )
            cursor = await connection.execute(
                "select * from public.approvals where id = %s and tenant_id = %s",
                (approval_id, tenant_id),
            )
            row = await cursor.fetchone()
        if row is None:
            raise KeyError("Approval not found")
        return _approval_from_row(row)

    async def decide(
        self, approval_id: str, tenant_id: str, decision: str, comment: str | None
    ) -> ApprovalRecord:
        async with self._database.pool.connection() as connection:
            cursor = await connection.execute(
                """
                update public.approvals
                set decision = %s, comment = %s, decided_at = now()
                where id = %s and tenant_id = %s and decision is null and expires_at > now()
                returning *
                """,
                (decision, str(redact(comment)) if comment is not None else None,
                 approval_id, tenant_id),
            )
            row = await cursor.fetchone()
        if row is None:
            raise ValueError("Approval is no longer pending")
        return _approval_from_row(row)


class PostgresSupportSendRepository:
    def __init__(self, database: PostgresRepositories) -> None:
        self._database = database

    async def authorize_and_send(
        self,
        receipt_id: str,
        approval_id: str,
        case_id: str,
        action_hash: str,
        ticket_key: str,
        body: str,
    ) -> SupportSendReceipt:
        return await self._database.authorize_and_send(
            receipt_id,
            approval_id,
            case_id,
            action_hash,
            ticket_key,
            body,
        )

    async def consume_receipt(
        self, receipt_id: str, approval_id: str, case_id: str, action_hash: str
    ) -> None:
        await self._database.consume_receipt(receipt_id, approval_id, case_id, action_hash)

    async def send_once(
        self, idempotency_key: str, case_id: str, ticket_key: str, body: str
    ) -> SupportSendReceipt:
        return await self._database.send_once(idempotency_key, case_id, ticket_key, body)


class PostgresFeedbackRepository:
    def __init__(self, database: PostgresRepositories) -> None:
        self._database = database

    async def store(self, feedback: FeedbackRecord) -> None:
        await self._database.store_feedback(feedback)


class PostgresGithubAccountRepository:
    def __init__(self, database: PostgresRepositories) -> None:
        self._database = database

    async def list(self, tenant_id: str) -> list[GithubAccountRecord]:
        return await self._database.list_github_accounts(tenant_id)

    async def get(self, account_id: str, tenant_id: str) -> GithubAccountRecord:
        return await self._database.get_github_account(account_id, tenant_id)

    async def create(self, account: GithubAccountRecord) -> GithubAccountRecord:
        return await self._database.create_github_account(account)

    async def delete(self, account_id: str, tenant_id: str) -> None:
        await self._database.delete_github_account(account_id, tenant_id)

    async def set_default(self, account_id: str, tenant_id: str) -> GithubAccountRecord:
        return await self._database.set_default_github_account(account_id, tenant_id)


def _github_account_from_row(row: dict[str, Any]) -> GithubAccountRecord:
    return GithubAccountRecord(
        id=str(row["id"]), tenant_id=str(row["tenant_id"]), label=str(row["label"]),
        username=str(row["username"]), token=str(row["token"]),
        is_default=bool(row["is_default"]), created_at=row["created_at"],
    )


def _approval_from_row(row: dict[str, Any]) -> ApprovalRecord:
    return ApprovalRecord(
        id=str(row["id"]), case_id=str(row["case_id"]), tenant_id=str(row["tenant_id"]),
        action=dict(row["action"]),
        evidence=list(row["evidence"]),
        approver=str(row["approver"]), scope=str(row["scope"]),
        expires_at=row["expires_at"],
        decision=str(row["decision"]) if row["decision"] is not None else None,
        comment=str(row["comment"]) if row["comment"] is not None else None,
        decided_at=row["decided_at"],
    )
