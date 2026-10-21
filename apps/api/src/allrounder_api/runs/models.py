"""Data model for the parallel-safe run infrastructure.

Everything a run owns — steps, artifacts, decisions, receipts, locks — is
namespaced by ``runId``. Records are plain dataclasses with explicit
``to_dict`` / ``from_dict`` round-trips so the same shape serves the API,
Redis, and Postgres persistence layers.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, cast

from .ceilings import SLOT_ORDER

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

# Risk bands a step may declare for its approval gate, reusing the exact
# scores in policy/risk.yaml (``preflight.scores``): benign 10, single_risk
# 55, irreversible_high_blast 90. The approval queue and the dispatcher
# therefore speak one scale; the YAML is not loaded at approval time.
RISK_BANDS = (10, 55, 90)

# Named anchors for the three bands, so a shipped definition annotates
# ``risk=RISK_IRREVERSIBLE`` instead of a magic number (``RISK_BANDS``
# membership — and therefore these names — is what ``__post_init__``
# validates against).
RISK_BENIGN, RISK_SINGLE, RISK_IRREVERSIBLE = RISK_BANDS


@dataclass(frozen=True)
class FieldDefinition:
    """One lane-declared input field on a step (U7), configured without code.

    Declared fields are display/input only: the console renders them on the
    step surface and their values ride the normal edit decision, so the
    receipt gate applies unchanged. ``snap_key`` names the canonical doc-snap
    extraction key (``abn``, ``expiry``, ``invoiceNumber``, ``total``) that
    auto-fills the field when a snapped document carries it.
    """

    id: str
    label: str
    kind: str = "text"  # text | date | number
    required: bool = False
    max_length: int = 4000
    placeholder: str = ""
    help: str = ""
    snap_key: str = ""


@dataclass(frozen=True)
class StepDefinition:
    """Static description of one workflow step (declared before the run)."""

    id: str
    title: str
    side_effecting: bool = False
    # Display-only provider ids (github, okta, slack, ...) the step touches.
    # The flow graph renders them as satellites; they never influence
    # permissions — ``side_effect_scope`` stays the governance source.
    integrations: tuple[str, ...] = ()
    # Lane-declared custom inputs the console renders on this step's surface
    # (U7); empty for steps that take no extra inputs.
    fields: tuple[FieldDefinition, ...] = ()
    # Extra ceiling slots a drive pass that may compute this step must hold
    # (``run`` is always held and never listed): ``("apply", "model")`` for
    # the patch-apply step, ``("model",)`` for model-bearing steps, ``()``
    # for pure computation. Declared here so the run service enforces the
    # three spec ceilings without inline conditionals in the drive loop.
    slots: tuple[str, ...] = ()
    # Risk band stamped on the approval this step's gate creates, so the
    # queue surfaces the riskiest gate first. ``None`` lets the service
    # default apply (55 side-effecting, 10 pure); an explicit band must be
    # one of ``RISK_BANDS``.
    risk: int | None = None

    def __post_init__(self) -> None:
        """Fail loudly on governance values the platform does not know.

        ``_pass_kinds`` filters the declared kinds against ``SLOT_ORDER``, so
        an undeclared kind (a ``"modl"`` typo) would silently drop the
        requirement and un-cap the step instead of capping it — the exact
        failure mode slot discipline exists to prevent. Validation happens at
        import time for the shipped definitions, never at run time.

        The same reasoning guards ``risk``: a typo'd band (``5`` for ``55``)
        would land in range but silently un-rank the gate onto a bogus value,
        so an explicit band must be one of the ``RISK_BANDS`` anchors.
        """
        unknown = [kind for kind in self.slots if kind not in SLOT_ORDER]
        if unknown:
            raise ValueError(
                f"Step {self.id!r} declares unknown ceiling slot(s) {unknown!r}; "
                f"valid kinds are {list(SLOT_ORDER)!r}"
            )
        if self.risk is not None and self.risk not in RISK_BANDS:
            raise ValueError(
                f"Step {self.id!r} declares risk band {self.risk!r}; "
                f"valid bands are {list(RISK_BANDS)!r} (policy/risk.yaml scores)"
            )


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
    # Last-progress clock: stamped at every serving-plane step transition
    # (start, pass launch, suspension, decision, terminal). The sweep's
    # deadline is measured from here, and ``run_snapshot`` publishes it as
    # ``heartbeatAt`` — the console's single liveness surface.
    heartbeat_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    # Actual spend for this run in micro-USD, derived from real token usage on
    # the engine side and reported in the completed result. Defaults to 0 for
    # lanes that do not instrument usage (and for scripted/offline runs).
    cost_usd_micro: int = 0
    # The drive pass the run is waiting to (re)execute, recorded before the
    # pass requests its ceiling slots so any kind's promotion re-drives the
    # right pass (start, or resume at ``stepId`` with ``decision``) instead of
    # restarting from the first step. ``slots`` is the acquisition prefix of
    # kinds granted for the pass and ``waitingOn`` the kind it queued on;
    # release walks ``slots`` in reverse. Cleared once every granted kind is
    # given back. Absent (None) on records written before this field existed.
    pending_pass: dict[str, object] | None = None

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
            "costUsdMicro": self.cost_usd_micro,
            "pendingPass": self.pending_pass,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> WorkflowRun:
        steps_raw = raw.get("steps", [])
        if not isinstance(steps_raw, list):
            raise TypeError("Invalid run steps")
        side_effects = raw.get("sideEffects")
        input_value = raw.get("input")
        finished = raw.get("finishedAt")
        pending_pass = raw.get("pendingPass")
        started_at = _parse_datetime(raw.get("startedAt"))
        # Additive-serialization discipline with a fail-closed clock: a
        # missing or unparseable ``heartbeatAt`` (including the empty
        # string, which is not ``None``) falls back to ``started_at``, the
        # sweep's original reference point — never to ``_parse_datetime``'s
        # read-time ``now``, which would re-stamp a corrupt record on every
        # read and keep it (and its slots) immune until the registry TTL.
        # The heartbeat is then clamped so it can never precede ``started_at``
        # — a corrupt ``startedAt`` falling back to ``now`` beside a valid
        # old heartbeat must not revive heartbeat-before-start.
        heartbeat_at = _parse_datetime_or(raw.get("heartbeatAt"), started_at)
        # Compare aware-to-aware: a corrupt record can pair a naive
        # ``heartbeatAt`` (an ISO string with no offset) with an aware
        # ``startedAt`` or the reverse, and the bare ``<`` would raise
        # ``TypeError`` on every later read of that run. A naive value is
        # read as UTC so the clamp degrades instead of crashing.
        if _as_aware(heartbeat_at) < _as_aware(started_at):
            heartbeat_at = started_at
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
            started_at=started_at,
            heartbeat_at=heartbeat_at,
            finished_at=_parse_datetime(finished) if finished else None,
            cost_usd_micro=int(raw.get("costUsdMicro", 0) or 0),
            pending_pass=pending_pass if isinstance(pending_pass, dict) else None,
        )


def _queue_state(run: WorkflowRun) -> tuple[str | None, list[str]]:
    """What a ``queued`` run is waiting on and the slot kinds it already
    holds, both sourced from ``pending_pass`` (``None``/empty when the run
    carries no recorded pass). Additive read-model keys for
    ``run_snapshot``/``run_summary`` so the console can name the actual
    ceiling instead of claiming "a run slot" for every queue."""
    pending = run.pending_pass
    if not isinstance(pending, dict):
        return None, []
    waiting = pending.get("waitingOn")
    held = pending.get("slots")
    return (
        str(waiting) if isinstance(waiting, str) else None,
        [str(kind) for kind in held] if isinstance(held, list) else [],
    )


def run_snapshot(run: WorkflowRun) -> dict[str, object]:
    """Shared detail snapshot for the REST surface and enriched SSE events.

    Same key set the ``GET /runs/{run_id}`` payload exposes; publishers embed
    it under ``run`` so live viewers can apply a transition without a refetch.
    """

    current = run.current_step()
    waiting_on, held_slots = _queue_state(run)
    return {
        "runId": run.run_id,
        "workflow": run.workflow,
        "ticketKey": run.ticket_key,
        "status": run.status,
        "queuePosition": run.queue_position,
        "waitingOn": waiting_on,
        "heldSlots": held_slots,
        "currentStepId": current.step_id if current is not None else None,
        "stepCount": len(run.steps),
        "stepsDone": sum(1 for step in run.steps if step.state == "done"),
        "startedAt": run.started_at.isoformat(),
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
        "caseId": run.case_id,
        "attempt": run.attempt,
        "heartbeatAt": run.heartbeat_at.isoformat(),
        "lockTarget": run.lock_target,
        "lockedBy": run.lock_owner,
        "outcome": run.outcome,
        "cancelReason": run.cancel_reason,
        "sideEffects": run.side_effects,
        "costUsdMicro": run.cost_usd_micro,
        "steps": [step.to_dict() for step in run.steps],
    }


def run_summary(run: WorkflowRun) -> dict[str, object]:
    """One run as a list row — the shared shape every list surface serves
    (live active lists, ticket history, and the archive ∪ Redis merge)."""

    current = run.current_step()
    waiting_on, held_slots = _queue_state(run)
    return {
        "runId": run.run_id,
        "workflow": run.workflow,
        "ticketKey": run.ticket_key,
        "status": run.status,
        "queuePosition": run.queue_position,
        "waitingOn": waiting_on,
        "heldSlots": held_slots,
        "currentStepId": current.step_id if current is not None else None,
        "stepCount": len(run.steps),
        "stepsDone": sum(1 for step in run.steps if step.state == "done"),
        "startedAt": run.started_at.isoformat(),
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
    }


def _fields_payload(static: StepDefinition | None) -> list[dict[str, object]]:
    """Declared custom fields of one step, ready for the console (U7).

    ``maxLength`` is clamped so a misdeclared field can never widen the
    4000-char input cap the surfaces enforce everywhere else.
    """

    if static is None:
        return []
    return [
        {
            "id": item.id,
            "label": item.label,
            "kind": item.kind,
            "required": item.required,
            "maxLength": min(item.max_length, 4000),
            "placeholder": item.placeholder,
            "help": item.help,
            "snapKey": item.snap_key,
        }
        for item in static.fields
    ]


def run_topology(
    run: WorkflowRun,
    definition: WorkflowDefinition | None,
) -> dict[str, object]:
    """Read-only topology for one run: steps + satellites + receipts + lock.

    One payload feeds the console's five lenses (forms, graph, data, timeline,
    logs): live step rows carry state, the static workflow definition adds the
    display-only ``sideEffecting`` / ``integrations`` fields the flow graph
    renders as satellites plus any lane-declared custom ``fields`` the
    console renders on the step surface, and the lock/receipt summaries close
    the loop. Run-level header fields and step rows derive from
    ``run_snapshot()`` — the shape ``GET /runs/{run_id}`` and SSE transition
    events publish — so the console read model can never disagree with the
    detail surface. The definition is passed in by the caller because
    ``definitions.py`` already imports this module — importing it back would
    be a cycle. Unknown workflows (``definition`` is None) degrade to the
    run's own rows with empty satellites instead of failing.
    """

    snapshot = run_snapshot(run)
    raw_steps = cast("list[dict[str, object]]", snapshot["steps"])
    side_effects = cast("dict[str, dict[str, object]]", snapshot["sideEffects"])
    steps: list[dict[str, object]] = []
    receipt_items: list[dict[str, object]] = []
    for raw in raw_steps:
        step_id = cast("str", raw["stepId"])
        static: StepDefinition | None = None
        if definition is not None:
            try:
                static = definition.step(step_id)
            except KeyError:
                static = None
        receipt = raw["receipt"]
        action_hash = raw["actionHash"]
        has_effect = step_id in side_effects
        if receipt is not None or action_hash is not None or has_effect:
            receipt_items.append(
                {
                    "stepId": step_id,
                    "receipt": receipt,
                    "actionHash": action_hash,
                    "effectRecorded": has_effect,
                }
            )
        steps.append(
            {
                "stepId": step_id,
                "index": raw["index"],
                "title": raw["title"],
                "state": raw["state"],
                "sideEffecting": static.side_effecting if static is not None else False,
                "integrations": list(static.integrations) if static is not None else [],
                "fields": _fields_payload(static),
                "receipt": receipt,
                "actionHash": action_hash,
                "hasArtifact": raw["artifact"] is not None,
                "hasDecision": raw["decision"] is not None,
                "regenerations": raw["regenerations"],
                "updatedAt": raw["updatedAt"],
            }
        )
    lock: dict[str, object] | None = None
    if snapshot["lockTarget"] is not None or snapshot["lockedBy"] is not None:
        lock = {"target": snapshot["lockTarget"], "lockedBy": snapshot["lockedBy"]}
    return {
        "runId": snapshot["runId"],
        "workflow": snapshot["workflow"],
        "status": snapshot["status"],
        "attempt": snapshot["attempt"],
        "currentStepId": snapshot["currentStepId"],
        "stepCount": snapshot["stepCount"],
        "stepsDone": snapshot["stepsDone"],
        "startedAt": snapshot["startedAt"],
        "finishedAt": snapshot["finishedAt"],
        "lock": lock,
        "receipts": {
            "signed": sum(1 for step in steps if step["receipt"] is not None),
            "items": receipt_items,
        },
        "steps": steps,
    }


# --------------------------------------------------------------- data pills
#
# N3: every reviewable output the run already holds is pickable as a "data
# pill" — a ``{{ref}}`` token a downstream text field mixes with free text.
# ``run_pills`` serves the picker catalog; ``resolve_pill_*`` swaps tokens for
# concrete values inside ``RunService.decide``, so a decision receipt is bound
# to the values that actually execute — a missing ref fails the decision
# loudly instead of riding through as literal text.

PILL_TOKEN_PATTERN = re.compile(r"\{\{([A-Za-z0-9_.\[\]-]{1,200})\}\}")

# The catalog stays bounded so one enormous artifact cannot flood the picker.
_PILL_DEPTH_LIMIT = 6
_PILL_GROUP_LIMIT = 60
_PILL_LIST_LIMIT = 12
_PILL_PREVIEW_LIMIT = 80
_PILL_KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
_PILL_PATH_SEGMENT = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


class PillRefError(ValueError):
    """One or more data pills no longer resolve against the run's outputs."""


