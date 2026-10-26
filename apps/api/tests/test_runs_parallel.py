"""PR1 T5: the parallelism and contention matrix (G1-G5), serving plane.

Five hard parallel-run requirements, each proven through the real service
(adapters from ``build_memory_run_service`` / the ceilings harness style), all
offline through ``ScriptedMastraRunClient``:

* G1  manifest-grammar target lock: the contender parks (``blocked``,
  ``run.locked``, owner = holder) while the holder drives to ``completed``,
  and ``retry_lock`` frees the contender only after the holder finished;
* G2  two live runs on one ticket key get distinct ids, distinct registry
  entries, per-run step state, and a decision on one never moves the other;
* G3  receipt replay returns the stored receipt without re-invoking the
  Mastra client or the side effect, and the stored receipt still validates
  through the run-bound lane (``require_run_id=True``);
* G4  a gate suspend on run A does not leak into run B: B's status, step
  state, decision and event stream are untouched while A parks and resumes;
* G5  the three shipped spec workflows (dependencies, accessibility,
  vendors) coexist under a run ceiling of 5 — three concurrent in-flight
  passes observe ``active_count == 3`` — and under a ceiling of 2 the next
  runs queue with visible FIFO positions on the ``run`` kind.

Harness helpers are imported from ``test_runs`` so the G1-G4 scenarios use
exactly the primitives the existing suite proves (same builder contract as
``test_target_lock_conflict_blocks_second_run_with_banner``).
"""

from __future__ import annotations

import asyncio
import json

import pytest
from allrounder_api.approvals import ApprovalReceiptSigner, ReceiptError
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import (
    ACCESSIBILITY_WORKFLOW,
    APPLY_SLOT,
    DEPENDENCIES_WORKFLOW,
    MODEL_SLOT,
    RUN_SLOT,
    VENDORS_WORKFLOW,
    WORKFLOW_DEFINITIONS,
    InMemoryRunEventBus,
    InMemoryRunRegistry,
    MemoryConcurrencyCeiling,
    MemoryRunReceiptStore,
    MemoryTargetLockStore,
    RunService,
    ScriptedMastraRunClient,
    StepDefinition,
    WorkflowDefinition,
    action_hash,
    build_memory_run_service,
    content_hash,
)
from allrounder_api.runs.definitions import side_effect_scope
from test_runs import (
    PRINCIPAL,
    REVIEW_STEPS,
    SECRET,
    TENANT,
    make_service,
    proceed,
    review_client,
    start_review,
)

MANIFEST_TARGET = "manifest:acme/app#web/next"


class RecordingCeiling(MemoryConcurrencyCeiling):
    """Memory ceiling that records every (run_id, kind) release it performs."""

    def __init__(self, limits: dict[str, int]) -> None:
        super().__init__(limits)
        self.released_by: list[tuple[str, str]] = []

    async def release(self, run_id: str, kind: str = RUN_SLOT) -> str | None:
        self.released_by.append((run_id, kind))
        return await super().release(run_id, kind)


def make_ceiling_service(
    mastra: ScriptedMastraRunClient,
    *,
    runs: int = 5,
    applies: int = 2,
    models: int = 4,
) -> tuple[RunService, RecordingCeiling]:
    """Ceiling-visible service over the shipped workflow definitions."""
    ceilings = RecordingCeiling({RUN_SLOT: runs, APPLY_SLOT: applies, MODEL_SLOT: models})
    service = RunService(
        workflows=WORKFLOW_DEFINITIONS,
        registry=InMemoryRunRegistry(),
        ceilings=ceilings,  # type: ignore[arg-type]
        locks=MemoryTargetLockStore(),
        receipts=MemoryRunReceiptStore(),
        events=InMemoryRunEventBus(),
        mastra=mastra,
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
    )
    return service, ceilings


async def marker_builder(
    workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
) -> dict[str, object]:
    return {"marker": run_input.get("marker"), "stepId": step_id}


