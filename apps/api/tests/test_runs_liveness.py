"""Heartbeat-liveness tests: the sweep deadline measures time-since-progress.

The serving plane reaps a *running* run once it has gone this long without a
serving-plane progress event (pass launch, step suspension, decision) —
never for total elapsed time, and never while it is merely waiting in a
ceiling FIFO queue (``queued`` runs are exempt: waiting for capacity is not
being stuck). Seven behaviors, all offline with the in-memory adapters and an
injected clock (nothing sleeps in real time):

1. a run advancing through several steps, each pass pushing the clock past
   the old ``started_at`` deadline, is never swept while it is healthy;
2. a run whose clock advances with no step transition is swept, and every
    kind it held (run, apply, model) reports its ``active_count`` back —
    the leak regression guard for Task 1's release discipline;
3. the sweep path publishes the terminal ``run.status`` event the console
   already consumes (snapshot embedded, ``heartbeatAt`` honest), and the
   reaped run's terminal record is saved before a promoted run drives;
4. a record serialized without the heartbeat/pendingPass fields (legacy
   shape) deserializes and is swept by the old ``started_at`` semantics
   rather than crashing or becoming immune;
5. (fix round 1) a ``queued`` run that has waited far past the budget on a
   healthy holder is never reaped for waiting;
6. (fix round 1) a stalled ``running`` run is still reaped with all three
   kinds released;
7. (fix round 1) corrupt timestamps fail closed on deserialization: a
   garbage heartbeat falls back to ``started_at`` and a heartbeat older
   than a corrupt ``startedAt`` is clamped up to it — never read-time
   ``now``, which would re-immortalize the record on every read;
8. (fix wave 3) the naive-versus-aware clock pairing is normalized at read
   time, not only inside the clamp comparison: a record whose ISO strings
   mix an offset and no offset loads aware-on-aware, is reaped on schedule,
   and cannot abort the sweep for the healthy runs behind it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import Principal
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import (
    APPLY_SLOT,
    MODEL_SLOT,
    RUN_SLOT,
    InMemoryRunEventBus,
    InMemoryRunRegistry,
    MemoryConcurrencyCeiling,
    MemoryRunReceiptStore,
    MemoryTargetLockStore,
    RunService,
    RunServiceConfig,
    RunStep,
    ScriptedMastraRunClient,
    StepDefinition,
    WorkflowDefinition,
    WorkflowRun,
)

SECRET = b"liveness-receipt-secret-for-tests-0123456789"
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))
TENANT = "omnidewalt"

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
IDLE_BUDGET = 100  # ``max_run_seconds`` used across these tests
PASS_STEP = 60  # clock advance per in-flight pass, so elapsed crosses the budget

# Three pure steps: every pass holds only the run kind, so sweeps here are
# about the liveness clock, never about ceilings.
THREE_WORKFLOW = WorkflowDefinition(
    id="three",
    mastra_workflow="threeFlow",
    title="Three Step Lane",
    steps=(
        StepDefinition(id="s1", title="First"),
        StepDefinition(id="s2", title="Second"),
        StepDefinition(id="s3", title="Third"),
    ),
)

# Heavy shape from the ceilings suite: one pass holds run + apply + model.
HEAVY_WORKFLOW = WorkflowDefinition(
    id="heavy",
    mastra_workflow="heavyFlow",
    title="Heavy Lane",
    steps=(
        StepDefinition(id="h", title="Heavy", slots=(APPLY_SLOT, MODEL_SLOT)),
        StepDefinition(id="tail", title="Tail"),
    ),
)

WORKFLOWS = {definition.id: definition for definition in (THREE_WORKFLOW, HEAVY_WORKFLOW)}


class RecordingCeiling(MemoryConcurrencyCeiling):
    """Memory ceiling that records every (run_id, kind) release."""

    def __init__(self, limits: dict[str, int]) -> None:
        super().__init__(limits)
        self.released_by: list[tuple[str, str]] = []

    async def release(self, run_id: str, kind: str = RUN_SLOT) -> str | None:
        self.released_by.append((run_id, kind))
        return await super().release(run_id, kind)


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
        ceilings=ceilings,  # type: ignore[arg-type]
        locks=MemoryTargetLockStore(),
        receipts=MemoryRunReceiptStore(),
        events=InMemoryRunEventBus(),
        mastra=mastra,  # type: ignore[arg-type]
        signer=ApprovalReceiptSigner(SECRET),
        # The repo expires pending approvals against its own clock, so the
        # injected service clock must drive it too (a T0 from January would
        # otherwise read as already expired at decide time).
        approvals=InMemoryApprovalRepository(clock=clock),
        config=config,
        clock=clock,
    )


async def start_run(service: RunService, workflow: str, marker: str) -> WorkflowRun:
    return await service.start(
        workflow=workflow,
        ticket_key=f"T-{marker}",
        case_id="case-1",
        run_input={"marker": marker},
        principal=PRINCIPAL,
    )


async def proceed(service: RunService, run_id: str, step_id: str) -> WorkflowRun:
    result = await service.decide(
        run_id=run_id, step_id=step_id, action="proceed", principal=PRINCIPAL
    )
    return result.run


async def zero(ceilings: RecordingCeiling) -> None:
    for kind in (RUN_SLOT, APPLY_SLOT, MODEL_SLOT):
        assert await ceilings.active_count(kind) == 0, kind


# ------------------------------------------- 1. an advancing run is immune


async def test_advancing_run_survives_the_old_elapsed_deadline() -> None:
    # Every pass pushes the injected clock 60s while it is in flight, so the
    # third sweep lands at 180s elapsed — past the 100s budget measured from
    # ``started_at``, yet only 60s of silence since the last step transition.
    now = [T0]
    gates = {step: asyncio.Event() for step in ("s1", "s2", "s3")}

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        await gates[step_id].wait()
        now[0] = now[0] + timedelta(seconds=PASS_STEP)
        return {"marker": run_input.get("marker"), "stepId": step_id}

    client = ScriptedMastraRunClient({"threeFlow": ("s1", "s2", "s3")}, builder=builder)
    ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 4})
    service = make_service(
        client,
        ceilings,
        config=RunServiceConfig(max_run_seconds=IDLE_BUDGET),
        clock=lambda: now[0],
    )

    sweeps: list[list[str]] = []

    task = asyncio.create_task(start_run(service, "three", "adv"))
    await asyncio.sleep(0.05)
    sweeps.append(await service.sweep_expired())
    gates["s1"].set()
    run = await asyncio.wait_for(task, timeout=5)
    assert run.status == "awaiting_human"
    assert run.heartbeat_at == now[0]  # stamped when the pass suspended

    for step_id, gate in (("s1", "s2"), ("s2", "s3")):
        task = asyncio.create_task(proceed(service, run.run_id, step_id))
        await asyncio.sleep(0.05)
        live = await service.get(run.run_id, TENANT)
        assert live.status == "running"
        now[0] = now[0] + timedelta(seconds=PASS_STEP)
        sweeps.append(await service.sweep_expired())
        gates[gate].set()
        await asyncio.wait_for(task, timeout=5)

    # Past the old deadline (elapsed 180s > budget 100s) yet never swept,
    # because each sweep saw progress inside the budget.
    assert sweeps == [[], [], []]
    assert (now[0] - T0).total_seconds() > 3 * IDLE_BUDGET / 2

    final = await proceed(service, run.run_id, "s3")
    assert final.status == "completed"
    assert final.heartbeat_at == final.finished_at == now[0]
    assert (final.finished_at - final.started_at).total_seconds() > IDLE_BUDGET
    await zero(ceilings)


# -------------------------------- 2. a stalled run is swept, kinds freed


async def test_stalled_run_is_swept_and_every_held_kind_is_freed() -> None:
    # A heavy pass parks mid-flight holding run+apply+model; the clock then
    # advances with no step transition. The sweep reaps it and every kind it
    # held reports its active count back — Task 1's release discipline, from
    # the heartbeat path. B, promoted out of the apply queue by A's release,
    # then proves the launch stamp: its pass is in flight, quiet for 90s
    # since that launch (inside budget) but 185s since it last made a
    # decision and 185s since it started (outside the old reference point),
    # and a second sweep must leave it alone.
    now = [T0]
    gates = {"a": asyncio.Event(), "b": asyncio.Event()}

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        marker = str(run_input.get("marker", ""))
        if step_id == "h" and marker in gates:
            await gates[marker].wait()
        return {"marker": marker, "stepId": step_id}

    client = ScriptedMastraRunClient({"heavyFlow": ("h", "tail")}, builder=builder)
    ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 1, MODEL_SLOT: 1})
    service = make_service(
        client,
        ceilings,
        config=RunServiceConfig(max_run_seconds=IDLE_BUDGET),
        clock=lambda: now[0],
    )

    task_a = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    run_a = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-a")
    assert run_a.status == "running"
    assert await ceilings.active_count(MODEL_SLOT) == 1
    assert await ceilings.active_count(APPLY_SLOT) == 1

    now[0] = T0 + timedelta(seconds=45)  # silence still inside the budget
    run_b = await start_run(service, "heavy", "b")
    assert run_b.status == "queued"  # holds run, waits on apply

    now[0] = T0 + timedelta(seconds=140)  # A stalled 140s, B only 95s
    sweep_task = asyncio.create_task(service.sweep_expired())
    await asyncio.sleep(0.05)

    # A's release chain promoted B and launched its recorded pass at T0+140;
    # that launch is the step transition the heartbeat must have been stamped
    # at, or a healthy promoted run would already be reaped here.
    promoted = await service.get(run_b.run_id, TENANT)
    assert promoted.status == "running"
    assert promoted.heartbeat_at == now[0]  # stamped at the promoted launch
    now[0] = T0 + timedelta(seconds=230)
    assert await service.sweep_expired() == []  # B progressing since launch

    gates["b"].set()  # B's pass suspends (releasing every kind) and sweep 1 ends
    affected = await asyncio.wait_for(sweep_task, timeout=5)
    assert affected == [run_a.run_id]

    reaped = await service.get(run_a.run_id, TENANT)
    assert reaped.status == "cancelled"
    assert reaped.cancel_reason == "timeout"
    # All three kinds the stalled pass held are back; B gave its own grants
    # back on suspension, so the board must be empty.
    for kind in (RUN_SLOT, APPLY_SLOT, MODEL_SLOT):
        assert await ceilings.active_count(kind) == 0, kind
    assert [kind for rid, kind in ceilings.released_by if rid == run_a.run_id] == [
        MODEL_SLOT,
        APPLY_SLOT,
        RUN_SLOT,
    ]

    parked_b = await service.get(run_b.run_id, TENANT)
    assert parked_b.status == "awaiting_human"  # promoted, driven, suspended

    gates["a"].set()
    finished = await asyncio.wait_for(task_a, timeout=5)
    assert finished.status == "cancelled"  # the in-flight outcome was discarded
    await zero(ceilings)


# ------------------------- 3. sweep event and save-before-promotion order


async def test_sweep_publishes_the_console_status_event_before_promoting() -> None:
    # The reaped run's terminal record must be saved before any promoted run
    # drives, and the sweep must speak the console's existing liveness
    # language: a terminal ``run.status`` event with the run snapshot (and
    # its ``heartbeatAt``) embedded — the payload SSE closes the stream on.
    now = [T0]
    gates = {"a": asyncio.Event()}
    registry = InMemoryRunRegistry()
    reaped_ids: list[str] = []
    observations: list[str] = []

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        marker = str(run_input.get("marker", ""))
        if marker == "a" and step_id == "h":
            await gates["a"].wait()
        if marker == "b":
            for reaped_id in reaped_ids:
                observations.append((await registry.get_internal(reaped_id)).status)
        return {"marker": marker, "stepId": step_id}

    client = ScriptedMastraRunClient({"heavyFlow": ("h", "tail")}, builder=builder)
    ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 1, MODEL_SLOT: 1})
    service = make_service(
        client,
        ceilings,
        config=RunServiceConfig(max_run_seconds=IDLE_BUDGET),
        clock=lambda: now[0],
        registry=registry,
    )

    task_a = asyncio.create_task(start_run(service, "heavy", "a"))
    await asyncio.sleep(0.05)
    run_a = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-a")
    reaped_ids.append(run_a.run_id)

    now[0] = T0 + timedelta(seconds=45)
    run_b = await start_run(service, "heavy", "b")
    assert run_b.status == "queued"

    now[0] = T0 + timedelta(seconds=140)
    affected = await service.sweep_expired()
    assert affected == [run_a.run_id]

    # B's promoted pass started only after A's cancelled record was saved.
    assert observations == ["cancelled"]

    events = await service.history(run_a.run_id)
    status_events = [event for event in events if event.get("type") == "run.status"]
    assert [event.get("status") for event in status_events] == ["cancelled"]
    swept = await service.get(run_a.run_id, TENANT)
    snapshot = status_events[-1]["run"]
    assert isinstance(snapshot, dict)  # SNAPSHOT_EVENT_TYPES embed the detail
    assert snapshot.get("status") == "cancelled"
    assert snapshot.get("heartbeatAt") == swept.heartbeat_at.isoformat()
    assert swept.heartbeat_at == swept.finished_at

    gates["a"].set()
    await asyncio.wait_for(task_a, timeout=5)
    await zero(ceilings)


# ------------------------------------------- 4. legacy shape stays bounded


async def test_legacy_record_without_heartbeat_field_is_swept_by_old_semantics() -> None:
    # A record serialized before the heartbeat fields existed must deserialize
    # (additive shape, ``.get`` defaults) and keep the sweep's old reference
    # point: last progress falls back to ``started_at``, so the stale legacy
    # run is reaped rather than becoming permanently immune.
    legacy = WorkflowRun(
        run_id="legacy-1",
        tenant_id=TENANT,
        workflow="heavy",
        ticket_key="T-legacy",
        case_id="case-1",
        input={"marker": "legacy"},
        steps=[
            RunStep(step_id="h", index=0, title="Heavy"),
            RunStep(step_id="tail", index=1, title="Tail"),
        ],
        status="running",
        started_at=T0,
        heartbeat_at=T0,
    )
    raw = legacy.to_dict()
    del raw["heartbeatAt"]  # the pre-heartbeat serialized shape
    raw.pop("pendingPass", None)  # and pre-Task-1 on the same axis

    revived = WorkflowRun.from_dict(raw)
    assert revived.pending_pass is None
    assert revived.heartbeat_at == revived.started_at == T0
    assert revived.to_dict()["heartbeatAt"] == T0.isoformat()  # re-serializes whole

    registry = InMemoryRunRegistry()
    await registry.save(revived)
    now = [T0]
    client = ScriptedMastraRunClient({"heavyFlow": ("h", "tail")})
    ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 4})
    service = make_service(
        client,
        ceilings,
        config=RunServiceConfig(max_run_seconds=IDLE_BUDGET),
        clock=lambda: now[0],
        registry=registry,
    )

    assert await service.sweep_expired() == []  # inside the budget: alive

    now[0] = T0 + timedelta(seconds=IDLE_BUDGET + 1)
    affected = await service.sweep_expired()  # swept by the old semantics, no crash
    assert affected == ["legacy-1"]
    reaped = await service.get("legacy-1", TENANT)
    assert reaped.status == "cancelled"
    assert reaped.cancel_reason == "timeout"
    await zero(ceilings)


# ------------------------- 5. (fix round 1) queued runs are exempt from
# --------------------------------------------- the idle deadline: waiting
#                              for capacity is not being stuck


async def test_queued_run_survives_the_sweep_while_waiting_on_capacity() -> None:
    # The ceilings contract (runs/ceilings.py) promises "over-cap work is
    # never dropped — it waits in FIFO order and reports its position".
    # Y stalls in flight holding the only apply+model pair; X queues behind
    # it, then B queues behind X. Sweep 1 reaps Y (stalled running) and its
    # releases promote X, whose gated pass is now the healthy holder
    # (launch-stamped, idle 0). While sweep 1 is still driving X's pass,
    # sweep 2 runs: B has sat in the queue more than 3x the budget and only
    # waits on capacity — it must come out of it ``queued``, with its FIFO
    # position, never cancelled with reason "timeout".
    now = [T0]
    gates = {"y": asyncio.Event(), "x": asyncio.Event(), "b": asyncio.Event()}

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        marker = str(run_input.get("marker", ""))
        if step_id == "h" and marker in gates:
            await gates[marker].wait()
        return {"marker": marker, "stepId": step_id}

    client = ScriptedMastraRunClient({"heavyFlow": ("h", "tail")}, builder=builder)
    ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 1, MODEL_SLOT: 1})
    service = make_service(
        client,
        ceilings,
        config=RunServiceConfig(max_run_seconds=IDLE_BUDGET),
        clock=lambda: now[0],
    )

    task_y = asyncio.create_task(start_run(service, "heavy", "y"))
    await asyncio.sleep(0.05)
    run_y = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-y")
    assert run_y.status == "running"

    now[0] = T0 + timedelta(seconds=5)
    run_x = await start_run(service, "heavy", "x")
    assert run_x.status == "queued"  # holds run, waits on apply
    assert run_x.queue_position == 1

    now[0] = T0 + timedelta(seconds=10)
    run_b = await start_run(service, "heavy", "b")
    assert run_b.status == "queued"
    assert run_b.queue_position == 2

    # Sweep 1 reaps the stalled Y; Y's release promotes X, whose gated pass
    # keeps this sweep in flight exactly as a production sweep would.
    now[0] = T0 + timedelta(seconds=240)
    sweep1 = asyncio.create_task(service.sweep_expired())
    await asyncio.sleep(0.05)

    holder = await service.get(run_x.run_id, TENANT)
    assert holder.status == "running"
    assert holder.heartbeat_at == now[0]  # launch stamp: the holder is healthy

    waiter = await service.get(run_b.run_id, TENANT)
    assert waiter.status == "queued"
    assert (now[0] - waiter.heartbeat_at).total_seconds() > IDLE_BUDGET

    # Sweep 2: B's queue wait reads 320s against a 100s budget while the run
    # it waits on is alive and idle-quiet for only 90s. Waiting is not
    # stalling — the sweep must return nothing and leave B queued.
    now[0] = T0 + timedelta(seconds=330)
    assert await service.sweep_expired() == []

    waiter = await service.get(run_b.run_id, TENANT)
    assert waiter.status == "queued"
    assert waiter.cancel_reason is None
    assert (now[0] - waiter.heartbeat_at).total_seconds() == 320 > IDLE_BUDGET
    assert await ceilings.position(run_b.run_id, APPLY_SLOT) == 1  # still the head

    # Let the queue do its job: X's pass suspends, releases, B is promoted.
    gates["x"].set()
    await asyncio.sleep(0.05)
    gates["b"].set()
    affected = await asyncio.wait_for(sweep1, timeout=5)
    assert affected == [run_y.run_id]  # only the stalled running run was reaped

    reaped_y = await service.get(run_y.run_id, TENANT)
    assert reaped_y.status == "cancelled"
    assert reaped_y.cancel_reason == "timeout"
    served_b = await service.get(run_b.run_id, TENANT)
    assert served_b.status == "awaiting_human"  # served from the queue, not killed
    assert served_b.cancel_reason is None
    assert served_b.queue_position is None

    gates["y"].set()  # Y's in-flight outcome lands on a terminal record: discarded
    finished = await asyncio.wait_for(task_y, timeout=5)
    assert finished.status == "cancelled"
    await zero(ceilings)


# -------- 6. (fix round 1) the exemption is queue-only: a stalled running
# --------------------------------------- run is still reaped, all kinds back


async def test_stalled_running_run_is_still_reaped_with_every_kind_released() -> None:
    # Pin the other half of the ruling: leaving queued runs alone must not
    # soften the running-path reap. One pass in flight holding run+apply+
    # model goes silent past the budget -> cancelled with reason "timeout",
    # every kind released in strict reverse order, board back to zero.
    now = [T0]
    gate = asyncio.Event()

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        if step_id == "h":
            await gate.wait()
        return {"marker": "solo", "stepId": step_id}

    client = ScriptedMastraRunClient({"heavyFlow": ("h", "tail")}, builder=builder)
    ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 4})
    service = make_service(
        client,
        ceilings,
        config=RunServiceConfig(max_run_seconds=IDLE_BUDGET),
        clock=lambda: now[0],
    )

    task = asyncio.create_task(start_run(service, "heavy", "solo"))
    await asyncio.sleep(0.05)
    run = next(run for run in await service.list_active(TENANT) if run.ticket_key == "T-solo")
    assert run.status == "running"
    for kind in (RUN_SLOT, APPLY_SLOT, MODEL_SLOT):
        assert await ceilings.active_count(kind) == 1, kind

    now[0] = T0 + timedelta(seconds=IDLE_BUDGET + 40)
    affected = await service.sweep_expired()
    assert affected == [run.run_id]

    reaped = await service.get(run.run_id, TENANT)
    assert reaped.status == "cancelled"
    assert reaped.cancel_reason == "timeout"
    assert [kind for rid, kind in ceilings.released_by if rid == run.run_id] == [
        MODEL_SLOT,
        APPLY_SLOT,
        RUN_SLOT,
    ]
    await zero(ceilings)

    gate.set()  # the in-flight outcome lands on the terminal record: discarded
    finished = await asyncio.wait_for(task, timeout=5)
    assert finished.status == "cancelled"
    await zero(ceilings)


# ------------------ 7. (fix round 1) heartbeat parsing fails closed, never
# --------------------------------------------- to read-time "now" (immortal)


def _running_record(run_id: str) -> WorkflowRun:
    return WorkflowRun(
        run_id=run_id,
        tenant_id=TENANT,
        workflow="heavy",
        ticket_key=f"T-{run_id}",
        case_id="case-1",
        input={"marker": run_id},
        steps=[
            RunStep(step_id="h", index=0, title="Heavy"),
            RunStep(step_id="tail", index=1, title="Tail"),
        ],
        status="running",
        started_at=T0,
        heartbeat_at=T0,
        pending_pass={"start": True, "slots": [RUN_SLOT, APPLY_SLOT, MODEL_SLOT]},
    )


async def _sweep_corrupted(corrupted: dict[str, object], moment: datetime) -> list[str]:
    """Revive ``corrupted``, hand its slots to fresh ceilings, sweep at ``moment``."""
    revived = WorkflowRun.from_dict(corrupted)
    registry = InMemoryRunRegistry()
    await registry.save(revived)
    ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 4})
    for kind in (RUN_SLOT, APPLY_SLOT, MODEL_SLOT):
        assert await ceilings.acquire(revived.run_id, kind) is None
    service = make_service(
        ScriptedMastraRunClient({"heavyFlow": ("h", "tail")}),
        ceilings,
        config=RunServiceConfig(max_run_seconds=IDLE_BUDGET),
        clock=lambda: moment,
        registry=registry,
    )
    affected = await service.sweep_expired(now=moment)
    if affected:
        reaped = await service.get(revived.run_id, TENANT)
        assert reaped.cancel_reason == "timeout"
        await zero(ceilings)  # reaped on schedule: its slots came back
    return affected


async def test_garbage_heartbeat_falls_back_to_started_at_not_to_now() -> None:
    # A corrupt ``heartbeatAt`` — a bad string or the empty string, which is
    # not ``None`` — must fail closed to ``started_at``, never to
    # ``_parse_datetime``'s read-time ``now``: refreshed on every read, such
    # a record would sit past its budget forever and keep its slots until
    # the registry TTL.
    for garbage in ("not-a-date", ""):
        raw = _running_record(f"garbage-{garbage!r}").to_dict()
        raw["heartbeatAt"] = garbage
        revived = WorkflowRun.from_dict(raw)
        assert revived.heartbeat_at == revived.started_at == T0, garbage
        assert revived.to_dict()["heartbeatAt"] == T0.isoformat(), garbage

        # Reaped exactly on the started_at schedule, not before, not never.
        inside = T0 + timedelta(seconds=IDLE_BUDGET - 1)
        assert await _sweep_corrupted(raw, inside) == [], garbage
        overdue = T0 + timedelta(seconds=IDLE_BUDGET + 1)
        assert await _sweep_corrupted(raw, overdue) == [revived.run_id], garbage


async def test_corrupt_started_at_clamps_the_heartbeat_up_to_it() -> None:
    # A valid (old) heartbeat next to an unparseable ``startedAt`` used to
    # revive with ``heartbeat_at < started_at`` (start fell back to
    # read-time ``now``). The heartbeat clamps up to the fallback start:
    # the record stays consistent and still dies on that schedule rather
    # than lingering immune on a clock that precedes its own birth.
    wall_clock = datetime.now(UTC)  # startedAt fallback reads the real clock
    raw = _running_record("corrupt-start").to_dict()
    raw["startedAt"] = "definitely-not-a-timestamp"
    raw["heartbeatAt"] = (wall_clock - timedelta(seconds=600)).isoformat()  # valid, old

    revived = WorkflowRun.from_dict(raw)
    assert revived.heartbeat_at == revived.started_at  # clamped, not older
    assert revived.heartbeat_at >= wall_clock

    # The clamped clock is the deadline's reference: silent 99s on it means
    # inside budget (before the clamp the months-old heartbeat read as
    # stalled and reaped early); 101s means reaped on schedule, slots back.
    inside = revived.started_at + timedelta(seconds=IDLE_BUDGET - 1)
    assert await _sweep_corrupted(raw, inside) == []
    overdue = revived.started_at + timedelta(seconds=IDLE_BUDGET + 1)
    assert await _sweep_corrupted(raw, overdue) == [revived.run_id]


def test_a_mixed_naive_and_aware_clock_clamps_instead_of_raising() -> None:
    # (fix wave item 7, corrected by wave 3 item 2) An ISO string with an
    # offset and one without can meet in the same corrupt record. The clamp
    # used to be made aware-safe only for its own comparison, which left the
    # naive value stored on the record and crashing the sweep's
    # ``moment - heartbeat_at`` later. Both clocks are now normalized through
    # ``_as_aware`` at read time, so a record written without an offset loads
    # aware-on-aware: the clamp still moves a heartbeat that precedes its
    # start up to the start, and no run record ever carries a naive datetime
    # into the code that reads it.
    naive_heartbeat = T0.replace(tzinfo=None).isoformat()  # no offset at all
    aware_heartbeat = T0.isoformat()

    # A naive heartbeat behind an aware start: clamped up to the start.
    start_later = T0 + timedelta(seconds=30)
    raw = _running_record("mixed-naive-heartbeat").to_dict()
    raw["startedAt"] = start_later.isoformat()
    raw["heartbeatAt"] = naive_heartbeat
    revived = WorkflowRun.from_dict(raw)
    assert revived.heartbeat_at == revived.started_at == start_later
    assert revived.started_at.tzinfo is not None
    assert revived.heartbeat_at.tzinfo is not None

    # The reverse pairing: an aware heartbeat behind a naive start.
    naive_start = (T0 + timedelta(seconds=30)).replace(tzinfo=None)
    raw = _running_record("mixed-naive-start").to_dict()
    raw["startedAt"] = naive_start.isoformat()
    raw["heartbeatAt"] = aware_heartbeat
    revived = WorkflowRun.from_dict(raw)
    assert revived.started_at == naive_start.replace(tzinfo=UTC)  # normalized at read
    assert revived.heartbeat_at == revived.started_at  # clamped, and never raises
    assert revived.to_dict()["heartbeatAt"] == naive_start.replace(tzinfo=UTC).isoformat()

    # A mixed pair that needs no clamp keeps its instants, read as UTC.
    raw = _running_record("mixed-consistent").to_dict()
    raw["startedAt"] = T0.replace(tzinfo=None).isoformat()
    raw["heartbeatAt"] = (T0 + timedelta(seconds=30)).isoformat()
    revived = WorkflowRun.from_dict(raw)
    assert revived.started_at == T0  # same instant, now an aware clock
    assert revived.started_at.tzinfo is not None
    assert revived.heartbeat_at == T0 + timedelta(seconds=30)


async def test_a_naive_clock_is_normalized_at_read_and_still_swept() -> None:
    # (fix wave 3, item 2) Normalizing only the clamp left the naive value on
    # the record, so ``sweep_expired``'s ``moment - active.heartbeat_at`` still
    # raised ``TypeError``: with the sweeper on by default, one row written
    # without an offset aborted the reaping of every other run in the same
    # pass. A naive heartbeat behind an aware start, and a naive start behind
    # an aware heartbeat, must each (a) load without raising, (b) be cancelled
    # when past the budget, and (c) leave the sweep running so the healthy run
    # in the same registry is still examined.
    moment = T0 + timedelta(seconds=400)

    for pairing in ("naive-heartbeat", "naive-start"):
        odd = _running_record(f"naive-{pairing}")
        raw = odd.to_dict()
        # The odd record sorts first (newest start), so under the old
        # read-time behavior the sweep died on it before reaching healthy.
        if pairing == "naive-heartbeat":
            raw["startedAt"] = (T0 + timedelta(seconds=200)).isoformat()  # aware
            raw["heartbeatAt"] = (T0 + timedelta(seconds=210)).replace(tzinfo=None).isoformat()
        else:
            raw["startedAt"] = (T0 + timedelta(seconds=200)).replace(tzinfo=None).isoformat()
            raw["heartbeatAt"] = (T0 + timedelta(seconds=210)).isoformat()  # aware

        revived = WorkflowRun.from_dict(raw)  # (a) loads
        assert revived.started_at.tzinfo is not None, pairing
        assert revived.heartbeat_at.tzinfo is not None, pairing
        assert revived.heartbeat_at == revived.started_at + timedelta(seconds=10), pairing

        healthy = _running_record(f"healthy-{pairing}")
        healthy.started_at = T0
        healthy.heartbeat_at = moment - timedelta(seconds=10)  # progressing

        registry = InMemoryRunRegistry()
        await registry.save(revived)
        await registry.save(healthy)
        ceilings = RecordingCeiling({RUN_SLOT: 5, APPLY_SLOT: 2, MODEL_SLOT: 4})
        for kind in (RUN_SLOT, APPLY_SLOT, MODEL_SLOT):
            assert await ceilings.acquire(revived.run_id, kind) is None
        service = make_service(
            ScriptedMastraRunClient({"heavyFlow": ("h", "tail")}),
            ceilings,
            config=RunServiceConfig(max_run_seconds=IDLE_BUDGET),
            clock=lambda: moment,
            registry=registry,
        )

        # (b) reaped on schedule, (c) and the sweep keeps going: the healthy
        # run, quiet for only 10s, is examined in the same pass and left alone.
        assert await service.sweep_expired(now=moment) == [revived.run_id], pairing
        reaped = await service.get(revived.run_id, TENANT)
        assert reaped.status == "cancelled", pairing
        assert reaped.cancel_reason == "timeout", pairing
        alive = await service.get(healthy.run_id, TENANT)
        assert alive.status == "running", pairing
        await zero(ceilings)  # the odd run's three kinds came back