def _pill_sources(
    run: WorkflowRun, *, before_index: int | None
) -> list[tuple[str, object]]:
    """The ``(ref prefix, base)`` pairs a pill ref may address, in order.

    Trigger input first, then the artifacts of the steps *before*
    ``before_index`` — the checkpoint the refs are authored at. Everything
    from the checkpoint on is out of scope: the step under review and later
    steps have not been decided yet.
    """

    sources: list[tuple[str, object]] = [("trigger", run.input)]
    for step in run.steps:
        if step.artifact is None:
            continue
        if before_index is not None and step.index >= before_index:
            continue
        sources.append((f"steps.{step.step_id}", step.artifact))
    return sources


def _pill_leaf(value: object) -> tuple[str, str] | None:
    """``(kind, preview)`` for a pillable scalar, else None (containers, None,
    empty strings carry nothing a field could mix in)."""

    if isinstance(value, str):
        if value == "":
            return None
        collapsed = " ".join(value.split())
        preview = (
            collapsed
            if len(collapsed) <= _PILL_PREVIEW_LIMIT
            else collapsed[: _PILL_PREVIEW_LIMIT - 1] + "…"
        )
        return ("text", preview)
    if isinstance(value, bool):
        return ("boolean", "true" if value else "false")
    if isinstance(value, (int, float)):
        return ("number", str(value))
    return None