def locked_events(history: list[dict[str, object]]) -> list[dict[str, object]]:
    return [event for event in history if event.get("type") == "run.locked"]


# ------------------------------------------------------------------ G1: lock


async def test_manifest_lock_holder_completes_while_contender_stays_parked() -> None:
    # Same builder contract as the existing lock test at test_runs.py:1054,
    # but with the plan's manifest grammar and the missing half of the
    # claim: the holder must drive all the way to `completed` while the
    # contender stays parked, and only then may retry_lock free it.
    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        target = run_input.get("target")
        return {
            "marker": run_input.get("marker"),
            **({"target": target} if target else {}),
        }

    service, ceilings = make_ceiling_service(review_client(builder=builder))
    holder = await start_review(
        service, ticket="ABC-1", marker="holder", target=MANIFEST_TARGET
    )
    assert holder.status == "awaiting_human"
    assert holder.lock_target == MANIFEST_TARGET
    assert holder.lock_owner == holder.run_id

    contender = await start_review(
        service, ticket="ABC-2", marker="contender", target=MANIFEST_TARGET
    )
    assert contender.status == "blocked"
    # The exact manifest grammar from the plan, not the pr: form.
    assert contender.lock_target == MANIFEST_TARGET
    assert contender.lock_owner == holder.run_id
    contender_step = contender.current_step()
    assert contender_step is not None
    assert contender_step.state == "blocked"

    events = await service.history(contender.run_id)
    locked = locked_events(events)
    assert locked, "the contender must publish a run.locked event"
    assert locked[-1]["target"] == MANIFEST_TARGET
    assert locked[-1]["lockedBy"] == holder.run_id

    # A blocked run parks its pass and gives its slots back: nothing it held
    # (or queued on) stays granted while it waits on the lock.
    assert await ceilings.active_count(RUN_SLOT) == 0
    assert (contender.run_id, RUN_SLOT) in ceilings.released_by

    # Drive the holder to a terminal completed state while the contender sits
    # blocked — the contender must neither cap the holder nor advance itself.
    for step_id in REVIEW_STEPS:
        result = await proceed(service, holder.run_id, step_id)
        assert result.run.status in ("awaiting_human", "completed"), step_id
        parked = await service.get(contender.run_id, TENANT)
        assert parked.status == "blocked", step_id
        assert parked.lock_owner == holder.run_id
        assert parked.step("select-pr").state == "blocked"
        assert parked.step("review-options").state == "pending"
    final = await service.get(holder.run_id, TENANT)
    assert final.status == "completed"

    # With the holder finished, the retry path lets the contender proceed.
    unlocked = await service.decide(
        run_id=contender.run_id,
        step_id="select-pr",
        action="retry_lock",
        principal=PRINCIPAL,
    )
    assert unlocked.run.status == "awaiting_human"
    assert unlocked.run.lock_owner == contender.run_id
    assert unlocked.run.step("select-pr").state == "awaiting_human"
    assert unlocked.run.step("select-pr").artifact is not None
    after = await service.history(contender.run_id)
    assert [event for event in after if event.get("type") == "run.unlocked"]
    # The completed holder released its lock and every ceiling kind it held.
    assert await ceilings.active_count(RUN_SLOT) == 0
    assert (holder.run_id, RUN_SLOT) in ceilings.released_by


# ----------------------------------------------------------------- G2: ticket


