"""Data model for the parallel-safe run infrastructure.

Everything a run owns — steps, artifacts, decisions, receipts, locks — is
namespaced by ``runId``. Records are plain dataclasses with explicit
``to_dict`` / ``from_dict`` round-trips so the same shape serves the API,
Redis, and Postgres persistence layers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

# Run lifecycle. ``queued`` is a first-class state: over-ceiling runs wait in
# the open with a visible position instead of being silently dropped.
RUN_STATUSES = (
    "queued",
    "running",
    "awaiting_human",
    "blocked",
    "completed",
    "failed",
    "cancelled",
)
TERMINAL_RUN_STATUSES = ("completed", "failed", "cancelled")

# Per-step lifecycle. ``awaiting_human`` means the run is suspended at this
# step until an explicit, receipt-backed decision arrives.
STEP_STATES = ("pending", "running", "awaiting_human", "blocked", "done", "failed")

DECISION_ACTIONS = ("proceed", "edit", "regenerate", "back", "abort", "retry_lock")

# Step ids the Mastra workflows must use for the decision action bar.
ACTION_BAR_ACTIONS = ("proceed", "edit", "regenerate", "back", "abort")


@dataclass(frozen=True)
class StepDefinition:
    """Static description of one workflow step (declared before the run)."""

    id: str
    title: str
    side_effecting: bool = False


@dataclass(frozen=True)
class WorkflowDefinition:
    """A runnable workflow: its Mastra counterpart and its ordered steps."""

    id: str
    mastra_workflow: str
    title: str
    steps: tuple[StepDefinition, ...]

    def step(self, step_id: str) -> StepDefinition:
        for step in self.steps:
            if step.id == step_id:
                return step
        raise KeyError(f"Unknown step {step_id!r} for workflow {self.id!r}")

    def index_of(self, step_id: str) -> int:
        for index, step in enumerate(self.steps):
            if step.id == step_id:
                return index
        raise KeyError(f"Unknown step {step_id!r} for workflow {self.id!r}")


@dataclass
class RunStep:
    """Live state of one step within a run."""

    step_id: str
    index: int
    title: str
    state: str = "pending"
    artifact: dict[str, object] | None = None
    decision: dict[str, object] | None = None
    receipt: str | None = None
    action_hash: str | None = None
    regenerations: int = 0
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, object]:
        return {
            "stepId": self.step_id,
            "index": self.index,
            "title": self.title,
            "state": self.state,
            "artifact": self.artifact,
            "decision": self.decision,
            "receipt": self.receipt,
            "actionHash": self.action_hash,
            "regenerations": self.regenerations,
            "updatedAt": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> RunStep:
        artifact = raw.get("artifact")
        decision = raw.get("decision")
        return cls(
            step_id=str(raw["stepId"]),
            index=int(raw["index"]),
            title=str(raw["title"]),
            state=str(raw.get("state", "pending")),
            artifact=artifact if isinstance(artifact, dict) else None,
            decision=decision if isinstance(decision, dict) else None,
            receipt=str(raw["receipt"]) if raw.get("receipt") is not None else None,
            action_hash=str(raw["actionHash"]) if raw.get("actionHash") is not None else None,
            regenerations=int(raw.get("regenerations", 0)),
            updated_at=_parse_datetime(raw.get("updatedAt")),
        )


@dataclass
class WorkflowRun:
    """A single workflow execution, isolated by ``run_id``."""

    run_id: str
    tenant_id: str
    workflow: str
    ticket_key: str
    case_id: str
    input: dict[str, object]
    steps: list[RunStep]
    status: str = "queued"
    attempt: int = 0
    queue_position: int | None = None
    lock_target: str | None = None
    lock_owner: str | None = None
    outcome: str | None = None
    cancel_reason: str | None = None
    side_effects: dict[str, dict[str, object]] = field(default_factory=dict)
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    heartbeat_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL_RUN_STATUSES

    def current_step(self) -> RunStep | None:
        for step in reversed(self.steps):
            if step.state in ("awaiting_human", "blocked", "running"):
                return step
        return None

    def step(self, step_id: str) -> RunStep:
        for step in self.steps:
            if step.step_id == step_id:
                return step
        raise KeyError(f"Unknown step {step_id!r} for run {self.run_id!r}")

    def decisions(self) -> dict[str, dict[str, object]]:
        """Engine-facing decision map carried into every Mastra pass."""
        return {
            step.step_id: step.decision
            for step in self.steps
            if step.decision is not None
        }

    def artifacts(self) -> dict[str, dict[str, object]]:
        """Reviewed artifacts so proceed/edit passes never recompute LLM output."""
        return {
            step.step_id: step.artifact
            for step in self.steps
            if step.artifact is not None
        }

    def to_dict(self) -> dict[str, object]:
        return {
            "runId": self.run_id,
            "tenantId": self.tenant_id,
            "workflow": self.workflow,
            "ticketKey": self.ticket_key,
            "caseId": self.case_id,
            "input": self.input,
            "steps": [step.to_dict() for step in self.steps],
            "status": self.status,
            "attempt": self.attempt,
            "queuePosition": self.queue_position,
            "lockTarget": self.lock_target,
            "lockOwner": self.lock_owner,
            "outcome": self.outcome,
            "cancelReason": self.cancel_reason,
            "sideEffects": self.side_effects,
            "startedAt": self.started_at.isoformat(),
            "heartbeatAt": self.heartbeat_at.isoformat(),
            "finishedAt": self.finished_at.isoformat() if self.finished_at else None,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> WorkflowRun:
        steps_raw = raw.get("steps", [])
        if not isinstance(steps_raw, list):
            raise TypeError("Invalid run steps")
        side_effects = raw.get("sideEffects")
        input_value = raw.get("input")
        finished = raw.get("finishedAt")
        return cls(
            run_id=str(raw["runId"]),
            tenant_id=str(raw["tenantId"]),
            workflow=str(raw["workflow"]),
            ticket_key=str(raw["ticketKey"]),
            case_id=str(raw["caseId"]),
            input=input_value if isinstance(input_value, dict) else {},
            steps=[RunStep.from_dict(item) for item in steps_raw if isinstance(item, dict)],
            status=str(raw.get("status", "queued")),
            attempt=int(raw.get("attempt", 0)),
            queue_position=(
                int(raw["queuePosition"])
                if raw.get("queuePosition") is not None
                else None
            ),
            lock_target=str(raw["lockTarget"]) if raw.get("lockTarget") is not None else None,
            lock_owner=str(raw["lockOwner"]) if raw.get("lockOwner") is not None else None,
            outcome=str(raw["outcome"]) if raw.get("outcome") is not None else None,
            cancel_reason=str(raw["cancelReason"]) if raw.get("cancelReason") is not None else None,
            side_effects=side_effects if isinstance(side_effects, dict) else {},
            started_at=_parse_datetime(raw.get("startedAt")),
            heartbeat_at=_parse_datetime(raw.get("heartbeatAt")),
            finished_at=_parse_datetime(finished) if finished else None,
        )


@dataclass(frozen=True)
class MastraOutcome:
    """Normalized result of one Mastra workflow pass (start or resume)."""

    status: str  # "suspended" | "completed" | "failed"
    step_id: str | None = None
    artifact: dict[str, object] | None = None
    target: str | None = None
    effects: dict[str, dict[str, object]] = field(default_factory=dict)
    output: dict[str, object] | None = None
    error: str | None = None


def _parse_datetime(value: object) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            pass
    return datetime.now(UTC)