def _pill_is_citation(value: Mapping[str, object]) -> bool:
    source = value.get("sourceId")
    return isinstance(source, str) and source != "" and "span" in value


def _pill_citation_preview(value: Mapping[str, object]) -> str:
    source = value.get("sourceId")
    span = value.get("span")
    if isinstance(span, str) and span:
        return f"{source} @ {span}"
    return str(source)


def _collect_pill_group(
    base: object,
    ref_prefix: str,
    group: str,
    group_title: str,
    step_index: int,
    pills: list[dict[str, object]],
) -> None:
    """Walk one base value (trigger input or a step artifact) into pills.

    ``{sourceId, span}`` citation records collapse into a single composite
    pill; list items keep their index (``violations[2].rule``) so a pill from
    a loop stays scoped to the item it came from.
    """

    remaining = _PILL_GROUP_LIMIT

    def emit(tail: str, kind: str, preview: str) -> None:
        nonlocal remaining
        if remaining <= 0 or tail == "":
            return
        remaining -= 1
        pills.append(
            {
                "ref": f"{ref_prefix}.{tail}",
                "group": group,
                "groupTitle": group_title,
                "label": tail,
                "kind": kind,
                "preview": preview,
                "stepIndex": step_index,
            }
        )

    def walk(value: object, tail: str, depth: int) -> None:
        nonlocal remaining
        if remaining <= 0 or depth > _PILL_DEPTH_LIMIT:
            return
        if isinstance(value, Mapping):
            if _pill_is_citation(value):
                emit(tail, "citation", _pill_citation_preview(value))
                return
            for key, item in value.items():
                if not isinstance(key, str) or _PILL_KEY_PATTERN.fullmatch(key) is None:
                    continue
                child = f"{tail}.{key}" if tail else key
                leaf = _pill_leaf(item)
                if leaf is not None:
                    emit(child, leaf[0], leaf[1])
                elif isinstance(item, (Mapping, list)):
                    walk(item, child, depth + 1)
        elif isinstance(value, list):
            for index, item in enumerate(value[:_PILL_LIST_LIMIT]):
                child = f"{tail}[{index}]"
                leaf = _pill_leaf(item)
                if leaf is not None:
                    emit(child, leaf[0], leaf[1])
                elif isinstance(item, (Mapping, list)):
                    walk(item, child, depth + 1)

    walk(base, "", 0)


