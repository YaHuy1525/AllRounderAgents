"""The run service: owns every run's lifecycle and the Mastra bridge.

Driving model — restart/resume with a decision envelope:

* Every Mastra pass receives ``{runId, input, decisions, artifacts, effects}``.
  A step with a proceed/edit decision fast-forwards using the reviewed
  artifact (never recomputing LLM output); a regenerate marker recomputes and
  suspends for fresh review; a step without a decision computes its artifact
  and suspends — the run parks in ``awaiting_human``.
* The service resumes the suspended Mastra run for forward decisions and
  restarts it for Back (downstream state is invalidated and re-derived).
* Proceed/Edit decisions are backed by single-use HMAC receipts bound to
  ``(approvalId, runId, caseId, action, scope)`` and recorded under
  ``(runId, stepId, actionHash)`` so a replay returns the original record and
  never duplicates a side effect.
* Ceiling slots are held only while a pass is in flight; queued runs are
  promoted FIFO and always know their visible position.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol
from uuid import uuid4

from ..approvals import ApprovalReceiptSigner, ReceiptError
from ..auth import Principal
from ..logging import get_logger
from ..repositories import ApprovalRecord, ApprovalRepository, CaseRepository
from .ceilings import RUN_SLOT, ConcurrencyCeiling
from .events import RunEventBus
from .locks import TargetLockStore
from .mastra_client import MastraClientError, MastraRunClient, action_hash
from .models import (
    DECISION_ACTIONS,
    MastraOutcome,
    RunStep,
    WorkflowDefinition,
    WorkflowRun,
)
from .receipts import RunReceiptStore
from .registry import RunRegistry


class RunConflictError(Exception):
    """The requested transition is invalid for the run's current state."""


class UnknownWorkflowError(ValueError):
    def __init__(self, workflow: str) -> None:
        super().__init__(f"Unknown workflow {workflow!r}")
        self.workflow = workflow


class RunMetrics(Protocol):
    """Bounded run instrumentation: workflow + status/action only.

    Prometheus label sets stay bounded — the ``runId`` tagging lives in the
    event stream, case records and logs, never in a metric label.
    """

    def record_run(self, *, workflow: str, status: str) -> None: ...

    def record_run_decision(self, *, workflow: str, action: str) -> None: ...


@dataclass(frozen=True)
class RunServiceConfig:
    lock_ttl_seconds: int = 900
    receipt_ttl_seconds: int = 3_600
    max_run_seconds: int = 1_800
    max_regenerations_per_step: int = 1


@dataclass(frozen=True)
class DecisionResult:
    run: WorkflowRun
    receipt: str | None = None
    replayed: bool = False


