"""Task 4 (PR1 T4): risk on approvals and the risk-then-age queue.

The ordering tests drive ``InMemoryApprovalRepository`` directly — the real
comparator, not a mock — and pin the queue rule both repositories share:
risk descending with nulls last, then oldest first. The Postgres ``ORDER BY
risk desc nulls last, created_at asc`` cannot be executed here (no test in
this repo touches Postgres), so it is text-verified against these cases.

The final review wave appends two more behaviors on the same axis: the
startup deploy gate that shouts when the ``risk`` column is missing (item 5),
and the declared top risk band the irreversible steps now carry (item 6).
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.phase1_api import ApprovalCreate
from allrounder_api.repositories import (
    ApprovalRecord,
    CaseRecord,
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
    InMemorySupportSendRepository,
    PostgresRepositories,
    _approval_from_row,
)
from allrounder_api.runs import (
    WORKFLOW_DEFINITIONS,
    ScriptedMastraRunClient,
    build_memory_run_service,
)
from allrounder_api.runs.models import RISK_IRREVERSIBLE, StepDefinition, WorkflowRun
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError
from structlog.testing import capture_logs

NOW = datetime(2026, 10, 21, 12, 0, 0, tzinfo=UTC)
TENANT = "omnidewalt"
PRINCIPAL = Principal("user-1", TENANT, frozenset({"agent", "approver", "admin"}))
SECRET = b"run-receipt-secret-for-tests-0123456789"
REVIEW_STEPS = ("select-pr", "review-options", "ai-review", "complete")


def _approval(approval_id: str, risk: int | None) -> ApprovalRecord:
    return ApprovalRecord(
        id=approval_id,
        case_id="case-1",
        tenant_id=TENANT,
        action={"draft": f"gate {approval_id}"},
        evidence=[{"sourceId": "doc-1", "span": "0-12"}],
        approver="user-1",
        scope="support:send",
        expires_at=NOW + timedelta(minutes=10),
        risk=risk,
    )


def _listed_ids(approvals: InMemoryApprovalRepository) -> list[str]:
    return [approval.id for approval in asyncio.run(approvals.list(TENANT))]


def test_risk_beats_age_across_bands() -> None:
    """The 90 created last is listed first: band dominates creation order."""
    approvals = InMemoryApprovalRepository(clock=lambda: NOW)
    asyncio.run(approvals.create(_approval("low-first", 10)))
    asyncio.run(approvals.create(_approval("medium", 55)))
    asyncio.run(approvals.create(_approval("high-last", 90)))
    assert _listed_ids(approvals) == ["high-last", "medium", "low-first"]


def test_age_is_the_tiebreak_within_a_band() -> None:
    """Two 55s come back oldest-first even with a 10 created between them."""
    approvals = InMemoryApprovalRepository(clock=lambda: NOW)
    asyncio.run(approvals.create(_approval("old-55", 55)))
    asyncio.run(approvals.create(_approval("mid-10", 10)))
    asyncio.run(approvals.create(_approval("new-55", 55)))
    assert _listed_ids(approvals) == ["old-55", "new-55", "mid-10"]


def test_unranked_sorts_after_every_declared_band() -> None:
    """risk=None lands last even against the lowest band and a newer 90."""
    approvals = InMemoryApprovalRepository(clock=lambda: NOW)
    asyncio.run(approvals.create(_approval("oldest", None)))
    asyncio.run(approvals.create(_approval("low", 10)))
    asyncio.run(approvals.create(_approval("newest-high", 90)))
    assert _listed_ids(approvals) == ["newest-high", "low", "oldest"]


def test_all_null_keeps_insertion_order() -> None:
    """Nothing silent re-ranks: an all-null set is pure creation order."""
    approvals = InMemoryApprovalRepository(clock=lambda: NOW)
    for approval_id in ("a", "b", "c", "d"):
        asyncio.run(approvals.create(_approval(approval_id, None)))
    assert _listed_ids(approvals) == ["a", "b", "c", "d"]


def test_approval_from_row_tolerates_a_missing_risk_key() -> None:
    """An un-migrated database (no risk column yet) must not crash reads."""
    row = {
        "id": "a1", "case_id": "case-1", "tenant_id": TENANT,
        "action": {}, "evidence": [], "approver": "user-1", "scope": "support:send",
        "expires_at": NOW, "decision": None, "comment": None, "decided_at": None,
    }
    assert _approval_from_row(row).risk is None
    row["risk"] = 90
    assert _approval_from_row(row).risk == 90


def _make_client(approvals: InMemoryApprovalRepository) -> TestClient:
    verifier = FakeBearerVerifier(
        {
            "approver-token": Principal(
                subject="user-1", tenant_id=TENANT, roles=frozenset({"approver"})
            )
        }
    )
    cases = InMemoryCaseRepository()
    asyncio.run(cases.create(CaseRecord(
        id="case-1", tenant_id=TENANT, ticket_key="SUP-1", domain="support", status="open"
    )))
    app = create_app(
        settings=Settings(
            webhook_secret=SecretStr("test"), cors_allow_origins=["https://ui.example"]
        ),
        auth_verifier=verifier,
        approval_repository=approvals,
        case_repository=cases,
        send_repository=InMemorySupportSendRepository(),
        receipt_signer=ApprovalReceiptSigner(b"y" * 32, clock=lambda: NOW),
    )
    return TestClient(app)


def _post_approval(client: TestClient, body: dict[str, object]) -> tuple[int, dict[str, object]]:
    response = client.post(
        "/approvals",
        headers={"Authorization": "Bearer approver-token"},
        json={
            "caseId": "case-1", "tenantId": TENANT,
            "action": {"draft": "Cited answer [doc-1:0-12]"},
            "evidence": [{"sourceId": "doc-1", "span": "0-12"}],
            "approver": "user-1", "scope": "support:send",
            "expiresAt": (NOW + timedelta(minutes=10)).isoformat(),
            **body,
        },
    )
    payload = response.json()
    return response.status_code, payload if isinstance(payload, dict) else {}


def test_approval_create_validates_the_risk_band() -> None:
    """Out-of-range bands are rejected; an absent band stays None; the 90
    accepted by the API surfaces in the listed queue."""
    client = _make_client(InMemoryApprovalRepository(clock=lambda: NOW))
    assert _post_approval(client, {"risk": 101})[0] == 422
    assert _post_approval(client, {"risk": -1})[0] == 422
    status_code, banded = _post_approval(client, {"risk": 90})
    assert status_code == 201
    assert banded["risk"] == 90
    status_code, bare = _post_approval(client, {})
    assert status_code == 201
    assert bare["risk"] is None
    listed = client.get(
        "/approvals", headers={"Authorization": "Bearer approver-token"}
    ).json()
    assert [item["risk"] for item in listed] == [90, None]
    with pytest.raises(ValidationError):
        ApprovalCreate.model_validate({
            "case_id": "case-1", "tenant_id": TENANT, "action": {},
            "evidence": [{"source_id": "doc-1", "span": "0-1"}],
            "approver": "user-1", "scope": "support:send",
            "expires_at": NOW.isoformat(), "risk": 101,
        })


def test_step_definition_rejects_a_typo_risk_band() -> None:
    """A band outside the policy/risk.yaml anchors fails loudly at import —
    a typo must not silently un-rank a gate."""
    StepDefinition(id="x", title="X", risk=55)
    StepDefinition(id="y", title="Y", risk=None)
    for band in (5, 50, 100, -10):
        with pytest.raises(ValueError):
            StepDefinition(id="x", title="X", risk=band)


def test_run_gate_stamps_the_default_band() -> None:
    """Side-effecting gate records 55, pure gate records 10 — the default
    rule off the shipped review definition, through the real service."""
    approvals = InMemoryApprovalRepository()
    cases = InMemoryCaseRepository()
    asyncio.run(cases.create(CaseRecord(
        id="case-1", tenant_id=TENANT, ticket_key="ABC-1", domain="coding", status="open"
    )))
    client = ScriptedMastraRunClient(
        {"reviewFlow": REVIEW_STEPS}, side_effecting=frozenset({"complete"})
    )
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=approvals,
        cases=cases,
        mastra=client,
    )

    async def drive() -> WorkflowRun:
        run = await service.start(
            workflow="review",
            ticket_key="ABC-1",
            case_id="case-1",
            run_input={"repository": "acme/app", "prNumber": 7},
            principal=PRINCIPAL,
        )
        for step_id in REVIEW_STEPS:
            await service.decide(
                run_id=run.run_id, step_id=step_id, action="proceed", principal=PRINCIPAL
            )
        return await service.get(run.run_id, TENANT)

    final = asyncio.run(drive())
    # Read the receipts the gates recorded: ai-review is pure (10), the
    # side-effecting complete step is single_risk (55).
    ai_review_decision = final.step("ai-review").decision
    complete_decision = final.step("complete").decision
    assert ai_review_decision is not None and complete_decision is not None
    assert asyncio.run(
        approvals.get(str(ai_review_decision["approvalId"]), TENANT)
    ).risk == 10
    assert asyncio.run(
        approvals.get(str(complete_decision["approvalId"]), TENANT)
    ).risk == 55


def test_renamed_step_leaves_the_gate_unranked_and_still_decides() -> None:
    """A run persisted before a step rename, resumed after it.

    The live run keeps the old step id while the shipped definition declares
    the new one, so the definition can no longer answer for that gate.
    ``_gate_risk`` must not raise (its own ``None`` fallback, the same one the
    queue rule uses for an unknown workflow): the approval records no band and
    sorts last, and the decision still lands with a receipt.
    """
    approvals = InMemoryApprovalRepository()
    cases = InMemoryCaseRepository()
    asyncio.run(cases.create(CaseRecord(
        id="case-1", tenant_id=TENANT, ticket_key="ABC-1", domain="coding", status="open"
    )))
    review = WORKFLOW_DEFINITIONS["review"]
    workflows = {"review": review}
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=approvals,
        cases=cases,
        mastra=ScriptedMastraRunClient(
            {"reviewFlow": REVIEW_STEPS}, side_effecting=frozenset({"complete"})
        ),
        workflows=workflows,
    )

    async def drive() -> WorkflowRun:
        run = await service.start(
            workflow="review",
            ticket_key="ABC-1",
            case_id="case-1",
            run_input={"repository": "acme/app", "prNumber": 7},
            principal=PRINCIPAL,
        )
        # Deploy the rename under the live run: the registry still holds
        # ``select-pr``, the definition now declares ``choose-pr``.
        workflows["review"] = replace(
            review,
            steps=(replace(review.steps[0], id="choose-pr"), *review.steps[1:]),
        )
        result = await service.decide(
            run_id=run.run_id, step_id="select-pr", action="proceed", principal=PRINCIPAL
        )
        return result.run

    decided = asyncio.run(drive())
    step = decided.step("select-pr")
    decision = step.decision
    assert decision is not None
    approval = asyncio.run(approvals.get(str(decision["approvalId"]), TENANT))
    assert approval.risk is None
    # The gate still decided and signed: nothing about the missing band is
    # allowed to reject the decision.
    assert step.receipt is not None
    assert step.state != "awaiting_human"
    # Unranked means unranked in the queue too: it is listed, and listed last.
    assert [item.risk for item in asyncio.run(approvals.list(TENANT))] == [None]


# ------------------------------------ fix wave item 5: the migration deploy gate
# ------------------- (wave 3 item 4 adds the boot-survival cases on the same seam)


class _RiskColumnCursor:
    def __init__(self, row: dict[str, int] | None) -> None:
        self._row = row

    async def fetchone(self) -> dict[str, int] | None:
        return self._row


class _RiskColumnConnection:
    """Records the statements the startup check runs and answers with one row."""

    def __init__(self, row: dict[str, int] | None) -> None:
        self.row = row
        self.statements: list[str] = []

    async def execute(self, sql: str, params: object = None) -> _RiskColumnCursor:
        self.statements.append(sql)
        return _RiskColumnCursor(self.row)


class _RiskColumnPool:
    """``AsyncConnectionPool`` stand-in: ``async with pool.connection()`` hands
    back one fake connection whose query yields a fixed row. No database, and
    no pool worker ever starts."""

    def __init__(self, row: dict[str, int] | None) -> None:
        self.connection_object = _RiskColumnConnection(row)
        self.checkouts = 0
        self.opened = 0

    async def open(self) -> None:
        self.opened += 1

    def connection(self) -> _RiskColumnPool:
        self.checkouts += 1
        return self

    async def __aenter__(self) -> _RiskColumnConnection:
        return self.connection_object

    async def __aexit__(self, *exc_info: object) -> None:
        return None


class _UnreachablePool(_RiskColumnPool):
    """Pool whose every checkout raises: the database is simply not there."""

    def connection(self) -> _UnreachablePool:
        self.checkouts += 1
        raise OSError("could not connect to the database")


def _repositories_with_column(row: dict[str, int] | None) -> PostgresRepositories:
    repositories = PostgresRepositories("postgresql://nobody@localhost:5500/nothing")
    repositories.pool = _RiskColumnPool(row)  # type: ignore[assignment] - no database here
    return repositories


def test_the_startup_check_shouts_when_the_risk_column_is_missing() -> None:
    """The migration is a hard deploy gate, so opening the Postgres repositories
    must say so at fatal level and name the file — once, not per request."""
    repositories = _repositories_with_column(None)
    with capture_logs() as logs:
        asyncio.run(repositories._check_approval_risk_column())

    events = [entry for entry in logs if entry["event"] == "approval_risk_column_missing"]
    assert len(events) == 1
    assert events[0]["log_level"] == "critical"
    assert "202610210016_approval_risk.sql" in str(events[0]["detail"])

    assert repositories.pool.checkouts == 1
    (sql,) = repositories.pool.connection_object.statements
    assert "information_schema.columns" in sql
    assert "'approvals'" in sql and "'risk'" in sql


def test_the_startup_check_is_silent_on_a_migrated_database() -> None:
    repositories = _repositories_with_column({"1": 1})
    with capture_logs() as logs:
        asyncio.run(repositories._check_approval_risk_column())

    assert [entry["event"] for entry in logs] == []
    assert repositories.pool.checkouts == 1


def test_an_unreachable_database_still_lets_the_repositories_open() -> None:
    """Wave 3 item 4: the deploy gate may not hold startup hostage.

    Before the check, ``open()`` never touched the database (the pool is built
    with ``min_size=0, open=False``), so an unreachable Postgres degraded per
    request instead of blocking boot. Running a real query from the startup
    handler made the API unbootable exactly when an operator most needs the
    health endpoint to apply the migration, so a raised check is contained and
    logged instead."""
    repositories = PostgresRepositories("postgresql://nobody@localhost:5500/nothing")
    repositories.pool = _UnreachablePool(None)  # type: ignore[assignment] - no database here

    asyncio.run(repositories.open())  # completes without raising

    assert repositories.pool.opened == 1  # the pool itself still opened
    assert repositories.pool.checkouts == 1  # the check really was attempted


def test_the_critical_still_shouts_through_open_on_an_unmigrated_database() -> None:
    """Containing the failure must not mute the finding: a pool that answers
    with no row still produces the critical migration message when the
    repositories open."""
    repositories = _repositories_with_column(None)
    with capture_logs() as logs:
        asyncio.run(repositories.open())

    events = [entry for entry in logs if entry["event"] == "approval_risk_column_missing"]
    assert [(entry["log_level"], entry["detail"] is not None) for entry in events] == [
        ("critical", True)
    ]
    assert repositories.pool.opened == 1
    assert repositories.pool.checkouts == 1


def test_a_failed_check_logs_its_own_event_and_not_the_critical() -> None:
    """The two failure modes stay distinguishable: an unreadable database logs
    ``approval_risk_column_check_failed`` with the exception info, and does not
    claim the column is missing when nothing was ever read."""
    repositories = PostgresRepositories("postgresql://nobody@localhost:5500/nothing")
    repositories.pool = _UnreachablePool(None)  # type: ignore[assignment] - no database here
    with capture_logs() as logs:
        asyncio.run(repositories.open())

    assert [entry["event"] for entry in logs] == ["approval_risk_column_check_failed"]
    failed = logs[0]
    assert failed["log_level"] == "error"
    # ``logger.exception`` attaches the active exception; ``capture_logs``
    # renders that as a flag rather than the object, so the assertion here is
    # that the event carries exception info at all.
    assert failed["exc_info"] is True


# ------------------------------------- fix wave item 6: the top band has producers


# The shipped steps whose action a revert cannot undo, one per lane. Wave 3
# removed two names from this list after checking the lanes that actually run
# them: ``dependencies.merge`` opens one PR per group on a bump branch and
# leaves the merge to a human (revertible), and ``security.contain`` executes
# whichever disposition a human approved, where close, escalate and recommend
# are dispositions too (a routine alert close is not a ledger posting).
IRREVERSIBLE_GATES = (
    ("bills", "post"),
    ("vendors", "create"),
    ("onboarding", "provision"),
    ("offboarding", "revoke"),
)

# Steps whose *name* sounds irreversible but whose shipped behavior is not,
# so they must fall back to the default side-effecting band.
DEFAULT_BAND_GATES = (
    ("dependencies", "merge"),
    ("security", "contain"),
)


def _gate_risk(workflow: str, step_id: str) -> int | None:
    """Ask the accessor the issuance path uses, offline.

    ``RunService._gate_risk`` reads only ``run.workflow`` and the shipped
    definition, so a bare record of the right lane answers for every gate in
    that lane without driving a pass.
    """
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        mastra=ScriptedMastraRunClient({}),
    )
    run = WorkflowRun(
        run_id="gate-1",
        tenant_id=TENANT,
        workflow=workflow,
        ticket_key="ABC-1",
        case_id="case-1",
        input={},
        steps=[],
    )
    return service._gate_risk(run, step_id)


def test_the_irreversible_steps_declare_the_top_band() -> None:
    assert RISK_IRREVERSIBLE == 90
    for workflow, step_id in IRREVERSIBLE_GATES:
        assert _gate_risk(workflow, step_id) == RISK_IRREVERSIBLE, f"{workflow}.{step_id}"


def test_only_the_named_steps_take_the_top_band() -> None:
    """Nothing else reached for 90: the annotation is the whole population, so
    the band stays a statement about irreversibility rather than a default."""
    declared = {
        (definition.id, step.id)
        for definition in WORKFLOW_DEFINITIONS.values()
        for step in definition.steps
        if step.risk == RISK_IRREVERSIBLE
    }
    assert declared == set(IRREVERSIBLE_GATES)


def test_the_other_gates_stay_on_the_default_rule() -> None:
    """A side effect that a revert can still undo keeps 55, a pure gate 10 —
    including the offboarding attestation next to the revocation it follows,
    and the two steps wave 3 dropped from the top band."""
    assert _gate_risk("review", "complete") == 55
    assert _gate_risk("offboarding", "attest") == 55
    assert _gate_risk("msp", "send") == 55
    assert _gate_risk("review", "ai-review") == 10
    assert _gate_risk("dependencies", "apply") == 10
    for workflow, step_id in DEFAULT_BAND_GATES:
        assert _gate_risk(workflow, step_id) == 55, f"{workflow}.{step_id}"