def run_pills(run: WorkflowRun) -> dict[str, object]:
    """Catalog of earlier outputs a downstream field can reference (N3).

    Every leaf of the trigger input and of the earlier steps' artifacts is
    exposed as a path-addressed pill (``trigger.repository``,
    ``steps.select-pr.prNumber``); the catalog stops at the current
    checkpoint and the runtime resolver enforces the same boundary, so the
    console can never offer a ref the decision would reject.
    """

    current = run.current_step()
    before_index = current.index if current is not None else None
    pills: list[dict[str, object]] = []
    _collect_pill_group(run.input, "trigger", "trigger", "Trigger", -1, pills)
    for step in run.steps:
        if step.artifact is None:
            continue
        if before_index is not None and step.index >= before_index:
            continue
        _collect_pill_group(
            step.artifact,
            f"steps.{step.step_id}",
            step.step_id,
            step.title,
            step.index,
            pills,
        )
    return {
        "runId": run.run_id,
        "workflow": run.workflow,
        "currentStepId": current.step_id if current is not None else None,
        "pills": pills,
    }


def _walk_pill_path(base: object, path: str) -> tuple[bool, object]:
    """Resolve ``a.b[2].c`` against a base value. Strict about separators so
    a malformed hand-typed ref never aliases a real path."""

    if path == "":
        return (False, None)
    current = base
    consumed = 0
    for match in _PILL_PATH_SEGMENT.finditer(path):
        skipped = path[consumed : match.start()]
        is_key = match.group(1) is not None
        if not (
            (consumed == 0 and match.start() == 0)
            or (skipped == "." and is_key and consumed > 0)
            or (skipped == "" and not is_key)
        ):
            return (False, None)
        if is_key:
            key = match.group(1)
            if not isinstance(current, Mapping) or key is None or key not in current:
                return (False, None)
            current = current[key]
        else:
            index = int(match.group(2) or "")
            if not isinstance(current, list) or index >= len(current):
                return (False, None)
            current = current[index]
        consumed = match.end()
    if consumed != len(path):
        return (False, None)
    return (True, current)


