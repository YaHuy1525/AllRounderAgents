"""Command-bar search (U1): scripted queries, deep links, and zero writes.

The done-criterion for the upgrade is literal: five scripted queries must
return the right ``run:step`` links and nothing the bar does may write. Both
are asserted here, including a byte-level check that signed receipt tokens
never leave the server through the search response.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.repositories import (
    ApprovalRecord,
    CaseRecord,
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
)
from allrounder_api.runs import (
    MemoryTargetLockStore,
    RunService,
    RunServiceConfig,
    ScriptedMastraRunClient,
    build_memory_run_service,
)
from allrounder_api.runs.models import WorkflowRun
from allrounder_api.search_api import resolve_search_intent
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = b"search-receipt-secret-for-tests-0123456789"
REVIEW_STEPS = ("select-pr", "review-options", "ai-review", "complete")
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))
VIEWER = Principal("user-2", "omnidewalt", frozenset({"viewer"}))
GUEST = Principal("user-3", "omnidewalt", frozenset({"guest"}))
TENANT = "omnidewalt"
AUTH = {"Authorization": "Bearer tok"}

SCRIPTED_QUERIES = (
    "which tickets wait on me?",
    "what's blocked?",
    "what is overdue?",
    "why is PR 77 blocked?",
    "open ABC-1",
    "receipts for ABC-3",
)


class _Clock:
    """Mutable service clock so tests can age runs for the overdue scope."""

    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def _lock_aware_client() -> ScriptedMastraRunClient:
    """Suspends at select-pr; only runs asking for a lock carry a target."""

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        target = run_input.get("lockTarget")
        artifact: dict[str, object] = {"stepId": step_id, "workflow": workflow}
        if isinstance(target, str) and target:
            artifact["target"] = target
        return artifact

    return ScriptedMastraRunClient(
        {"reviewFlow": REVIEW_STEPS},
        builder=builder,
        side_effecting=frozenset({"complete"}),
    )


def _make_service(
    clock: _Clock,
    cases: InMemoryCaseRepository,
    approvals: InMemoryApprovalRepository,
) -> tuple[RunService, ScriptedMastraRunClient]:
    client = _lock_aware_client()
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=approvals,
        cases=cases,
        mastra=client,
        max_concurrent=5,
        config=RunServiceConfig(),
        clock=clock,
        locks=MemoryTargetLockStore(),
    )
    return service, client


async def _start(
    service: RunService, ticket: str, **input_extra: object
) -> WorkflowRun:
    payload: dict[str, object] = {"repository": "acme/app", **input_extra}
    return await service.start(
        workflow="review",
        ticket_key=ticket,
        case_id=f"case-{ticket}",
        run_input=payload,
        principal=PRINCIPAL,
    )


async def _seed_async() -> tuple[
    TestClient,
    RunService,
    ScriptedMastraRunClient,
    InMemoryCaseRepository,
    InMemoryApprovalRepository,
    dict[str, WorkflowRun],
]:
    """Four runs telling one story: aged, lock-blocked, waiting, receipted."""

    cases = InMemoryCaseRepository()
    approvals = InMemoryApprovalRepository()
    clock = _Clock(datetime.now(UTC) - timedelta(hours=2))
    service, mastra = _make_service(clock, cases, approvals)
    aged = await _start(service, "OPS-9", lockTarget="acme/app#77")
    clock.now = datetime.now(UTC)
    blocked = await _start(service, "ABC-1", prNumber=77, lockTarget="acme/app#77")
    waiting = await _start(service, "ABC-2")
    receipted = await _start(service, "ABC-3")
    await service.decide(
        run_id=receipted.run_id,
        step_id="select-pr",
        action="proceed",
        principal=PRINCIPAL,
    )
    await cases.create(
        CaseRecord(
            id="case-ABC-3",
            tenant_id=TENANT,
            ticket_key="ABC-3",
            domain="support",
            status="open",
        )
    )
    await approvals.create(
        ApprovalRecord(
            id="appr-1",
            case_id="case-ABC-3",
            tenant_id=TENANT,
            action={"tool": "send", "summary": "approve refund"},
            evidence=[],
            approver="teamlead",
            scope="hr-help:approve",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
    )
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": PRINCIPAL, "viewer": VIEWER, "guest": GUEST}),
        runs_service=service,
        approval_repository=approvals,
        case_repository=cases,
    )
    runs = {
        "aged": aged,
        "blocked": blocked,
        "waiting": waiting,
        "receipted": receipted,
    }
    return TestClient(app), service, mastra, cases, approvals, runs


def _seeded() -> tuple[
    TestClient,
    RunService,
    ScriptedMastraRunClient,
    InMemoryCaseRepository,
    InMemoryApprovalRepository,
    dict[str, WorkflowRun],
]:
    return asyncio.run(_seed_async())


def _search(client: TestClient, query: str) -> dict[str, object]:
    response = client.get("/search", params={"q": query}, headers=AUTH)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert isinstance(payload, dict)
    return payload


# ------------------------------------------------------------------- intents


def test_intent_resolution_is_deterministic() -> None:
    plan = resolve_search_intent("which tickets wait on me?")
    assert (plan.intent, plan.scope) == ("list", "awaiting")

    plan = resolve_search_intent("what's blocked?")
    assert (plan.intent, plan.scope) == ("list", "blocked")

    plan = resolve_search_intent("what is overdue?")
    assert (plan.intent, plan.scope) == ("list", "overdue")

    plan = resolve_search_intent("why is PR 77 blocked?")
    assert plan.intent == "why"
    assert plan.tokens == ("pr", "77")

    plan = resolve_search_intent("open ABC-1")
    assert plan.intent == "do"
    assert plan.tokens == ("abc-1",)

    plan = resolve_search_intent("receipts for ABC-3")
    assert plan.intent == "find"
    assert plan.tokens == ("receipts", "abc-3")


# ----------------------------------------------------------- scripted queries


def test_search_api_answers_the_command_bar_queries() -> None:
    client, service, _, _, _, runs = _seeded()

    # 1. "which tickets wait on me?" -> every awaiting run with its step link.
    payload = _search(client, "which tickets wait on me?")
    assert payload["intent"] == "list"
    assert payload["scope"] == "awaiting"
    results = payload["results"]
    assert isinstance(results, list)
    assert {row["id"] for row in results} == {
        runs["aged"].run_id,
        runs["waiting"].run_id,
        runs["receipted"].run_id,
    }
    for row in results:
        assert row["status"] == "awaiting_human"
        assert row["ticketKey"] is not None
        assert row["stepId"] in ("select-pr", "review-options")

    # 2. "what's blocked?" -> the lock-blocked run, reason in the snippet.
    payload = _search(client, "what's blocked?")
    results = payload["results"]
    assert [row["id"] for row in results] == [runs["blocked"].run_id]
    assert results[0]["status"] == "blocked"
    assert results[0]["stepId"] == "select-pr"
    assert "acme/app#77" in str(results[0]["snippet"])

    # 3. "what is overdue?" -> only the run aged past the threshold.
    payload = _search(client, "what is overdue?")
    results = payload["results"]
    assert [row["id"] for row in results] == [runs["aged"].run_id]

    # 4. "why is PR 77 blocked?" -> blocked reason + log line + step link.
    payload = _search(client, "why is PR 77 blocked?")
    assert payload["intent"] == "why"
    results = payload["results"]
    assert results[0]["id"] == runs["blocked"].run_id
    reason = str(results[0]["reason"])
    assert "acme/app#77" in reason and "held by" in reason
    assert "stepState=blocked" in str(results[0]["logLine"])
    assert results[0]["stepId"] == "select-pr"

    # 5. "open ABC-1" -> a deep link onto that ticket's step.
    payload = _search(client, "open ABC-1")
    assert payload["intent"] == "do"
    results = payload["results"]
    assert results[0]["kind"] == "run"
    assert results[0]["ticketKey"] == "ABC-1"
    assert results[0]["stepId"] == "select-pr"

    # 6. "receipts for ABC-3" -> hashed receipt hints, never the signed token.
    payload = _search(client, "receipts for ABC-3")
    receipt_rows = [row for row in payload["results"] if row["kind"] == "receipt"]
    assert receipt_rows, payload
    assert receipt_rows[0]["runId"] == runs["receipted"].run_id
    assert str(receipt_rows[0]["receipt"]).startswith("action:")
    signed = (
        asyncio.run(service.get(runs["receipted"].run_id, TENANT)).step("select-pr").receipt
    )
    assert signed is not None
    assert signed not in json.dumps(payload)

    # Approvals are searchable through their case ticket — both the seeded
    # gate and the receipt-backed decision records the run service writes.
    payload = _search(client, "approvals for ABC-3")
    approval_rows = [row for row in payload["results"] if row["kind"] == "approval"]
    assert {row["id"] for row in approval_rows} >= {"appr-1"}
    seeded_row = next(row for row in approval_rows if row["id"] == "appr-1")
    assert seeded_row["ticketKey"] == "ABC-3"
    assert seeded_row["stepId"] == "approve"


# --------------------------------------------------------------------- auth


def test_search_api_requires_a_bearer_and_a_console_role() -> None:
    client, _service, _mastra, _cases, _approvals, _runs = _seeded()

    response = client.get("/search", params={"q": "open ABC-1"})
    assert response.status_code == 401

    response = client.get(
        "/search",
        params={"q": "open ABC-1"},
        headers={"Authorization": "Bearer guest"},
    )
    assert response.status_code == 403

    response = client.get(
        "/search",
        params={"q": "open ABC-1"},
        headers={"Authorization": "Bearer viewer"},
    )
    assert response.status_code == 200


# ---------------------------------------------------------------- zero writes


async def _snapshot(
    service: RunService,
    cases: InMemoryCaseRepository,
    approvals: InMemoryApprovalRepository,
) -> dict[str, object]:
    recent = await service.registry.list_recent(TENANT, 100)
    return {
        "runs": json.dumps([run.to_dict() for run in recent], sort_keys=True, default=str),
        "histories": {
            run.run_id: len(await service.history(run.run_id)) for run in recent
        },
        "approvals": json.dumps(
            [record.__dict__ for record in await approvals.list(TENANT)],
            sort_keys=True,
            default=str,
        ),
        "caseEvents": len((await cases.get("case-ABC-3", TENANT)).events),
    }


def test_search_api_performs_zero_writes() -> None:
    client, service, mastra, cases, approvals, _runs = _seeded()
    before = asyncio.run(_snapshot(service, cases, approvals))
    before_calls = list(mastra.calls)

    for query in SCRIPTED_QUERIES:
        _search(client, query)

    after = asyncio.run(_snapshot(service, cases, approvals))
    assert after == before
    # The engine trail is untouched too: search never starts, resumes, or decides.
    assert mastra.calls == before_calls
