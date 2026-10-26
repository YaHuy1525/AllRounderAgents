"""Coding-lane benchmark read-model: decision funnel, pass rate, cost, A7.

Pure unit tests over hand-built ``WorkflowRun`` lists — no LLM, no clock, no
database. The document is deterministic: the same archive snapshot in, the same
counts and ratios out. These assert the decision mapping (the crux), per-step
approval rate, lane pass rate, cost-per-pass, receipt count, the ``None``
empty-denominator rule, and that the excluded ``retry_lock`` action never forms
a funnel row.
"""

from __future__ import annotations

from allrounder_api.benchmark import (
    CODING_LANES,
    build_benchmark,
    empty_benchmark,
)
from allrounder_api.runs.models import RunStep, WorkflowRun


def _step(
    step_id: str,
    index: int,
    *,
    action: str | None = None,
    receipt: str | None = None,
    title: str | None = None,
    artifact: dict[str, object] | None = None,
) -> RunStep:
    decision = {"action": action} if action is not None else None
    return RunStep(
        step_id=step_id,
        index=index,
        title=title or step_id.replace("-", " ").title(),
        state="done",
        decision=decision,
        receipt=receipt,
        artifact=artifact,
    )


def _run(
    *,
    run_id: str,
    workflow: str,
    status: str,
    case_id: str,
    steps: list[RunStep],
    cost: int = 0,
) -> WorkflowRun:
    return WorkflowRun(
        run_id=run_id,
        tenant_id="tenant-a",
        workflow=workflow,
        ticket_key="ABC-1",
        case_id=case_id,
        input={},
        steps=steps,
        status=status,
        cost_usd_micro=cost,
    )


def _lane(document: dict[str, object], workflow: str) -> dict[str, object]:
    for lane in document["lanes"]:  # type: ignore[index]
        if lane["workflow"] == workflow:  # type: ignore[index]
            return lane  # type: ignore[return-value]
    raise AssertionError(f"lane {workflow!r} missing from benchmark")


def _step_row(lane: dict[str, object], step_id: str) -> dict[str, object]:
    for row in lane["steps"]:  # type: ignore[index]
        if row["stepId"] == step_id:  # type: ignore[index]
            return row  # type: ignore[return-value]
    raise AssertionError(f"step {step_id!r} missing from lane funnel")


def test_decision_mapping_and_per_step_rate() -> None:
    # One review run: proceed (approval), regenerate (retry), edit (approval),
    # back (revisit), abort (stop) across distinct steps.
    run = _run(
        run_id="r1",
        workflow="review",
        status="completed",
        case_id="case-1",
        steps=[
            _step("select-pr", 0, action="proceed"),
            _step("review-options", 1, action="regenerate"),
            _step("ai-review", 2, action="edit"),
            _step("diff", 3, action="back"),
            _step("complete", 4, action="abort"),
        ],
    )
    lane = _lane(build_benchmark([run]), "review")

    assert _step_row(lane, "select-pr")["approvals"] == 1
    assert _step_row(lane, "select-pr")["approvalRate"] == 1.0
    # proceed + edit both bucket as approvals on their own steps.
    assert _step_row(lane, "ai-review")["approvals"] == 1
    assert _step_row(lane, "review-options")["retries"] == 1
    assert _step_row(lane, "review-options")["approvalRate"] == 0.0
    assert _step_row(lane, "complete")["stops"] == 1
    # back is a revisit, reported separately and out of the rate denominator.
    assert _step_row(lane, "diff")["revisits"] == 1
    assert _step_row(lane, "diff")["approvalRate"] is None


def test_approval_rate_counts_proceed_and_edit_over_approvals_retries_stops() -> None:
    # A single step gated three ways across runs: 2 approvals + 1 retry + 1 stop
    # → 2 / (2 + 1 + 1) = 0.5. Revisits never enter the denominator.
    runs = [
        _run(run_id="a", workflow="review", status="completed", case_id="c", steps=[
            _step("ai-review", 2, action="proceed"),
        ]),
        _run(run_id="b", workflow="review", status="completed", case_id="c", steps=[
            _step("ai-review", 2, action="edit"),
        ]),
        _run(run_id="d", workflow="review", status="completed", case_id="c", steps=[
            _step("ai-review", 2, action="regenerate"),
        ]),
        _run(run_id="e", workflow="review", status="completed", case_id="c", steps=[
            _step("ai-review", 2, action="abort"),
        ]),
        _run(run_id="f", workflow="review", status="completed", case_id="c", steps=[
            _step("ai-review", 2, action="back"),
        ]),
    ]
    lane = _lane(build_benchmark(runs), "review")
    row = _step_row(lane, "ai-review")
    assert row["approvals"] == 2
    assert row["retries"] == 1
    assert row["stops"] == 1
    assert row["revisits"] == 1
    assert row["gates"] == 5
    assert row["approvalRate"] == 0.5


def test_retry_lock_only_step_never_forms_a_row() -> None:
    run = _run(
        run_id="r1",
        workflow="issues",
        status="completed",
        case_id="c",
        steps=[
            _step("issue-selection", 0, action="retry_lock"),
            _step("analysis", 1, action="proceed", receipt="sig"),
        ],
    )
    lane = _lane(build_benchmark([run]), "issues")
    step_ids = [row["stepId"] for row in lane["steps"]]  # type: ignore[index]
    assert "issue-selection" not in step_ids
    assert _step_row(lane, "analysis")["approvals"] == 1
    # The receipt on the gated analysis step counts toward gateReceipts.
    assert lane["gateReceipts"] == 1


