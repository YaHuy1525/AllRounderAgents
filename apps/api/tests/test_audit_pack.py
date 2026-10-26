"""Audit pack exporter pins.

Covers the month window math, the archive ∪ registry union, the receipt
re-verification (hash recompute + signature validation pinned to the decision
time), and the PDF render. The decision records are crafted with the same
hash/signing functions the run service uses, so the verification path is
exercised against genuine tokens.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.audit_pack import AuditPackBuilder, month_window, render_pdf
from allrounder_api.repositories import CaseRecord, InMemoryCaseRepository
from allrounder_api.runs import (
    WORKFLOW_DEFINITIONS,
    InMemoryRunRegistry,
    MemoryRunArchive,
    action_hash,
    content_hash,
)
from allrounder_api.runs.definitions import side_effect_scope
from allrounder_api.runs.models import RunStep, WorkflowRun

SECRET = b"audit-pack-receipt-secret-for-tests-0123456"
TENANT = "omnidewalt"
CLIENT = "acme"
CASE_ID = "msp-acme-482913"
TICKET = "MSP-482913"
STARTED = datetime(2026, 9, 15, 9, 0, tzinfo=UTC)
DECIDED_AT = STARTED + timedelta(minutes=30)
FIRST_RUN = "11111111-1111-4111-8111-111111111111"
LIVE_RUN = "22222222-2222-4222-8222-222222222222"


def _msp_run(
    *,
    run_id: str = FIRST_RUN,
    status: str = "completed",
    case_id: str = CASE_ID,
    started_at: datetime = STARTED,
) -> WorkflowRun:
    definition = WORKFLOW_DEFINITIONS["msp"]
    steps = [
        RunStep(step_id=step.id, index=index, title=step.title)
        for index, step in enumerate(definition.steps)
    ]
    run = WorkflowRun(
        run_id=run_id,
        tenant_id=TENANT,
        workflow="msp",
        ticket_key=TICKET,
        case_id=case_id,
        input={"clientRef": CLIENT, "subject": "VPN drops every hour"},
        steps=steps,
        status=status,
        started_at=started_at,
        heartbeat_at=started_at,
        finished_at=started_at + timedelta(hours=1) if status == "completed" else None,
    )
    run.step("intake").artifact = {
        "subject": "VPN drops every hour",
        "from": "jane@acme.example",
    }
    run.step("intake").state = "done"
    run.step("ticket").artifact = {"ticketKey": TICKET, "commentId": "c-1"}
    run.step("ticket").state = "done"
    run.step("draft").artifact = {"body": "Hi Jane, please restart the tunnel."}
    run.step("draft").state = "done"
    run.step("approve").state = "done"
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


def _decide_all(run: WorkflowRun, signer: ApprovalReceiptSigner) -> None:
    _decide(run, "ticket", signer)
    run.step("send").artifact = {"to": "jane@acme.example", "messageId": "mail-9"}
    _decide(run, "send", signer, approvals="ap-2", edits={"body": "Edited body."})
    run.step("send").state = "done"
    run.side_effects = {"send": {"messageId": "mail-9", "commentId": "c-1"}}


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


def test_month_window_shapes_and_validation() -> None:
    assert month_window("2026-09") == (
        "2026-09-01T00:00:00+00:00",
        "2026-10-01T00:00:00+00:00",
    )
    assert month_window("2026-12") == (
        "2026-12-01T00:00:00+00:00",
        "2027-01-01T00:00:00+00:00",
    )
    for bad in ("2026-13", "2026-00", "26-09", "2026-9", "2026/09", "september"):
        with pytest.raises(ValueError, match="YYYY-MM"):
            month_window(bad)


async def test_list_full_filters_by_prefix_window_and_terminal_only() -> None:
    archive = MemoryRunArchive()
    run = _msp_run()
    _decide_all(run, ApprovalReceiptSigner(SECRET))
    await archive.record(run)
    await archive.record(_msp_run(run_id=LIVE_RUN, status="running"))
    elsewhere = _msp_run(
        run_id="55555555-5555-4555-8555-555555555555", case_id="msp-beta-111111"
    )
    await archive.record(elsewhere)

    since, until = month_window("2026-09")
    rows = await archive.list_full(
        TENANT, case_id_prefix="msp-acme-", since=since, until=until
    )
    assert [row.run_id for row in rows] == [run.run_id]
    assert rows[0].case_id == CASE_ID
    assert rows[0].side_effects == run.side_effects
    assert rows[0].step("send").decision is not None
    outside = await archive.list_full(
        TENANT, case_id_prefix="msp-acme-", since=month_window("2026-10")[0]
    )
    assert outside == []


async def test_build_unions_archive_and_registry_scoped_to_client_and_month() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    cases = InMemoryCaseRepository()
    run = _msp_run()
    _decide_all(run, signer)
    await archive.record(run)
    await registry.save(run)
    live = _msp_run(run_id=LIVE_RUN, status="running")
    await registry.save(live)
    await archive.record(
        _msp_run(
            run_id="55555555-5555-4555-8555-555555555555", case_id="msp-beta-111111"
        )
    )
    await archive.record(
        _msp_run(
            run_id="33333333-3333-4333-8333-333333333333",
            started_at=datetime(2026, 8, 31, 23, 0, tzinfo=UTC),
        )
    )
    await cases.create(
        CaseRecord(
            id=CASE_ID, tenant_id=TENANT, ticket_key=TICKET, domain="msp", status="open"
        )
    )
    await cases.append_event(
        CASE_ID, actor="system", kind="run_started", payload={"runId": run.run_id}
    )

    pack = await _builder(signer, archive=archive, registry=registry, cases=cases).build(
        tenant_id=TENANT, client_ref=CLIENT, month="2026-09"
    )
    assert pack["packKey"] == f"{TENANT}:{CLIENT}:2026-09"
    summary = pack["summary"]
    assert summary == {
        "caseCount": 1,
        "runCount": 2,
        "completedRuns": 1,
        "failedRuns": 0,
        "cancelledRuns": 0,
        "decisionCount": 2,
        "receiptsVerified": 2,
        "receiptsFailed": 0,
        "eventCount": 1,
    }
    run_ids = [item["runId"] for item in pack["runs"]]
    assert run_ids == [FIRST_RUN, LIVE_RUN]
    cases_payload = pack["cases"]
    assert cases_payload[0]["caseId"] == CASE_ID
    assert cases_payload[0]["events"][0]["kind"] == "run_started"
    live_steps = _steps_by_id(pack, LIVE_RUN)
    assert live_steps["send"]["state"] == "pending"
    assert "decision" not in live_steps["send"]


async def test_verification_flags_tampering_and_missing_receipts() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    run = _msp_run()
    _decide_all(run, signer)
    await archive.record(run)
    record = archive.records[run.run_id]
    steps = record["steps"]
    # Tamper the archived artifact of the send step: the recomputed hash no
    # longer matches the recorded action hash.
    steps[4]["artifact"] = {"to": "attacker@example.com"}
    # Tamper the receipt token of the ticket step.
    steps[1]["receipt"] = "not-a-token"

    pack = await _builder(
        signer, archive=archive, registry=registry, cases=None
    ).build(tenant_id=TENANT, client_ref=CLIENT, month="2026-09")
    summary = pack["summary"]
    assert summary["decisionCount"] == 2
    assert summary["receiptsVerified"] == 0
    assert summary["receiptsFailed"] == 2
    steps_by_id = _steps_by_id(pack, FIRST_RUN)
    assert steps_by_id["send"]["verification"] == {
        "actionHashMatches": False,
        "receiptVerified": False,
        "reason": "action_hash_mismatch",
    }
    assert steps_by_id["ticket"]["verification"]["reason"] == "receipt_invalid"


async def test_missing_receipt_and_edits_binding() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    run = _msp_run()
    _decide_all(run, signer)
    await archive.record(run)
    # Strip the ticket receipt after the fact: decision survives, token is gone.
    archive.records[run.run_id]["steps"][1]["receipt"] = None

    pack = await _builder(signer, archive=archive, registry=registry, cases=None).build(
        tenant_id=TENANT, client_ref=CLIENT, month="2026-09"
    )
    steps_by_id = _steps_by_id(pack, FIRST_RUN)
    assert steps_by_id["ticket"]["verification"]["reason"] == "missing_receipt"
    # The send decision was bound with an editsHash; it still verifies.
    assert steps_by_id["send"]["verification"]["receiptVerified"] is True
    assert steps_by_id["send"]["decision"]["edits"] == {"body": "Edited body."}


async def test_regenerate_decision_is_recorded_but_not_a_failed_receipt() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    run = _msp_run()
    _decide_all(run, signer)
    # The draft was sent back once before the approve step passed: the
    # regenerate decision survives on the trail with no receipt by design.
    draft = run.step("draft")
    draft.decision = {
        "action": "regenerate",
        "guidance": "Ask for the OS build number.",
        "regenerations": 1,
    }
    draft.updated_at = DECIDED_AT
    await archive.record(run)

    pack = await _builder(signer, archive=archive, registry=registry, cases=None).build(
        tenant_id=TENANT, client_ref=CLIENT, month="2026-09"
    )
    summary = pack["summary"]
    assert summary["decisionCount"] == 3
    assert summary["receiptsVerified"] == 2
    assert summary["receiptsFailed"] == 0
    steps_by_id = _steps_by_id(pack, FIRST_RUN)
    assert steps_by_id["draft"]["decision"]["action"] == "regenerate"
    assert steps_by_id["draft"]["verification"] == {
        "actionHashMatches": None,
        "receiptVerified": None,
        "reason": "no_receipt_required",
    }


async def test_expired_receipt_verifies_at_decision_time() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    run = _msp_run()
    _decide_all(run, signer)
    await archive.record(run)
    # Wall-clock now is far past the one-hour receipt TTL: verification must
    # still pass because it validates as of decidedAt.
    builder = _builder(
        signer,
        archive=archive,
        registry=registry,
        cases=None,
        clock=datetime(2027, 3, 1, tzinfo=UTC),
    )
    pack = await builder.build(tenant_id=TENANT, client_ref=CLIENT, month="2026-09")
    assert pack["summary"]["receiptsVerified"] == 2


async def test_build_rejects_bad_client_ref_and_month() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    builder = _builder(
        signer, archive=MemoryRunArchive(), registry=InMemoryRunRegistry(), cases=None
    )
    with pytest.raises(ValueError, match="clientRef"):
        await builder.build(tenant_id=TENANT, client_ref="Acme!", month="2026-09")
    with pytest.raises(ValueError, match="YYYY-MM"):
        await builder.build(tenant_id=TENANT, client_ref=CLIENT, month="2026-9")


async def test_render_pdf_produces_pdf_bytes() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    archive = MemoryRunArchive()
    registry = InMemoryRunRegistry()
    cases = InMemoryCaseRepository()
    run = _msp_run()
    _decide_all(run, signer)
    await archive.record(run)
    await cases.create(
        CaseRecord(
            id=CASE_ID, tenant_id=TENANT, ticket_key=TICKET, domain="msp", status="open"
        )
    )
    await cases.append_event(
        CASE_ID, actor="system", kind="run_started", payload={"runId": run.run_id}
    )

    pack = await _builder(signer, archive=archive, registry=registry, cases=cases).build(
        tenant_id=TENANT, client_ref=CLIENT, month="2026-09"
    )
    pdf = render_pdf(pack)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 2_000

    empty = render_pdf({})
    assert empty.startswith(b"%PDF")
    assert len(empty) > 1_000