async def test_two_runs_on_one_ticket_are_isolated_registry_entries() -> None:
    # The service does not reject a second same-ticket run (verified against
    # service.start: no ticket-level guard exists), so this proves the live
    # pair stays isolated end to end.
    service = make_service(review_client(builder=marker_builder))
    run_a = await start_review(service, ticket="ABC-7", marker="m1")
    run_b = await start_review(service, ticket="ABC-7", marker="m2")
    assert run_a.run_id != run_b.run_id
    assert run_a.status == "awaiting_human"
    assert run_b.status == "awaiting_human"

    entries = await service.list_for_ticket("ABC-7", TENANT)
    assert {entry.run_id for entry in entries} == {run_a.run_id, run_b.run_id}
    assert len(entries) == 2

    fresh_a = await service.get(run_a.run_id, TENANT)
    fresh_b = await service.get(run_b.run_id, TENANT)
    assert fresh_a.current_step().artifact["marker"] == "m1"  # type: ignore[union-attr,index]
    assert fresh_b.current_step().artifact["marker"] == "m2"  # type: ignore[union-attr,index]
    assert fresh_a.step("select-pr").state == "awaiting_human"
    assert fresh_b.step("select-pr").decision is None

    moved = await proceed(service, run_a.run_id, "select-pr")
    assert moved.run.current_step().step_id == "review-options"  # type: ignore[union-attr]
    untouched = await service.get(run_b.run_id, TENANT)
    assert untouched.status == "awaiting_human"
    assert untouched.current_step().step_id == "select-pr"  # type: ignore[union-attr]
    assert untouched.step("select-pr").decision is None
    assert untouched.step("review-options").state == "pending"
    # The ticket index still carries both entries independently.
    still_both = await service.list_for_ticket("ABC-7", TENANT)
    by_id = {entry.run_id: entry for entry in still_both}
    assert set(by_id) == {run_a.run_id, run_b.run_id}
    assert by_id[run_b.run_id].step("select-pr").decision is None


# ---------------------------------------------------------------- G3: replay


# A lane whose FIRST step is side-effecting in the shipped-definition sense:
# only a definition-side ``side_effecting`` step routes the receipt to the
# ``workflow:step`` scope and triggers the service's pre-drive re-verification
# with ``require_run_id=True`` (runs/service.py:570). Replaying that step's
# decision is what makes the T3 carry provable rather than decorative.
GATE_WORKFLOW = WorkflowDefinition(
    id="gatetest",
    mastra_workflow="gateFlow",
    title="Gate Replay Lane",
    steps=(
        StepDefinition(id="g1", title="Gate", side_effecting=True),
        StepDefinition(id="g2", title="After"),
    ),
)