def _pill_string(value: object) -> str | None:
    """The text form a pill resolves to; None when the value is not pillable
    (containers, None, empty sourceIds)."""

    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, Mapping):
        source = value.get("sourceId")
        if isinstance(source, str) and source:
            span = value.get("span")
            if isinstance(span, str) and span:
                return f"{source} @ {span}"
            return source
    return None


def _resolve_pill_ref(ref: str, run: WorkflowRun, *, before_index: int | None) -> str | None:
    best: tuple[str, object] | None = None
    for prefix, base in _pill_sources(run, before_index=before_index):
        if ref.startswith(prefix + ".") and (best is None or len(prefix) > len(best[0])):
            best = (prefix, base)
    if best is None:
        return None
    prefix, base = best
    found, value = _walk_pill_path(base, ref[len(prefix) + 1 :])
    if not found:
        return None
    return _pill_string(value)


def _substitute_pill_tokens(
    text: str,
    run: WorkflowRun,
    *,
    before_index: int | None,
    broken: list[str],
) -> str:
    def replace(match: re.Match[str]) -> str:
        ref = match.group(1)
        resolved = _resolve_pill_ref(ref, run, before_index=before_index)
        if resolved is None:
            broken.append(match.group(0))
            return match.group(0)
        return resolved

    return PILL_TOKEN_PATTERN.sub(replace, text)