class RunService:
    def __init__(
        self,
        *,
        workflows: dict[str, WorkflowDefinition],
        registry: RunRegistry,
        ceilings: ConcurrencyCeiling,
        locks: TargetLockStore,
        receipts: RunReceiptStore,
        events: RunEventBus,
        mastra: MastraRunClient,
        signer: ApprovalReceiptSigner,
        approvals: ApprovalRepository,
        cases: CaseRepository | None = None,
        config: RunServiceConfig | None = None,
        clock: Callable[[], datetime] | None = None,
        metrics: RunMetrics | None = None,
    ) -> None:
        self._workflows = workflows
        self._registry = registry
        self._ceilings = ceilings
        self._locks = locks
        self._receipts = receipts
        self._events = events
        self._mastra = mastra
        self._signer = signer
        self._approvals = approvals
        self._cases = cases
        self._config = config or RunServiceConfig()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._metrics = metrics
        self._logger = get_logger()
        self._run_locks: dict[str, asyncio.Lock] = {}

    # ---------------------------------------------------------------- start

    async def start(
        self,
        *,
        workflow: str,
        ticket_key: str,
        case_id: str,
        run_input: dict[str, object],
        principal: Principal,
    ) -> WorkflowRun:
        definition = self._workflows.get(workflow)
        if definition is None:
            raise UnknownWorkflowError(workflow)
        run = WorkflowRun(
            run_id=str(uuid4()),
            tenant_id=principal.tenant_id,
            workflow=workflow,
            ticket_key=ticket_key,
            case_id=case_id,
            input=run_input,
            steps=[
                RunStep(step_id=step.id, index=index, title=step.title)
                for index, step in enumerate(definition.steps)
            ],
            started_at=self._clock(),
            heartbeat_at=self._clock(),
        )
        await self._registry.save(run)
        await self._publish(run, {"type": "run.created", "workflow": workflow})
        await self._case_event(run, "run_started", {"workflow": workflow})
        async with self._run_lock(run.run_id):
            launched = await self._try_launch(run)
        if launched:
            await self._drive(run, start=True)
        return await self._reload(run.run_id)

    # -------------------------------------------------------------- decide

    async def decide(
        self,
        *,
        run_id: str,
        step_id: str,
        action: str,
        principal: Principal,
        edits: dict[str, object] | None = None,
        guidance: str | None = None,
        comment: str | None = None,
    ) -> DecisionResult:
        if action not in DECISION_ACTIONS:
            raise RunConflictError(f"Unknown decision action {action!r}")
        if action == "abort":
            run = await self.cancel(
                run_id=run_id, tenant_id=principal.tenant_id,
                reason=comment or f"aborted by {principal.subject}",
            )
            self._record_decision(run, action)
            return DecisionResult(run=run)
        async with self._run_lock(run_id):
            run = await self._registry.get(run_id, principal.tenant_id)
            if run.terminal:
                raise RunConflictError("Run already finished")
            if action == "retry_lock":
                decided = await self._retry_lock(run)
                self._record_decision(run, action)
                return DecisionResult(run=decided)
            if run.status != "awaiting_human":
                raise RunConflictError("Run is not awaiting a human decision")
            step = run.step(step_id)
            if step.state != "awaiting_human":
                raise RunConflictError("Step is not awaiting a human decision")
            definition = self._definition(run)
            receipt: str | None = None
            replayed = False
            if action in ("proceed", "edit"):
                result = await self._approve_step(
                    run, step, action, edits, principal=principal, comment=comment
                )
                receipt = result[0]
                replayed = result[1]
                if replayed:
                    return DecisionResult(
                        run=await self._reload(run_id), receipt=receipt, replayed=True
                    )
                self._record_decision(run, action)
            elif action == "regenerate":
                if step.regenerations >= self._config.max_regenerations_per_step:
                    raise RunConflictError(
                        "Regeneration limit reached; escalate to a human choice"
                    )
                step.regenerations += 1
                step.decision = {
                    "action": "regenerate",
                    "guidance": guidance,
                    "regenerations": step.regenerations,
                }
                step.updated_at = self._clock()
                self._record_decision(run, action)
            else:  # back
                index = definition.index_of(step_id)
                if index == 0:
                    raise RunConflictError("Already at the first step")
                self._invalidate_from(run, index - 1)
                self._record_decision(run, action)
            run.heartbeat_at = self._clock()
            await self._save(run)
            await self._publish(
                run,
                {
                    "type": "run.decision",
                    "stepId": step_id,
                    "action": action,
                    "receipt": receipt,
                },
            )
            if action == "back":
                run.attempt += 1
            launched = await self._try_launch(run)
        if launched:
            if action == "back":
                await self._drive(run, start=True)
            else:
                await self._drive(
                    run,
                    start=False,
                    step_id=step_id,
                    decision=run.step(step_id).decision or {},
                )
        return DecisionResult(
            run=await self._reload(run_id), receipt=receipt, replayed=replayed
        )

    async def _approve_step(
        self,
        run: WorkflowRun,
        step: RunStep,
        action: str,
        edits: dict[str, object] | None,
        *,
        principal: Principal,
        comment: str | None,
    ) -> tuple[str, bool]:
        artifact_hash = _content_hash(step.artifact or {})
        action_dict: dict[str, object] = {
            "workflow": run.workflow,
            "runId": run.run_id,
            "stepId": step.step_id,
            "action": action,
            "artifactHash": artifact_hash,
        }
        if edits is not None:
            action_dict["editsHash"] = _content_hash(edits)
        digest = action_hash(action_dict)
        replay = await self._receipts.replay(run.run_id, step.step_id, digest)
        if replay is not None:
            recorded = replay.get("receipt")
            step.decision = _decision_from_record(replay)
            step.receipt = str(recorded) if isinstance(recorded, str) else None
            return step.receipt or "", True
        now = self._clock()
        approval_id = str(uuid4())
        scope = f"run:{run.workflow}"
        expiry = now + timedelta(seconds=self._config.receipt_ttl_seconds)
        await self._approvals.create(
            ApprovalRecord(
                id=approval_id,
                case_id=run.case_id,
                tenant_id=run.tenant_id,
                action=action_dict,
                evidence=[
                    {
                        "runId": run.run_id,
                        "workflow": run.workflow,
                        "stepId": step.step_id,
                        "artifactHash": artifact_hash,
                    }
                ],
                approver=principal.subject,
                scope=scope,
                expires_at=expiry,
            )
        )
        await self._approvals.decide(approval_id, run.tenant_id, "approved", comment)
        try:
            receipt = self._signer.issue(
                approval_id=approval_id,
                case_id=run.case_id,
                action=action_dict,
                approver=principal.subject,
                scope=scope,
                decision="approved",
                expires_at=expiry,
                run_id=run.run_id,
            )
            claims = self._signer.validate(
                receipt,
                approval_id=approval_id,
                case_id=run.case_id,
                action=action_dict,
                scope=scope,
                run_id=run.run_id,
                now=now,
            )
        except ReceiptError as error:  # pragma: no cover - signing our own token
            raise RunConflictError("Receipt could not be issued") from error
        step.decision = {
            "action": action,
            "edits": edits,
            "actionHash": digest,
            "approvalId": approval_id,
            "receiptId": claims.receipt_id,
            "approver": principal.subject,
            "decidedAt": now.isoformat(),
        }
        step.receipt = receipt
        step.action_hash = digest
        step.updated_at = now
        record: dict[str, object] = {
            "runId": run.run_id,
            "stepId": step.step_id,
            "action": action,
            "actionHash": digest,
            "approvalId": approval_id,
            "receiptId": claims.receipt_id,
            "approver": principal.subject,
            "receipt": receipt,
            "decidedAt": now.isoformat(),
            "edits": edits,
        }
        await self._receipts.remember(run.run_id, step.step_id, digest, record)
        return receipt, False

    def _invalidate_from(self, run: WorkflowRun, index: int) -> None:
        """Drop decisions/artifacts from ``index`` on; recorded side effects
        stay so an identical re-derived action replays instead of doubling."""
        for step in run.steps:
            if step.index < index:
                continue
            step.state = "pending"
            step.decision = None
            step.artifact = None
            step.receipt = None
            step.action_hash = None
            step.updated_at = self._clock()

    # --------------------------------------------------------------- cancel

    async def cancel(
        self, *, run_id: str, tenant_id: str, reason: str
    ) -> WorkflowRun:
        async with self._run_lock(run_id):
            run = await self._registry.get(run_id, tenant_id)
            if run.terminal:
                return run
            run.status = "cancelled"
            run.cancel_reason = reason
            run.finished_at = self._clock()
            run.heartbeat_at = run.finished_at
            await self._save(run)
            await self._publish(
                run, {"type": "run.status", "status": "cancelled", "reason": reason}
            )
            await self._case_event(run, "run_cancelled", {"reason": reason})
            self._record_terminal(run)
        await self._release_resources(run)
        return await self._reload(run_id)

    # ------------------------------------------------------------ internals

    def _definition(self, run: WorkflowRun) -> WorkflowDefinition:
        definition = self._workflows.get(run.workflow)
        if definition is None:  # pragma: no cover - registry consistency
            raise UnknownWorkflowError(run.workflow)
        return definition

    def _run_lock(self, run_id: str) -> asyncio.Lock:
        return self._run_locks.setdefault(run_id, asyncio.Lock())

    def _envelope(self, run: WorkflowRun) -> dict[str, object]:
        return {
            "runId": run.run_id,
            "workflow": run.workflow,
            "ticketKey": run.ticket_key,
            "caseId": run.case_id,
            # Flow contracts count attempts from 1 (z.number().int().positive())
            # while the registry stores this run's 0-based attempt.
            "attempt": run.attempt + 1,
            # Input schemas are passthrough and the features/issues contracts
            # require the ticket key inside `input`, so it is always mirrored
            # there (the run's ticket wins over any client-provided copy).
            "input": {**run.input, "ticketKey": run.ticket_key},
            "decisions": run.decisions(),
            "artifacts": run.artifacts(),
            "effects": run.side_effects,
        }

    async def _try_launch(self, run: WorkflowRun) -> bool:
        """Grab a ceiling slot; returns True when the run may drive now."""
        position = await self._ceilings.acquire(run.run_id, RUN_SLOT)
        if position is not None:
            run.status = "queued"
            run.queue_position = position
            await self._save(run)
            await self._publish(
                run, {"type": "run.queued", "queuePosition": position}
            )
            return False
        run.status = "running"
        run.queue_position = None
        await self._save(run)
        return True

    async def _drive(
        self,
        run: WorkflowRun,
        *,
        start: bool,
        step_id: str | None = None,
        decision: dict[str, object] | None = None,
    ) -> None:
        definition = self._definition(run)
        envelope = self._envelope(run)
        try:
            if start:
                outcome = await self._mastra.start(
                    workflow=definition.mastra_workflow,
                    run_id=f"{run.run_id}:a{run.attempt}",
                    input_data=envelope,
                )
            else:
                outcome = await self._mastra.resume(
                    workflow=definition.mastra_workflow,
                    run_id=f"{run.run_id}:a{run.attempt}",
                    step_id=step_id or "",
                    resume_data={**envelope, "decision": decision or {}},
                )
        except MastraClientError as error:
            await self._fail_run(run, str(error))
            return
        except asyncio.CancelledError:
            raise
        except Exception as error:  # pragma: no cover - defensive boundary
            self._logger.exception("run_drive_failed", run_id=run.run_id)
            await self._fail_run(run, f"Unexpected engine error: {type(error).__name__}")
            return
        await self._apply_outcome(run, outcome)

    async def _apply_outcome(self, run: WorkflowRun, outcome: MastraOutcome) -> None:
        latest = await self._registry.get_internal(run.run_id)
        if latest.terminal:
            # A cancel/timeout landed while the pass was in flight: discard the
            # outcome and just give the slot back.
            await self._release_and_promote(latest)
            return
        run = latest
        for step_id, effect in outcome.effects.items():
            run.side_effects[step_id] = effect
        if outcome.status == "suspended" and outcome.step_id is not None:
            try:
                suspended = run.step(outcome.step_id)
            except KeyError:
                await self._fail_run(run, f"Engine suspended at unknown step {outcome.step_id!r}")
                return
            for step in run.steps:
                if step.index < suspended.index and step.state != "done":
                    step.state = "done"
                    step.updated_at = self._clock()
            suspended.state = "awaiting_human"
            if outcome.artifact is not None:
                suspended.artifact = outcome.artifact
            suspended.updated_at = self._clock()
            run.status = "awaiting_human"
            run.queue_position = None
            run.heartbeat_at = self._clock()
            locked = await self._acquire_target(run, outcome.target)
            await self._save(run)
            await self._publish(
                run,
                {
                    "type": "run.suspended",
                    "stepId": suspended.step_id,
                    "stepState": "blocked" if not locked else "awaiting_human",
                    "artifact": suspended.artifact,
                    "target": run.lock_target,
                    "lockedBy": run.lock_owner if not locked else None,
                },
            )
            await self._release_and_promote(run)
            return
        if outcome.status == "completed":
            for step in run.steps:
                if step.state != "done":
                    step.state = "done"
                    step.updated_at = self._clock()
            run.status = "completed"
            run.outcome = "completed"
            run.finished_at = self._clock()
            run.heartbeat_at = run.finished_at
            await self._save(run)
            await self._publish(run, {"type": "run.status", "status": "completed"})
            await self._case_event(run, "run_completed", {})
            self._record_terminal(run)
            await self._release_resources(run)
            return
        await self._fail_run(run, outcome.error or "Workflow failed")

    async def _fail_run(self, run: WorkflowRun, error: str) -> None:
        already_terminal = run.terminal
        current = run.current_step()
        if current is not None:
            current.state = "failed"
            current.updated_at = self._clock()
        run.status = "failed"
        run.outcome = error
        run.finished_at = self._clock()
        run.heartbeat_at = run.finished_at
        await self._save(run)
        await self._publish(run, {"type": "run.status", "status": "failed", "error": error})
        await self._case_event(run, "run_failed", {"error": error})
        if not already_terminal:
            self._record_terminal(run)
        await self._release_resources(run)

    async def _acquire_target(self, run: WorkflowRun, target: str | None) -> bool:
        """Claim the step's target lock; a conflict parks the run as blocked."""
        if target is None:
            return True
        info = await self._locks.acquire(target, run.run_id, self._config.lock_ttl_seconds)
        run.lock_target = target
        if info is not None:
            run.lock_owner = run.run_id
            return True
        owner = await self._locks.inspect(target)
        run.lock_owner = owner.owner_run_id if owner is not None else None
        run.status = "blocked"
        current = run.current_step()
        if current is not None:
            current.state = "blocked"
        await self._publish(
            run,
            {
                "type": "run.locked",
                "target": target,
                "lockedBy": run.lock_owner,
            },
        )
        return False

    async def _retry_lock(self, run: WorkflowRun) -> WorkflowRun:
        if run.status != "blocked" or run.lock_target is None:
            raise RunConflictError("Run is not blocked on a target lock")
        info = await self._locks.acquire(
            run.lock_target, run.run_id, self._config.lock_ttl_seconds
        )
        if info is None:
            owner = await self._locks.inspect(run.lock_target)
            run.lock_owner = owner.owner_run_id if owner is not None else None
            await self._save(run)
            return await self._reload(run.run_id)
        run.lock_owner = run.run_id
        run.status = "awaiting_human"
        current = run.current_step()
        if current is not None and current.state == "blocked":
            current.state = "awaiting_human"
            current.updated_at = self._clock()
        run.heartbeat_at = self._clock()
        await self._save(run)
        await self._publish(
            run, {"type": "run.unlocked", "target": run.lock_target}
        )
        return await self._reload(run.run_id)

    async def _release_resources(self, run: WorkflowRun) -> None:
        if run.lock_target is not None and run.lock_owner == run.run_id:
            await self._locks.release(run.lock_target, run.run_id)
            run.lock_owner = None
            await self._save(run)
        await self._release_and_promote(run)

    async def _release_and_promote(self, run: WorkflowRun) -> None:
        promoted = await self._ceilings.release(run.run_id, RUN_SLOT)
        if promoted is not None:
            next_run: WorkflowRun | None
            try:
                next_run = await self._registry.get_internal(promoted)
            except KeyError:
                next_run = None
            if next_run is not None and not next_run.terminal:
                next_run.status = "running"
                next_run.queue_position = None
                await self._save(next_run)
                await self._drive(next_run, start=True)
        await self._refresh_queue_positions()

    async def _refresh_queue_positions(self) -> None:
        for active in await self._registry.list_active():
            if active.status != "queued":
                continue
            position = await self._ceilings.position(active.run_id, RUN_SLOT)
            if position != active.queue_position:
                active.queue_position = position
                await self._save(active)
                await self._publish(
                    active, {"type": "run.queued", "queuePosition": position}
                )

    async def sweep_expired(self, now: datetime | None = None) -> list[str]:
        """Timeout over-budget passes and unblock runs whose lock has expired.

        Only runs actively consuming compute (queued/running) are timed out;
        runs parked on a human or a lock keep their receipts and are never
        auto-approved.
        """
        moment = now or self._clock()
        affected: list[str] = []
        for active in await self._registry.list_active():
            if active.status in ("queued", "running"):
                age = (moment - active.started_at).total_seconds()
                if age > self._config.max_run_seconds:
                    await self.cancel(
                        run_id=active.run_id,
                        tenant_id=active.tenant_id,
                        reason="timeout",
                    )
                    affected.append(active.run_id)
            elif active.status == "blocked" and active.lock_target is not None:
                info = await self._locks.inspect(active.lock_target)
                if info is None:
                    async with self._run_lock(active.run_id):
                        awaited = await self._registry.get_internal(active.run_id)
                        if awaited.status == "blocked":
                            await self._retry_lock(awaited)
                            affected.append(active.run_id)
        return affected

    # --------------------------------------------------------------- reads

    async def get(self, run_id: str, tenant_id: str) -> WorkflowRun:
        return await self._registry.get(run_id, tenant_id)

    async def list_for_ticket(
        self, ticket_key: str, tenant_id: str, limit: int = 50
    ) -> list[WorkflowRun]:
        return await self._registry.list_for_ticket(ticket_key, tenant_id, limit)

    async def list_active(self, tenant_id: str) -> list[WorkflowRun]:
        active = await self._registry.list_active()
        return [run for run in active if run.tenant_id == tenant_id]

    def subscribe(self, run_id: str) -> AsyncIterator[dict[str, object]]:
        return self._events.subscribe(run_id)

    async def history(self, run_id: str) -> list[dict[str, object]]:
        """Buffered events for a run; final once the run is terminal."""
        return await self._events.history(run_id)

    # -------------------------------------------------------------- helpers

    async def _reload(self, run_id: str) -> WorkflowRun:
        return await self._registry.get_internal(run_id)

    def _record_decision(self, run: WorkflowRun, action: str) -> None:
        if self._metrics is not None:
            self._metrics.record_run_decision(workflow=run.workflow, action=action)

    def _record_terminal(self, run: WorkflowRun) -> None:
        if self._metrics is not None:
            self._metrics.record_run(workflow=run.workflow, status=run.status)

    async def _save(self, run: WorkflowRun) -> None:
        await self._registry.save(run)

    async def _publish(self, run: WorkflowRun, event: dict[str, object]) -> None:
        await self._events.publish(run.run_id, {**event, "runId": run.run_id})

    async def _case_event(
        self, run: WorkflowRun, kind: str, payload: dict[str, object]
    ) -> None:
        if self._cases is None:
            return
        # Runs are platform machinery, so their case events use the "system"
        # actor from the agent | human | system vocabulary the schema enforces.
        try:
            await self._cases.append_event(
                run.case_id,
                actor="system",
                kind=kind,
                payload={"runId": run.run_id, "workflow": run.workflow, **payload},
            )
        except KeyError:
            self._logger.info("run_case_missing", run_id=run.run_id, case_id=run.case_id)
        except ValueError:
            # Provenance is best-effort: a rejected event must not block the run.
            self._logger.warning("run_case_event_rejected", run_id=run.run_id, kind=kind)


def _content_hash(value: dict[str, object]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _decision_from_record(record: dict[str, object]) -> dict[str, object]:
    edits = record.get("edits")
    return {
        "action": record.get("action"),
        "edits": edits if isinstance(edits, dict) else None,
        "actionHash": record.get("actionHash"),
        "approvalId": record.get("approvalId"),
        "receiptId": record.get("receiptId"),
        "approver": record.get("approver"),
        "decidedAt": record.get("decidedAt"),
    }


__all__ = [
    "DecisionResult",
    "RunConflictError",
    "RunMetrics",
    "RunService",
    "RunServiceConfig",
    "UnknownWorkflowError",
]