async def test_replay_returns_stored_receipt_without_re_running_the_effect() -> None:
    # Extension of test_runs.py:1302 with the two halves it left unproven:
    # the replay provably never re-invokes the Mastra client or the side
    # effect, and the stored receipt still validates through the run-bound
    # lane (require_run_id=True) on a side-effecting (opted-in) step.
    builds: list[str] = []

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        builds.append(step_id)
        return {"stepId": step_id, "marker": run_input.get("marker")}

    approvals = InMemoryApprovalRepository()
    signer = ApprovalReceiptSigner(SECRET)
    client = ScriptedMastraRunClient(
        {"gateFlow": ("g1", "g2")},
        builder=builder,
        side_effecting=frozenset({"g1"}),
    )
    service = build_memory_run_service(
        signer=signer,
        approvals=approvals,
        workflows={"gatetest": GATE_WORKFLOW},
        mastra=client,
    )
    run = await service.start(
        workflow="gatetest",
        ticket_key="ABC-5",
        case_id="case-1",
        run_input={"marker": "m"},
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    assert run.current_step().step_id == "g1"  # type: ignore[union-attr]

    first = await service.decide(
        run_id=run.run_id, step_id="g1", action="proceed", principal=PRINCIPAL
    )
    assert first.replayed is False
    assert first.receipt is not None
    # The side effect ran exactly once, behind the service's own run-bound
    # re-verification (a side-effecting gate validates with
    # require_run_id=True before the drive; the review:complete-style scope is
    # ``gatetest:g1``).
    assert client.effect_executions == ["g1"]
    assert len(await approvals.list(TENANT)) == 1
    decided = await service.get(run.run_id, TENANT)
    first_hash = decided.step("g1").action_hash
    assert first_hash is not None
    assert decided.step("g1").receipt == first.receipt
    approval_id = str(decided.step("g1").decision["approvalId"])  # type: ignore[union-attr]

    # Back invalidates g1 and the restart pass recomputes its artifact; the
    # recorded effect must still not re-execute.
    await service.decide(
        run_id=run.run_id, step_id="g2", action="back", principal=PRINCIPAL
    )
    assert builds.count("g1") == 2
    assert client.effect_executions == ["g1"]

    calls_before = len(client.calls)
    builds_before = list(builds)
    replay = await service.decide(
        run_id=run.run_id, step_id="g1", action="proceed", principal=PRINCIPAL
    )
    assert replay.replayed is True
    assert replay.receipt == first.receipt
    # Replay is provably inert: no Mastra pass was started for it at all.
    assert len(client.calls) == calls_before
    assert builds == builds_before
    assert client.effect_executions == ["g1"]
    assert len(await approvals.list(TENANT)) == 1
    # OBSERVED production behavior (escalated in the report): the replay
    # branch early-returns before persisting or driving, so the run stays
    # parked at the recomputed gate and a repeated identical proceed replays
    # again — after a Back, an identical proceed can never advance the run.
    stuck = await service.get(run.run_id, TENANT)
    assert stuck.status == "awaiting_human"
    assert stuck.current_step().step_id == "g1"  # type: ignore[union-attr]
    assert stuck.step("g1").decision is None  # the restored decision is not saved
    again = await service.decide(
        run_id=run.run_id, step_id="g1", action="proceed", principal=PRINCIPAL
    )
    assert again.replayed is True
    assert again.receipt == first.receipt
    assert len(client.calls) == calls_before

    # The stored receipt still validates through the run-bound path the
    # service itself uses (runs/service.py:402 and :570).
    reloaded = await service.get(run.run_id, TENANT)
    step = reloaded.step("g1")
    action = {
        "workflow": "gatetest",
        "runId": run.run_id,
        "stepId": "g1",
        "action": "proceed",
        "artifactHash": content_hash(step.artifact or {}),
    }
    assert action_hash(action) == first_hash
    claims = signer.validate(
        replay.receipt or "",
        approval_id=approval_id,
        case_id=run.case_id,
        action=action,
        scope=side_effect_scope("gatetest", "g1"),
        run_id=run.run_id,
        require_run_id=True,
    )
    assert claims.run_id == run.run_id
    with pytest.raises(ReceiptError):
        signer.validate(
            replay.receipt or "",
            approval_id=approval_id,
            case_id=run.case_id,
            action=action,
            scope=side_effect_scope("gatetest", "g1"),
            run_id="some-other-run",
            require_run_id=True,
        )


# ---------------------------------------------------------------- G4: suspend


async def test_gate_suspend_on_run_a_does_not_leak_into_run_b() -> None:
    # The serving plane parks a run at its gate when the client returns the
    # suspend outcome; the gap this closes is cross-run leakage: run A gates
    # with an explicit suspend directive in its payload while run B (same
    # workflow, different ticket) waits normally.
    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        artifact: dict[str, object] = {"marker": run_input.get("marker"), "stepId": step_id}
        if run_input.get("marker") == "a" and step_id == "select-pr":
            artifact["gateSuspend"] = True
        return artifact

    service = make_service(review_client(builder=builder))
    run_a = await start_review(service, ticket="ABC-20", marker="a")
    run_b = await start_review(service, ticket="ABC-21", marker="b")

    # A's gate suspend: status, step state, and its own events.
    assert run_a.status == "awaiting_human"
    assert run_a.step("select-pr").state == "awaiting_human"
    a_suspends = [
        event
        for event in await service.history(run_a.run_id)
        if event.get("type") == "run.suspended"
    ]
    assert a_suspends
    assert a_suspends[-1]["stepId"] == "select-pr"
    assert a_suspends[-1]["artifact"] == {
        "marker": "a",
        "stepId": "select-pr",
        "gateSuspend": True,
    }
    assert a_suspends[-1]["runId"] == run_a.run_id
    assert a_suspends[-1]["run"]["runId"] == run_a.run_id  # embedded snapshot

    # B is untouched: normal awaiting-human gate, no decision, and none of
    # A's identity anywhere in B's event stream.
    assert run_b.status == "awaiting_human"
    assert run_b.current_step().step_id == "select-pr"  # type: ignore[union-attr]
    assert run_b.step("select-pr").decision is None
    b_history = await service.history(run_b.run_id)
    b_suspends = [event for event in b_history if event.get("type") == "run.suspended"]
    assert b_suspends
    assert all(event["runId"] == run_b.run_id for event in b_suspends)
    assert all(event["artifact"]["marker"] == "b" for event in b_suspends)
    assert run_a.run_id not in json.dumps(b_history)
    b_events_before = len(b_history)

    # Resume A through its gate; B must not move, gain a decision, or gain
    # an event.
    resumed = await proceed(service, run_a.run_id, "select-pr")
    assert resumed.run.current_step().step_id == "review-options"  # type: ignore[union-attr]
    after = await service.get(run_b.run_id, TENANT)
    assert after.status == "awaiting_human"
    assert after.current_step().step_id == "select-pr"  # type: ignore[union-attr]
    assert after.step("select-pr").decision is None
    assert after.step("review-options").state == "pending"
    b_history_after = await service.history(run_b.run_id)
    assert len(b_history_after) == b_events_before
    assert run_a.run_id not in json.dumps(b_history_after)


# ----------------------------------------------------------------- G5: mixed


def _three_flows_client(builder) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {
            DEPENDENCIES_WORKFLOW.mastra_workflow: tuple(
                step.id for step in DEPENDENCIES_WORKFLOW.steps
            ),
            ACCESSIBILITY_WORKFLOW.mastra_workflow: tuple(
                step.id for step in ACCESSIBILITY_WORKFLOW.steps
            ),
            VENDORS_WORKFLOW.mastra_workflow: tuple(step.id for step in VENDORS_WORKFLOW.steps),
        },
        builder=builder,
    )