def test_pass_rate_and_cost_per_pass() -> None:
    runs = [
        _run(run_id="a", workflow="features", status="completed", case_id="c1",
             steps=[_step("plan", 0, action="proceed")], cost=1000),
        _run(run_id="b", workflow="features", status="completed", case_id="c2",
             steps=[_step("plan", 0, action="proceed")], cost=2000),
        _run(run_id="c", workflow="features", status="failed", case_id="c3",
             steps=[_step("plan", 0, action="abort")], cost=500),
    ]
    lane = _lane(build_benchmark(runs), "features")
    assert lane["terminalRuns"] == 3
    assert lane["passes"] == 2
    assert lane["passRate"] == round(2 / 3, 4)
    # Lane cost is the sum of each run's own reported spend, not a case join.
    assert lane["costUsdMicro"] == 3500
    # cost-per-pass spans the whole lane cost, not only passing runs.
    assert lane["costPerPassUsdMicro"] == round(3500 / 2)


def test_zero_passes_yields_none_cost_per_pass() -> None:
    run = _run(
        run_id="a", workflow="dependencies", status="failed", case_id="c1",
        steps=[_step("plan", 0, action="abort")], cost=700,
    )
    lane = _lane(build_benchmark([run]), "dependencies")
    assert lane["passes"] == 0
    assert lane["passRate"] == 0.0
    assert lane["costUsdMicro"] == 700
    assert lane["costPerPassUsdMicro"] is None


def test_non_coding_lane_is_ignored() -> None:
    run = _run(
        run_id="a", workflow="bills", status="completed", case_id="c1",
        steps=[_step("extract", 0, action="proceed")],
    )
    document = build_benchmark([run])
    assert document["lanes"] == []
    assert document["totals"]["terminalRuns"] == 0  # type: ignore[index]


def test_self_correction_counters_are_scanned_tolerantly() -> None:
    # A7 signals live inside the archived step artifact; the scan counts bools
    # and sums ints without knowing the artifact's exact nesting.
    run = _run(
        run_id="a", workflow="review", status="completed", case_id="c",
        steps=[
            _step(
                "validate", 2, action="proceed",
                artifact={
                    "harness": {
                        "validationAttempts": 2,
                        "repairApplied": True,
                        "criticBlocked": False,
                        "doomLoopStops": True,
                        "checksRun": 3,
                    },
                },
            ),
        ],
    )
    lane = _lane(build_benchmark([run]), "review")
    assert lane["selfCorrection"] == {  # type: ignore[index]
        "repairApplied": 1,
        "criticBlocked": 0,
        "doomLoopStops": 1,
        "validationAttempts": 2,
        "checksRun": 3,
    }


def test_lane_scope_is_ordered_by_declaration() -> None:
    runs = [
        _run(run_id="a", workflow="issues", status="completed", case_id="c",
             steps=[_step("analysis", 1, action="proceed")]),
        _run(run_id="b", workflow="review", status="completed", case_id="c",
             steps=[_step("select-pr", 0, action="proceed")]),
    ]
    document = build_benchmark(runs)
    assert [lane["workflow"] for lane in document["lanes"]] == ["review", "issues"]  # type: ignore[index]
    assert document["laneScope"] == list(CODING_LANES)  # type: ignore[index]


def test_totals_roll_up_across_lanes() -> None:
    runs = [
        _run(run_id="a", workflow="review", status="completed", case_id="c1",
             steps=[_step("select-pr", 0, action="proceed", receipt="s")], cost=400),
        _run(run_id="b", workflow="issues", status="failed", case_id="c2",
             steps=[_step("analysis", 1, action="abort")], cost=600),
    ]
    totals = build_benchmark(runs)["totals"]
    assert totals == {
        "terminalRuns": 2,
        "passes": 1,
        "passRate": 0.5,
        "costUsdMicro": 1000,
        "costPerPassUsdMicro": 1000,
        "gateReceipts": 1,
        "selfCorrection": {
            "repairApplied": 0,
            "criticBlocked": 0,
            "doomLoopStops": 0,
            "validationAttempts": 0,
            "checksRun": 0,
        },
    }


def test_empty_benchmark_shape() -> None:
    document = empty_benchmark()
    assert document["lanes"] == []
    assert document["laneScope"] == list(CODING_LANES)
    assert document["totals"]["passRate"] is None  # type: ignore[index]
    assert document["totals"]["costPerPassUsdMicro"] is None  # type: ignore[index]


def test_output_is_deterministic_for_the_same_snapshot() -> None:
    def snapshot() -> list[WorkflowRun]:
        return [
            _run(run_id="a", workflow="review", status="completed", case_id="c",
                 steps=[_step("select-pr", 0, action="proceed"),
                        _step("ai-review", 2, action="regenerate")], cost=100),
        ]

    first = build_benchmark(snapshot())
    second = build_benchmark(snapshot())
    # generatedAt is the only permitted variation.
    del first["generatedAt"]
    del second["generatedAt"]
    assert first == second
