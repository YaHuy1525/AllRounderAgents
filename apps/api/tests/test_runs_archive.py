"""Run archive + history scope: terminal mirroring and GET /runs filters."""

from __future__ import annotations

from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import (
    MemoryRunArchive,
    NullRunArchive,
    RunService,
    RunServiceConfig,
    ScriptedMastraRunClient,
    build_memory_run_service,
)
from allrounder_api.runs.models import WorkflowRun
from allrounder_api.runs.service import _cost_usd_micro_from_output
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = b"run-receipt-secret-for-tests-0123456789"
REVIEW_STEPS = ("select-pr", "review-options", "ai-review", "complete")
ISSUES_STEPS = ("issue-selection", "analysis", "implementation", "complete")
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))


def _client(
    *,
    side_effecting: frozenset[str] = frozenset({"complete"}),
    fail_steps: frozenset[str] = frozenset(),
) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {"reviewFlow": REVIEW_STEPS, "issuesFlow": ISSUES_STEPS},
        side_effecting=side_effecting,
        fail_steps=fail_steps,
    )


def _service(
    client: ScriptedMastraRunClient,
    *,
    archive: object | None = None,
) -> RunService:
    return build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        mastra=client,
        archive=archive,  # type: ignore[arg-type]
        config=RunServiceConfig(),
    )


async def _start(service: RunService, *, ticket: str = "ABC-1", workflow: str = "review") -> str:
    run = await service.start(
        workflow=workflow,
        ticket_key=ticket,
        case_id="case-1",
        run_input={"repository": "acme/app"},
        principal=PRINCIPAL,
    )
    return run.run_id


async def _complete(service: RunService, run_id: str, steps: tuple[str, ...]) -> None:
    for step_id in steps:
        await service.decide(
            run_id=run_id, step_id=step_id, action="proceed", principal=PRINCIPAL
        )


# ------------------------------------------------------- terminal mirroring


async def test_completed_run_mirrors_into_the_archive() -> None:
    archive = MemoryRunArchive()
    service = _service(_client(), archive=archive)
    run_id = await _start(service)
    await _complete(service, run_id, REVIEW_STEPS)

    record = archive.records[run_id]
    assert record["status"] == "completed"
    steps = record["steps"]
    assert isinstance(steps, list)
    assert all(step["state"] == "done" for step in steps)


async def test_failed_run_mirrors_into_the_archive() -> None:
    archive = MemoryRunArchive()
    service = _service(_client(fail_steps=frozenset({"review-options"})), archive=archive)
    run_id = await _start(service)
    await service.decide(
        run_id=run_id, step_id="select-pr", action="proceed", principal=PRINCIPAL
    )
    # The failure fires when the failing step's own decision is applied.
    await service.decide(
        run_id=run_id, step_id="review-options", action="proceed", principal=PRINCIPAL
    )

    record = archive.records[run_id]
    assert record["status"] == "failed"


async def test_cancelled_run_mirrors_once_and_records_never_rewrite() -> None:
    archive = MemoryRunArchive()
    service = _service(_client(), archive=archive)
    run_id = await _start(service)
    await service.cancel(run_id=run_id, tenant_id="omnidewalt", reason="done")
    # A second cancel on a terminal run returns early: still exactly one row.
    await service.cancel(run_id=run_id, tenant_id="omnidewalt", reason="again")

    assert len(archive.records) == 1
    assert archive.records[run_id]["status"] == "cancelled"


async def test_archive_failure_never_fails_the_run() -> None:
    class ExplodingArchive:
        def __init__(self) -> None:
            self.calls = 0

        async def record(self, run: object) -> None:
            self.calls += 1
            raise RuntimeError("archive is down")

        async def list_recent(self, *args: object, **kwargs: object) -> list[dict[str, object]]:
            raise RuntimeError("archive is down")

    archive = ExplodingArchive()
    service = _service(_client(), archive=archive)
    run_id = await _start(service)
    await _complete(service, run_id, REVIEW_STEPS)

    detail = await service.get(run_id, "omnidewalt")
    assert detail.status == "completed"
    assert archive.calls >= 1


# ------------------------------------------------------------ history scope


