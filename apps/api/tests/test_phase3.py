from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.dispatcher import DeterministicDispatcher, normalize_jira_payload
from allrounder_api.finance import propose_posting, reconcile
from allrounder_api.finance_runs import (
    FinanceRunRecord,
    InMemoryFinanceRunRepository,
    PostgresFinanceRunRepository,
)
from allrounder_api.repositories import InMemoryApprovalRepository, InMemorySupportSendRepository
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

NOW = datetime(2026, 9, 7, tzinfo=UTC)
FIXTURE = json.loads(
    (Path(__file__).parents[3] / "fixtures" / "phase3_finance.json").read_text(encoding="utf-8")
)


def fixture_lines(side: str) -> list[dict[str, object]]:
    return [
        {
            "account": item["account"],
            "amountCents": item["amountCents"],
            "currency": item["currency"],
            "externalRef": item["externalRef"],
        }
        for item in FIXTURE[side]
    ]


def start_payload() -> dict[str, object]:
    return {
        "caseId": "case-fin-1",
        "ticketKey": "SCRUM-5",
        "period": FIXTURE["period"],
        "ledger": fixture_lines("ledger"),
        "bank": fixture_lines("bank"),
        "idempotencyKey": "fin-scrum-5-2026-08",
    }


def client_with_finance() -> tuple[
    TestClient,
    InMemoryFinanceRunRepository,
    InMemoryApprovalRepository,
    InMemorySupportSendRepository,
]:
    verifier = FakeBearerVerifier(
        {
            "agent": Principal("agent-1", "tenant-a", frozenset({"agent"})),
            "admin": Principal("admin-1", "tenant-a", frozenset({"admin"})),
            "approver": Principal("user-1", "tenant-a", frozenset({"approver"})),
            "viewer": Principal("viewer-1", "tenant-a", frozenset({"viewer"})),
            "other": Principal("viewer-2", "tenant-b", frozenset({"viewer"})),
        }
    )
    runs = InMemoryFinanceRunRepository()
    approvals = InMemoryApprovalRepository(clock=lambda: NOW)
    sends = InMemorySupportSendRepository()
    signer = ApprovalReceiptSigner(b"y" * 32, clock=lambda: NOW)
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=verifier,
        approval_repository=approvals,
        send_repository=sends,
        receipt_signer=signer,
        finance_runs=runs,
    )
    return TestClient(app), runs, approvals, sends


def test_reconcile_month_end_fixture_finds_three_exceptions() -> None:
    exceptions = reconcile(FIXTURE["ledger"], FIXTURE["bank"])
    expected = sorted(
        f"{item['type']}:{item['externalRef']}" for item in FIXTURE["expectedExceptions"]
    )
    actual = sorted(f"{item.type}:{item.external_ref}" for item in exceptions)
    assert actual == expected
    assert all(isinstance(item.delta_cents, int) for item in exceptions)
    posting = propose_posting(FIXTURE["period"], exceptions)
    assert posting is not None
    assert posting["ledger"] == "sandbox"


def test_dispatcher_routes_scrum_finance_content_without_project_map() -> None:
    payload = {
        "webhookEvent": "jira:issue_created",
        "timestamp": 1788720000999,
        "issue": {
            "id": "10099",
            "key": "SCRUM-5",
            "fields": {
                "project": {"key": "SCRUM"},
                "issuetype": {"name": "Task"},
                "labels": ["finance", "ledger", "reconciliation"],
                "priority": {"name": "High"},
                "summary": "Reconcile September month-end ledger against bank",
                "description": "Investigate unmatched journal and treasury variance",
                "reporter": {"accountId": "acct-9"},
                "attachment": [],
            },
        },
    }
    routed = DeterministicDispatcher().dispatch(normalize_jira_payload(payload))
    assert routed.verdict.domain.value == "finance"
    assert routed.workflow == "finance-comment-only"


