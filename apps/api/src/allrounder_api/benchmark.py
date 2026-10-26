"""Coding-lane benchmark read-model.

A pure aggregation over the durable ``run_archive`` mirror in the ``metrics.py``
style, so the numbers survive a console restart. It answers a per-step approval
funnel (``approvals / (approvals + retries + stops)``) and a lane pass rate paired
with cost per pass. Same snapshot in, same document out, with counts and ratios
only.

Decision mapping: ``approvals`` are proceed and edit, ``retries`` are regenerate,
``stops`` are abort, ``revisits`` are back (reported apart from the rate), and
``retry_lock`` is excluded as an infra heal rather than a human judgment.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from .runs.definitions import WORKFLOW_DEFINITIONS
from .runs.models import RunStep, WorkflowRun

# The five coding lanes the benchmark scopes to (ids in runs/definitions.py).
# Coding lanes end ``completed`` when the Draft PR opens, so terminal status
# is a faithful pass signal.
CODING_LANES: tuple[str, ...] = (
    "review",
    "issues",
    "features",
    "dependencies",
    "accessibility",
)

# Decision action -> funnel bucket. ``retry_lock`` is intentionally absent:
# it is an infrastructure heal, never a human judgment, so it is excluded from
# the funnel entirely.
_APPROVAL_ACTIONS = frozenset({"proceed", "edit"})
_RETRY_ACTIONS = frozenset({"regenerate"})
_STOP_ACTIONS = frozenset({"abort"})
_REVISIT_ACTIONS = frozenset({"back"})

# A7 self-correction counters reported per lane so the harness upgrade is
# provable. Part A writes these keys into the archived step artifacts; the
# scan is tolerant, so a lane that has not exercised them simply reports zero.
_BOOL_SIGNALS = ("repairApplied", "criticBlocked", "doomLoopStops")
_INT_SIGNALS = ("validationAttempts", "checksRun")


def _decision_action(step: RunStep) -> str | None:
    """The recorded ``decision.action`` on a gated step, if any."""
    decision = step.decision
    if not isinstance(decision, Mapping):
        return None
    action = decision.get("action")
    return action if isinstance(action, str) else None


def _walk_signal(value: object, key: str) -> tuple[int, int]:
    """Sum ``(int_total, bool_count)`` found under ``key`` in a nested artifact.

    Tolerant scan of a step artifact for the A7 counters: integers add to the
    total, booleans count occurrences. Unknown shapes contribute nothing.
    """
    int_total = 0
    bool_count = 0
    if isinstance(value, Mapping):
        for child_key, child in value.items():
            if child_key == key:
                if isinstance(child, bool):
                    bool_count += 1 if child else 0
                elif isinstance(child, int):
                    int_total += child
            elif isinstance(child, (Mapping, list)):
                sub_int, sub_bool = _walk_signal(child, key)
                int_total += sub_int
                bool_count += sub_bool
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, (Mapping, list)):
                sub_int, sub_bool = _walk_signal(item, key)
                int_total += sub_int
                bool_count += sub_bool
    return int_total, bool_count


def _self_correction(runs: Sequence[WorkflowRun]) -> dict[str, int]:
    """Aggregate the A7 harness counters across a lane's archived runs."""
    signals = {key: 0 for key in (*_BOOL_SIGNALS, *_INT_SIGNALS)}
    for run in runs:
        for step in run.steps:
            artifact = step.artifact
            if not isinstance(artifact, Mapping):
                continue
            for key in _BOOL_SIGNALS:
                _, counted = _walk_signal(artifact, key)
                signals[key] += counted
            for key in _INT_SIGNALS:
                total, _ = _walk_signal(artifact, key)
                signals[key] += total
    return signals


def _rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator > 0 else None


def _lane_title(workflow: str) -> str:
    definition = WORKFLOW_DEFINITIONS.get(workflow)
    return definition.title if definition is not None else workflow


def _blank_step(step_id: str, index: int, title: str) -> dict[str, Any]:
    return {
        "stepId": step_id,
        "index": index,
        "title": title,
        "gates": 0,
        "approvals": 0,
        "retries": 0,
        "stops": 0,
        "revisits": 0,
    }