async def _start_lane(service: RunService, workflow: str, marker: str):
    return await service.start(
        workflow=workflow,
        ticket_key=f"LANE-{marker}",
        case_id="case-1",
        run_input={"marker": marker},
        principal=PRINCIPAL,
    )


async def test_three_shipped_workflows_coexist_under_a_ceiling_of_five() -> None:
    # Phase 1 (cap 5): one dependencies + one accessibility + one vendors
    # run drive concurrently against the real shipped definitions — three
    # in-flight passes observe the run ceiling at 3 active of 5, then all
    # three park at their own first gate.
    inside = {"count": 0, "max": 0}
    rendezvous = asyncio.Event()
    sampled = asyncio.Event()
    release = asyncio.Event()
    observed: list[int] = []
    ceiling_ref: dict[str, RecordingCeiling] = {}

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        inside["count"] += 1
        inside["max"] = max(inside["max"], inside["count"])
        if inside["count"] >= 3:
            rendezvous.set()
        await rendezvous.wait()
        # Every pass holds its run slot from acquisition until its outcome
        # applies; release only opens once all three samples are in, so every
        # read here is taken with all three passes in flight together.
        observed.append(await ceiling_ref["c"].active_count(RUN_SLOT))
        if len(observed) >= 3:
            sampled.set()
        await release.wait()
        inside["count"] -= 1
        return {"marker": run_input.get("marker"), "stepId": step_id}

    service, ceilings = make_ceiling_service(_three_flows_client(builder), runs=5)
    ceiling_ref["c"] = ceilings
    task_deps = asyncio.create_task(_start_lane(service, "dependencies", "deps"))
    task_a11y = asyncio.create_task(_start_lane(service, "accessibility", "a11y"))
    task_vendors = asyncio.create_task(_start_lane(service, "vendors", "vendors"))
    await asyncio.wait_for(sampled.wait(), timeout=5)
    assert inside["max"] == 3  # genuinely concurrent passes
    assert observed and set(observed) == {3}  # 3 active of the cap of 5

    release.set()
    runs = await asyncio.gather(
        asyncio.wait_for(task_deps, timeout=5),
        asyncio.wait_for(task_a11y, timeout=5),
        asyncio.wait_for(task_vendors, timeout=5),
    )
    by_workflow = {run.workflow: run for run in runs}
    assert set(by_workflow) == {"dependencies", "accessibility", "vendors"}
    assert by_workflow["dependencies"].current_step().step_id == "scan"  # type: ignore[union-attr]
    assert by_workflow["accessibility"].current_step().step_id == "crawl"  # type: ignore[union-attr]
    assert by_workflow["vendors"].current_step().step_id == "collect"  # type: ignore[union-attr]
    for run in runs:
        assert run.status == "awaiting_human"
        assert run.queue_position is None
    # Suspended passes gave their slots back: nothing is stuck active.
    for kind in (RUN_SLOT, APPLY_SLOT, MODEL_SLOT):
        assert await ceilings.active_count(kind) == 0

    # Phase 2 (ceiling of 2): the same three graphs — one of them twice —
    # contend: with two passes in flight, the third and fourth queue on the
    # ``run`` kind with visible FIFO positions and promote when slots free.
    gates = {"deps": asyncio.Event(), "a11y": asyncio.Event()}

    async def gated_builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        marker = str(run_input.get("marker", ""))
        if marker in gates:
            await gates[marker].wait()
        return {"marker": marker, "stepId": step_id}

    service2, ceilings2 = make_ceiling_service(_three_flows_client(gated_builder), runs=2)
    task_deps2 = asyncio.create_task(_start_lane(service2, "dependencies", "deps"))
    await asyncio.sleep(0.05)
    task_a11y2 = asyncio.create_task(_start_lane(service2, "accessibility", "a11y"))
    await asyncio.sleep(0.05)
    assert await ceilings2.active_count(RUN_SLOT) == 2  # the cap is reached

    run_vendors = await _start_lane(service2, "vendors", "vendors2")
    assert run_vendors.status == "queued"
    assert run_vendors.queue_position == 1
    fourth = await _start_lane(service2, "dependencies", "deps-late")
    assert fourth.status == "queued"
    assert fourth.queue_position == 2
    for queued_run in (run_vendors, fourth):
        events = [
            event
            for event in await service2.history(queued_run.run_id)
            if event.get("type") == "run.queued"
        ]
        assert events, "a queued run must publish run.queued"
        assert events[-1]["waitingOn"] == RUN_SLOT  # queued on the run kind

    gates["deps"].set()
    gates["a11y"].set()
    await asyncio.wait_for(task_deps2, timeout=5)
    await asyncio.wait_for(task_a11y2, timeout=5)

    promoted_vendors = await service2.get(run_vendors.run_id, TENANT)
    assert promoted_vendors.status == "awaiting_human"  # promoted and driven
    assert promoted_vendors.queue_position is None
    assert promoted_vendors.current_step().step_id == "collect"  # type: ignore[union-attr]
    promoted_fourth = await service2.get(fourth.run_id, TENANT)
    assert promoted_fourth.status == "awaiting_human"
    assert promoted_fourth.queue_position is None
    assert promoted_fourth.current_step().step_id == "scan"  # type: ignore[union-attr]
    for kind in (RUN_SLOT, APPLY_SLOT, MODEL_SLOT):
        assert await ceilings2.active_count(kind) == 0
