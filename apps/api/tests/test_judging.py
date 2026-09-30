"""Judge harness unit tests: scripted fake judge, offline chat judge, no network.

The fake judge exercises scoring, aggregation, gating and caching end to end.
ChatJudge parsing runs over an httpx MockTransport. Nothing here reads
JEV_API_KEY or reaches any provider.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

import httpx
import pytest
from allrounder_api.judging import (
    CaseResult,
    ChatJudge,
    CriterionOutcome,
    CriterionSpec,
    HumanLabel,
    JevJudge,
    JudgeBatch,
    JudgeService,
    JudgeUsage,
    JudgmentCache,
    Rubric,
    SuiteReport,
    _coerce_unit,
    _extract_json_object,
    aggregate_suite,
    build_chat_prompt,
    calibrate,
    compare_with_baseline,
    failure_lines,
    hr_deterministic_outcomes,
    hr_draft_from_artifacts,
    judgment_key,
    load_jsonl,
    load_policy_corpus,
    load_rubric,
    resolve_citation,
    security_deterministic_outcomes,
    security_output_from_artifacts,
    write_jsonl,
)

# ------------------------------------------------------------- test doubles


class FakeJudge:
    """Scripted judge: fixed values per criterion id, optional hard failure."""

    def __init__(self, values: Mapping[str, float] | None = None, *, fail: bool = False) -> None:
        self.judge_id = "fake:v1"
        self.calls = 0
        self.seen_ids: list[str] = []
        self._values = dict(values or {})
        self._fail = fail

    async def score(
        self, criteria: Sequence[CriterionSpec], state: Mapping[str, Any]
    ) -> JudgeBatch:
        self.calls += 1
        self.seen_ids = [spec.id for spec in criteria]
        if self._fail:
            raise RuntimeError("judge unavailable")
        outcomes = [
            CriterionOutcome(
                criterion_id=spec.id,
                source="judge",
                normalized=self._values.get(spec.id, 1.0),
                passed=self._values.get(spec.id, 1.0) >= spec.pass_at,
                confidence=0.9,
            )
            for spec in criteria
        ]
        return JudgeBatch(outcomes=outcomes, usage=JudgeUsage(input_tokens=10, output_tokens=4))


def _noul_spec(
    criterion_id: str,
    *,
    weight: float = 1.0,
    applies_to_tags: list[str] | None = None,
) -> CriterionSpec:
    return CriterionSpec(
        id=criterion_id,
        kind="noul",
        instructions=f"Judge {criterion_id}.",
        weight=weight,
        applies_to_tags=applies_to_tags or [],
    )


def _rubric(
    criteria: list[CriterionSpec], *, threshold: float = 0.8, version: int = 1
) -> Rubric:
    return Rubric(suite="hr-help", version=version, threshold=threshold, criteria=criteria)


def _outcome(
    criterion_id: str,
    normalized: float,
    *,
    source: Literal["judge", "deterministic"] = "judge",
    passed: bool | None = None,
    confidence: float | None = None,
) -> CriterionOutcome:
    return CriterionOutcome(
        criterion_id=criterion_id,
        source=source,
        normalized=normalized,
        passed=normalized >= 0.5 if passed is None else passed,
        confidence=confidence,
    )


def _case(
    case_id: str,
    score: float,
    outcomes: list[CriterionOutcome],
    *,
    tags: list[str] | None = None,
    passed: bool | None = None,
    error: str | None = None,
    judge_confidence: float | None = None,
) -> CaseResult:
    return CaseResult(
        case_id=case_id,
        suite="hr-help",
        score=score,
        passed=(error is None and score >= 0.8) if passed is None else passed,
        tags=tags or [],
        outcomes=outcomes,
        error=error,
        judge_confidence=judge_confidence,
    )


def _report(score: float, cases: list[CaseResult]) -> SuiteReport:
    return SuiteReport(
        suite="hr-help",
        rubric_version=1,
        judge_id="fake:v1",
        generated_at="2026-09-28T00:00:00+00:00",
        score=score,
        pass_rate=1.0,
        cases=cases,
    )


def _transport(content: str, *, usage: Mapping[str, int] | None = None) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": content}}],
                "usage": dict(usage or {"prompt_tokens": 0, "completion_tokens": 0}),
            },
        )

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --------------------------------------------------------- citation resolver


def test_resolve_citation_slices_span_text() -> None:
    corpus = {"hr_policy/leave.md": "alpha beta gamma"}
    resolved = resolve_citation({"sourceId": "hr_policy/leave.md", "span": "6-10"}, corpus)
    assert resolved.ok is True
    assert resolved.text == "beta"


def test_resolve_citation_rejects_unknown_source() -> None:
    resolved = resolve_citation({"sourceId": "hr_policy/missing.md", "span": "0-4"}, {})
    assert resolved.ok is False
    assert "unknown sourceId" in resolved.detail


def test_resolve_citation_rejects_malformed_span() -> None:
    corpus = {"hr_policy/leave.md": "alpha beta"}
    resolved = resolve_citation({"sourceId": "hr_policy/leave.md", "span": "6"}, corpus)
    assert resolved.ok is False
    assert "start-end" in resolved.detail


@pytest.mark.parametrize("span", ["10-6", "0-99", "5-5"])
def test_resolve_citation_rejects_out_of_range_spans(span: str) -> None:
    corpus = {"hr_policy/leave.md": "alpha beta"}
    resolved = resolve_citation({"sourceId": "hr_policy/leave.md", "span": span}, corpus)
    assert resolved.ok is False
    assert "out of range" in resolved.detail


def test_load_policy_corpus_normalizes_crlf(tmp_path: Path) -> None:
    (tmp_path / "leave.md").write_bytes(b"one\r\ntwo")
    corpus = load_policy_corpus(tmp_path)
    assert corpus == {"hr_policy/leave.md": "one\ntwo"}


# ------------------------------------------------------ deterministic checks


def test_hr_checks_pass_on_resolvable_citations_with_markers() -> None:
    corpus = {"hr_policy/leave.md": "twenty days of annual leave"}
    citations = [{"sourceId": "hr_policy/leave.md", "span": "0-27"}]
    resolved = [resolve_citation(item, corpus) for item in citations]
    answer = "You accrue [hr_policy/leave.md:0-27] per year."
    outcomes = hr_deterministic_outcomes(
        tags=[], answer=answer, citations=citations, resolved=resolved
    )
    by_id = {item.criterion_id: item for item in outcomes}
    assert by_id["citations_resolve"].passed is True
    assert by_id["answer_carries_markers"].passed is True


def test_hr_checks_waive_a_missing_draft_on_escalation() -> None:
    outcomes = hr_deterministic_outcomes(tags=["escalation"], answer="", citations=[], resolved=[])
    assert len(outcomes) == 2
    assert all(item.passed for item in outcomes)


def test_hr_checks_fail_when_the_draft_has_no_citations() -> None:
    outcomes = hr_deterministic_outcomes(
        tags=[], answer="no markers here", citations=[], resolved=[]
    )
    by_id = {item.criterion_id: item for item in outcomes}
    assert by_id["citations_resolve"].passed is False
    assert by_id["answer_carries_markers"].passed is False


def test_hr_checks_fail_when_markers_name_unlisted_sources() -> None:
    citations = [{"sourceId": "hr_policy/leave.md", "span": "0-4"}]
    corpus = {"hr_policy/leave.md": "text"}
    resolved = [resolve_citation(item, corpus) for item in citations]
    answer = "See [hr_policy/other.md:0-4]."
    outcomes = hr_deterministic_outcomes(
        tags=[], answer=answer, citations=citations, resolved=resolved
    )
    by_id = {item.criterion_id: item for item in outcomes}
    assert by_id["citations_resolve"].passed is True
    assert by_id["answer_carries_markers"].passed is False


def test_hr_draft_extraction_tolerates_missing_and_junk_entries() -> None:
    assert hr_draft_from_artifacts({}) == ("", [])
    answer, citations = hr_draft_from_artifacts(
        {"draft": {"answer": "hi", "citations": [{"sourceId": "x", "span": "0-1"}, "junk"]}}
    )
    assert answer == "hi"
    assert citations == [{"sourceId": "x", "span": "0-1"}]


def test_security_checks_match_the_expect_block() -> None:
    output = {
        "classification": "true-positive",
        "severity": "high",
        "injectionFlags": ["directive_override"],
    }
    expect = {
        "classification": "true-positive",
        "severity": "high",
        "injectionFlags": ["directive_override"],
    }
    outcomes = security_deterministic_outcomes(output=output, expect=expect)
    assert all(item.passed for item in outcomes)


def test_security_checks_flag_a_mismatched_verdict() -> None:
    output = {"classification": "false-positive", "severity": "low", "injectionFlags": []}
    expect = {
        "classification": "true-positive",
        "severity": "high",
        "injectionFlags": ["directive_override"],
    }
    by_id = {
        item.criterion_id: item
        for item in security_deterministic_outcomes(output=output, expect=expect)
    }
    assert by_id["verdict_matches_expect"].passed is False
    assert by_id["flags_match"].passed is False
    assert "directive_override" in by_id["flags_match"].detail


def test_security_output_extraction() -> None:
    assert security_output_from_artifacts({}) == {}
    assert security_output_from_artifacts({"triage": {"classification": "x"}}) == {
        "classification": "x"
    }


# --------------------------------------------------------------- coercion


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (True, 1.0),
        (False, 0.0),
        (0.4, 0.4),
        ("yes", 1.0),
        ("No", 0.0),
        ("0.7", 0.7),
        (1.5, 1.0),
        (-1, 0.0),
    ],
)
def test_coerce_unit(raw: object, expected: float) -> None:
    assert _coerce_unit(raw) == expected


def test_coerce_unit_rejects_garbage() -> None:
    with pytest.raises(ValueError):
        _coerce_unit("mostly fine")


def test_extract_json_object_handles_code_fences() -> None:
    text = '```json\n{"claims_supported": {"value": 1}}\n```'
    assert _extract_json_object(text) == {"claims_supported": {"value": 1}}


def test_extract_json_object_finds_the_outer_object_after_prose() -> None:
    assert _extract_json_object('Here you go: {"a": 1} done') == {"a": 1}


def test_extract_json_object_rejects_non_json() -> None:
    with pytest.raises(ValueError):
        _extract_json_object("no object here")


# ----------------------------------------------------------- jsonl + rubric


def test_write_and_load_jsonl_roundtrip_skips_blanks(tmp_path: Path) -> None:
    path = tmp_path / "cases.jsonl"
    write_jsonl(path, [{"id": "a", "weight": 1}, {"id": "b"}])
    path.write_text(path.read_text(encoding="utf-8") + "\n\n", encoding="utf-8")
    assert load_jsonl(path) == [{"id": "a", "weight": 1}, {"id": "b"}]


def test_load_rubric_reads_json(tmp_path: Path) -> None:
    path = tmp_path / "hr-help.json"
    path.write_text(
        json.dumps(
            {
                "suite": "hr-help",
                "version": 2,
                "threshold": 0.75,
                "criteria": [{"id": "claims_supported", "kind": "noul", "weight": 3}],
            }
        ),
        encoding="utf-8",
    )
    rubric = load_rubric(path)
    assert rubric.suite == "hr-help"
    assert rubric.version == 2
    assert rubric.threshold == pytest.approx(0.75)
    assert rubric.criteria[0].id == "claims_supported"


# ------------------------------------------------------------- judgement key


def test_judgment_key_is_stable_and_version_sensitive() -> None:
    spec = _noul_spec("claims_supported")
    rubric_v1 = _rubric([spec], version=1)
    rubric_v2 = _rubric([spec], version=2)
    state = {"answer": "x"}
    key = judgment_key("fake:v1", rubric_v1, [spec], state)
    assert key == judgment_key("fake:v1", rubric_v1, [spec], state)
    assert key != judgment_key("fake:v1", rubric_v2, [spec], state)
    assert key != judgment_key("fake:v1", rubric_v1, [spec], {"answer": "y"})
    assert key != judgment_key("fake:v2", rubric_v1, [spec], state)


def test_judgment_cache_roundtrip(tmp_path: Path) -> None:
    cache = JudgmentCache(tmp_path)
    batch = JudgeBatch(
        outcomes=[_outcome("claims_supported", 0.5, passed=True)],
        usage=JudgeUsage(input_tokens=7),
    )
    assert cache.get("missing") is None
    cache.put("key1", batch)
    loaded = cache.get("key1")
    assert loaded is not None
    assert loaded.outcomes[0].criterion_id == "claims_supported"
    assert loaded.outcomes[0].normalized == pytest.approx(0.5)
    assert loaded.usage.input_tokens == 7


def test_judgment_cache_ignores_corrupt_entries(tmp_path: Path) -> None:
    cache = JudgmentCache(tmp_path)
    (tmp_path / "bad.json").write_text("{not json", encoding="utf-8")
    assert cache.get("bad") is None


# -------------------------------------------------------------- judge guard


def test_jev_judge_requires_a_key() -> None:
    with pytest.raises(ValueError, match="JEV_API_KEY"):
        JevJudge(api_key="")
    assert JevJudge(api_key="k", model="jev-latest").judge_id == "jev:jev-latest"


def test_chat_judge_requires_key_and_model() -> None:
    with pytest.raises(ValueError):
        ChatJudge(base_url="http://judge.test/v1", api_key="", model="m")
    with pytest.raises(ValueError):
        ChatJudge(base_url="http://judge.test/v1", api_key="k", model="")


# ---------------------------------------------------------------- service


async def test_service_weights_criteria_and_respects_the_threshold() -> None:
    rubric = _rubric([_noul_spec("a", weight=3), _noul_spec("b", weight=1)], threshold=0.8)
    judge = FakeJudge({"a": 1.0, "b": 0.0})
    result = await JudgeService(judge=judge).evaluate_case(
        rubric=rubric, case_id="case-1", tags=[], state={}, deterministic=[]
    )
    assert result.score == pytest.approx(0.75)
    assert result.passed is False
    assert result.judge_confidence == pytest.approx(0.9)


async def test_service_marks_a_strong_case_passed() -> None:
    rubric = _rubric([_noul_spec("claims_supported")], threshold=0.8)
    judge = FakeJudge({"claims_supported": 0.9})
    result = await JudgeService(judge=judge).evaluate_case(
        rubric=rubric, case_id="case-1", tags=[], state={}, deterministic=[]
    )
    assert result.score == pytest.approx(0.9)
    assert result.passed is True
    assert result.error is None
    assert result.usage.input_tokens == 10


async def test_service_forces_failure_when_a_deterministic_check_fails() -> None:
    rubric = _rubric(
        [
            CriterionSpec(id="citations_resolve", kind="deterministic", weight=1.0),
            _noul_spec("claims_supported", weight=1.0),
        ],
        threshold=0.5,
    )
    judge = FakeJudge({"claims_supported": 1.0})
    failed = _outcome("citations_resolve", 0.0, source="deterministic", passed=False)
    result = await JudgeService(judge=judge).evaluate_case(
        rubric=rubric, case_id="case-1", tags=[], state={}, deterministic=[failed]
    )
    assert judge.seen_ids == ["claims_supported"]
    assert result.score == pytest.approx(0.5)
    assert result.passed is False


async def test_service_skips_criteria_that_do_not_apply_to_the_tags() -> None:
    rubric = _rubric(
        [
            _noul_spec("claims_supported"),
            _noul_spec("avoids_unfounded_answer", applies_to_tags=["escalation"]),
        ]
    )
    judge = FakeJudge({"claims_supported": 1.0, "avoids_unfounded_answer": 0.0})
    plain = await JudgeService(judge=judge).evaluate_case(
        rubric=rubric, case_id="case-1", tags=[], state={}, deterministic=[]
    )
    assert judge.seen_ids == ["claims_supported"]
    assert plain.score == pytest.approx(1.0)
    assert plain.passed is True
    tagged = await JudgeService(judge=judge).evaluate_case(
        rubric=rubric, case_id="case-2", tags=["escalation"], state={}, deterministic=[]
    )
    assert judge.seen_ids == ["claims_supported", "avoids_unfounded_answer"]
    assert tagged.score == pytest.approx(0.5)
    assert tagged.passed is False


async def test_service_turns_a_judge_fault_into_a_failed_case() -> None:
    rubric = _rubric([_noul_spec("claims_supported")], threshold=0.5)
    result = await JudgeService(judge=FakeJudge({}, fail=True)).evaluate_case(
        rubric=rubric, case_id="case-1", tags=[], state={}, deterministic=[]
    )
    assert result.passed is False
    assert result.error is not None
    assert "judge unavailable" in result.error
    assert all(item.passed is False for item in result.outcomes)


async def test_service_reuses_cached_judgments(tmp_path: Path) -> None:
    rubric = _rubric([_noul_spec("claims_supported")], threshold=0.5)
    judge = FakeJudge({"claims_supported": 1.0})
    service = JudgeService(judge=judge, cache=JudgmentCache(tmp_path))
    first = await service.evaluate_case(
        rubric=rubric, case_id="case-1", tags=[], state={"answer": "x"}, deterministic=[]
    )
    second = await service.evaluate_case(
        rubric=rubric, case_id="case-1", tags=[], state={"answer": "x"}, deterministic=[]
    )
    assert judge.calls == 1
    assert first.score == second.score == pytest.approx(1.0)


# -------------------------------------------------------------- aggregation


def test_aggregate_suite_computes_metrics() -> None:
    case_one = _case(
        "case-1",
        0.8,
        [
            _outcome("claims_supported", 0.6, confidence=0.8),
            _outcome("citations_resolve", 1.0, source="deterministic"),
        ],
        passed=True,
        judge_confidence=0.8,
    )
    case_two = _case(
        "case-2",
        0.75,
        [_outcome("claims_supported", 1.0), _outcome("avoids_unfounded_answer", 0.5)],
        tags=["escalation"],
        passed=True,
    )
    case_three = _case(
        "case-3",
        0.5,
        [_outcome("claims_supported", 0.4), _outcome("injection_resisted", 0.25)],
        tags=["injection"],
        passed=False,
    )
    report = aggregate_suite(
        suite="hr-help",
        rubric=_rubric([_noul_spec("claims_supported")]),
        judge_id="fake:v1",
        generated_at="2026-09-28T00:00:00+00:00",
        results=[case_one, case_two, case_three],
        usage=JudgeUsage(input_tokens=42),
    )
    assert report.score == pytest.approx((0.8 + 0.75 + 0.5) / 3)
    assert report.pass_rate == pytest.approx(2 / 3)
    assert report.means["claims_supported"] == pytest.approx((0.6 + 1.0 + 0.4) / 3)
    assert report.unsupported_claim_rate == pytest.approx(1.0 - (0.6 + 1.0 + 0.4) / 3)
    assert report.escalation_correct_rate == pytest.approx(0.5)
    assert report.injection_resistance_rate == pytest.approx(0.25)
    assert report.judge_confidence_mean == pytest.approx(0.8)
    assert report.usage.input_tokens == 42


def test_aggregate_suite_omits_tagged_metrics_without_tags() -> None:
    case = _case("case-1", 0.9, [_outcome("claims_supported", 0.9)], passed=True)
    report = aggregate_suite(
        suite="hr-help",
        rubric=_rubric([_noul_spec("claims_supported")]),
        judge_id="fake:v1",
        generated_at="2026-09-28T00:00:00+00:00",
        results=[case],
        usage=JudgeUsage(),
    )
    assert report.escalation_correct_rate is None
    assert report.injection_resistance_rate is None
    assert report.judge_confidence_mean is None


# ------------------------------------------------------------------- gate


def test_gate_passes_on_identical_reports() -> None:
    case = _case("case-1", 0.9, [], passed=True)
    verdict = compare_with_baseline(_report(0.9, [case]), _report(0.9, [case]), [])
    assert verdict.passed is True
    assert verdict.regressions == []


def test_gate_fails_on_a_mean_drop_beyond_tolerance() -> None:
    baseline = _report(0.9, [_case("case-1", 0.9, [], passed=True)])
    current = _report(0.75, [_case("case-1", 0.75, [], passed=True)])
    verdict = compare_with_baseline(current, baseline, [])
    assert verdict.passed is False
    assert any(line.startswith("suite mean dropped") for line in verdict.regressions)
    assert len(verdict.regressions) == 1


def test_gate_fails_on_a_case_drop_and_honors_waivers() -> None:
    baseline = _report(0.75, [_case("case-1", 0.9, [], passed=True)])
    current = _report(0.75, [_case("case-1", 0.5, [], passed=False)])
    verdict = compare_with_baseline(current, baseline, [])
    assert verdict.passed is False
    assert any("case-1" in line and "waivable" in line for line in verdict.regressions)
    waivers = [{"suite": "hr-help", "caseId": "case-1", "reason": "tracked flake"}]
    assert compare_with_baseline(current, baseline, waivers).passed is True


def test_gate_fails_on_judge_errors_even_without_regressions() -> None:
    case = _case("case-1", 0.9, [], passed=False, error="RuntimeError: judge unavailable")
    baseline = _report(0.9, [_case("case-1", 0.9, [], passed=True)])
    verdict = compare_with_baseline(_report(0.9, [case]), baseline, [])
    assert verdict.passed is False
    assert verdict.regressions == []


def test_failure_lines_summarize_unpassed_outcomes() -> None:
    case = _case(
        "case-1",
        0.3,
        [
            _outcome("claims_supported", 0.2, passed=False),
            _outcome("citations_resolve", 1.0, source="deterministic"),
        ],
        passed=False,
    )
    lines = failure_lines(case)
    assert "case-1" in lines[0]
    assert any("claims_supported" in line for line in lines)
    assert not any("citations_resolve" in line for line in lines)


# ------------------------------------------------------------ calibration


def test_calibrate_matches_agreement_and_buckets() -> None:
    case1 = _case(
        "case-1",
        0.9,
        [_outcome("claims_supported", 1.0, passed=True, confidence=0.99)],
        passed=True,
    )
    case2 = _case(
        "case-2",
        0.5,
        [_outcome("completeness_vs_points", 0.2, passed=False, confidence=0.8)],
        passed=False,
    )
    case3 = _case(
        "case-3",
        0.4,
        [_outcome("claims_supported", 0.1, passed=False, confidence=0.7)],
        passed=False,
    )
    case4 = _case(
        "case-4",
        0.9,
        [_outcome("claims_supported", 1.0, passed=True, confidence=0.99)],
        passed=True,
    )
    labels = [
        HumanLabel(case_id="case-1", criterion_id="claims_supported", human=True),
        HumanLabel(case_id="case-2", criterion_id="completeness_vs_points", human=True),
        HumanLabel(case_id="case-3", criterion_id="claims_supported", human=False),
        HumanLabel(case_id="case-4", criterion_id="claims_supported", human=None),
    ]
    report = calibrate(labels, [_report(0.675, [case1, case2, case3, case4])])
    assert report.judge_id == "fake:v1"
    assert report.labeled == 3
    assert report.pending == 1
    assert report.agreement == pytest.approx(2 / 3)
    assert report.per_criterion["claims_supported"] == pytest.approx(1.0)
    assert report.per_criterion["completeness_vs_points"] == pytest.approx(0.0)
    assert [bucket.count for bucket in report.buckets] == [1, 1, 1]
    # case-2 misses at confidence 0.8, case-3 matches at 0.7, case-1 at 0.99.
    assert report.expected_calibration_error == pytest.approx((0.8 + 0.3 + 0.01) / 3)


def test_calibrate_reports_pending_without_labels() -> None:
    case = _case(
        "case-1",
        0.9,
        [_outcome("claims_supported", 1.0, passed=True, confidence=0.9)],
        passed=True,
    )
    report = calibrate([], [_report(0.9, [case])])
    assert report.labeled == 0
    assert report.agreement is None
    assert report.expected_calibration_error is None
    assert report.buckets == []


def test_calibrate_skips_deterministic_outcomes() -> None:
    case = _case(
        "case-1",
        0.9,
        [
            _outcome("citations_resolve", 1.0, source="deterministic"),
            _outcome("claims_supported", 1.0, passed=True, confidence=0.9),
        ],
        passed=True,
    )
    labels = [
        HumanLabel(case_id="case-1", criterion_id="citations_resolve", human=True),
        HumanLabel(case_id="case-1", criterion_id="claims_supported", human=True),
    ]
    report = calibrate(labels, [_report(0.9, [case])])
    assert report.labeled == 1
    assert report.per_criterion == {"claims_supported": pytest.approx(1.0)}


# ---------------------------------------------------------------- chat judge


async def test_chat_judge_parses_fenced_json_and_usage() -> None:
    spec = _noul_spec("claims_supported")
    client = _transport(
        '```json\n{"claims_supported": {"value": 0.8, "reason": "supported"}}\n```',
        usage={"prompt_tokens": 120, "completion_tokens": 15},
    )
    judge = ChatJudge(
        base_url="http://judge.test/v1", api_key="k", model="judge-model", client=client
    )
    try:
        batch = await judge.score([spec], {"answer": "x"})
    finally:
        await client.aclose()
    assert judge.judge_id == "chat:judge-model:judge-chat-v1"
    assert batch.outcomes[0].normalized == pytest.approx(0.8)
    assert batch.outcomes[0].passed is True
    assert batch.outcomes[0].detail == "supported"
    assert batch.usage.input_tokens == 120
    assert batch.usage.output_tokens == 15


async def test_chat_judge_fails_omitted_criteria() -> None:
    spec = _noul_spec("claims_supported")
    client = _transport('{"other": {"value": 1}}')
    judge = ChatJudge(base_url="http://judge.test/v1", api_key="k", model="m", client=client)
    try:
        batch = await judge.score([spec], {})
    finally:
        await client.aclose()
    assert batch.outcomes[0].passed is False
    assert "omitted" in batch.outcomes[0].detail


async def test_chat_judge_reads_choice_values() -> None:
    spec = CriterionSpec(
        id="severity_label",
        kind="choice",
        instructions="Pick the severity label.",
        options={"low": "low impact", "high": "high impact"},
        pass_options=["low"],
    )
    client = _transport('{"severity_label": {"value": "low", "reason": "contained"}}')
    judge = ChatJudge(base_url="http://judge.test/v1", api_key="k", model="m", client=client)
    try:
        batch = await judge.score([spec], {})
    finally:
        await client.aclose()
    assert batch.outcomes[0].passed is True
    assert batch.outcomes[0].detail == "contained"


async def test_chat_judge_clamps_values_over_one() -> None:
    spec = _noul_spec("claims_supported")
    client = _transport('{"claims_supported": {"value": 1.5, "reason": ""}}')
    judge = ChatJudge(base_url="http://judge.test/v1", api_key="k", model="m", client=client)
    try:
        batch = await judge.score([spec], {})
    finally:
        await client.aclose()
    assert batch.outcomes[0].normalized == pytest.approx(1.0)


async def test_chat_judge_rejects_unreadable_values() -> None:
    spec = _noul_spec("claims_supported")
    client = _transport('{"claims_supported": {"value": "mostly", "reason": ""}}')
    judge = ChatJudge(base_url="http://judge.test/v1", api_key="k", model="m", client=client)
    try:
        with pytest.raises(ValueError):
            await judge.score([spec], {})
    finally:
        await client.aclose()


async def test_chat_judge_explainer_is_best_effort() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    judge = ChatJudge(base_url="http://judge.test/v1", api_key="k", model="m", client=client)
    try:
        assert await judge.explain(["case-1 failed"]) == ""
    finally:
        await client.aclose()


def test_chat_prompt_carries_criteria_and_state() -> None:
    prompt = build_chat_prompt([_noul_spec("claims_supported")], {"answer": "hello"})
    assert "claims_supported" in prompt
    assert '"answer": "hello"' in prompt


def test_chat_prompt_accepts_a_versioned_preamble() -> None:
    prompt = build_chat_prompt(
        [_noul_spec("claims_supported")], {}, preamble="Custom rubric line."
    )
    assert prompt.startswith("Custom rubric line.")
    assert "claims_supported" in prompt


# ------------------------------------------------------------------ settings


def test_judge_settings_have_safe_defaults() -> None:
    from allrounder_api.settings import Settings

    settings = Settings(webhook_secret="test", _env_file=None)
    assert settings.judge_provider == "jev"
    assert settings.judge_model == "jev-latest"
    assert settings.jev_api_key.get_secret_value() == ""
    assert settings.judge_chat_model == ""
