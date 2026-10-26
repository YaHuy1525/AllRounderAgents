"""Ceiling enforcement tests: model/apply caps per drive pass, ordered release.

Five spec behaviors, all offline via ``MemoryConcurrencyCeiling`` and the
scripted Mastra stand-in:

1. the model cap admits exactly ``max_concurrent_model_calls`` passes and the
   next run queues (position + kind visible) until one releases;
2. the apply cap serializes dependency-style runs (it used to be decorative);
3. suspend / completion / failure / cancel / timeout all give back every held
   kind in the strict reverse of the acquisition order;
4. acquisition order ``run -> apply -> model`` cannot deadlock under
   contention (the regression test for the fixed global order);
5. promotion re-drives the run's recorded pass — a resume stays a resume.

Fix-round 1 adds the slot-discipline cases: a grant the acquire walk cannot
finish recording is given back (no leak), every release finishes before a
promoted run starts driving, a cancel racing a promotion re-walk cannot
resurrect the run, an unheld release promotes no one, and a step cannot
declare a slot kind the ceilings do not know.

Fix-round 2 adds the two promotion-survival cases: a record save that dies
inside the release seam still promotes the run it handed capacity to. Fix
round 3 replaces that round's queue-refresh "self-heal" with the invariant it
has to respect: the refresh only re-reads FIFO positions, reports a ``queued``
run with no queue entry, and never drives a run, because a legitimately
promoted run reads exactly the same state while its grant lands. It also pins
that the release seam guards an error but never absorbs a cancellation.
Fix-round 4 closes the gap those two rulings opened: a cancellation landing on
one promotion is recorded, every remaining granted run is still driven, and the
cancellation propagates only after the whole loop has run.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import Principal
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import (
    APPLY_SLOT,
    MODEL_SLOT,
    RUN_SLOT,
    InMemoryRunEventBus,
    InMemoryRunRegistry,
    MastraClientError,
    MastraOutcome,
    MemoryConcurrencyCeiling,
    MemoryRunReceiptStore,
    MemoryTargetLockStore,
    RunService,
    RunServiceConfig,
    ScriptedMastraRunClient,
    StepDefinition,
    WorkflowDefinition,
    WorkflowRun,
)
from allrounder_api.runs.ceilings import _RELEASE_SCRIPT, SLOT_ORDER
from structlog.testing import capture_logs

SECRET = b"ceiling-receipt-secret-for-tests-0123456789"
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))
TENANT = "omnidewalt"

# A single model-bearing step: every pass that computes it needs a model slot.
MODEL_WORKFLOW = WorkflowDefinition(
    id="ml",
    mastra_workflow="mlFlow",
    title="Model Lane",
    steps=(StepDefinition(id="infer", title="Infer", slots=(MODEL_SLOT,)),),
)

# Dependency shape: only the apply pass carries the patch-apply ceiling.
APPLY_WORKFLOW = WorkflowDefinition(
    id="deps",
    mastra_workflow="depsFlow",
    title="Dependency Update (test lane)",
    steps=(
        StepDefinition(id="scan", title="Scan"),
        StepDefinition(id="group", title="Group"),
        StepDefinition(id="apply", title="Apply", slots=(APPLY_SLOT, MODEL_SLOT)),
        StepDefinition(id="merge", title="Merge"),
    ),
)

# Both ceilings on one heavy step plus a pure tail step.
HEAVY_WORKFLOW = WorkflowDefinition(
    id="heavy",
    mastra_workflow="heavyFlow",
    title="Heavy Lane",
    steps=(
        StepDefinition(id="h", title="Heavy", slots=(APPLY_SLOT, MODEL_SLOT)),
        StepDefinition(id="tail", title="Tail"),
    ),
)

# Re-drive test: the first pass is pure, the pass after it needs the model cap.
TWO_STEP_WORKFLOW = WorkflowDefinition(
    id="two",
    mastra_workflow="twoFlow",
    title="Two Step Lane",
    steps=(
        StepDefinition(id="r1", title="First"),
        StepDefinition(id="r2", title="Model Step", slots=(MODEL_SLOT,)),
    ),
)

WORKFLOWS = {
    definition.id: definition
    for definition in (MODEL_WORKFLOW, APPLY_WORKFLOW, HEAVY_WORKFLOW, TWO_STEP_WORKFLOW)
}


class RecordingCeiling(MemoryConcurrencyCeiling):
    """Memory ceiling that also records the per-kind release order."""

    def __init__(self, limits: dict[str, int]) -> None:
        super().__init__(limits)
        self.released: list[str] = []
        self.released_by: list[tuple[str, str]] = []

    async def release(self, run_id: str, kind: str = RUN_SLOT) -> str | None:
        self.released.append(kind)
        self.released_by.append((run_id, kind))
        return await super().release(run_id, kind)


class ExplodingCeiling(RecordingCeiling):
    """Recording ceiling whose model acquire dies mid-walk (backend outage)."""

    def __init__(self, limits: dict[str, int]) -> None:
        super().__init__(limits)
        self.explode = False

    async def acquire(self, run_id: str, kind: str = RUN_SLOT) -> int | None:
        if self.explode and kind == MODEL_SLOT:
            raise RuntimeError("ceiling backend unavailable")
        return await super().acquire(run_id, kind)


class HookedCeiling(RecordingCeiling):
    """Recording ceiling that parks one run's acquire on one kind.

    The park makes an otherwise-scheduled race (a cancel landing while a
    promoted run re-walks its acquisition) reproducible step by step.
    """

    def __init__(self, limits: dict[str, int], *, hook_kind: str) -> None:
        super().__init__(limits)
        self.hook_kind = hook_kind
        self.hook_run_id = ""
        self.armed = False
        self.entered = asyncio.Event()
        self.unblocked = asyncio.Event()

    async def acquire(self, run_id: str, kind: str = RUN_SLOT) -> int | None:
        if self.armed and run_id == self.hook_run_id and kind == self.hook_kind:
            self.armed = False
            self.entered.set()
            await self.unblocked.wait()
        return await super().acquire(run_id, kind)


class ExplodingRegistry(InMemoryRunRegistry):
    """In-memory registry that starts refusing saves (persisted-store outage)."""

    def __init__(self) -> None:
        super().__init__()
        self.saves = 0
        self.fail_after: int | None = None

    async def save(self, run: WorkflowRun) -> None:
        self.saves += 1
        if self.fail_after is not None and self.saves > self.fail_after:
            raise RuntimeError("registry unavailable")
        await super().save(run)


class ExplodingClient:
    """Fails every pass the way the HTTP bridge does: a MastraClientError."""

    async def start(self, **kwargs: object) -> MastraOutcome:
        raise MastraClientError("engine down")

    async def resume(self, **kwargs: object) -> MastraOutcome:
        raise MastraClientError("engine down")


def make_ceilings(
    *, runs: int = 5, applies: int = 2, models: int = 4
) -> RecordingCeiling:
    return RecordingCeiling({RUN_SLOT: runs, APPLY_SLOT: applies, MODEL_SLOT: models})


def make_service(
    mastra: object,
    ceilings: RecordingCeiling,
    *,
    config: RunServiceConfig | None = None,
    clock: Callable[[], datetime] | None = None,
    registry: InMemoryRunRegistry | None = None,
) -> RunService:
    return RunService(
        workflows=WORKFLOWS,
        registry=registry or InMemoryRunRegistry(),
        ceilings=ceilings,
        locks=MemoryTargetLockStore(),
        receipts=MemoryRunReceiptStore(),
        events=InMemoryRunEventBus(),
        mastra=mastra,  # type: ignore[arg-type]
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        config=config,
        clock=clock,
    )


def gated_client(
    gates: dict[str, asyncio.Event],
    *,
    gate_steps: frozenset[str] = frozenset(),
    ceilings: MemoryConcurrencyCeiling | None = None,
    observations: list[int] | None = None,
) -> ScriptedMastraRunClient:
    """Scripted client whose builder parks in-flight while a marker is gated.

    ``gate_steps`` narrows the block to specific steps (a gated run then holds
    its granted slots with the pass in flight); when a ceiling is passed, every
    builder entry samples the live model count so caps are asserted, not
    assumed.
    """

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        if observations is not None and ceilings is not None:
            observations.append(await ceilings.active_count(MODEL_SLOT))
        marker = str(run_input.get("marker", ""))
        if marker in gates and (not gate_steps or step_id in gate_steps):
            await gates[marker].wait()
        return {"marker": marker, "stepId": step_id}

    return ScriptedMastraRunClient(
        {
            "mlFlow": ("infer",),
            "depsFlow": ("scan", "group", "apply", "merge"),
            "heavyFlow": ("h", "tail"),
            "twoFlow": ("r1", "r2"),
        },
        builder=builder,
    )


async def start_run(service: RunService, workflow: str, marker: str):
    return await service.start(
        workflow=workflow,
        ticket_key=f"T-{marker}",
        case_id="case-1",
        run_input={"marker": marker},
        principal=PRINCIPAL,
    )


async def proceed(service: RunService, run_id: str, step_id: str):
    return await service.decide(
        run_id=run_id, step_id=step_id, action="proceed", principal=PRINCIPAL
    )


async def queued_events(service: RunService, run_id: str) -> list[dict[str, object]]:
    history = await service.history(run_id)
    return [event for event in history if event.get("type") == "run.queued"]


async def zero(ceilings: MemoryConcurrencyCeiling) -> None:
    for kind in (RUN_SLOT, APPLY_SLOT, MODEL_SLOT):
        assert await ceilings.active_count(kind) == 0, kind


# ------------------------------------------------------------- 1. model cap


async def test_model_cap_queues_third_run_on_model_kind() -> None:
    gates = {"a": asyncio.Event(), "b": asyncio.Event()}
    observations: list[int] = []
    ceilings = make_ceilings(models=2)
    client = gated_client(
        gates,
        gate_steps=frozenset({"infer"}),
        ceilings=ceilings,
        observations=observations,
    )
    service = make_service(client, ceilings)

    task_a = asyncio.create_task(start_run(service, "ml", "a"))
    await asyncio.sleep(0.05)
    task_b = asyncio.create_task(start_run(service, "ml", "b"))
    await asyncio.sleep(0.05)
    run_c = await start_run(service, "ml", "c")

    assert run_c.status == "queued"
    assert run_c.queue_position == 1
    events = await queued_events(service, run_c.run_id)
    assert events, "the third run must publish run.queued"
    assert events[-1].get("waitingOn") == MODEL_SLOT
    assert await ceilings.active_count(MODEL_SLOT) == 2
    assert await ceilings.active_count(RUN_SLOT) == 3  # holds are cumulative
    assert max(observations) == 2  # the cap held while three passes competed

    for gate in gates.values():
        gate.set()
    run_a = await asyncio.wait_for(task_a, timeout=5)
    await asyncio.wait_for(task_b, timeout=5)

    reloaded_c = await service.get(run_c.run_id, TENANT)
    assert reloaded_c.status == "awaiting_human"  # promoted, then driven
    assert reloaded_c.queue_position is None
    assert run_a.status == "awaiting_human"

    await proceed(service, run_c.run_id, "infer")
    final = await service.get(run_c.run_id, TENANT)
    assert final.status == "completed"
    await zero(ceilings)


# ------------------------------------------------------------- 2. apply cap


async def test_apply_cap_serializes_third_dependency_run() -> None:
    gates = {"a": asyncio.Event(), "b": asyncio.Event()}
    ceilings = make_ceilings()
    client = gated_client(gates, gate_steps=frozenset({"apply"}), ceilings=ceilings)
    service = make_service(client, ceilings)

    ids: dict[str, str] = {}
    for marker in ("a", "b", "c"):
        run = await start_run(service, "deps", marker)
        ids[marker] = run.run_id
        await proceed(service, run.run_id, "scan")

    task_a = asyncio.create_task(proceed(service, ids["a"], "group"))
    await asyncio.sleep(0.05)
    task_b = asyncio.create_task(proceed(service, ids["b"], "group"))
    await asyncio.sleep(0.05)
    await proceed(service, ids["c"], "group")

    run_c = await service.get(ids["c"], TENANT)
    assert run_c.status == "queued"
    assert run_c.queue_position == 1
    events = await queued_events(service, run_c.run_id)
    assert events[-1].get("waitingOn") == APPLY_SLOT
    assert await ceilings.active_count(APPLY_SLOT) == 2  # the cap is real now

    gates["a"].set()
    await asyncio.wait_for(task_a, timeout=5)
    gates["b"].set()
    await asyncio.wait_for(task_b, timeout=5)

    run_c = await service.get(ids["c"], TENANT)
    assert run_c.status == "awaiting_human"
    assert run_c.current_step() is not None
    assert run_c.current_step().step_id == "apply"  # serialized, then promoted

    for marker in ("a", "b", "c"):
        for step_id in ("apply", "merge"):
            await proceed(service, ids[marker], step_id)
        final = await service.get(ids[marker], TENANT)
        assert final.status == "completed"
    await zero(ceilings)


# -------------------------------------------------- 3. reverse-order release


async def test_suspend_releases_model_then_apply_then_run() -> None:
    ceilings = make_ceilings()
    service = make_service(gated_client({}, ceilings=ceilings), ceilings)
    run = await start_run(service, "heavy", "solo")
    assert run.status == "awaiting_human"
    # The suspended pass hands every granted kind back in strict reverse.
    assert ceilings.released[:3] == [MODEL_SLOT, APPLY_SLOT, RUN_SLOT]
    await zero(ceilings)


async def test_completion_releases_every_kind() -> None:
    ceilings = make_ceilings()
    service = make_service(gated_client({}, ceilings=ceilings), ceilings)
    run = await start_run(service, "heavy", "solo")
    await proceed(service, run.run_id, "h")
    mid = await service.get(run.run_id, TENANT)
    assert mid.status == "awaiting_human"
    await zero(ceilings)  # the suspend between passes leaked nothing
    await proceed(service, run.run_id, "tail")
    final = await service.get(run.run_id, TENANT)
    assert final.status == "completed"
    await zero(ceilings)


async def test_failure_releases_every_kind() -> None:
    ceilings = make_ceilings()
    service = make_service(ExplodingClient(), ceilings)
    run = await start_run(service, "heavy", "boom")
    assert run.status == "failed"
    # The failed pass released every kind it had been granted, in reverse.
    assert ceilings.released == [MODEL_SLOT, APPLY_SLOT, RUN_SLOT]
    await zero(ceilings)


async def test_cancel_of_in_flight_pass_releases_all_kinds() -> None:
    gates = {"a": asyncio.Event()}
    ceilings = make_ceilings()
    service = make_service(
        gated_client(gates, gate_steps=frozenset({"h"}), ceilings=ceilings), ceilings
    )
    task = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    active = await service.list_active(TENANT)
    running = next(run for run in active if run.status == "running")
    assert await ceilings.active_count(MODEL_SLOT) == 1

    cancelled = await service.cancel(
        run_id=running.run_id, tenant_id=TENANT, reason="stop"
    )
    assert cancelled.status == "cancelled"
    await zero(ceilings)  # cancel released model+apply+run while the pass spun

    gates["a"].set()
    finished = await asyncio.wait_for(task, timeout=5)
    assert finished.status == "cancelled"
    await zero(ceilings)


async def test_timeout_sweep_releases_all_kinds() -> None:
    gates = {"a": asyncio.Event()}
    now = [datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)]
    ceilings = make_ceilings()
    service = make_service(
        gated_client(gates, gate_steps=frozenset({"h"}), ceilings=ceilings),
        ceilings,
        config=RunServiceConfig(max_run_seconds=100),
        clock=lambda: now[0],
    )
    task = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    assert await ceilings.active_count(MODEL_SLOT) == 1

    now[0] = now[0] + timedelta(seconds=101)
    affected = await service.sweep_expired()
    assert len(affected) == 1
    await zero(ceilings)

    gates["a"].set()
    finished = await asyncio.wait_for(task, timeout=5)
    assert finished.status == "cancelled"
    await zero(ceilings)


# ------------------------------------------------- 4. ordered acquisition


async def test_acquisition_order_makes_progress_under_tight_caps() -> None:
    # run 2 / apply 2 / model 1: a holder of two ceilings waits only on the
    # last kind, never on an earlier one — no cycle can form.
    gates = {"a": asyncio.Event(), "b": asyncio.Event()}
    ceilings = make_ceilings(runs=2, applies=2, models=1)
    service = make_service(
        gated_client(gates, gate_steps=frozenset({"h"}), ceilings=ceilings), ceilings
    )
    task_a = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    task_b = asyncio.create_task(start_run(service, "heavy", "b"))
    await asyncio.sleep(0.05)
    run_c = await start_run(service, "heavy", "c")
    run_d = await start_run(service, "heavy", "d")

    b_run = next(
        run for run in await service.list_active(TENANT) if run.ticket_key == "T-b"
    )
    assert b_run.status == "queued"
    assert b_run.queue_position == 1
    events = await queued_events(service, b_run.run_id)
    assert events[-1].get("waitingOn") == MODEL_SLOT  # queued on model anyway
    assert await ceilings.active_count(RUN_SLOT) == 2
    assert await ceilings.active_count(APPLY_SLOT) == 2  # a and b hold it
    assert await ceilings.active_count(MODEL_SLOT) == 1  # only a got it
    assert run_c.status == "queued" and run_c.queue_position == 1
    assert run_d.status == "queued" and run_d.queue_position == 2

    gates["a"].set()
    gates["b"].set()
    # task_a's release chain promotes b, then c and d in turn; with a broken
    # order this would hang instead of completing.
    run_a = await asyncio.wait_for(task_a, timeout=10)
    await asyncio.wait_for(task_b, timeout=10)
    assert run_a.status == "awaiting_human"
    for run in (b_run, run_c, run_d):
        fresh = await service.get(run.run_id, TENANT)
        assert fresh.status == "awaiting_human", fresh.ticket_key
        assert fresh.queue_position is None
    await zero(ceilings)


# --------------------------------------------------- 5. promotion re-drive


async def test_promotion_replays_recorded_resume_not_a_restart() -> None:
    gates = {"x": asyncio.Event()}
    ceilings = make_ceilings(models=1)
    client = gated_client(gates, gate_steps=frozenset({"infer"}), ceilings=ceilings)
    service = make_service(client, ceilings)
    # A model-bearing run parks its pass in flight, holding the only slot.
    task_x = asyncio.create_task(start_run(service, "ml", "x"))
    await asyncio.sleep(0.05)

    run = await start_run(service, "two", "late")
    assert run.status == "awaiting_human"  # first pass computed pure r1
    assert run.current_step() is not None
    assert run.current_step().step_id == "r1"

    await proceed(service, run.run_id, "r1")  # the r2 pass needs model: queues
    queued = await service.get(run.run_id, TENANT)
    assert queued.status == "queued"
    assert queued.queue_position == 1
    events = await queued_events(service, run.run_id)
    assert events[-1].get("waitingOn") == MODEL_SLOT

    gates["x"].set()
    await asyncio.wait_for(task_x, timeout=5)

    resumed = await service.get(run.run_id, TENANT)
    assert resumed.status == "awaiting_human"
    assert resumed.current_step() is not None
    assert resumed.current_step().step_id == "r2"  # continued at the recorded pass
    assert resumed.step("r1").state == "done"
    mine = [call for call in client.calls if call[2].startswith(run.run_id)]
    assert [call[0] for call in mine] == ["start", "resume"]  # no restart
    await zero(ceilings)


# ---------------------------------------- 6. no grant without a guaranteed give


async def test_acquire_failure_mid_walk_releases_the_granted_prefix() -> None:
    # The ceiling dies on the model acquire, after ``run`` and ``apply`` were
    # granted. That prefix was never persisted, so the only way to keep it from
    # leaking for the registry TTL is to hand it straight back, in reverse.
    ceilings = ExplodingCeiling({RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 4})
    service = make_service(gated_client({}, ceilings=ceilings), ceilings)
    ceilings.explode = True

    with pytest.raises(RuntimeError, match="ceiling backend"):
        await start_run(service, "heavy", "boom")

    assert ceilings.released == [APPLY_SLOT, RUN_SLOT]
    await zero(ceilings)


async def test_record_failure_after_a_partial_grant_leaves_no_slot_held() -> None:
    # The denial branch's save is the other half of the walk: the run already
    # sits in the denying kind's queue and holds the earlier prefix, and the
    # record that would have said so could not be written.
    gates = {"x": asyncio.Event()}
    ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 1})
    registry = ExplodingRegistry()
    service = make_service(
        gated_client(gates, gate_steps=frozenset({"infer"}), ceilings=ceilings),
        ceilings,
        registry=registry,
    )

    task_x = asyncio.create_task(start_run(service, "ml", "x"))
    await asyncio.sleep(0.05)

    # x's record save and its running save are the first two: the next one is
    # y's record save, so the walk's own save is the one that dies.
    registry.fail_after = registry.saves + 1
    with pytest.raises(RuntimeError, match="registry unavailable"):
        await start_run(service, "ml", "y")

    run_y = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-y")
    # The queue entry was dropped and the granted run slot given back.
    assert [kind for rid, kind in ceilings.released_by if rid == run_y.run_id] == [
        MODEL_SLOT,
        RUN_SLOT,
    ]
    assert await ceilings.position(run_y.run_id, MODEL_SLOT) is None
    assert await ceilings.active_count(RUN_SLOT) == 1  # only x's parked pass
    assert await ceilings.active_count(MODEL_SLOT) == 1

    registry.fail_after = None  # x can persist its outcome again
    gates["x"].set()
    await asyncio.wait_for(task_x, timeout=5)
    await zero(ceilings)  # the failed record left nothing behind


# --------------------------------------- 7. releases precede promoted drives


async def test_release_frees_every_kind_before_a_promoted_run_drives() -> None:
    gates = {"a": asyncio.Event()}
    ceilings = RecordingCeiling({RUN_SLOT: 2, APPLY_SLOT: 1, MODEL_SLOT: 1})
    snapshots: list[list[tuple[str, str]]] = []

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        marker = str(run_input.get("marker", ""))
        if marker == "b" and step_id == "h":
            snapshots.append(list(ceilings.released_by))
        if marker in gates and step_id == "h":
            await gates[marker].wait()
        return {"marker": marker, "stepId": step_id}

    client = ScriptedMastraRunClient({"heavyFlow": ("h", "tail")}, builder=builder)
    service = make_service(client, ceilings)

    task_a = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    run_a = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-a")
    run_b = await start_run(service, "heavy", "b")
    run_c = await start_run(service, "heavy", "c")
    assert run_b.status == "queued"  # holds run, waits on apply
    assert run_c.status == "queued"  # the run ceiling is already full

    gates["a"].set()
    await asyncio.wait_for(task_a, timeout=5)

    assert snapshots, "the promoted run must have driven its pass"
    freed_by_a = [kind for rid, kind in snapshots[0] if rid == run_a.run_id]
    # Not only the kind that triggered the promotion: apply and run came back
    # too, before any promoted run was allowed to start a pass.
    assert freed_by_a == [MODEL_SLOT, APPLY_SLOT, RUN_SLOT]

    for run in (run_a, run_b, run_c):
        fresh = await service.get(run.run_id, TENANT)
        assert fresh.status == "awaiting_human", fresh.ticket_key
    await zero(ceilings)


# -------------------------------------------- 8. the re-walk holds run's lock


async def test_cancel_racing_a_promotion_rewalk_keeps_the_run_cancelled() -> None:
    gates = {"x": asyncio.Event(), "y": asyncio.Event()}
    ceilings = HookedCeiling(
        {RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 1}, hook_kind=MODEL_SLOT
    )
    client = gated_client(gates, gate_steps=frozenset({"infer"}), ceilings=ceilings)
    service = make_service(client, ceilings)

    task_x = asyncio.create_task(start_run(service, "ml", "x"))
    await asyncio.sleep(0.05)
    run_y = await start_run(service, "ml", "y")
    assert run_y.status == "queued"
    assert await ceilings.active_count(MODEL_SLOT) == 1

    # Arm the park on y's next model acquire, then let x finish: x's release
    # promotes y, whose re-walk now sits inside the acquisition walk.
    ceilings.hook_run_id = run_y.run_id
    ceilings.armed = True
    gates["x"].set()
    await asyncio.wait_for(ceilings.entered.wait(), timeout=5)

    task_cancel = asyncio.create_task(
        service.cancel(run_id=run_y.run_id, tenant_id=TENANT, reason="stop")
    )
    await asyncio.sleep(0.05)
    ceilings.unblocked.set()
    await asyncio.wait_for(task_cancel, timeout=5)

    # y's promoted pass was already dispatched outside the lock; its outcome
    # must be discarded, not applied to the cancelled record. x (whose release
    # nested the promotion) completes only once that gate opens.
    gates["y"].set()
    run_x = await asyncio.wait_for(task_x, timeout=5)
    assert run_x.status == "awaiting_human"  # x drove on; y never came back
    final = await service.get(run_y.run_id, TENANT)
    assert final.status == "cancelled"  # never resurrected as running
    assert final.step("infer").state == "pending"  # the walk drove nothing through
    assert final.step("infer").artifact is None
    statuses = [
        event.get("status")
        for event in await service.history(run_y.run_id)
        if event.get("type") == "run.status"
    ]
    assert statuses == ["cancelled"]
    await zero(ceilings)


# -------------------------------------- 9. an unheld release promotes nobody


async def test_release_of_an_unheld_slot_promotes_no_one() -> None:
    # The parity contract both back-ends must honour: capacity moves to the
    # queue head only when a release actually freed a slot.
    ceilings = MemoryConcurrencyCeiling({RUN_SLOT: 1, APPLY_SLOT: 1, MODEL_SLOT: 1})
    assert await ceilings.acquire("holder", MODEL_SLOT) is None
    assert await ceilings.acquire("waiter", MODEL_SLOT) == 1

    assert await ceilings.release("stranger", MODEL_SLOT) is None
    assert await ceilings.active_count(MODEL_SLOT) == 1
    assert await ceilings.position("waiter", MODEL_SLOT) == 1

    assert await ceilings.acquire("grant", APPLY_SLOT) is None
    assert await ceilings.acquire("queued", APPLY_SLOT) == 1
    assert await ceilings.release("queued", APPLY_SLOT) is None  # unqueue only
    assert await ceilings.active_count(APPLY_SLOT) == 1
    assert await ceilings.position("queued", APPLY_SLOT) is None

    assert await ceilings.release("holder", MODEL_SLOT) == "waiter"
    assert await ceilings.active_count(MODEL_SLOT) == 1  # transferred, never doubled


def test_release_script_gates_promotion_on_a_freed_slot() -> None:
    """No Redis and no Lua runtime in the dev set, so the script cannot be
    executed here: pin the guard structure instead (the slot ZREM result is
    captured, an unqueue returns early, head promotion sits behind
    ``freed ~= 1``), which is what the Memory parity test above asserts.
    """
    script = _RELEASE_SCRIPT
    slot_zrem = script.index("local freed = redis.call('ZREM', slot_key, run_id)")
    unqueue_guard = script.index("if unqueued == 1 then")
    freed_guard = script.index("if freed ~= 1 then")
    promotion = script.index("redis.call('ZADD', slot_key, ARGV[2], promoted)")
    assert slot_zrem < unqueue_guard < freed_guard < promotion


# ------------------------------------------ 10. declarable slot kinds only


def test_step_definition_rejects_unknown_slot_kind() -> None:
    # An unknown kind is filtered out by ``_pass_kinds``, so a ``"modl"`` typo
    # would silently un-cap the step. The declaration itself has to fail.
    with pytest.raises(ValueError, match="modl"):
        StepDefinition(id="slip", title="Slip", slots=("modl",))
    with pytest.raises(ValueError, match="ceiling slot"):
        StepDefinition(id="slip", title="Slip", slots=(MODEL_SLOT, "aply"))

    valid = StepDefinition(id="ok", title="Ok", slots=(APPLY_SLOT, MODEL_SLOT))
    assert valid.slots == (APPLY_SLOT, MODEL_SLOT)


def test_shipped_definitions_only_declare_known_slots() -> None:
    from allrounder_api.runs.definitions import WORKFLOW_DEFINITIONS

    order = set(SLOT_ORDER)
    for definition in WORKFLOW_DEFINITIONS.values():
        for step in definition.steps:
            assert set(step.slots) <= order, step.id
    assert order == {RUN_SLOT, APPLY_SLOT, MODEL_SLOT}


# ------------------------- 11. (fix round 2) a promotion never dies on a save


class OnceFailingRegistry(InMemoryRunRegistry):
    """Registry that refuses exactly the next save, then behaves normally."""

    def __init__(self) -> None:
        super().__init__()
        self.fail_next = False

    async def save(self, run: WorkflowRun) -> None:
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("registry unavailable")
        await super().save(run)


class CancelOnceRegistry(OnceFailingRegistry):
    """Registry that raises ``CancelledError`` on exactly the next save.

    Stands in for the shutdown or timeout cancellation that can land while the
    release seam is writing its record: the slots are already back, so the
    promotions must still run, but the cancellation must not be absorbed."""

    async def save(self, run: WorkflowRun) -> None:
        if self.fail_next:
            self.fail_next = False
            raise asyncio.CancelledError
        await super().save(run)


class ArmOnLastRelease(RecordingCeiling):
    """Recording ceiling that arms a one-shot save failure the moment ``victim``
    gives back its last kind.

    The release walk ends with ``run``, and the very next write is
    ``_release_and_promote``'s record save — so arming here hits exactly the
    save whose failure used to skip the whole promotion loop, nothing earlier.
    """

    def __init__(
        self, limits: dict[str, int], *, registry: OnceFailingRegistry, victim: str = ""
    ) -> None:
        super().__init__(limits)
        self.registry = registry
        self.victim = victim

    async def release(self, run_id: str, kind: str = RUN_SLOT) -> str | None:
        promoted = await super().release(run_id, kind)
        if run_id == self.victim and kind == RUN_SLOT:
            self.registry.fail_next = True
        return promoted


class ParkedReleaseCeiling(RecordingCeiling):
    """Recording ceiling that parks once a release has already transferred its
    slot to the queue head.

    The transfer and the removal of the head's queue entry are atomic inside
    ``release``; parking *after* super() returns therefore freezes the exact
    grant window every promoted run walks through: the promoted run holds the
    slot, has no queue entry, and its record still says ``queued`` because the
    promotion that would save ``running`` has not started yet.
    """

    def __init__(self, limits: dict[str, int], *, park_kind: str) -> None:
        super().__init__(limits)
        self.park_kind = park_kind
        self.park_run_id = ""
        self.armed = False
        self.entered = asyncio.Event()
        self.unblocked = asyncio.Event()

    async def release(self, run_id: str, kind: str = RUN_SLOT) -> str | None:
        promoted = await super().release(run_id, kind)
        if self.armed and kind == self.park_kind and promoted == self.park_run_id:
            self.armed = False
            self.entered.set()
            await self.unblocked.wait()
        return promoted


async def test_a_queued_run_with_no_queue_entry_is_reported_never_driven() -> None:
    """Invariant: a ``queued`` run with no entry on the kind it waits on is an
    anomaly the position refresh reports, not a state it repairs.

    The state is produced here by the real slot transfer (the release hands the
    model slot to the queue head and drops that head's queue entry). The
    refresh re-reads positions only: it must log ``run_queued_without_queue_entry``
    for that run, leave it ``queued``, and drive nothing — no launch, no state
    write. The stranded grant itself is a ceiling design gap (a run cannot be
    told apart from a waiter by ``position()``), recorded as a PR2 residual.
    """
    gates = {"x": asyncio.Event()}
    ceilings = make_ceilings(models=1)
    client = gated_client(gates, gate_steps=frozenset({"infer"}), ceilings=ceilings)
    service = make_service(client, ceilings)
    task_x = asyncio.create_task(start_run(service, "ml", "x"))
    await asyncio.sleep(0.05)

    run_y = await start_run(service, "ml", "y")
    assert run_y.status == "queued"
    assert run_y.queue_position == 1

    holder = next(
        run for run in await service.list_active(TENANT) if run.status == "running"
    )
    assert await ceilings.release(holder.run_id, MODEL_SLOT) == run_y.run_id
    assert await ceilings.position(run_y.run_id, MODEL_SLOT) is None
    still = await service.get(run_y.run_id, TENANT)
    assert still.status == "queued"  # granted, undriven, and invisible to the sweep

    with capture_logs() as logs:
        await service._refresh_queue_positions()

    anomalies = [entry for entry in logs if entry["event"] == "run_queued_without_queue_entry"]
    assert [(entry["run_id"], entry["kind"]) for entry in anomalies] == [
        (run_y.run_id, MODEL_SLOT)
    ]
    untouched = await service.get(run_y.run_id, TENANT)
    assert untouched.status == "queued"  # reported, never repaired
    assert untouched.queue_position == 1  # no state write
    mine = [call for call in client.calls if call[2].startswith(run_y.run_id)]
    assert mine == []  # nothing launched, nothing re-walked

    # The capacity it holds is still real, so clean up through the cancel path
    # (which releases the granted run slot plus the transferred model slot).
    await service.cancel(run_id=run_y.run_id, tenant_id=TENANT, reason="cleanup")
    gates["x"].set()
    await asyncio.wait_for(task_x, timeout=5)
    await zero(ceilings)


async def test_a_promoted_run_in_the_grant_window_is_driven_exactly_once() -> None:
    """Invariant: the position refresh never re-drives a run whose grant is
    already landing.

    A release transfers the model slot to the queue head and parks before the
    promotion runs, so the head is a ``queued`` run with no queue entry —
    byte-for-byte the state the removed self-heal keyed on. Running the
    refresh inside that window must not start a second pass for it: when the
    release seam then promotes the run, exactly one Mastra call may carry its
    run id. A second drive would be a duplicate pass and duplicate model
    spend, would re-stamp the heartbeat the sweeper watches, and the second
    outcome release would hand back only the run slot and leak the model grant.
    """
    gates = {"x": asyncio.Event(), "y": asyncio.Event()}
    ceilings = ParkedReleaseCeiling(
        {RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 1}, park_kind=MODEL_SLOT
    )
    client = gated_client(gates, gate_steps=frozenset({"infer"}), ceilings=ceilings)
    service = make_service(client, ceilings)

    task_x = asyncio.create_task(start_run(service, "ml", "x"))
    await asyncio.sleep(0.05)
    run_x = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-x")
    run_y = await start_run(service, "ml", "y")
    assert run_y.status == "queued"
    assert run_y.queue_position == 1

    ceilings.park_run_id = run_y.run_id
    ceilings.armed = True
    task_cancel = asyncio.create_task(
        service.cancel(run_id=run_x.run_id, tenant_id=TENANT, reason="stop")
    )
    await asyncio.wait_for(ceilings.entered.wait(), timeout=5)

    stranded = await service.get(run_y.run_id, TENANT)
    assert stranded.status == "queued"
    assert await ceilings.position(run_y.run_id, MODEL_SLOT) is None

    with capture_logs() as logs:
        await service._refresh_queue_positions()
    assert [entry["event"] for entry in logs] == ["run_queued_without_queue_entry"]

    # Still the only drive path: the release seam's own promotion, which is now
    # parked behind the ceiling hook.
    gates["y"].set()
    ceilings.unblocked.set()
    await asyncio.wait_for(task_cancel, timeout=5)

    served = await service.get(run_y.run_id, TENANT)
    assert served.status == "awaiting_human"  # promoted once, by the release seam
    mine = [call for call in client.calls if call[2].startswith(run_y.run_id)]
    assert [call[0] for call in mine] == ["start"]  # never a second pass

    gates["x"].set()
    await asyncio.wait_for(task_x, timeout=5)
    await zero(ceilings)


async def test_a_failed_release_save_still_promotes_the_granted_run() -> None:
    """The ``finally`` half of item 2: the slots are already back and the queue
    entry already removed, so a record save that dies must not strand the run
    that was handed them.

    Caps run 2 / apply 1 / model 1: a parks its pass in flight holding all
    three, b holds ``run`` and waits on ``apply``. a's release walk transfers
    apply to b, then the armed save of a's cleared grant raises — the exact
    failure that used to abort before the promotion loop. b still drives.
    """
    gates = {"a": asyncio.Event()}
    registry = OnceFailingRegistry()
    ceilings = ArmOnLastRelease({RUN_SLOT: 2, APPLY_SLOT: 1, MODEL_SLOT: 1}, registry=registry)
    client = gated_client(gates, gate_steps=frozenset({"h"}), ceilings=ceilings)
    service = make_service(client, ceilings, registry=registry)

    task_a = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    run_a = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-a")
    ceilings.victim = run_a.run_id

    run_b = await start_run(service, "heavy", "b")
    assert run_b.status == "queued"
    assert run_b.queue_position == 1
    assert not registry.fail_next  # nothing armed before a's release walk

    gates["a"].set()
    finished_a = await asyncio.wait_for(task_a, timeout=5)

    assert finished_a.status == "awaiting_human"  # the failed save never escaped
    assert not registry.fail_next  # the armed save really was attempted

    healed_b = await service.get(run_b.run_id, TENANT)
    assert healed_b.status == "awaiting_human"  # promoted and driven anyway
    assert healed_b.step("h").artifact is not None
    assert healed_b.queue_position is None
    mine = [call for call in client.calls if call[2].startswith(run_b.run_id)]
    assert [call[0] for call in mine] == ["start"]
    await zero(ceilings)


async def test_a_cancelled_release_save_still_promotes_and_still_propagates() -> None:
    """Wave 3 item 5: the release seam guards an error, never a cancellation.

    Both guards there caught ``BaseException``, so an ``asyncio.CancelledError``
    delivered by a shutdown or a timeout was absorbed and the caller returned as
    though nothing had been asked of it, against the house rule in ``_drive``
    (``except asyncio.CancelledError: raise``). The guarantee the seam owns is
    the capacity, not the cancellation: the promotions still run in the
    ``finally``, and the cancellation then keeps travelling outward.
    """
    gates = {"a": asyncio.Event()}
    registry = CancelOnceRegistry()
    ceilings = ArmOnLastRelease({RUN_SLOT: 2, APPLY_SLOT: 1, MODEL_SLOT: 1}, registry=registry)
    client = gated_client(gates, gate_steps=frozenset({"h"}), ceilings=ceilings)
    service = make_service(client, ceilings, registry=registry)

    task_a = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    run_a = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-a")
    ceilings.victim = run_a.run_id

    run_b = await start_run(service, "heavy", "b")
    assert run_b.status == "queued"
    assert run_b.queue_position == 1

    gates["a"].set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task_a, timeout=5)
    assert not registry.fail_next  # the armed save really was attempted

    promoted_b = await service.get(run_b.run_id, TENANT)
    assert promoted_b.status == "awaiting_human"  # the finally promotions ran
    assert promoted_b.step("h").artifact is not None
    mine = [call for call in client.calls if call[2].startswith(run_b.run_id)]
    assert [call[0] for call in mine] == ["start"]
    # Every kind a's pass held is back: the release walk completed before the
    # save that carried the cancellation.
    await zero(ceilings)


# ------------------- 12. (wave 4) every promotion runs before cancelling


class CancelPromoteRegistry(InMemoryRunRegistry):
    """Registry that raises ``CancelledError`` on one run's promotion read.

    ``_promote`` reloads the record through ``get_internal`` before it walks
    anything, so arming this for a run id cancels exactly that run's promotion
    and touches no ceiling state: the stand-in for the shutdown or timeout that
    lands on the first promotion of a release seam's loop. It fires once, so
    the stranded run stays fully readable for the assertions that follow.
    """

    def __init__(self) -> None:
        super().__init__()
        self.cancel_run_id = ""
        self.cancelled: list[str] = []

    async def get_internal(self, run_id: str) -> WorkflowRun:
        if run_id == self.cancel_run_id:
            self.cancel_run_id = ""
            self.cancelled.append(run_id)
            raise asyncio.CancelledError
        return await super().get_internal(run_id)


async def test_a_cancelled_promotion_still_drives_the_runs_behind_it() -> None:
    """Wave 4: the release seam's loop is abandonment-proof, not propagation-proof.

    Narrowing the per-promotion guard to ``Exception`` (wave 3) let a
    ``CancelledError`` on the first promoted id escape the ``finally`` loop and
    abandon the ids behind it. With the refresh's blind re-drive also gone, that
    run is ``queued``, holds a granted slot with no queue entry, is sweep-exempt
    and is never driven again. The loop now records the cancellation, drives
    every remaining granted id, and only then lets the caller see the
    cancellation.

    Caps run 2 / apply 1 / model 1: a parks its pass in flight holding all three
    kinds, b holds ``run`` and waits on ``apply``, c waits on ``run``. a's
    release walk hands apply to b and then run to c, so the loop has two ids to
    drive and the cancellation lands on the first of them.
    """
    gates = {"a": asyncio.Event()}
    registry = CancelPromoteRegistry()
    ceilings = RecordingCeiling({RUN_SLOT: 2, APPLY_SLOT: 1, MODEL_SLOT: 1})
    client = gated_client(gates, gate_steps=frozenset({"h"}), ceilings=ceilings)
    service = make_service(client, ceilings, registry=registry)

    task_a = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    run_a = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-a")
    run_b = await start_run(service, "heavy", "b")
    assert run_b.status == "queued"
    assert run_b.queue_position == 1  # waiting on apply, behind a
    run_c = await start_run(service, "ml", "c")
    assert run_c.status == "queued"
    assert run_c.queue_position == 1  # waiting on run, behind a and b

    registry.cancel_run_id = run_b.run_id  # b is the first id a's walk promotes
    with capture_logs() as logs, pytest.raises(asyncio.CancelledError):
        await service._release_and_promote(await service.get(run_a.run_id, TENANT))

    assert registry.cancelled == [run_b.run_id]
    driven_c = await service.get(run_c.run_id, TENANT)
    assert driven_c.status == "awaiting_human"  # the second id was never abandoned
    mine_c = [call for call in client.calls if call[2].startswith(run_c.run_id)]
    assert [call[0] for call in mine_c] == ["start"]
    assert [
        entry["run_id"] for entry in logs if entry["event"] == "run_promotion_cancelled"
    ] == [run_b.run_id]

    # b is the residue a mid-loop cancellation still leaves: granted apply,
    # never driven. The refresh reports it and only PR2's holder-versus-waiter
    # discriminator can repair it.
    stranded_b = await service.get(run_b.run_id, TENANT)
    assert stranded_b.status == "queued"
    assert await ceilings.position(run_b.run_id, APPLY_SLOT) is None  # it holds apply
    assert [call for call in client.calls if call[2].startswith(run_b.run_id)] == []

    gates["a"].set()
    await asyncio.wait_for(task_a, timeout=5)
    await service.cancel(run_id=run_b.run_id, tenant_id=TENANT, reason="cleanup")
    await zero(ceilings)


async def test_a_cancelled_rollback_promotion_still_drives_the_runs_behind_it() -> None:
    """Wave 4, the same shape for ``_rollback_partial_grant``'s promotion loop.

    That loop's guard was still ``BaseException``, so a cancellation arriving at
    the identical save-and-promote seam was absorbed into a log line and the
    caller kept walking as if nothing had been asked of it. Undoing a's granted
    prefix hands apply to b and run to c; the cancellation lands on b's
    promotion, c is driven anyway, and the cancellation then propagates out of
    the rollback instead of being logged away.
    """
    gates = {"a": asyncio.Event()}
    registry = CancelPromoteRegistry()
    ceilings = RecordingCeiling({RUN_SLOT: 2, APPLY_SLOT: 1, MODEL_SLOT: 1})
    client = gated_client(gates, gate_steps=frozenset({"h"}), ceilings=ceilings)
    service = make_service(client, ceilings, registry=registry)

    task_a = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    run_a = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-a")
    run_b = await start_run(service, "heavy", "b")
    assert run_b.status == "queued"
    run_c = await start_run(service, "ml", "c")
    assert run_c.status == "queued"

    registry.cancel_run_id = run_b.run_id
    with pytest.raises(asyncio.CancelledError):
        await service._rollback_partial_grant(
            await service.get(run_a.run_id, TENANT),
            [RUN_SLOT, APPLY_SLOT, MODEL_SLOT],
            None,
        )

    assert registry.cancelled == [run_b.run_id]
    driven_c = await service.get(run_c.run_id, TENANT)
    assert driven_c.status == "awaiting_human"  # the second id was never abandoned
    mine_c = [call for call in client.calls if call[2].startswith(run_c.run_id)]
    assert [call[0] for call in mine_c] == ["start"]

    stranded_b = await service.get(run_b.run_id, TENANT)
    assert stranded_b.status == "queued"
    assert await ceilings.position(run_b.run_id, APPLY_SLOT) is None

    gates["a"].set()
    await asyncio.wait_for(task_a, timeout=5)
    await service.cancel(run_id=run_b.run_id, tenant_id=TENANT, reason="cleanup")
    await zero(ceilings)