def test_start_and_read_finance_run_are_role_and_tenant_scoped() -> None:
    client, _runs, _approvals, _sends = client_with_finance()
    agent = {"Authorization": "Bearer agent"}
    viewer = {"Authorization": "Bearer viewer"}

    assert client.post("/finance/runs", json=start_payload()).status_code == 401
    assert client.post("/finance/runs", headers=viewer, json=start_payload()).status_code == 403
    created = client.post("/finance/runs", headers=agent, json=start_payload())
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["status"] == "awaiting_approval"
    assert body["posting"]["ledger"] == "sandbox"
    assert len(body["exceptions"]) == 3
    assert all(check["passed"] for check in body["auditPack"]["checks"])

    run_id = body["id"]
    assert client.get(f"/finance/runs/{run_id}", headers=viewer).status_code == 200
    assert client.get(
        f"/finance/runs/{run_id}", headers={"Authorization": "Bearer other"}
    ).status_code == 404
    assert client.get(f"/finance/runs/{run_id}", headers=agent).status_code == 403


def test_start_is_idempotent_and_rejects_float_money() -> None:
    client, _runs, _approvals, _sends = client_with_finance()
    headers = {"Authorization": "Bearer admin"}
    first = client.post("/finance/runs", headers=headers, json=start_payload())
    second = client.post("/finance/runs", headers=headers, json=start_payload())
    assert first.json()["id"] == second.json()["id"]

    fractional = start_payload()
    fractional["ledger"] = [{**fixture_lines("ledger")[0], "amountCents": 10.5}]
    assert client.post("/finance/runs", headers=headers, json=fractional).status_code == 422


def test_posting_without_approval_fails_closed() -> None:
    client, _runs, _approvals, _sends = client_with_finance()
    admin = {"Authorization": "Bearer admin"}
    created = client.post("/finance/runs", headers=admin, json=start_payload())
    run_id = created.json()["id"]
    posting = created.json()["posting"]
    denied = client.post(
        f"/finance/runs/{run_id}/post",
        headers=admin,
        json={
            "approvalId": "missing",
            "caseId": "case-fin-1",
            "action": posting,
            "receipt": "not-an-approval-receipt",
        },
    )
    assert denied.status_code == 403
    replay_without_receipt = client.post(
        f"/finance/runs/{run_id}/post",
        headers=admin,
        json={"approvalId": "missing", "caseId": "case-fin-1", "action": posting},
    )
    assert replay_without_receipt.status_code in {403, 422}
    fetched = client.get(f"/finance/runs/{run_id}", headers={"Authorization": "Bearer viewer"})
    assert fetched.json()["status"] == "awaiting_approval"


def test_approved_receipt_posts_sandbox_and_replays_idempotently() -> None:
    client, _runs, _approvals, _sends = client_with_finance()
    admin = {"Authorization": "Bearer admin"}
    approver = {"Authorization": "Bearer approver"}
    created = client.post("/finance/runs", headers=admin, json=start_payload())
    run_id = created.json()["id"]
    posting = created.json()["posting"]
    approval = client.post(
        "/approvals",
        headers=approver,
        json={
            "caseId": "case-fin-1",
            "tenantId": "tenant-a",
            "action": posting,
            "evidence": [{"sourceId": "recon-pack", "span": "0-12"}],
            "approver": "user-1",
            "scope": "finance:post",
            "expiresAt": (NOW + timedelta(minutes=10)).isoformat(),
        },
    )
    assert approval.status_code == 201, approval.text
    approval_id = approval.json()["id"]
    decision = client.post(
        f"/approvals/{approval_id}/decision",
        headers=approver,
        json={"decision": "approved", "comment": "post sandbox"},
    )
    assert decision.status_code == 200
    receipt = decision.json()["receipt"]
    posted = client.post(
        f"/finance/runs/{run_id}/post",
        headers=approver,
        json={
            "approvalId": approval_id,
            "caseId": "case-fin-1",
            "action": posting,
            "receipt": receipt,
        },
    )
    assert posted.status_code == 200, posted.text
    assert posted.json()["status"] == "posted"
    assert posted.json()["artifact"].startswith("sandbox-post:")
    replay = client.post(
        f"/finance/runs/{run_id}/post",
        headers=approver,
        json={
            "approvalId": approval_id,
            "caseId": "case-fin-1",
            "action": posting,
            "receipt": receipt,
        },
    )
    assert replay.status_code == 200
    assert replay.json()["artifact"] == posted.json()["artifact"]


