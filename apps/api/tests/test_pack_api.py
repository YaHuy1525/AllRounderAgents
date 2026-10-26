"""Per-case audit pack (U6): one case, all its runs, the full lane evidence.

Two layers are pinned here. The builder: the archive ∪ registry union scoped
to the exact case, the receipt re-verification inherited from the MSP pack,
and the evidence walk that lifts ``citations`` and ``files`` out of lane
artifacts (nested anywhere, deduped per step, bool-safe counts) alongside the
case cost. The endpoint: ``GET /cases/{case_id}/pack`` role gates, 404 for
unknown or foreign cases, the sanitized PDF filename, and a JSON body that
proves the U6 done-criterion end to end — decisions + receipts + citations +
diffs + cost from a real seeded run. The decision records are crafted with the
same hash/signing functions the run service uses, so the verification path is
exercised against genuine tokens.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.audit_pack import AuditPackBuilder, render_pdf
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.repositories import (
    CaseRecord,
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
)
from allrounder_api.runs import (
    WORKFLOW_DEFINITIONS,
    InMemoryRunRegistry,
    MemoryRunArchive,
    RunService,
    RunServiceConfig,
    ScriptedMastraRunClient,
    action_hash,
    build_memory_run_service,
    content_hash,
)
from allrounder_api.runs.definitions import side_effect_scope
from allrounder_api.runs.models import RunStep, WorkflowRun
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = b"case-pack-receipt-secret-for-tests-0123456"
TENANT = "omnidewalt"
CASE_ID = "case-ABC-9"
TICKET = "ABC-9"
STARTED = datetime(2026, 9, 15, 9, 0, tzinfo=UTC)
DECIDED_AT = STARTED + timedelta(minutes=30)
FIRST_RUN = "11111111-1111-4111-8111-111111111111"
LIVE_RUN = "22222222-2222-4222-8222-222222222222"

PRINCIPAL = Principal("user-1", TENANT, frozenset({"agent", "approver", "admin"}))
VIEWER = Principal("user-2", TENANT, frozenset({"viewer"}))
GUEST = Principal("user-3", TENANT, frozenset({"guest"}))
AUTH = {"Authorization": "Bearer tok"}
VIEWER_AUTH = {"Authorization": "Bearer viewer"}
GUEST_AUTH = {"Authorization": "Bearer guest"}
# Pinned so seeded receipts verify as of their decision time, never wall-clock.
CLOCK = datetime(2026, 9, 15, 12, 0, tzinfo=UTC)
REVIEW_STEPS = ("select-pr", "review-options", "ai-review", "complete")


# ------------------------------------------------------------ builder pins


def _review_run(
    *,
    run_id: str = FIRST_RUN,
    status: str = "completed",
    case_id: str = CASE_ID,
    started_at: datetime = STARTED,
) -> WorkflowRun:
    definition = WORKFLOW_DEFINITIONS["review"]
    steps = [
        RunStep(step_id=step.id, index=index, title=step.title)
        for index, step in enumerate(definition.steps)
    ]
    run = WorkflowRun(
        run_id=run_id,
        tenant_id=TENANT,
        workflow="review",
        ticket_key=TICKET,
        case_id=case_id,
        input={"repository": "acme/app", "prNumber": 77},
        steps=steps,
        status=status,
        started_at=started_at,
        heartbeat_at=started_at,
        finished_at=started_at + timedelta(hours=1) if status == "completed" else None,
    )
    run.step("select-pr").artifact = {"repository": "acme/app", "prNumber": 77}
    run.step("select-pr").state = "done"
    run.step("review-options").artifact = {"options": [{"label": "standard"}]}
    run.step("review-options").state = "done"
    # Nested on purpose: the walker must find citations wherever they sit.
    # One duplicate, one spanless, and two unparseable entries ride along.
    run.step("ai-review").artifact = {
        "review": {
            "summary": "One policy citation applies.",
            "citations": [
                {"sourceId": "kb-remote-work", "span": "remote-work.md#L4-L9"},
                {"sourceId": "kb-remote-work", "span": "remote-work.md#L4-L9"},
                {"sourceId": "kb-benefits", "span": "benefits.md#L1"},
                {"sourceId": "kb-onboarding"},
                {"sourceId": ""},
                {"span": "no source"},
            ],
        }
    }
    run.step("ai-review").state = "done"
    run.step("complete").artifact = {
        "pr": {"url": "https://github.com/acme/app/pull/77", "number": 77},
        "files": [
            {
                "path": "src/app.ts",
                "status": "modified",
                "additions": 12,
                "deletions": 3,
                "area": "api",
            },
            {
                "path": "src/legacy.ts",
                "status": "removed",
                "additions": True,
                "deletions": 8,
            },
            {
                "path": "src/app.ts",
                "status": "modified",
                "additions": 12,
                "deletions": 3,
                "area": "api",
            },
            {"path": ""},
        ],
    }
    return run


def _decide(
    run: WorkflowRun,
    step_id: str,
    signer: ApprovalReceiptSigner,
    *,
    action: str = "proceed",
    approvals: str = "ap-1",
    edits: dict[str, object] | None = None,
    decided_at: datetime = DECIDED_AT,
) -> None:
    """Mirror ``RunService._approve_step`` exactly (hash-stable binding)."""

    step = run.step(step_id)
    definition = WORKFLOW_DEFINITIONS[run.workflow]
    scope = (
        side_effect_scope(run.workflow, step_id)
        if definition.step(step_id).side_effecting
        else f"run:{run.workflow}"
    )
    action_dict: dict[str, object] = {
        "workflow": run.workflow,
        "runId": run.run_id,
        "stepId": step_id,
        "action": action,
        "artifactHash": content_hash(step.artifact or {}),
    }
    if edits is not None:
        action_dict["editsHash"] = content_hash(edits)
    digest = action_hash(action_dict)
    receipt = signer.issue(
        approval_id=approvals,
        case_id=run.case_id,
        action=action_dict,
        approver="jane",
        scope=scope,
        decision="approved",
        expires_at=decided_at + timedelta(hours=1),
        run_id=run.run_id,
    )
    step.decision = {
        "action": action,
        "edits": edits,
        "actionHash": digest,
        "approvalId": approvals,
        "receiptId": f"r-{step_id}",
        "approver": "jane",
        "decidedAt": decided_at.isoformat(),
    }
    step.receipt = receipt
    step.action_hash = digest
    step.updated_at = decided_at
    step.state = "done"


def _builder(
    signer: ApprovalReceiptSigner,
    *,
    archive: MemoryRunArchive,
    registry: InMemoryRunRegistry,
    cases: InMemoryCaseRepository | None,
    clock: datetime = datetime(2026, 10, 5, tzinfo=UTC),
) -> AuditPackBuilder:
    return AuditPackBuilder(
        archive=archive,
        registry=registry,
        signer=signer,
        cases=cases,
        workflows=WORKFLOW_DEFINITIONS,
        clock=lambda: clock,
    )


def _steps_by_id(pack: dict[str, object], run_id: str) -> dict[str, dict[str, object]]:
    runs = pack["runs"]
    assert isinstance(runs, list)
    for run in runs:
        if run["runId"] == run_id:
            return {step["stepId"]: step for step in run["steps"]}
    raise AssertionError(f"run {run_id} missing from pack")


async def _seed_full_case(
    signer: ApprovalReceiptSigner,
    archive: MemoryRunArchive,
    registry: InMemoryRunRegistry,
    cases: InMemoryCaseRepository,
) -> WorkflowRun:
    """One completed review run with every evidence shape, one in flight."""

    run = _review_run()
    options = run.step("review-options")
    options.decision = {
        "action": "regenerate",
        "guidance": "Ask for the ticket link.",
        "regenerations": 1,
    }
    options.updated_at = DECIDED_AT
    _decide(run, "complete", signer)
    await archive.record(run)
    await registry.save(run)
    live = _review_run(
        run_id=LIVE_RUN, status="running", started_at=STARTED + timedelta(minutes=1)
    )
    await registry.save(live)
    await cases.create(
        CaseRecord(
            id=CASE_ID,
            tenant_id=TENANT,
            ticket_key=TICKET,
            domain="support",
            status="open",
            cost_usd_micro=2500,
            outcome="replied",
        )
    )
    await cases.append_event(
        CASE_ID, actor="system", kind="run_started", payload={"runId": run.run_id}
    )
    await cases.append_event(
        CASE_ID, actor="human", kind="status_changed", payload={"status": "open"}
    )
    return run


async def test_build_case_pack_carries_the_full_lane_evidence() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    cases = InMemoryCaseRepository()
    await _seed_full_case(signer, archive, registry, cases)

    pack = await _builder(signer, archive=archive, registry=registry, cases=cases).build_case(
        tenant_id=TENANT, case_id=CASE_ID
    )
    assert pack["packVersion"] == "v0"
    assert pack["packKind"] == "case"
    assert pack["packKey"] == f"{TENANT}:{CASE_ID}"
    assert pack["tenantId"] == TENANT
    assert pack["caseId"] == CASE_ID
    assert pack["ticketKey"] == TICKET
    assert pack["domain"] == "support"
    assert pack["status"] == "open"
    assert pack["outcome"] == "replied"
    assert pack["generatedAt"] == "2026-10-05T00:00:00+00:00"
    assert pack["summary"] == {
        "caseCount": 1,
        "runCount": 2,
        "completedRuns": 1,
        "failedRuns": 0,
        "cancelledRuns": 0,
        "decisionCount": 2,
        "receiptsVerified": 1,
        "receiptsFailed": 0,
        "eventCount": 2,
        "costUsdMicro": 2500,
        "citationCount": 3,
        "changedFileCount": 2,
    }
    assert [item["runId"] for item in pack["runs"]] == [FIRST_RUN, LIVE_RUN]

    # Citations: found nested, deduped per step, span defaults to "".
    assert pack["citations"] == [
        {
            "runId": FIRST_RUN,
            "stepId": "ai-review",
            "sourceId": "kb-remote-work",
            "span": "remote-work.md#L4-L9",
        },
        {
            "runId": FIRST_RUN,
            "stepId": "ai-review",
            "sourceId": "kb-benefits",
            "span": "benefits.md#L1",
        },
        {
            "runId": FIRST_RUN,
            "stepId": "ai-review",
            "sourceId": "kb-onboarding",
            "span": "",
        },
    ]
    # Diffs: deduped per (step, path); a bool addition never passes as a count.
    assert pack["changedFiles"] == [
        {
            "runId": FIRST_RUN,
            "stepId": "complete",
            "path": "src/app.ts",
            "status": "modified",
            "additions": 12,
            "deletions": 3,
            "area": "api",
        },
        {
            "runId": FIRST_RUN,
            "stepId": "complete",
            "path": "src/legacy.ts",
            "status": "removed",
            "additions": 0,
            "deletions": 8,
        },
    ]

    case_payload = pack["cases"][0]
    assert case_payload["caseId"] == CASE_ID
    assert case_payload["costUsdMicro"] == 2500
    assert [event["kind"] for event in case_payload["events"]] == [
        "run_started",
        "status_changed",
    ]

    steps = _steps_by_id(pack, FIRST_RUN)
    assert steps["review-options"]["decision"]["action"] == "regenerate"
    assert steps["review-options"]["verification"] == {
        "actionHashMatches": None,
        "receiptVerified": None,
        "reason": "no_receipt_required",
    }
    assert steps["complete"]["decision"]["approver"] == "jane"
    assert steps["complete"]["verification"] == {
        "actionHashMatches": True,
        "receiptVerified": True,
        "reason": None,
    }
    assert "decision" not in steps["select-pr"]
    # Decision-time pinning: the builder clock is 20 days past the receipts'
    # one-hour TTL, yet the summary above still counts them verified.


async def test_build_case_scopes_runs_to_the_exact_case() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    cases = InMemoryCaseRepository()
    await cases.create(
        CaseRecord(
            id=CASE_ID, tenant_id=TENANT, ticket_key=TICKET, domain="support", status="open"
        )
    )
    run = _review_run()
    await archive.record(run)
    # A prefix-matching neighbour must not leak in through the archive scan...
    neighbour = _review_run(
        run_id="33333333-3333-4333-8333-333333333333", case_id=f"{CASE_ID}-extra"
    )
    await archive.record(neighbour)
    # ...and a foreign live run must not leak in through the registry.
    foreign = _review_run(
        run_id="44444444-4444-4444-8444-444444444444", case_id="case-OTHER-1"
    )
    await registry.save(foreign)
    await registry.save(run)
    live = _review_run(
        run_id=LIVE_RUN, status="running", started_at=STARTED + timedelta(minutes=1)
    )
    await registry.save(live)

    pack = await _builder(signer, archive=archive, registry=registry, cases=cases).build_case(
        tenant_id=TENANT, case_id=CASE_ID
    )
    assert [item["runId"] for item in pack["runs"]] == [FIRST_RUN, LIVE_RUN]
    assert pack["summary"]["runCount"] == 2
    assert pack["summary"]["eventCount"] == 0


async def test_build_case_requires_a_known_case() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    cases = InMemoryCaseRepository()
    unscoped = _builder(
        signer, archive=MemoryRunArchive(), registry=InMemoryRunRegistry(), cases=None
    )
    with pytest.raises(KeyError):
        await unscoped.build_case(tenant_id=TENANT, case_id=CASE_ID)

    scoped = _builder(
        signer, archive=MemoryRunArchive(), registry=InMemoryRunRegistry(), cases=cases
    )
    with pytest.raises(KeyError):
        await scoped.build_case(tenant_id=TENANT, case_id=CASE_ID)

    # A case in another tenant is not this tenant's case, and vice versa.
    await cases.create(
        CaseRecord(
            id=CASE_ID, tenant_id="otherco", ticket_key=TICKET, domain="support", status="open"
        )
    )
    with pytest.raises(KeyError):
        await scoped.build_case(tenant_id=TENANT, case_id=CASE_ID)
    pack = await scoped.build_case(tenant_id="otherco", case_id=CASE_ID)
    assert pack["tenantId"] == "otherco"
    assert pack["summary"]["runCount"] == 0
    assert pack["runs"] == []


async def test_build_case_flags_a_tampered_receipt_and_still_walks() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    cases = InMemoryCaseRepository()
    run = _review_run()
    _decide(run, "complete", signer)
    await archive.record(run)
    await cases.create(
        CaseRecord(
            id=CASE_ID, tenant_id=TENANT, ticket_key=TICKET, domain="support", status="open"
        )
    )
    # Rewrite the surviving artifact: the recomputed action hash no longer
    # matches, and the pack reports the tamper instead of the files it lost.
    archive.records[run.run_id]["steps"][3]["artifact"] = {"pr": {}}

    pack = await _builder(signer, archive=archive, registry=registry, cases=cases).build_case(
        tenant_id=TENANT, case_id=CASE_ID
    )
    assert pack["summary"]["decisionCount"] == 1
    assert pack["summary"]["receiptsVerified"] == 0
    assert pack["summary"]["receiptsFailed"] == 1
    assert pack["summary"]["changedFileCount"] == 0
    steps = _steps_by_id(pack, FIRST_RUN)
    assert steps["complete"]["verification"] == {
        "actionHashMatches": False,
        "receiptVerified": False,
        "reason": "action_hash_mismatch",
    }
    # The citations on the untouched ai-review artifact still walk through.
    assert len(pack["citations"]) == 3


async def test_render_pdf_renders_case_packs_with_evidence() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    cases = InMemoryCaseRepository()
    await _seed_full_case(signer, archive, registry, cases)
    pack = await _builder(signer, archive=archive, registry=registry, cases=cases).build_case(
        tenant_id=TENANT, case_id=CASE_ID
    )
    pdf = render_pdf(pack)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 2_000

    # The empty-evidence branches render too, and stay case-shaped.
    minimal = render_pdf(
        {
            "packVersion": "v0",
            "packKind": "case",
            "packKey": f"{TENANT}:{CASE_ID}",
            "tenantId": TENANT,
            "caseId": CASE_ID,
            "ticketKey": TICKET,
            "domain": "support",
            "status": "open",
            "outcome": None,
            "generatedAt": "2026-10-05T00:00:00+00:00",
            "summary": {"caseCount": 1, "runCount": 0},
            "citations": [],
            "changedFiles": [],
            "cases": [],
            "runs": [],
        }
    )
    assert minimal.startswith(b"%PDF")
    assert len(minimal) > 1_000


# ----------------------------------------------------------- endpoint pins


def _evidence_client() -> ScriptedMastraRunClient:
    """Artifacts carrying a citation (ai-review) and a diff (complete)."""

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        if step_id == "ai-review":
            return {
                "summary": "One policy citation applies.",
                "citations": [
                    {"sourceId": "kb-remote-work", "span": "remote-work.md#L4-L9"},
                ],
            }
        if step_id == "complete":
            return {
                "pr": {"url": "https://github.com/acme/app/pull/77", "number": 77},
                "files": [
                    {
                        "path": "src/app.ts",
                        "status": "modified",
                        "additions": 12,
                        "deletions": 3,
                    },
                ],
            }
        return {"stepId": step_id, "workflow": workflow}

    return ScriptedMastraRunClient(
        {"reviewFlow": REVIEW_STEPS},
        builder=builder,
        side_effecting=frozenset({"complete"}),
    )


def _api() -> tuple[TestClient, InMemoryCaseRepository, RunService]:
    cases = InMemoryCaseRepository()
    signer = ApprovalReceiptSigner(SECRET)
    service = build_memory_run_service(
        signer=signer,
        # Both the approvals repo and the service run on the pinned clock, so
        # a receipt issued at decision time is not instantly "expired".
        approvals=InMemoryApprovalRepository(clock=lambda: CLOCK),
        cases=cases,
        mastra=_evidence_client(),
        config=RunServiceConfig(),
        clock=lambda: CLOCK,
    )
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": PRINCIPAL, "viewer": VIEWER, "guest": GUEST}),
        case_repository=cases,
        receipt_signer=signer,
        runs_service=service,
    )
    return TestClient(app), cases, service


async def _seed_review_run() -> tuple[TestClient, str]:
    """One review run parked at ``complete`` with three receipted decisions."""

    http, cases, service = _api()
    await cases.create(
        CaseRecord(
            id=CASE_ID,
            tenant_id=TENANT,
            ticket_key=TICKET,
            domain="support",
            status="open",
            cost_usd_micro=2500,
            outcome="replied",
        )
    )
    run = await service.start(
        workflow="review",
        ticket_key=TICKET,
        case_id=CASE_ID,
        run_input={"repository": "acme/app", "prNumber": 77},
        principal=PRINCIPAL,
    )
    for step_id in ("select-pr", "review-options", "ai-review"):
        result = await service.decide(
            run_id=run.run_id,
            step_id=step_id,
            action="proceed",
            principal=PRINCIPAL,
        )
        assert result.receipt
    return http, run.run_id


def test_case_pack_json_carries_decisions_receipts_citations_diffs_and_cost() -> None:
    http, run_id = asyncio.run(_seed_review_run())
    response = http.get(f"/cases/{CASE_ID}/pack", headers=AUTH)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    pack = response.json()
    assert pack["packVersion"] == "v0"
    assert pack["packKind"] == "case"
    assert pack["packKey"] == f"{TENANT}:{CASE_ID}"
    assert pack["tenantId"] == TENANT
    assert pack["caseId"] == CASE_ID
    assert pack["ticketKey"] == TICKET
    assert pack["domain"] == "support"
    assert pack["status"] == "open"
    assert pack["outcome"] == "replied"
    assert pack["summary"] == {
        "caseCount": 1,
        "runCount": 1,
        "completedRuns": 0,
        "failedRuns": 0,
        "cancelledRuns": 0,
        "decisionCount": 3,
        "receiptsVerified": 3,
        "receiptsFailed": 0,
        "eventCount": 1,
        "costUsdMicro": 2500,
        "citationCount": 1,
        "changedFileCount": 1,
    }
    assert pack["citations"] == [
        {
            "runId": run_id,
            "stepId": "ai-review",
            "sourceId": "kb-remote-work",
            "span": "remote-work.md#L4-L9",
        }
    ]
    assert pack["changedFiles"] == [
        {
            "runId": run_id,
            "stepId": "complete",
            "path": "src/app.ts",
            "status": "modified",
            "additions": 12,
            "deletions": 3,
        }
    ]

    case_payload = pack["cases"][0]
    assert case_payload["caseId"] == CASE_ID
    assert case_payload["costUsdMicro"] == 2500
    assert [event["kind"] for event in case_payload["events"]] == ["run_started"]

    run_payload = pack["runs"][0]
    assert run_payload["runId"] == run_id
    assert run_payload["workflow"] == "review"
    assert run_payload["status"] == "awaiting_human"
    steps = {step["stepId"]: step for step in run_payload["steps"]}
    assert steps["ai-review"]["decision"]["approver"] == "user-1"
    assert steps["ai-review"]["verification"] == {
        "actionHashMatches": True,
        "receiptVerified": True,
        "reason": None,
    }
    # The parked step's artifact is already in the pack; its decision is not.
    assert "decision" not in steps["complete"]
    assert steps["complete"]["artifact"]["files"][0]["path"] == "src/app.ts"


def test_case_pack_pdf_download_for_viewer() -> None:
    http, _run_id = asyncio.run(_seed_review_run())
    pdf = http.get(f"/cases/{CASE_ID}/pack", params={"format": "pdf"}, headers=VIEWER_AUTH)
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"] == 'attachment; filename="case-pack-ABC-9.pdf"'
    assert pdf.content.startswith(b"%PDF-")
    assert len(pdf.content) > 1_000


def test_case_pack_role_gates_and_bad_input() -> None:
    http, _cases, _service = _api()
    assert http.get(f"/cases/{CASE_ID}/pack").status_code == 401
    assert http.get(f"/cases/{CASE_ID}/pack", headers=GUEST_AUTH).status_code == 403
    assert http.get("/cases/-leading/pack", headers=AUTH).status_code == 422
    assert (
        http.get(f"/cases/{CASE_ID}/pack", params={"format": "csv"}, headers=AUTH).status_code
        == 422
    )
    assert http.get("/cases/case-missing/pack", headers=AUTH).status_code == 404


def test_case_pack_never_crosses_tenants() -> None:
    http, cases, _service = _api()
    asyncio.run(
        cases.create(
            CaseRecord(
                id="case-otherco-1",
                tenant_id="otherco",
                ticket_key="OTH-1",
                domain="support",
                status="open",
            )
        )
    )
    assert http.get("/cases/case-otherco-1/pack", headers=AUTH).status_code == 404
