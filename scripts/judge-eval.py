"""Judge eval CLI: produce, judge and gate the judge suites.

Produce drives the real API (POST /runs, polling, proceed decisions) and
records candidate outputs under ``evals/judge/candidates/``. Judge scores the
candidates with the rubric-based judge (Jev by default) plus deterministic
checks and writes a report under ``evals/judge/reports/``. Gate compares the
latest report against the committed baseline and fails on regression.

Exit codes: 0 pass or clean skip, 1 gate regression, 2 configuration error.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
import time
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from allrounder_api.judging import (
    CaseResult,
    ChatJudge,
    CriterionOutcome,
    CriterionSpec,
    HumanLabel,
    JevJudge,
    JudgeBatch,
    JudgeClient,
    JudgeService,
    JudgeUsage,
    JudgmentCache,
    SuiteReport,
    aggregate_suite,
    calibrate,
    compare_with_baseline,
    failure_lines,
    hr_deterministic_outcomes,
    hr_draft_from_artifacts,
    hr_state,
    load_jsonl,
    load_policy_corpus,
    load_rubric,
    resolve_citation,
    security_deterministic_outcomes,
    security_output_from_artifacts,
    security_state,
    write_jsonl,
)
from allrounder_api.settings import Settings

ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = ROOT / "evals" / "judge"
RUBRIC_DIR = EVAL_DIR / "rubrics"
CASE_DIR = EVAL_DIR / "cases"
CANDIDATE_DIR = EVAL_DIR / "candidates"
BASELINE_DIR = EVAL_DIR / "baselines"
REPORT_DIR = EVAL_DIR / "reports"
CACHE_DIR = EVAL_DIR / ".cache"
PROMPT_FILE = EVAL_DIR / "prompts" / "judge-chat-v1.txt"
WAIVER_FILE = EVAL_DIR / "waivers.json"
LABEL_FILE = EVAL_DIR / "human_labels.jsonl"
POLICY_DIR = ROOT / "fixtures" / "hr_policy"
SECURITY_CORPORA = (
    ("injection", ROOT / "evals" / "security_injection_corpus.jsonl"),
    ("false-positive", ROOT / "evals" / "security_fp_corpus.jsonl"),
)

SUITES = ("hr-help", "security-triage")
WORKFLOWS = {"hr-help": "hr-help", "security-triage": "security"}
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


class ConfigError(Exception):
    """Missing or invalid eval configuration; ``skip`` softens auto mode."""

    def __init__(self, message: str, *, skip: bool = False) -> None:
        super().__init__(message)
        self.skip = skip


class FakeJudge:
    """Offline stand-in judge: everything passes; proves the pipeline only."""

    judge_id = "fake:v1"

    async def score(
        self, criteria: Sequence[CriterionSpec], state: Mapping[str, Any]
    ) -> JudgeBatch:
        return JudgeBatch(
            outcomes=[
                CriterionOutcome(
                    criterion_id=spec.id,
                    source="judge",
                    normalized=1.0,
                    passed=True,
                    detail="fake judge",
                    confidence=0.9,
                )
                for spec in criteria
            ]
        )


# --------------------------------------------------------------- case loading


def load_cases(suite: str) -> list[dict[str, Any]]:
    if suite == "hr-help":
        return load_jsonl(CASE_DIR / "hr_help_cases.jsonl")
    cases: list[dict[str, Any]] = []
    for tag, path in SECURITY_CORPORA:
        for record in load_jsonl(path):
            cases.append(
                {
                    "caseId": str(record["id"]),
                    "ticketKey": str(record["ticketKey"]),
                    "tags": [tag],
                    "input": record["input"],
                    "expect": record["expect"],
                }
            )
    return cases


def expand(suite: str) -> tuple[str, ...]:
    return SUITES if suite == "all" else (suite,)


# ------------------------------------------------------------------- produce


def resolve_token() -> str:
    token = os.environ.get("JUDGE_EVAL_TOKEN", "").strip()
    if token:
        return token
    base_url = (
        os.environ.get("JUDGE_EVAL_SUPABASE_URL") or os.environ.get("SUPABASE_URL") or ""
    ).strip()
    anon_key = (
        os.environ.get("JUDGE_EVAL_SUPABASE_ANON_KEY")
        or os.environ.get("SUPABASE_PUBLISHABLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or ""
    ).strip()
    email = os.environ.get("JUDGE_EVAL_EMAIL", "").strip()
    password = os.environ.get("JUDGE_EVAL_PASSWORD", "").strip()
    if not (base_url and anon_key and email and password):
        raise ConfigError(
            "produce auth is not configured: set JUDGE_EVAL_TOKEN, or JUDGE_EVAL_EMAIL "
            "and JUDGE_EVAL_PASSWORD together with SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY"
        )
    response = httpx.post(
        f"{base_url.rstrip('/')}/auth/v1/token",
        params={"grant_type": "password"},
        headers={"apikey": anon_key},
        json={"email": email, "password": password},
        timeout=30.0,
    )
    response.raise_for_status()
    access_token = str(response.json().get("access_token", ""))
    if not access_token:
        raise ConfigError("the Supabase password grant returned no access token")
    return access_token


def approved_signer_patch(
    snapshot: Mapping[str, Any], step_id: str
) -> list[dict[str, Any]] | None:
    """The approve step's signers, approved, for a security signer edit.

    The contain gate requires every matrix signer to be approved, which the
    approval console records by editing the artifact. Returns None when the
    step has no signer chain or every signer is already approved.
    """
    steps = snapshot.get("steps")
    if not isinstance(steps, list):
        return None
    for step in steps:
        if not isinstance(step, dict) or step.get("stepId") != step_id:
            continue
        artifact = step.get("artifact")
        if not isinstance(artifact, dict):
            return None
        signers = artifact.get("signers")
        if not isinstance(signers, list) or not signers:
            return None
        if all(
            isinstance(signer, dict)
            and signer.get("state") == "approved"
            and signer.get("approvedAt") is not None
            for signer in signers
        ):
            return None
        approved_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        return [
            {
                "role": signer.get("role"),
                "name": signer.get("name"),
                "state": "approved",
                "approvedAt": approved_at,
                "comment": signer.get("comment") or "Approved in review.",
            }
            for signer in signers
            if isinstance(signer, dict)
        ]
    return None


async def drive_case(
    client: httpx.AsyncClient,
    api_url: str,
    headers: Mapping[str, str],
    suite: str,
    workflow: str,
    case: Mapping[str, Any],
    run_timeout: float,
    poll_interval: float,
) -> dict[str, Any]:
    started = time.monotonic()
    # The case store keys events by uuid, so the case is opened first and its
    # server-assigned id is used for the run (reports keep the readable id).
    opened = await client.post(
        f"{api_url}/cases",
        headers=dict(headers),
        json={"ticketKey": str(case["ticketKey"])},
    )
    opened.raise_for_status()
    store_case_id = str(opened.json().get("caseId", ""))
    run_input = {"question": case["question"]} if workflow == "hr-help" else case["input"]
    start = await client.post(
        f"{api_url}/runs",
        headers=dict(headers),
        json={
            "workflow": workflow,
            "ticketKey": case["ticketKey"],
            "caseId": store_case_id,
            "input": run_input,
        },
    )
    start.raise_for_status()
    snapshot: dict[str, Any] = start.json()
    run_id = str(snapshot.get("runId", ""))
    decisions = 0
    last_unlock_attempt = 0.0
    poll_timed_out = False
    try:
        while str(snapshot.get("status", "")) not in TERMINAL_STATUSES:
            if time.monotonic() - started > run_timeout:
                raise TimeoutError(f"run {run_id} did not finish within {run_timeout:.0f}s")
            if not poll_timed_out and snapshot.get("status") == "awaiting_human":
                step_id = str(snapshot.get("currentStepId") or "")
                payload: dict[str, Any] = {"action": "proceed"}
                if workflow == "security" and step_id == "approve":
                    signer_patch = approved_signer_patch(snapshot, step_id)
                    if signer_patch is not None:
                        payload = {
                            "action": "edit",
                            "edits": {"signers": signer_patch, "allApproved": True},
                        }
                try:
                    decision = await client.post(
                        f"{api_url}/runs/{run_id}/steps/{step_id}/decision",
                        headers=dict(headers),
                        json=payload,
                    )
                    if decision.status_code != 409:
                        decision.raise_for_status()
                        decisions += 1
                except httpx.TimeoutException:
                    # The decision resumes the workflow, and the reply arrives
                    # only once the next step settles. A slow step can hold the
                    # reply past the client timeout even though the decision
                    # itself was recorded, so keep waiting instead of
                    # abandoning an attempt that is merely slow.
                    poll_timed_out = True
            elif (
                not poll_timed_out
                and snapshot.get("status") == "blocked"
                and time.monotonic() - last_unlock_attempt > 10
            ):
                # A stale target lock (e.g. a previous failed run) parks the run;
                # retry_lock heals it once the lock is free.
                last_unlock_attempt = time.monotonic()
                step_id = str(snapshot.get("currentStepId") or "")
                try:
                    await client.post(
                        f"{api_url}/runs/{run_id}/steps/{step_id}/decision",
                        headers=dict(headers),
                        json={"action": "retry_lock"},
                    )
                except httpx.TimeoutException:
                    # Same slow-resume case as the proceed decision above.
                    poll_timed_out = True
            poll_timed_out = False
            await asyncio.sleep(poll_interval)
            try:
                poll = await client.get(f"{api_url}/runs/{run_id}", headers=dict(headers))
                poll.raise_for_status()
                snapshot = poll.json()
            except httpx.TimeoutException:
                # A slow step can hold the run endpoint past the client timeout.
                # The run is still live, so keep waiting inside the case budget
                # instead of abandoning an attempt that is merely slow.
                poll_timed_out = True
    except Exception:
        # A live run left behind by a failed attempt keeps its target lock and
        # parks the retry as blocked, so the attempt cancels its own run first.
        with contextlib.suppress(httpx.HTTPError):
            await client.post(
                f"{api_url}/runs/{run_id}/cancel",
                headers=dict(headers),
                json={"reason": "produce attempt failed"},
            )
        raise
    artifacts: dict[str, Any] = {}
    steps = snapshot.get("steps")
    if isinstance(steps, list):
        for step in steps:
            if isinstance(step, dict) and step.get("artifact") is not None:
                artifacts[str(step.get("stepId"))] = step["artifact"]
    return {
        "caseId": str(case["caseId"]),
        "storeCaseId": store_case_id,
        "suite": suite,
        "workflow": workflow,
        "ticketKey": str(case["ticketKey"]),
        "runId": run_id,
        "status": str(snapshot.get("status", "")),
        "outcome": snapshot.get("outcome"),
        "artifacts": artifacts,
        "decisions": decisions,
        "latencySeconds": round(time.monotonic() - started, 2),
        "collectedAt": datetime.now(UTC).isoformat(),
        "error": None,
    }


def failed_record(
    suite: str, workflow: str, case: Mapping[str, Any], reason: str
) -> dict[str, Any]:
    return {
        "caseId": str(case["caseId"]),
        "storeCaseId": None,
        "suite": suite,
        "workflow": workflow,
        "ticketKey": str(case["ticketKey"]),
        "runId": None,
        "status": "produce-error",
        "outcome": None,
        "artifacts": {},
        "decisions": 0,
        "latencySeconds": None,
        "collectedAt": datetime.now(UTC).isoformat(),
        "error": reason,
    }


async def produce_suite(
    client: httpx.AsyncClient,
    suite: str,
    api_url: str,
    headers: Mapping[str, str],
    limit: int | None,
    run_timeout: float,
    poll_interval: float,
) -> None:
    cases = load_cases(suite)
    if limit is not None:
        cases = cases[:limit]
    workflow = WORKFLOWS[suite]
    records: list[dict[str, Any]] = []
    for case in cases:
        record: dict[str, Any] | None = None
        for attempt in (1, 2):
            try:
                record = await drive_case(
                    client, api_url, headers, suite, workflow, case, run_timeout, poll_interval
                )
                outcome = str(record.get("outcome") or "")
                if record["status"] == "failed" and (
                    "Mastra request failed" in outcome
                    or "RemoteProtocolError" in outcome
                    or "produced unsourced claims" in outcome
                ):
                    # Transient Mastra/pg disconnects and claim-span slop from
                    # the lane model are produce flakes, not lane behaviour, so
                    # they are retried instead of recorded.
                    raise RuntimeError(outcome)
                break
            except Exception as error:  # noqa: BLE001 - recorded per case and retried once
                reason = f"{type(error).__name__}: {error}"
                if attempt == 2:
                    record = failed_record(suite, workflow, case, reason)
        if record is None:  # pragma: no cover - the loop always assigns on attempt 2
            record = failed_record(suite, workflow, case, "no attempt ran")
        records.append(record)
        outcome = str(record["status"]) if record["error"] is None else "error"
        print(f"  {suite}: {record['caseId']} -> {outcome}")
    path = CANDIDATE_DIR / f"{suite}.jsonl"
    write_jsonl(path, records)
    print(f"{suite}: wrote {len(records)} candidate(s) to {path}")


async def run_produce(
    suite: str, api_url: str, limit: int | None, run_timeout: float, poll_interval: float
) -> int:
    token = resolve_token()
    api_url = api_url.rstrip("/")
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0)) as client:
        for name in expand(suite):
            print(f"producing {name} against {api_url}")
            await produce_suite(client, name, api_url, headers, limit, run_timeout, poll_interval)
    return 0


# --------------------------------------------------------------------- judge


def load_settings() -> Settings:
    env_file = ROOT / ".env"
    if env_file.exists():
        return Settings(_env_file=env_file)
    return Settings()


def read_prompt_preamble() -> str | None:
    if not PROMPT_FILE.exists():
        return None
    text = PROMPT_FILE.read_text(encoding="utf-8").strip()
    return text or None


def build_judge(name: str) -> tuple[JudgeClient, ChatJudge | None]:
    settings = load_settings()
    preamble = read_prompt_preamble()
    timeout = settings.judge_timeout_seconds
    if name == "fake":
        return FakeJudge(), None
    if name == "chat" or (name == "auto" and settings.judge_provider == "chat"):
        api_key = settings.judge_chat_api_key.get_secret_value()
        if not settings.judge_chat_model or not api_key:
            raise ConfigError(
                "the chat judge needs JUDGE_CHAT_MODEL and JUDGE_CHAT_API_KEY",
                skip=name == "auto",
            )
        judge = ChatJudge(
            base_url=settings.judge_chat_base_url,
            api_key=api_key,
            model=settings.judge_chat_model,
            preamble=preamble,
            timeout=timeout,
        )
        return judge, judge
    api_key = settings.jev_api_key.get_secret_value()
    if not api_key:
        raise ConfigError("JEV_API_KEY is not set", skip=name == "auto")
    judge = JevJudge(api_key=api_key, model=settings.judge_model, timeout=timeout)
    chat_key = settings.judge_chat_api_key.get_secret_value()
    explainer: ChatJudge | None = None
    if settings.judge_chat_model and chat_key:
        explainer = ChatJudge(
            base_url=settings.judge_chat_base_url,
            api_key=chat_key,
            model=settings.judge_chat_model,
            preamble=preamble,
            timeout=timeout,
        )
    return judge, explainer


def sum_usage(results: Sequence[CaseResult]) -> JudgeUsage:
    return JudgeUsage(
        input_tokens=sum(result.usage.input_tokens for result in results),
        output_tokens=sum(result.usage.output_tokens for result in results),
        cost_usd=sum(result.usage.cost_usd for result in results),
        latency_seconds=sum(result.usage.latency_seconds for result in results),
    )


def write_report(suite: str, report: SuiteReport, explanations: Mapping[str, str]) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    payload = report.model_dump(mode="json")
    payload["explanations"] = dict(explanations)
    path = REPORT_DIR / f"{suite}-latest.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


async def judge_suite(suite: str, judge_name: str, limit: int | None) -> SuiteReport:
    rubric = load_rubric(RUBRIC_DIR / f"{suite}.json")
    cases = {str(case["caseId"]): case for case in load_cases(suite)}
    candidate_path = CANDIDATE_DIR / f"{suite}.jsonl"
    if not candidate_path.exists():
        raise ConfigError(f"no candidates for {suite}: run produce first ({candidate_path})")
    candidates = load_jsonl(candidate_path)
    if limit is not None:
        candidates = candidates[:limit]
    corpus = load_policy_corpus(POLICY_DIR) if suite == "hr-help" else {}
    judge, explainer = build_judge(judge_name)
    service = JudgeService(judge=judge, cache=JudgmentCache(CACHE_DIR))
    results: list[CaseResult] = []
    try:
        for candidate in candidates:
            case_id = str(candidate.get("caseId", ""))
            case = cases.get(case_id)
            if case is None:
                raise ConfigError(f"candidate {case_id!r} has no case definition")
            tags = [str(tag) for tag in case.get("tags", [])]
            error = candidate.get("error")
            if error:
                results.append(
                    CaseResult(
                        case_id=case_id,
                        suite=suite,
                        score=0.0,
                        passed=False,
                        tags=tags,
                        error=str(error),
                    )
                )
                continue
            raw_artifacts = candidate.get("artifacts")
            artifacts: Mapping[str, Mapping[str, Any]] = (
                raw_artifacts if isinstance(raw_artifacts, dict) else {}
            )
            if suite == "hr-help":
                answer, citations = hr_draft_from_artifacts(artifacts)
                resolved = [resolve_citation(item, corpus) for item in citations]
                deterministic = hr_deterministic_outcomes(
                    tags=tags, answer=answer, citations=citations, resolved=resolved
                )
                state = hr_state(
                    question=str(case["question"]),
                    answer=answer,
                    resolved=resolved,
                    expected_points=[str(point) for point in case.get("expectedPoints", [])],
                )
            else:
                output = security_output_from_artifacts(artifacts)
                deterministic = security_deterministic_outcomes(
                    output=output, expect=case["expect"]
                )
                state = security_state(alert=case["input"], expect=case["expect"], output=output)
            result = await service.evaluate_case(
                rubric=rubric,
                case_id=case_id,
                tags=tags,
                state=state,
                deterministic=deterministic,
            )
            results.append(result)
            mark = "pass" if result.passed else "fail"
            print(f"  {suite}: {case_id} -> {result.score:.2f} {mark}")
        report = aggregate_suite(
            suite=suite,
            rubric=rubric,
            judge_id=judge.judge_id,
            generated_at=datetime.now(UTC).isoformat(),
            results=results,
            usage=sum_usage(results),
        )
        explanations: dict[str, str] = {}
        failed = [
            result for result in results if not result.passed and result.error is None
        ]
        if explainer is not None and failed:
            for result in failed:
                text = await explainer.explain(failure_lines(result))
                if text:
                    explanations[result.case_id] = text
        write_report(suite, report, explanations)
        return report
    finally:
        if isinstance(judge, ChatJudge):
            await judge.aclose()
        if explainer is not None and explainer is not judge:
            await explainer.aclose()


def print_summary(report: SuiteReport) -> None:
    def fmt(value: float | None, digits: int = 3) -> str:
        return "n/a" if value is None else f"{value:.{digits}f}"

    failed = [case.case_id for case in report.cases if not case.passed]
    print()
    print(f"## {report.suite}")
    print(f"- judge: {report.judge_id} (rubric v{report.rubric_version})")
    print(f"- score: {report.score:.3f} | pass rate: {report.pass_rate:.0%}")
    print(
        f"- unsupported claims: {fmt(report.unsupported_claim_rate)} | "
        f"escalation correct: {fmt(report.escalation_correct_rate)} | "
        f"injection resisted: {fmt(report.injection_resistance_rate)}"
    )
    print(f"- judge confidence mean: {fmt(report.judge_confidence_mean)}")
    print(
        f"- usage: {report.usage.input_tokens} in / {report.usage.output_tokens} out tokens, "
        f"${report.usage.cost_usd:.4f}, {report.usage.latency_seconds:.1f}s"
    )
    if failed:
        print(f"- failed cases: {', '.join(failed)}")


async def run_judge(suite: str, judge_name: str, limit: int | None) -> int:
    for name in expand(suite):
        report = await judge_suite(name, judge_name, limit)
        print_summary(report)
    return 0


# ---------------------------------------------------------------------- gate


def load_waivers(suite: str) -> list[dict[str, Any]]:
    if not WAIVER_FILE.exists():
        return []
    parsed = json.loads(WAIVER_FILE.read_text(encoding="utf-8"))
    if not isinstance(parsed, list):
        raise ConfigError("waivers.json must be a JSON array")
    return [item for item in parsed if isinstance(item, dict) and item.get("suite") == suite]


async def run_gate_suite(
    suite: str, judge_name: str, limit: int | None, write_baseline: bool, summary: bool
) -> int:
    report = await judge_suite(suite, judge_name, limit)
    if summary:
        print_summary(report)
    baseline_path = BASELINE_DIR / f"{suite}.json"
    if write_baseline:
        BASELINE_DIR.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
        print(f"{suite}: baseline written to {baseline_path}")
        return 0
    if not baseline_path.exists():
        print(f"{suite}: no baseline committed yet (write one with gate --write-baseline)")
        return 0
    baseline = SuiteReport.model_validate_json(baseline_path.read_text(encoding="utf-8"))
    verdict = compare_with_baseline(report, baseline, load_waivers(suite))
    if verdict.passed:
        print(
            f"{suite}: gate passed (score {report.score:.3f} against baseline "
            f"{baseline.score:.3f})"
        )
        return 0
    print(f"{suite}: gate failed")
    for line in verdict.regressions:
        print(f"  regression: {line}")
    for case in report.cases:
        if case.error is not None:
            print(f"  judge error: {case.case_id}: {case.error}")
    return 1


async def run_gate(
    suite: str, judge_name: str, limit: int | None, write_baseline: bool, summary: bool
) -> int:
    codes = [
        await run_gate_suite(name, judge_name, limit, write_baseline, summary)
        for name in expand(suite)
    ]
    return 1 if any(code == 1 for code in codes) else 0


# --------------------------------------------------------------- calibration


def load_labels() -> list[HumanLabel]:
    if not LABEL_FILE.exists():
        return []
    labels: list[HumanLabel] = []
    for record in load_jsonl(LABEL_FILE):
        labels.append(
            HumanLabel(
                case_id=str(record.get("caseId", "")),
                criterion_id=str(record.get("criterionId", "")),
                human=record.get("human"),
                note=str(record.get("note", "")),
            )
        )
    return labels


def latest_reports(suite: str) -> list[SuiteReport]:
    reports: list[SuiteReport] = []
    for name in expand(suite):
        path = REPORT_DIR / f"{name}-latest.json"
        if not path.exists():
            raise ConfigError(f"no report for {name}: run judge first (missing {path.name})")
        reports.append(SuiteReport.model_validate_json(path.read_text(encoding="utf-8")))
    return reports


def write_label_template(reports: Sequence[SuiteReport]) -> None:
    """Write the human label skeleton, keeping any verdicts already filled in."""
    existing = {(label.case_id, label.criterion_id): label for label in load_labels()}
    lines: list[dict[str, Any]] = []
    for report in reports:
        for case in report.cases:
            for outcome in case.outcomes:
                if outcome.source != "judge" or outcome.confidence is None:
                    continue
                prior = existing.get((case.case_id, outcome.criterion_id))
                lines.append(
                    {
                        "caseId": case.case_id,
                        "criterionId": outcome.criterion_id,
                        "human": None if prior is None else prior.human,
                        "note": "" if prior is None else prior.note,
                    }
                )
    write_jsonl(LABEL_FILE, lines)
    filled = sum(1 for line in lines if line["human"] is not None)
    print(f"{LABEL_FILE}: {len(lines)} label(s), {filled} filled")


def run_calibrate(suite: str, template: bool) -> int:
    reports = latest_reports(suite)
    if template:
        write_label_template(reports)
        return 0
    report = calibrate(load_labels(), reports)
    if report.labeled == 0:
        print(f"calibration pending: {report.pending} label(s) still empty in {LABEL_FILE}")
        print("fill evals/judge/human_labels.jsonl, or seed it with calibrate --template")
        return 0
    print(
        f"calibration ({report.judge_id}): {report.labeled} labeled, "
        f"{report.pending} pending"
    )
    if report.agreement is not None:
        print(f"- agreement: {report.agreement:.1%}")
    if report.expected_calibration_error is not None:
        print(f"- expected calibration error: {report.expected_calibration_error:.3f}")
    for criterion_id, value in report.per_criterion.items():
        print(f"- {criterion_id}: {value:.1%} agreement")
    for bucket in report.buckets:
        print(
            f"- confidence [{bucket.low:.2f}, {bucket.high:.2f}): n={bucket.count} "
            f"accuracy={bucket.accuracy:.1%} mean={bucket.mean_confidence:.3f}"
        )
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / "calibration-latest.json"
    path.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    print(f"calibration written to {path}")
    return 0


# ---------------------------------------------------------------------- main


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="judge-eval.py", description="Judge eval harness: produce, judge, gate."
    )
    sub = parser.add_subparsers(dest="verb", required=True)
    produce_parser = sub.add_parser(
        "produce", help="drive the suites through the API and record candidates"
    )
    produce_parser.add_argument("--suite", choices=(*SUITES, "all"), default="all")
    produce_parser.add_argument("--api-url", default="http://localhost:8000")
    produce_parser.add_argument("--limit", type=int, default=None)
    produce_parser.add_argument("--timeout", type=float, default=600.0)
    produce_parser.add_argument("--poll-interval", type=float, default=2.0)
    judge_parser = sub.add_parser(
        "judge", help="score the recorded candidates and write a report"
    )
    judge_parser.add_argument("--suite", choices=(*SUITES, "all"), default="all")
    judge_parser.add_argument("--judge", choices=("auto", "jev", "chat", "fake"), default="auto")
    judge_parser.add_argument("--limit", type=int, default=None)
    gate_parser = sub.add_parser(
        "gate", help="judge the candidates and compare against the committed baseline"
    )
    gate_parser.add_argument("--suite", choices=(*SUITES, "all"), default="all")
    gate_parser.add_argument("--judge", choices=("auto", "jev", "chat", "fake"), default="auto")
    gate_parser.add_argument("--limit", type=int, default=None)
    gate_parser.add_argument("--summary", action="store_true")
    gate_parser.add_argument("--write-baseline", action="store_true")
    calibrate_parser = sub.add_parser(
        "calibrate", help="compare human labels with the latest judge reports"
    )
    calibrate_parser.add_argument("--suite", choices=(*SUITES, "all"), default="all")
    calibrate_parser.add_argument(
        "--template", action="store_true", help="write a human_labels.jsonl skeleton"
    )
    args = parser.parse_args(argv)
    try:
        if args.verb == "produce":
            return asyncio.run(
                run_produce(
                    args.suite, args.api_url, args.limit, args.timeout, args.poll_interval
                )
            )
        if args.verb == "judge":
            return asyncio.run(run_judge(args.suite, args.judge, args.limit))
        if args.verb == "calibrate":
            return run_calibrate(args.suite, args.template)
        return asyncio.run(
            run_gate(args.suite, args.judge, args.limit, args.write_baseline, args.summary)
        )
    except ConfigError as error:
        if error.skip:
            print(f"judge eval skipped: {error}")
            return 0
        print(f"configuration error: {error}", file=sys.stderr)
        return 2
    except httpx.HTTPError as error:
        print(f"API request failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