def _history_api(
    archive: object | None = None,
) -> tuple[TestClient, MemoryRunArchive | None, RunService]:
    mem_archive = archive
    client = _client()
    service = _service(client, archive=mem_archive)
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": PRINCIPAL}),
        runs_service=service,
    )
    if isinstance(mem_archive, MemoryRunArchive):
        return TestClient(app), mem_archive, service
    return TestClient(app), None, service


def test_history_merges_sources_filters_and_paginates() -> None:
    http, _archive, _service_inst = _history_api(MemoryRunArchive())
    headers = {"Authorization": "Bearer tok"}

    def start(ticket: str, workflow: str) -> str:
        created = http.post(
            "/runs",
            json={
                "workflow": workflow,
                "ticketKey": ticket,
                "caseId": "case-1",
                "input": {"repository": "acme/app"},
            },
            headers=headers,
        )
        assert created.status_code == 201
        return str(created.json()["runId"])

    def proceed(run_id: str, steps: tuple[str, ...]) -> None:
        for step_id in steps:
            response = http.post(
                f"/runs/{run_id}/steps/{step_id}/decision",
                json={"action": "proceed"},
                headers=headers,
            )
            assert response.status_code == 200

    review_done = start("ABC-1", "review")
    proceed(review_done, REVIEW_STEPS)
    review_cancelled = start("ABC-2", "review")
    http.post(f"/runs/{review_cancelled}/cancel", json={"reason": "nope"}, headers=headers)
    issues_cancelled = start("ABC-3", "issues")
    http.post(f"/runs/{issues_cancelled}/cancel", json={"reason": "nope"}, headers=headers)

    # Active scope stays live-only: every run reached a terminal state.
    active = http.get("/runs", headers=headers).json()
    assert active["runs"] == []
    assert active["nextCursor"] is None

    everything = http.get("/runs", params={"scope": "history"}, headers=headers).json()
    assert {row["runId"] for row in everything["runs"]} == {
        review_done,
        review_cancelled,
        issues_cancelled,
    }
    assert everything["nextCursor"] is None

    filtered = http.get(
        "/runs",
        params={"scope": "history", "workflow": "review"},
        headers=headers,
    ).json()
    assert {row["runId"] for row in filtered["runs"]} == {review_done, review_cancelled}

    completed = http.get(
        "/runs",
        params={"scope": "history", "workflow": "review", "status": "completed"},
        headers=headers,
    ).json()
    assert [row["runId"] for row in completed["runs"]] == [review_done]

    # Keyset pagination: one row per page, cursor chained, no duplicates.
    seen: list[str] = []
    cursor: str | None = None
    for _ in range(3):
        params: dict[str, object] = {"scope": "history", "limit": 1}
        if cursor is not None:
            params["cursor"] = cursor
        page = http.get("/runs", params=params, headers=headers).json()
        assert len(page["runs"]) == 1
        seen.append(str(page["runs"][0]["runId"]))
        cursor = page["nextCursor"]
    assert cursor is None
    assert sorted(seen) == sorted({review_done, review_cancelled, issues_cancelled})

    # The ticket branch keeps its shape (plus the additive cursor key).
    ticket = http.get("/runs", params={"ticket": "ABC-2"}, headers=headers).json()
    assert [row["runId"] for row in ticket["runs"]] == [review_cancelled]
    assert ticket["nextCursor"] is None

    # An unknown status value is rejected by the contract.
    invalid = http.get(
        "/runs", params={"scope": "history", "status": "nope"}, headers=headers
    )
    assert invalid.status_code == 422


def test_history_without_an_archive_still_pages_redis() -> None:
    http, archive, _service_inst = _history_api(None)
    assert archive is None
    headers = {"Authorization": "Bearer tok"}
    created = http.post(
        "/runs",
        json={
            "workflow": "review",
            "ticketKey": "ABC-9",
            "caseId": "case-1",
            "input": {"repository": "acme/app"},
        },
        headers=headers,
    )
    run_id = created.json()["runId"]
    http.post(f"/runs/{run_id}/cancel", json={"reason": "done"}, headers=headers)

    history = http.get("/runs", params={"scope": "history"}, headers=headers).json()
    assert [row["runId"] for row in history["runs"]] == [run_id]