@pytest.mark.asyncio
async def test_repository_scopes_idempotency() -> None:
    repository = InMemoryFinanceRunRepository()
    record = FinanceRunRecord(
        id="run-1",
        case_id="case-1",
        tenant_id="tenant-a",
        ticket_key="SCRUM-5",
        period="2026-08",
        ledger=FIXTURE["ledger"],
        bank=FIXTURE["bank"],
        exceptions=[],
        audit_pack={"checks": []},
        posting={"ledger": "sandbox", "period": "2026-08", "lines": []},
        idempotency_key="key-1",
    )
    first = await repository.create(record)
    second = await repository.create(record)
    assert first.id == second.id
    with pytest.raises(KeyError):
        await repository.get("run-1", "tenant-b")


@pytest.mark.asyncio
async def test_postgres_finance_repository_uses_scoped_parameterized_writes() -> None:
    database = type("FakeDatabase", (), {"pool": FakePool()})()
    repository = PostgresFinanceRunRepository(database)  # type: ignore[arg-type]
    record = FinanceRunRecord(
        id="run-1",
        case_id="case-1",
        tenant_id="tenant-a",
        ticket_key="SCRUM-5",
        period="2026-08",
        ledger=FIXTURE["ledger"],
        bank=FIXTURE["bank"],
        exceptions=[],
        audit_pack={"checks": []},
        posting={"ledger": "sandbox", "period": "2026-08", "lines": [{"account": "1000"}]},
        idempotency_key="key-1",
    )
    assert (await repository.create(record)).tenant_id == "tenant-a"
    assert (await repository.get("run-1", "tenant-a")).id == "run-1"
    saved = await repository.post_sandbox(
        "run-1", "tenant-a", "a" * 64, "receipt-1", record.posting or {}
    )
    assert saved["ledger"] == "sandbox"
    assert all("%s" in statement for statement, _ in database.pool.value.calls)
    assert all(
        "tenant-a" in parameters
        for statement, parameters in database.pool.value.calls
        if "finance_" in statement
    )


def test_phase3_migration_forces_rls_and_removes_browser_grants() -> None:
    migration = (
        Path(__file__).parents[3] / "supabase" / "migrations" / "202609070006_phase3_finance.sql"
    ).read_text(encoding="utf-8")
    for table in ("finance_runs", "finance_postings"):
        assert f"alter table public.{table} force row level security" in migration
        assert f"revoke all on public.{table} from public, anon, authenticated" in migration
    assert "check (ledger = 'sandbox')" in migration
    assert "unique (tenant_id, action_hash)" in migration


class FakeCursor:
    def __init__(self, row: dict[str, object] | None) -> None:
        self._row = row

    async def fetchone(self) -> dict[str, object] | None:
        return self._row


class FakeConnection:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def execute(self, statement: str, parameters: tuple[object, ...]) -> FakeCursor:
        self.calls.append((statement, parameters))
        if "returning *" in statement or "from public.finance_runs" in statement:
            return FakeCursor(
                {
                    "id": "run-1",
                    "case_id": "case-1",
                    "tenant_id": "tenant-a",
                    "ticket_key": "SCRUM-5",
                    "period": "2026-08",
                    "ledger": FIXTURE["ledger"],
                    "bank": FIXTURE["bank"],
                    "exceptions": [],
                    "audit_pack": {"checks": []},
                    "posting": {
                        "ledger": "sandbox",
                        "period": "2026-08",
                        "lines": [{"account": "1000"}],
                    },
                    "status": "posted",
                    "idempotency_key": "key-1",
                    "artifact": "sandbox-post:" + "a" * 64,
                }
            )
        return FakeCursor({"finance_run_id": "run-1", "ledger": "sandbox"})


class FakeConnectionContext:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection

    async def __aenter__(self) -> FakeConnection:
        return self.connection

    async def __aexit__(self, *_args: object) -> None:
        return None


class FakePool:
    def __init__(self) -> None:
        self.value = FakeConnection()

    def connection(self) -> FakeConnectionContext:
        return FakeConnectionContext(self.value)