def _build_lane(workflow: str, runs: Sequence[WorkflowRun]) -> dict[str, Any]:
    terminal_runs = len(runs)
    passes = sum(1 for run in runs if run.status == "completed")

    # Per-step funnel: one row per gated step, keyed by step id, ordered by the
    # definition order (smallest step index seen for that id across the lane).
    step_rows: dict[str, dict[str, Any]] = {}
    gate_receipts = 0
    for run in runs:
        for step in run.steps:
            action = _decision_action(step)
            if action is None:
                continue
            # Bucket the decision first; an excluded action (retry_lock or an
            # unknown verb) never materialises a step row, so a purely infra-
            # gated step stays out of the funnel entirely.
            if action in _APPROVAL_ACTIONS:
                bucket = "approvals"
            elif action in _RETRY_ACTIONS:
                bucket = "retries"
            elif action in _STOP_ACTIONS:
                bucket = "stops"
            elif action in _REVISIT_ACTIONS:
                bucket = "revisits"
            else:
                continue
            row = step_rows.setdefault(
                step.step_id, _blank_step(step.step_id, step.index, step.title)
            )
            row["index"] = min(row["index"], step.index)
            row[bucket] += 1
            row["gates"] += 1
            if step.receipt is not None:
                gate_receipts += 1

    steps: list[dict[str, object]] = []
    for row in sorted(step_rows.values(), key=lambda item: (item["index"], item["stepId"])):
        denominator = row["approvals"] + row["retries"] + row["stops"]
        steps.append(
            {
                "stepId": row["stepId"],
                "title": row["title"],
                "gates": row["gates"],
                "approvals": row["approvals"],
                "retries": row["retries"],
                "stops": row["stops"],
                "revisits": row["revisits"],
                "approvalRate": _rate(row["approvals"], denominator),
            }
        )

    lane_cost = sum(int(run.cost_usd_micro or 0) for run in runs)
    return {
        "workflow": workflow,
        "title": _lane_title(workflow),
        "terminalRuns": terminal_runs,
        "passes": passes,
        "passRate": _rate(passes, terminal_runs),
        "costUsdMicro": lane_cost,
        "costPerPassUsdMicro": round(lane_cost / passes) if passes > 0 else None,
        "gateReceipts": gate_receipts,
        "selfCorrection": _self_correction(runs),
        "steps": steps,
    }


def build_benchmark(runs: Sequence[WorkflowRun]) -> dict[str, object]:
    """Fold archived coding-lane runs into the benchmark document.

    ``runs`` are terminal ``WorkflowRun`` records (already scoped to the tenant
    and the coding lanes by the caller). Cost is read off each run's
    ``cost_usd_micro`` (the engine's actual token spend), so a case with
    several runs no longer blurs their individual cost. The output is stable
    and camelCase, matching the rest of the metrics surface.
    """
    lanes_by_workflow: dict[str, list[WorkflowRun]] = {}
    for run in runs:
        if run.workflow not in CODING_LANES:
            continue
        lanes_by_workflow.setdefault(run.workflow, []).append(run)

    # Preserve the CODING_LANES declaration order so the panel is stable
    # regardless of which archive rows arrive first.
    lanes = [
        _build_lane(workflow, lanes_by_workflow[workflow])
        for workflow in CODING_LANES
        if workflow in lanes_by_workflow
    ]

    total_runs = sum(int(lane["terminalRuns"]) for lane in lanes)
    total_passes = sum(int(lane["passes"]) for lane in lanes)
    total_cost = sum(int(lane["costUsdMicro"]) for lane in lanes)
    total_receipts = sum(int(lane["gateReceipts"]) for lane in lanes)
    total_self_correction: dict[str, int] = {}
    for lane in lanes:
        for key, value in lane["selfCorrection"].items():
            total_self_correction[key] = total_self_correction.get(key, 0) + int(value)

    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "laneScope": list(CODING_LANES),
        "lanes": lanes,
        "totals": {
            "terminalRuns": total_runs,
            "passes": total_passes,
            "passRate": _rate(total_passes, total_runs),
            "costUsdMicro": total_cost,
            "costPerPassUsdMicro": round(total_cost / total_passes) if total_passes > 0 else None,
            "gateReceipts": total_receipts,
            "selfCorrection": total_self_correction,
        },
    }


def empty_benchmark() -> dict[str, object]:
    """Zeroed benchmark served when no archive is wired or no runs exist."""
    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "laneScope": list(CODING_LANES),
        "lanes": [],
        "totals": {
            "terminalRuns": 0,
            "passes": 0,
            "passRate": None,
            "costUsdMicro": 0,
            "costPerPassUsdMicro": None,
            "gateReceipts": 0,
            "selfCorrection": {key: 0 for key in (*_BOOL_SIGNALS, *_INT_SIGNALS)},
        },
    }


__all__ = ["CODING_LANES", "build_benchmark", "empty_benchmark"]