# ------------------------------------------------------------ benchmark scan


async def test_scan_workflows_filters_to_the_requested_lanes() -> None:
    archive = MemoryRunArchive()
    service = _service(_client(), archive=archive)
    review_id = await _start(service)
    await _complete(service, review_id, REVIEW_STEPS)
    issues_id = await _start(service, ticket="ABC-2", workflow="issues")
    await _complete(service, issues_id, ISSUES_STEPS)

    scanned = await archive.scan_workflows("omnidewalt", workflows=("review", "issues"))
    assert {run.run_id for run in scanned} == {review_id, issues_id}

    only_review = await archive.scan_workflows("omnidewalt", workflows=("review",))
    assert [run.run_id for run in only_review] == [review_id]

    # Another tenant is isolated; an empty lane list is empty.
    assert await archive.scan_workflows("someone-else", workflows=("review",)) == []
    assert await archive.scan_workflows("omnidewalt", workflows=()) == []


async def test_scan_workflows_returns_full_runs_newest_first_capped() -> None:
    archive = MemoryRunArchive()
    service = _service(_client(), archive=archive)
    first_id = await _start(service, ticket="ABC-1")
    await _complete(service, first_id, REVIEW_STEPS)
    second_id = await _start(service, ticket="ABC-2")
    await _complete(service, second_id, REVIEW_STEPS)

    # Newest first: the second run started later, so it leads the scan.
    ordered = await archive.scan_workflows("omnidewalt", workflows=("review",))
    assert [run.run_id for run in ordered] == [second_id, first_id]

    capped = await archive.scan_workflows("omnidewalt", workflows=("review",), limit=1)
    assert [run.run_id for run in capped] == [second_id]

    # The scan returns full runs: the proceeded gates carry recorded decisions,
    # which is exactly what the benchmark funnel reads.
    review_run = capped[0]
    assert any(step.decision is not None for step in review_run.steps)


async def test_null_archive_scan_is_empty() -> None:
    assert await NullRunArchive().scan_workflows("t", workflows=("review", "issues")) == []


# --------------------------------------------------------------- per-run cost


def _terminal_run(run_id: str = "r-cost", cost: int = 4_321) -> WorkflowRun:
    return WorkflowRun.from_dict(
        {
            "runId": run_id,
            "tenantId": "omnidewalt",
            "workflow": "review",
            "ticketKey": "ABC-1",
            "caseId": "case-1",
            "input": {},
            "steps": [],
            "status": "completed",
            "startedAt": "2026-10-11T00:00:00+00:00",
            "heartbeatAt": "2026-10-11T00:00:01+00:00",
            "finishedAt": "2026-10-11T00:00:02+00:00",
            "costUsdMicro": cost,
        }
    )


def test_workflow_run_serializes_cost_round_trip() -> None:
    run = _terminal_run()
    assert run.to_dict()["costUsdMicro"] == 4_321
    assert WorkflowRun.from_dict(run.to_dict()).cost_usd_micro == 4_321


async def test_archive_preserves_per_run_cost() -> None:
    archive = MemoryRunArchive()
    await archive.record(_terminal_run())
    assert archive.records["r-cost"]["cost_usd_micro"] == 4_321
    scanned = await archive.scan_workflows("omnidewalt", workflows=("review",))
    assert [run.cost_usd_micro for run in scanned] == [4_321]


def test_cost_from_output_is_defensively_sanitized() -> None:
    assert _cost_usd_micro_from_output(None) == 0
    assert _cost_usd_micro_from_output({}) == 0
    assert _cost_usd_micro_from_output({"costUsdMicro": 500}) == 500
    assert _cost_usd_micro_from_output({"costUsdMicro": 0}) == 0
    # Negative, bool, and non-int values collapse to 0 rather than corrupt the
    # archive; a lane that never instruments usage reports a clean zero.
    assert _cost_usd_micro_from_output({"costUsdMicro": -1}) == 0
    assert _cost_usd_micro_from_output({"costUsdMicro": True}) == 0
    assert _cost_usd_micro_from_output({"costUsdMicro": "500"}) == 0