def _resolve_pill_deep(
    value: object,
    run: WorkflowRun,
    *,
    before_index: int | None,
    broken: list[str],
) -> object:
    if isinstance(value, str):
        return _substitute_pill_tokens(
            value, run, before_index=before_index, broken=broken
        )
    if isinstance(value, Mapping):
        return {
            key: _resolve_pill_deep(item, run, before_index=before_index, broken=broken)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            _resolve_pill_deep(item, run, before_index=before_index, broken=broken)
            for item in value
        ]
    return value


def _pill_error(broken: list[str]) -> PillRefError:
    unique = list(dict.fromkeys(broken))
    listed = ", ".join(unique[:5])
    if len(unique) > 5:
        listed += f", and {len(unique) - 5} more"
    if len(unique) == 1:
        return PillRefError(f"Data pill {listed} no longer exists — re-map the field")
    return PillRefError(f"Data pills {listed} no longer exist — re-map the field")


def resolve_pill_value(
    value: object, run: WorkflowRun, *, before_index: int | None
) -> object:
    """Swap every ``{{ref}}`` token in ``value`` for its current value.

    All broken refs are collected before raising so a decision is rejected
    with the complete re-map list; strings without tokens pass through
    untouched.
    """

    broken: list[str] = []
    resolved = _resolve_pill_deep(value, run, before_index=before_index, broken=broken)
    if broken:
        raise _pill_error(broken)
    return resolved


def resolve_pill_text(
    text: str, run: WorkflowRun, *, before_index: int | None
) -> str:
    """Token substitution for a single free-text field (e.g. guidance)."""

    broken: list[str] = []
    resolved = _substitute_pill_tokens(
        text, run, before_index=before_index, broken=broken
    )
    if broken:
        raise _pill_error(broken)
    return resolved


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


def _parse_datetime_or(value: object, fallback: datetime) -> datetime:
    """Parse an optional timestamp, failing closed to a caller-chosen safe
    value. Unlike ``_parse_datetime`` the fallback is never read-time
    ``now``: a missing or corrupt clock field must revive stale-but-bounded,
    not re-immortalized on every read."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            pass
    return fallback


def _as_aware(value: datetime) -> datetime:
    """Attach UTC to a naive datetime so mixed records compare (ISO strings
    with and without an offset both parse to valid ``datetime`` objects)."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
