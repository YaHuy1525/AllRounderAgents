"""Run infrastructure tests: parallel safety, ceilings, locks, idempotency, API."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner, ReceiptError
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.metrics import MetricsRegistry
from allrounder_api.repositories import (
    CaseRecord,
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
)
from allrounder_api.runs import (
    ACCESSIBILITY_WORKFLOW,
    DEPENDENCIES_WORKFLOW,
    FEATURES_WORKFLOW,
    HR_HELP_WORKFLOW,
    ISSUES_WORKFLOW,
    LEAVE_WORKFLOW,
    OFFBOARDING_WORKFLOW,
    ONBOARDING_WORKFLOW,
    SCREENING_WORKFLOW,
    SECURITY_WORKFLOW,
    VENDORS_WORKFLOW,
    WORKFLOW_DEFINITIONS,
    HttpMastraRunClient,
    MastraClientError,
    MastraOutcome,
    MemoryTargetLockStore,
    RunConflictError,
    RunService,
    RunServiceConfig,
    ScriptedMastraRunClient,
    UnknownWorkflowError,
    build_memory_run_service,
)
from allrounder_api.runs.mastra_client import ArtifactBuilder
from allrounder_api.runs.models import (
    PillRefError,
    RunStep,
    WorkflowRun,
    resolve_pill_text,
    resolve_pill_value,
    run_pills,
    run_snapshot,
    run_topology,
)
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = b"run-receipt-secret-for-tests-0123456789"
REVIEW_STEPS = ("select-pr", "review-options", "ai-review", "complete")
ISSUES_STEPS = ("issue-selection", "analysis", "implementation", "complete")
FEATURES_STEPS = ("feature-selection", "scope-design", "implementation", "complete")
DEPENDENCIES_STEPS = ("scan", "group", "apply", "validate", "merge")
ACCESSIBILITY_STEPS = ("crawl", "violations", "fix", "re-scan")
VENDORS_STEPS = ("collect", "verify", "risk-score", "approve", "create")
LEAVE_STEPS = ("intake", "policy-check", "approve", "apply")
ONBOARDING_STEPS = ("collect", "verify", "risk-score", "approve", "provision")
OFFBOARDING_STEPS = ("intake", "access-audit", "approve", "revoke", "attest")
SCREENING_STEPS = ("requisition", "screen", "shortlist", "schedule")
HR_HELP_STEPS = ("intake", "retrieve", "draft", "approve", "send")
SECURITY_STEPS = ("ingest", "triage", "investigate", "decide", "approve", "contain")
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))
VIEWER = Principal("user-2", "omnidewalt", frozenset({"viewer"}))
TENANT = "omnidewalt"


def review_client(
    builder: ArtifactBuilder | None = None,
    side_effecting: frozenset[str] = frozenset({"complete"}),
    fail_steps: frozenset[str] = frozenset(),
) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {"reviewFlow": REVIEW_STEPS},
        builder=builder,
        side_effecting=side_effecting,
        fail_steps=fail_steps,
    )


def issues_client(
    builder: ArtifactBuilder | None = None,
    side_effecting: frozenset[str] = frozenset({"complete"}),
    fail_steps: frozenset[str] = frozenset(),
) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {"issuesFlow": ISSUES_STEPS},
        builder=builder,
        side_effecting=side_effecting,
        fail_steps=fail_steps,
    )


def features_client(
    builder: ArtifactBuilder | None = None,
    side_effecting: frozenset[str] = frozenset({"complete"}),
    fail_steps: frozenset[str] = frozenset(),
) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {"featuresFlow": FEATURES_STEPS},
        builder=builder,
        side_effecting=side_effecting,
        fail_steps=fail_steps,
    )


def dependencies_client(
    builder: ArtifactBuilder | None = None,
    side_effecting: frozenset[str] = frozenset({"merge"}),
    fail_steps: frozenset[str] = frozenset(),
) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {"dependenciesFlow": DEPENDENCIES_STEPS},
        builder=builder,
        side_effecting=side_effecting,
        fail_steps=fail_steps,
    )


def accessibility_client(
    builder: ArtifactBuilder | None = None,
    side_effecting: frozenset[str] = frozenset({"re-scan"}),
    fail_steps: frozenset[str] = frozenset(),
) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {"accessibilityFlow": ACCESSIBILITY_STEPS},
        builder=builder,
        side_effecting=side_effecting,
        fail_steps=fail_steps,
    )


def vendors_client(
    builder: ArtifactBuilder | None = None,
    side_effecting: frozenset[str] = frozenset({"create"}),
    fail_steps: frozenset[str] = frozenset(),
) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {"vendorsFlow": VENDORS_STEPS},
        builder=builder,
        side_effecting=side_effecting,
        fail_steps=fail_steps,
    )


def security_client(
    builder: ArtifactBuilder | None = None,
    side_effecting: frozenset[str] = frozenset({"contain"}),
    fail_steps: frozenset[str] = frozenset(),
) -> ScriptedMastraRunClient:
    return ScriptedMastraRunClient(
        {"securityFlow": SECURITY_STEPS},
        builder=builder,
        side_effecting=side_effecting,
        fail_steps=fail_steps,
    )


def make_service(
    client: ScriptedMastraRunClient | None = None,
    *,
    max_concurrent: int = 5,
    config: RunServiceConfig | None = None,
    clock: Callable[[], datetime] | None = None,
    cases: InMemoryCaseRepository | None = None,
    locks: MemoryTargetLockStore | None = None,
    metrics: MetricsRegistry | None = None,
    approvals: InMemoryApprovalRepository | None = None,
) -> RunService:
    return build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=approvals or InMemoryApprovalRepository(),
        cases=cases,
        mastra=client or review_client(),
        max_concurrent=max_concurrent,
        config=config or RunServiceConfig(),
        clock=clock,
        locks=locks,
        metrics=metrics,
    )


async def start_review(service: RunService, **input_extra: object) -> WorkflowRun:
    payload: dict[str, object] = {"repository": "acme/app", "prNumber": 7, **input_extra}
    return await service.start(
        workflow="review",
        ticket_key=str(input_extra.get("ticket", "ABC-1")),
        case_id="case-1",
        run_input=payload,
        principal=PRINCIPAL,
    )


async def proceed(service: RunService, run_id: str, step_id: str) -> object:
    return await service.decide(
        run_id=run_id, step_id=step_id, action="proceed", principal=PRINCIPAL
    )


# ------------------------------------------------------------------- flow


async def test_full_review_flow_runs_step_by_step_with_receipts() -> None:
    cases = InMemoryCaseRepository()
    await cases.create(
        CaseRecord(
            id="case-1", tenant_id=TENANT, ticket_key="ABC-1", domain="coding", status="open"
        )
    )
    client = review_client()
    service = make_service(client, cases=cases)
    run = await start_review(service)
    assert run.status == "awaiting_human"
    assert run.current_step() is not None
    assert run.current_step().step_id == "select-pr"  # type: ignore[union-attr]
    assert run.current_step().artifact is not None  # type: ignore[union-attr]

    with pytest.raises(RunConflictError):
        await service.decide(
            run_id=run.run_id, step_id="complete", action="proceed", principal=PRINCIPAL
        )

    for step_id in REVIEW_STEPS:
        result = await proceed(service, run.run_id, step_id)
        assert result.receipt is not None  # type: ignore[attr-defined]
        assert result.replayed is False  # type: ignore[attr-defined]
        assert result.run.step(step_id).decision is not None  # type: ignore[attr-defined]

    final = await service.get(run.run_id, TENANT)
    assert final.status == "completed"
    assert all(step.state == "done" for step in final.steps)
    assert client.effect_executions == ["complete"]

    case = await cases.get("case-1", TENANT)
    event_kinds = [event.kind for event in case.events]
    assert "run_started" in event_kinds
    assert "run_completed" in event_kinds
    assert {event.actor for event in case.events} == {"system"}


# ------------------------------------------------------- issue resolution


def test_workflow_registry_keeps_definitions_in_sync() -> None:
    """Every built-in definition carries ordered steps and its Mastra id."""
    assert set(WORKFLOW_DEFINITIONS) == {
        "review",
        "issues",
        "features",
        "dependencies",
        "accessibility",
        "vendors",
        "leave",
        "onboarding",
        "offboarding",
        "screening",
        "hr-help",
        "security",
        "msp",
        "bills",
        "qa",
    }
    assert ISSUES_WORKFLOW.mastra_workflow == "issuesFlow"
    assert ISSUES_WORKFLOW.title == "Issue Resolution"
    assert [step.id for step in ISSUES_WORKFLOW.steps] == list(ISSUES_STEPS)
    assert [step.title for step in ISSUES_WORKFLOW.steps] == [
        "Issue Selection",
        "Analysis",
        "Implementation",
        "Complete",
    ]
    final = ISSUES_WORKFLOW.steps[-1]
    assert final.side_effecting is True
    assert all(step.side_effecting is False for step in ISSUES_WORKFLOW.steps[:-1])
    assert FEATURES_WORKFLOW.mastra_workflow == "featuresFlow"
    assert FEATURES_WORKFLOW.title == "Feature Implementation"
    assert [step.id for step in FEATURES_WORKFLOW.steps] == list(FEATURES_STEPS)
    assert [step.title for step in FEATURES_WORKFLOW.steps] == [
        "Feature Selection",
        "Scope & Design",
        "Implementation",
        "Complete",
    ]
    final_feature = FEATURES_WORKFLOW.steps[-1]
    assert final_feature.side_effecting is True
    assert all(step.side_effecting is False for step in FEATURES_WORKFLOW.steps[:-1])
    assert DEPENDENCIES_WORKFLOW.mastra_workflow == "dependenciesFlow"
    assert DEPENDENCIES_WORKFLOW.title == "Dependency Update"
    assert [step.id for step in DEPENDENCIES_WORKFLOW.steps] == list(DEPENDENCIES_STEPS)
    assert [step.title for step in DEPENDENCIES_WORKFLOW.steps] == [
        "Scan",
        "Group",
        "Apply",
        "Validate",
        "Merge",
    ]
    final_dependency = DEPENDENCIES_WORKFLOW.steps[-1]
    assert final_dependency.side_effecting is True
    assert all(step.side_effecting is False for step in DEPENDENCIES_WORKFLOW.steps[:-1])
    assert ACCESSIBILITY_WORKFLOW.mastra_workflow == "accessibilityFlow"
    assert ACCESSIBILITY_WORKFLOW.title == "Accessibility Audit"
    assert [step.id for step in ACCESSIBILITY_WORKFLOW.steps] == list(ACCESSIBILITY_STEPS)
    assert [step.title for step in ACCESSIBILITY_WORKFLOW.steps] == [
        "Crawl",
        "Violations",
        "Fix",
        "Re-scan",
    ]
    final_accessibility = ACCESSIBILITY_WORKFLOW.steps[-1]
    assert final_accessibility.side_effecting is True
    assert all(step.side_effecting is False for step in ACCESSIBILITY_WORKFLOW.steps[:-1])
    assert VENDORS_WORKFLOW.mastra_workflow == "vendorsFlow"
    assert VENDORS_WORKFLOW.title == "Vendor Onboarding"
    assert [step.id for step in VENDORS_WORKFLOW.steps] == list(VENDORS_STEPS)
    assert [step.title for step in VENDORS_WORKFLOW.steps] == [
        "Collect",
        "Verify",
        "Risk Score",
        "Approve",
        "Create",
    ]
    final_vendor = VENDORS_WORKFLOW.steps[-1]
    assert final_vendor.side_effecting is True
    assert all(step.side_effecting is False for step in VENDORS_WORKFLOW.steps[:-1])
    assert LEAVE_WORKFLOW.mastra_workflow == "leaveFlow"
    assert LEAVE_WORKFLOW.title == "Leave Request"
    assert [step.id for step in LEAVE_WORKFLOW.steps] == list(LEAVE_STEPS)
    assert [step.title for step in LEAVE_WORKFLOW.steps] == [
        "Intake",
        "Policy Check",
        "Approve",
        "Apply",
    ]
    final_leave = LEAVE_WORKFLOW.steps[-1]
    assert final_leave.side_effecting is True
    assert all(step.side_effecting is False for step in LEAVE_WORKFLOW.steps[:-1])
    assert ONBOARDING_WORKFLOW.mastra_workflow == "onboardingFlow"
    assert ONBOARDING_WORKFLOW.title == "New-Hire Onboarding"
    assert [step.id for step in ONBOARDING_WORKFLOW.steps] == list(ONBOARDING_STEPS)
    assert [step.title for step in ONBOARDING_WORKFLOW.steps] == [
        "Collect",
        "Verify",
        "Risk Score",
        "Approve",
        "Provision",
    ]
    final_onboarding = ONBOARDING_WORKFLOW.steps[-1]
    assert final_onboarding.side_effecting is True
    assert all(step.side_effecting is False for step in ONBOARDING_WORKFLOW.steps[:-1])
    assert OFFBOARDING_WORKFLOW.mastra_workflow == "offboardingFlow"
    assert OFFBOARDING_WORKFLOW.title == "Employee Offboarding"
    assert [step.id for step in OFFBOARDING_WORKFLOW.steps] == list(OFFBOARDING_STEPS)
    assert [step.title for step in OFFBOARDING_WORKFLOW.steps] == [
        "Intake",
        "Access Audit",
        "Approve",
        "Revoke",
        "Attest",
    ]
    # Offboarding is the first lane with two side-effecting steps: revoking
    # access and then attesting the close (final pay, equipment, case close).
    assert [step.side_effecting for step in OFFBOARDING_WORKFLOW.steps] == [
        False,
        False,
        False,
        True,
        True,
    ]
    assert SCREENING_WORKFLOW.mastra_workflow == "screeningFlow"
    assert SCREENING_WORKFLOW.title == "Candidate Screening"
    assert [step.id for step in SCREENING_WORKFLOW.steps] == list(SCREENING_STEPS)
    assert [step.title for step in SCREENING_WORKFLOW.steps] == [
        "Requisition",
        "Screen",
        "Shortlist",
        "Schedule",
    ]
    # Scheduling the interview invites is the single side effect (idempotent
    # by candidate + requisition).
    assert [step.side_effecting for step in SCREENING_WORKFLOW.steps] == [
        False,
        False,
        False,
        True,
    ]
    assert HR_HELP_WORKFLOW.mastra_workflow == "hrHelpFlow"
    assert HR_HELP_WORKFLOW.title == "HR Help"
    assert [step.id for step in HR_HELP_WORKFLOW.steps] == list(HR_HELP_STEPS)
    assert [step.title for step in HR_HELP_WORKFLOW.steps] == [
        "Intake",
        "Retrieve",
        "Draft",
        "Approve",
        "Send",
    ]
    # Recording the answer is the single side effect (idempotent by case +
    # ticket).
    assert [step.side_effecting for step in HR_HELP_WORKFLOW.steps] == [
        False,
        False,
        False,
        False,
        True,
    ]
    assert SECURITY_WORKFLOW.mastra_workflow == "securityFlow"
    assert SECURITY_WORKFLOW.title == "SOC Alert Triage"
    assert [step.id for step in SECURITY_WORKFLOW.steps] == list(SECURITY_STEPS)
    assert [step.title for step in SECURITY_WORKFLOW.steps] == [
        "Ingest",
        "Triage",
        "Investigate",
        "Decide",
        "Approve",
        "Contain",
    ]
    # Executing the approved disposition is the single side effect
    # (idempotent by alert + host) behind the security:contain scope.
    assert [step.side_effecting for step in SECURITY_WORKFLOW.steps] == [
        False,
        False,
        False,
        False,
        False,
        True,
    ]


async def test_issue_resolution_flow_runs_step_by_step_with_receipts() -> None:
    client = issues_client()
    service = make_service(client)
    run = await service.start(
        workflow="issues",
        ticket_key="ABC-42",
        case_id="case-42",
        run_input={
            "ticketKey": "ABC-42",
            "repository": "acme/app",
            "baseBranch": "main",
        },
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    assert run.current_step() is not None
    assert run.current_step().step_id == "issue-selection"  # type: ignore[union-attr]
    assert run.current_step().artifact is not None  # type: ignore[union-attr]

    for step_id in ISSUES_STEPS:
        result = await proceed(service, run.run_id, step_id)
        assert result.receipt is not None  # type: ignore[attr-defined]
        assert result.replayed is False  # type: ignore[attr-defined]

    final = await service.get(run.run_id, TENANT)
    assert final.status == "completed"
    assert all(step.state == "done" for step in final.steps)
    # Only the completion step executes a side effect, exactly once.
    assert client.effect_executions == ["complete"]
    assert "complete" in final.side_effects


# ------------------------------------------------ feature implementation


async def test_feature_implementation_flow_runs_step_by_step_with_receipts() -> None:
    client = features_client()
    service = make_service(client)
    run = await service.start(
        workflow="features",
        ticket_key="FEAT-7",
        case_id="case-7",
        run_input={
            "ticketKey": "FEAT-7",
            "repository": "acme/app",
            "baseBranch": "main",
            "acceptanceCriteria": ["Toggle persists after reload"],
        },
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    assert run.current_step() is not None
    assert run.current_step().step_id == "feature-selection"  # type: ignore[union-attr]
    assert run.current_step().artifact is not None  # type: ignore[union-attr]

    for step_id in FEATURES_STEPS:
        result = await proceed(service, run.run_id, step_id)
        assert result.receipt is not None  # type: ignore[attr-defined]
        assert result.replayed is False  # type: ignore[attr-defined]

    final = await service.get(run.run_id, TENANT)
    assert final.status == "completed"
    assert all(step.state == "done" for step in final.steps)
    # Only the completion step executes a side effect, exactly once.
    assert client.effect_executions == ["complete"]
    assert "complete" in final.side_effects


# ----------------------------------------------------- dependency update


async def test_dependency_update_flow_runs_step_by_step_with_receipts() -> None:
    client = dependencies_client()
    service = make_service(client)
    run = await service.start(
        workflow="dependencies",
        ticket_key="acme-app",
        case_id="case-deps",
        run_input={
            "repository": "acme/app",
            "baseBranch": "main",
            "manifestPath": "package.json",
        },
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    assert run.current_step() is not None
    assert run.current_step().step_id == "scan"  # type: ignore[union-attr]
    assert run.current_step().artifact is not None  # type: ignore[union-attr]

    for step_id in DEPENDENCIES_STEPS:
        result = await proceed(service, run.run_id, step_id)
        assert result.receipt is not None  # type: ignore[attr-defined]
        assert result.replayed is False  # type: ignore[attr-defined]

    final = await service.get(run.run_id, TENANT)
    assert final.status == "completed"
    assert all(step.state == "done" for step in final.steps)
    # Only the merge step executes a side effect, exactly once.
    assert client.effect_executions == ["merge"]
    assert "merge" in final.side_effects


async def test_accessibility_audit_flow_runs_step_by_step_with_receipts() -> None:
    client = accessibility_client()
    service = make_service(client)
    run = await service.start(
        workflow="accessibility",
        ticket_key="acme-app-web",
        case_id="case-a11y",
        run_input={
            "repository": "acme/app-web",
            "baseBranch": "main",
            "targetUrl": "https://preview.acme.test",
        },
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    assert run.current_step() is not None
    assert run.current_step().step_id == "crawl"  # type: ignore[union-attr]
    assert run.current_step().artifact is not None  # type: ignore[union-attr]

    for step_id in ACCESSIBILITY_STEPS:
        result = await proceed(service, run.run_id, step_id)
        assert result.receipt is not None  # type: ignore[attr-defined]
        assert result.replayed is False  # type: ignore[attr-defined]

    final = await service.get(run.run_id, TENANT)
    assert final.status == "completed"
    assert all(step.state == "done" for step in final.steps)
    # Only the re-scan step executes a side effect (the fix PR), exactly once.
    assert client.effect_executions == ["re-scan"]
    assert "re-scan" in final.side_effects


async def test_vendor_onboarding_flow_runs_step_by_step_with_receipts() -> None:
    client = vendors_client()
    service = make_service(client)
    run = await service.start(
        workflow="vendors",
        ticket_key="VEND-12",
        case_id="case-vendors",
        run_input={
            "vendorName": "Northwind Supply Ltd",
            "taxId": "GB-812345678",
            "requestor": "procurement@acme.test",
            "country": "GB",
        },
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    assert run.current_step() is not None
    assert run.current_step().step_id == "collect"  # type: ignore[union-attr]
    assert run.current_step().artifact is not None  # type: ignore[union-attr]

    for step_id in VENDORS_STEPS:
        result = await proceed(service, run.run_id, step_id)
        assert result.receipt is not None  # type: ignore[attr-defined]
        assert result.replayed is False  # type: ignore[attr-defined]

    final = await service.get(run.run_id, TENANT)
    assert final.status == "completed"
    assert all(step.state == "done" for step in final.steps)
    # Only the create step executes a side effect (the vendor record), once.
    assert client.effect_executions == ["create"]
    assert "create" in final.side_effects


# ----------------------------------------------------------- SOC alert triage


async def test_security_flow_runs_step_by_step_with_receipts() -> None:
    """Six checkpoints end to end; the contain side effect carries the
    security:contain scope and its decision carries the signed receipt the
    executor re-verifies before acting."""
    client = security_client()
    approvals = InMemoryApprovalRepository()
    service = make_service(client, approvals=approvals)
    run = await service.start(
        workflow="security",
        ticket_key="SEC-102",
        case_id="case-security",
        run_input={
            "alertSource": "edr",
            "title": "Suspicious encoded PowerShell with scheduled task persistence",
            "rawAlert": (
                "EDR detected powershell.exe running with -enc on fin-db-01: the "
                "base64 payload registers a scheduled task and beacons to "
                "203.0.113.77."
            ),
            "host": "fin-db-01",
            "indicators": ["203.0.113.77"],
        },
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    assert run.current_step() is not None
    assert run.current_step().step_id == "ingest"  # type: ignore[union-attr]
    assert run.current_step().artifact is not None  # type: ignore[union-attr]

    for step_id in SECURITY_STEPS:
        result = await proceed(service, run.run_id, step_id)
        assert result.receipt is not None  # type: ignore[attr-defined]
        assert result.replayed is False  # type: ignore[attr-defined]

    final = await service.get(run.run_id, TENANT)
    assert final.status == "completed"
    assert all(step.state == "done" for step in final.steps)
    # Only the contain step executes a side effect (the approved disposition).
    assert client.effect_executions == ["contain"]
    assert "contain" in final.side_effects

    # The side effect is bound to the security:contain scope; review-only
    # checkpoints stay under the run-wide scope.
    decision = final.step("contain").decision
    assert decision is not None
    approval = await approvals.get(str(decision["approvalId"]), TENANT)
    assert approval.scope == "security:contain"
    approve_decision = final.step("approve").decision
    assert approve_decision is not None
    approve_record = await approvals.get(str(approve_decision["approvalId"]), TENANT)
    assert approve_record.scope == "run:security"

    # The decision carries the signed receipt reference the executor requires
    # before acting; the envelope handed to the flow mirrors it.
    receipt_id = decision["receiptId"]
    assert isinstance(receipt_id, str) and receipt_id != ""
    assert decision["actionHash"] == final.step("contain").action_hash
    envelope = client.inputs[-1]
    resume_decisions = envelope["decisions"]
    assert isinstance(resume_decisions, dict)
    contain_decision = resume_decisions["contain"]
    assert isinstance(contain_decision, dict)
    assert contain_decision["receiptId"] == receipt_id


async def test_security_metrics_record_triage_verdicts_and_containment() -> None:
    """Triage verdicts and containment receipts land in the metrics registry
    with bounded labels; the containment outcome falls back to the contain
    artifact when the receipt itself carries none."""
    metrics = MetricsRegistry()

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        if step_id == "triage":
            return {
                "classification": "tp",
                "severity": "high",
                "injectionFlags": ["override_instruction"],
            }
        if step_id == "contain":
            return {"outcome": "contained"}
        return {"workflow": workflow, "stepId": step_id, "guidance": guidance}

    service = make_service(security_client(builder=builder), metrics=metrics)
    run = await service.start(
        workflow="security",
        ticket_key="SEC-301",
        case_id="case-security-metrics",
        run_input={},
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    for step_id in SECURITY_STEPS:
        result = await proceed(service, run.run_id, step_id)
        assert result.receipt is not None  # type: ignore[attr-defined]

    text = metrics.render().decode()
    assert (
        'security_triage_verdicts_total{classification="tp",injection="flagged",'
        'severity="high"} 1.0'
        in text
    )
    assert 'security_containment_total{outcome="contained",replayed="false"} 1.0' in text


async def test_security_metrics_keep_label_sets_bounded() -> None:
    """Off-contract artifacts must not invent new label values: without the
    contract enums the triage counter stays untouched and containment degrades
    to outcome="unknown"."""
    metrics = MetricsRegistry()
    service = make_service(security_client(), metrics=metrics)
    run = await service.start(
        workflow="security",
        ticket_key="SEC-302",
        case_id="case-security-plain",
        run_input={},
        principal=PRINCIPAL,
    )
    await proceed(service, run.run_id, "ingest")
    # The counter's HELP/TYPE metadata renders regardless; the sample lines do not.
    assert "security_triage_verdicts_total{" not in metrics.render().decode()

    for step_id in SECURITY_STEPS[1:]:
        await proceed(service, run.run_id, step_id)
    text = metrics.render().decode()
    assert 'security_containment_total{outcome="unknown",replayed="false"} 1.0' in text


async def test_unknown_workflow_is_rejected_before_any_mastra_call() -> None:
    client = issues_client()
    service = make_service(client)
    with pytest.raises(UnknownWorkflowError):
        await service.start(
            workflow="not-a-workflow",
            ticket_key="ABC-1",
            case_id="case-1",
            run_input={},
            principal=PRINCIPAL,
        )
    assert client.calls == []


async def test_mastra_envelope_maps_onto_the_flow_contract() -> None:
    """Flows count attempts from 1 and want the ticket key inside `input`."""
    client = features_client()
    service = make_service(client)
    await service.start(
        workflow="features",
        ticket_key="FEAT-9",
        case_id="case-9",
        run_input={"repository": "acme/app"},
        principal=PRINCIPAL,
    )
    envelope = client.inputs[0]
    nested = envelope["input"]
    assert isinstance(nested, dict)
    assert envelope["attempt"] == 1
    assert envelope["ticketKey"] == "FEAT-9"
    assert nested["ticketKey"] == "FEAT-9"
    assert nested["repository"] == "acme/app"


async def test_http_mastra_client_surfaces_the_http_error_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "Invalid input data: attempt must be > 0"})

    client = HttpMastraRunClient("http://mastra.test", transport=httpx.MockTransport(handler))
    with pytest.raises(MastraClientError) as caught:
        await client.start(workflow="featuresFlow", run_id="run-1", input_data={})
    message = str(caught.value)
    assert "HTTP 400" in message
    assert "Invalid input data" in message


async def test_http_mastra_client_surfaces_the_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("All connection attempts failed")

    client = HttpMastraRunClient("http://mastra.test", transport=httpx.MockTransport(handler))
    with pytest.raises(MastraClientError) as caught:
        await client.start(workflow="featuresFlow", run_id="run-1", input_data={})
    assert "ConnectError" in str(caught.value)


async def test_failed_flow_error_object_surfaces_its_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "failed",
                "error": {
                    "message": "Path denied: README.md",
                    "name": "RepositoryPolicyError",
                    "code": "path_denied",
                },
            },
        )

    client = HttpMastraRunClient("http://mastra.test", transport=httpx.MockTransport(handler))
    outcome = await client.start(workflow="featuresFlow", run_id="run-1", input_data={})
    assert outcome.status == "failed"
    assert outcome.error == "RepositoryPolicyError: Path denied: README.md"


def test_receipt_binds_run_id() -> None:
    signer = ApprovalReceiptSigner(SECRET)
    action = {"workflow": "review", "stepId": "select-pr", "action": "proceed"}
    token = signer.issue(
        approval_id="a1",
        case_id="c1",
        action=action,
        approver="user-1",
        scope="run:review",
        decision="approved",
        expires_at=datetime.now(UTC) + timedelta(hours=1),
        run_id="run-1",
    )
    claims = signer.validate(
        token,
        approval_id="a1",
        case_id="c1",
        action=action,
        scope="run:review",
        run_id="run-1",
    )
    assert claims.run_id == "run-1"
    with pytest.raises(ReceiptError):
        signer.validate(
            token,
            approval_id="a1",
            case_id="c1",
            action=action,
            scope="run:review",
            run_id="run-2",
        )


# --------------------------------------------------------------- parallel


async def test_three_parallel_runs_are_isolated() -> None:
    seen = {"count": 0, "max": 0}
    gate = asyncio.Event()

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        seen["count"] += 1
        seen["max"] = max(seen["max"], seen["count"])
        if seen["count"] >= 3:
            gate.set()
        await gate.wait()
        seen["count"] -= 1
        return {"marker": run_input.get("marker"), "stepId": step_id}

    client = review_client(builder=builder)
    service = make_service(client)
    runs = list(
        await asyncio.gather(
            *(
                start_review(service, ticket=f"ABC-{index}", marker=f"r{index}")
                for index in range(1, 4)
            )
        )
    )
    assert seen["max"] == 3
    markers = {
        run.current_step().artifact["marker"]  # type: ignore[union-attr,index]
        for run in runs
    }
    assert markers == {"r1", "r2", "r3"}

    await proceed(service, runs[1].run_id, "select-pr")
    for untouched in (runs[0], runs[2]):
        reloaded = await service.get(untouched.run_id, TENANT)
        assert reloaded.status == "awaiting_human"
        assert reloaded.current_step().step_id == "select-pr"  # type: ignore[union-attr]
        assert reloaded.step("select-pr").decision is None
    moved = await service.get(runs[1].run_id, TENANT)
    assert moved.current_step().step_id == "review-options"  # type: ignore[union-attr]


async def test_ceiling_queues_visibly_and_promotes_fifo() -> None:
    gate = asyncio.Event()
    first = {"pending": True}

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        if first["pending"]:
            first["pending"] = False
            await gate.wait()
        return {"marker": run_input.get("marker")}

    client = review_client(builder=builder)
    service = make_service(client, max_concurrent=1)
    task_a = asyncio.create_task(start_review(service, ticket="ABC-1", marker="a"))
    await asyncio.sleep(0.05)
    run_b = await start_review(service, ticket="ABC-2", marker="b")
    run_c = await start_review(service, ticket="ABC-3", marker="c")
    assert run_b.status == "queued"
    assert run_b.queue_position == 1
    assert run_c.status == "queued"
    assert run_c.queue_position == 2

    gate.set()
    run_a = await task_a
    assert run_a.status == "awaiting_human"
    reloaded_b = await service.get(run_b.run_id, TENANT)
    reloaded_c = await service.get(run_c.run_id, TENANT)
    assert reloaded_b.status == "awaiting_human"
    assert reloaded_b.queue_position is None
    assert reloaded_c.status == "awaiting_human"
    assert reloaded_c.queue_position is None
    starts = [run_id for _, _, run_id in client.calls]
    assert starts == [
        f"{run_a.run_id}:a0",
        f"{run_b.run_id}:a0",
        f"{run_c.run_id}:a0",
    ]


async def test_cancel_releases_slot_and_promotes_next() -> None:
    gate = asyncio.Event()
    first = {"pending": True}

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        if first["pending"]:
            first["pending"] = False
            await gate.wait()
        return {"marker": run_input.get("marker")}

    client = review_client(builder=builder)
    service = make_service(client, max_concurrent=1)

    async def start_and_capture() -> WorkflowRun:
        return await start_review(service, ticket="ABC-1", marker="a")

    task_a = asyncio.create_task(start_and_capture())
    await asyncio.sleep(0.05)
    run_b = await start_review(service, ticket="ABC-2", marker="b")
    assert run_b.status == "queued"

    run_a_started = None
    while run_a_started is None:
        active = await service.list_active(TENANT)
        run_a_started = next(
            (run for run in active if run.ticket_key == "ABC-1"), None
        )
        if run_a_started is None:
            await asyncio.sleep(0)
    cancelled = await service.cancel(
        run_id=run_a_started.run_id, tenant_id=TENANT, reason="stop"
    )
    assert cancelled.status == "cancelled"
    reloaded_b = await service.get(run_b.run_id, TENANT)
    assert reloaded_b.status == "awaiting_human"

    gate.set()
    run_a = await task_a
    assert run_a.status == "cancelled"
    assert (await service.get(run_a.run_id, TENANT)).status == "cancelled"


async def test_cancel_of_queued_run_refreshes_positions() -> None:
    gate = asyncio.Event()

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        if run_input.get("ticket") == "ABC-1":
            await gate.wait()
        return {"marker": run_input.get("marker")}

    service = make_service(review_client(builder=builder), max_concurrent=1)
    task_a = asyncio.create_task(start_review(service, ticket="ABC-1", marker="a"))
    await asyncio.sleep(0.05)
    run_b = await start_review(service, ticket="ABC-2", marker="b")
    run_c = await start_review(service, ticket="ABC-3", marker="c")
    assert run_b.queue_position == 1
    assert run_c.queue_position == 2

    cancelled = await service.cancel(
        run_id=run_b.run_id, tenant_id=TENANT, reason="changed mind"
    )
    assert cancelled.status == "cancelled"
    reloaded_c = await service.get(run_c.run_id, TENANT)
    assert reloaded_c.queue_position == 1

    gate.set()
    await task_a


async def test_sweep_times_out_over_budget_runs() -> None:
    gate = asyncio.Event()
    first = {"pending": True}

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        if first["pending"]:
            first["pending"] = False
            await gate.wait()
        return {}

    now = [datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)]
    client = review_client(builder=builder)
    service = make_service(
        client,
        max_concurrent=1,
        config=RunServiceConfig(max_run_seconds=100),
        clock=lambda: now[0],
    )
    task_a = asyncio.create_task(start_review(service, ticket="ABC-1"))
    await asyncio.sleep(0.05)

    async def start_b() -> WorkflowRun:
        return await start_review(service, ticket="ABC-2")

    run_b = await start_b()
    assert run_b.status == "queued"
    now[0] = now[0] + timedelta(seconds=101)
    # Fix round 1 (PR1 T2): a queued run is exempt from the idle deadline —
    # waiting behind the ceiling queue is not being stuck. Only A's stalled
    # running pass is reaped; B is promoted by A's release and served.
    # (This test previously asserted `len(affected) == 2`: the sweep reaping
    # the queued B purely for its queue wait, the policy the ruling retired.)
    affected = await service.sweep_expired()
    assert len(affected) == 1
    served_b = await service.get(run_b.run_id, TENANT)
    assert served_b.status == "awaiting_human"  # promoted, driven, suspended
    assert served_b.cancel_reason is None
    gate.set()
    await task_a
    active = await service.list_active(TENANT)
    assert [run.run_id for run in active] == [run_b.run_id]
    await service.cancel(run_id=run_b.run_id, tenant_id=TENANT, reason="test-end")
    assert await service.list_active(TENANT) == []


# ------------------------------------------------------------------ locks


async def test_target_lock_conflict_blocks_second_run_with_banner() -> None:
    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        target = run_input.get("target")
        return {"marker": run_input.get("marker"), **({"target": target} if target else {})}

    client = review_client(builder=builder)
    service = make_service(client)
    run_a = await start_review(service, ticket="ABC-1", marker="a", target="pr:acme/app#7")
    assert run_a.status == "awaiting_human"
    assert run_a.lock_target == "pr:acme/app#7"
    assert run_a.lock_owner == run_a.run_id

    run_b = await start_review(service, ticket="ABC-2", marker="b", target="pr:acme/app#7")
    assert run_b.status == "blocked"
    assert run_b.lock_owner == run_a.run_id
    blocked_step = run_b.current_step()
    assert blocked_step is not None
    assert blocked_step.state == "blocked"

    still_blocked = await service.decide(
        run_id=run_b.run_id, step_id="select-pr", action="retry_lock", principal=PRINCIPAL
    )
    assert still_blocked.run.status == "blocked"

    await service.cancel(run_id=run_a.run_id, tenant_id=TENANT, reason="finished")
    unlocked = await service.decide(
        run_id=run_b.run_id, step_id="select-pr", action="retry_lock", principal=PRINCIPAL
    )
    assert unlocked.run.status == "awaiting_human"
    assert unlocked.run.lock_owner == run_b.run_id


async def test_target_lock_ttl_expiry_frees_the_target() -> None:
    clock = [0.0]
    store = MemoryTargetLockStore(clock=lambda: clock[0])
    assert await store.acquire("t", "run-1", ttl_seconds=10) is not None
    assert await store.acquire("t", "run-2", ttl_seconds=10) is None
    clock[0] = 11.0
    assert await store.acquire("t", "run-2", ttl_seconds=10) is not None
    assert await store.refresh("t", "run-1", ttl_seconds=10) is False


async def test_sweep_unblocks_run_when_lock_expires() -> None:
    lock_clock = [0.0]
    locks = MemoryTargetLockStore(clock=lambda: lock_clock[0])

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        return {"target": "pr:acme/app#7"}

    service = make_service(review_client(builder=builder), locks=locks)
    run_a = await start_review(service, ticket="ABC-1")
    run_b = await start_review(service, ticket="ABC-2")
    assert run_a.lock_owner == run_a.run_id
    assert run_b.status == "blocked"

    lock_clock[0] = 10_000.0  # past the lock TTL
    affected = await service.sweep_expired()
    assert affected == [run_b.run_id]
    unlocked = await service.get(run_b.run_id, TENANT)
    assert unlocked.status == "awaiting_human"
    assert unlocked.lock_owner == run_b.run_id
    assert unlocked.step("select-pr").state == "awaiting_human"


# --------------------------------------------------- back / regenerate


async def test_back_invalidates_downstream_and_re_derives() -> None:
    builds: list[str] = []

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        builds.append(step_id)
        return {"stepId": step_id, "guide": guidance}

    client = review_client(builder=builder)
    service = make_service(client)
    run = await start_review(service)
    await proceed(service, run.run_id, "select-pr")
    await proceed(service, run.run_id, "review-options")
    current = await service.get(run.run_id, TENANT)
    assert current.current_step().step_id == "ai-review"  # type: ignore[union-attr]

    result = await service.decide(
        run_id=run.run_id, step_id="ai-review", action="back", principal=PRINCIPAL
    )
    reloaded = result.run
    assert reloaded.status == "awaiting_human"
    assert reloaded.current_step().step_id == "review-options"  # type: ignore[union-attr]
    assert reloaded.step("review-options").decision is None
    assert reloaded.step("review-options").artifact is not None
    assert reloaded.step("ai-review").state == "pending"
    assert builds.count("review-options") == 2
    assert builds.count("select-pr") == 1


async def test_regenerate_recomputes_once_then_escalates() -> None:
    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        return {"stepId": step_id, "guidance": guidance}

    client = review_client(builder=builder)
    service = make_service(client)
    run = await start_review(service)
    result = await service.decide(
        run_id=run.run_id,
        step_id="select-pr",
        action="regenerate",
        principal=PRINCIPAL,
        guidance="pick the other PR",
    )
    assert result.run.status == "awaiting_human"
    assert result.run.step("select-pr").artifact["guidance"] == "pick the other PR"  # type: ignore[index]
    assert result.receipt is None
    with pytest.raises(RunConflictError):
        await service.decide(
            run_id=run.run_id,
            step_id="select-pr",
            action="regenerate",
            principal=PRINCIPAL,
            guidance="again",
        )


# -------------------------------------------------- action-bar edge paths


async def test_abort_action_cancels_with_reason() -> None:
    service = make_service()
    run = await start_review(service)
    result = await service.decide(
        run_id=run.run_id,
        step_id="select-pr",
        action="abort",
        principal=PRINCIPAL,
        comment="wrong ticket",
    )
    assert result.run.status == "cancelled"
    assert result.run.cancel_reason == "wrong ticket"


async def test_conflicting_decisions_are_rejected() -> None:
    service = make_service()
    run = await start_review(service)
    with pytest.raises(RunConflictError):
        await service.decide(
            run_id=run.run_id, step_id="select-pr", action="back", principal=PRINCIPAL
        )
    cancelled = await service.cancel(run_id=run.run_id, tenant_id=TENANT, reason="stop")
    assert cancelled.status == "cancelled"
    again = await service.cancel(run_id=run.run_id, tenant_id=TENANT, reason="stop")
    assert again.status == "cancelled"
    with pytest.raises(RunConflictError):
        await proceed(service, run.run_id, "select-pr")


async def test_edit_decision_records_edits_and_advances() -> None:
    service = make_service()
    run = await start_review(service)
    result = await service.decide(
        run_id=run.run_id,
        step_id="select-pr",
        action="edit",
        principal=PRINCIPAL,
        edits={"prNumber": 9},
    )
    assert result.receipt is not None  # type: ignore[attr-defined]
    reloaded = result.run  # type: ignore[attr-defined]
    decision = reloaded.step("select-pr").decision
    assert decision is not None
    assert decision["edits"] == {"prNumber": 9}
    assert reloaded.current_step().step_id == "review-options"  # type: ignore[union-attr]


async def test_proceed_rejected_when_run_is_blocked() -> None:
    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        return {"target": "pr:acme/app#7"}

    service = make_service(review_client(builder=builder))
    await start_review(service, ticket="ABC-1")
    run_b = await start_review(service, ticket="ABC-2")
    assert run_b.status == "blocked"
    with pytest.raises(RunConflictError):
        await proceed(service, run_b.run_id, "select-pr")


async def test_engine_step_failure_marks_run_failed() -> None:
    service = make_service(review_client(fail_steps=frozenset({"ai-review"})))
    run = await start_review(service)
    await proceed(service, run.run_id, "select-pr")
    await proceed(service, run.run_id, "review-options")
    final = await proceed(service, run.run_id, "ai-review")
    assert final.run.status == "failed"  # type: ignore[attr-defined]
    assert final.run.outcome is not None  # type: ignore[attr-defined]
    assert "ai-review" in final.run.outcome  # type: ignore[attr-defined]
    assert final.run.step("ai-review").state == "failed"  # type: ignore[attr-defined]


class _ExplodingClient:
    async def start(
        self, *, workflow: str, run_id: str, input_data: dict[str, object]
    ) -> MastraOutcome:
        raise MastraClientError("bridge down")

    async def resume(
        self,
        *,
        workflow: str,
        run_id: str,
        step_id: str,
        resume_data: dict[str, object],
    ) -> MastraOutcome:
        raise MastraClientError("bridge down")


async def test_mastra_transport_error_fails_the_run() -> None:
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        mastra=_ExplodingClient(),
    )
    run = await start_review(service)
    assert run.status == "failed"
    assert run.outcome == "bridge down"
    assert run.finished_at is not None


async def test_engine_suspend_at_unknown_step_fails_the_run() -> None:
    client = ScriptedMastraRunClient({"reviewFlow": ("select-pr", "ghost-step")})
    service = make_service(client)
    run = await start_review(service)
    result = await proceed(service, run.run_id, "select-pr")
    assert result.run.status == "failed"  # type: ignore[attr-defined]
    assert result.run.outcome is not None  # type: ignore[attr-defined]
    assert "ghost-step" in result.run.outcome  # type: ignore[attr-defined]


# --------------------------------------------------------- idempotency


async def test_decision_replay_returns_original_receipt() -> None:
    approvals = InMemoryApprovalRepository()
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=approvals,
        mastra=review_client(),
    )
    run = await start_review(service)
    first = await proceed(service, run.run_id, "select-pr")
    assert first.receipt is not None  # type: ignore[attr-defined]
    assert len(await approvals.list(TENANT)) == 1

    back = await service.decide(
        run_id=run.run_id, step_id="review-options", action="back", principal=PRINCIPAL
    )
    assert back.run.current_step().step_id == "select-pr"  # type: ignore[union-attr]
    replay = await proceed(service, run.run_id, "select-pr")
    assert replay.replayed is True  # type: ignore[attr-defined]
    assert replay.receipt == first.receipt  # type: ignore[attr-defined]
    assert len(await approvals.list(TENANT)) == 1


async def test_side_effect_executes_once_across_restarts() -> None:
    builds: list[str] = []

    async def builder(
        workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
    ) -> dict[str, object]:
        builds.append(step_id)
        return {"stepId": step_id}

    client = review_client(builder=builder, side_effecting=frozenset({"review-options"}))
    service = make_service(client)
    run = await start_review(service)
    await proceed(service, run.run_id, "select-pr")
    resolved = await proceed(service, run.run_id, "review-options")
    assert resolved.run.step("review-options").action_hash is not None  # type: ignore[attr-defined]
    assert client.effect_executions == ["review-options"]

    back = await service.decide(
        run_id=run.run_id, step_id="ai-review", action="back", principal=PRINCIPAL
    )
    assert back.run.status == "awaiting_human"
    # The restart pass replays the recorded effect keyed by actionHash.
    last_input = client.inputs[-1]
    effects = last_input["effects"]
    assert isinstance(effects, dict)
    assert effects["review-options"]["actionHash"] == resolved.run.step(  # type: ignore[attr-defined]
        "review-options"
    ).action_hash
    assert client.effect_executions == ["review-options"]


# ------------------------------------------------------------ API surface


def _api() -> tuple[TestClient, RunService, ScriptedMastraRunClient]:
    client = review_client()
    service = make_service(client)
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": PRINCIPAL, "viewer": VIEWER}),
        runs_service=service,
    )
    return TestClient(app), service, client


def test_runs_api_lifecycle_and_auth() -> None:
    http, _service, _client = _api()
    headers = {"Authorization": "Bearer tok"}
    body = {
        "workflow": "review",
        "ticketKey": "ABC-1",
        "caseId": "case-1",
        "input": {"repository": "acme/app", "prNumber": 7},
    }
    assert http.post("/runs", json=body).status_code == 401
    assert (
        http.post("/runs", json=body, headers={"Authorization": "Bearer viewer"}).status_code
        == 403
    )

    created = http.post("/runs", json=body, headers=headers)
    assert created.status_code == 201
    payload = created.json()
    run_id = payload["runId"]
    assert payload["status"] == "awaiting_human"
    assert payload["steps"][0]["stepId"] == "select-pr"

    detail = http.get(f"/runs/{run_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["steps"][0]["state"] == "awaiting_human"
    # The UI reads the posted-review receipt from the side-effect trail.
    assert detail.json()["sideEffects"] == {}

    history = http.get("/runs", params={"ticket": "ABC-1"}, headers=headers)
    assert history.json()["runs"][0]["runId"] == run_id

    decision = http.post(
        f"/runs/{run_id}/steps/select-pr/decision",
        json={"action": "proceed"},
        headers=headers,
    )
    assert decision.status_code == 200
    assert decision.json()["receipt"]
    conflict = http.post(
        f"/runs/{run_id}/steps/select-pr/decision",
        json={"action": "proceed"},
        headers=headers,
    )
    assert conflict.status_code == 409

    unknown = http.post(
        "/runs",
        json={**body, "workflow": "nope"},
        headers=headers,
    )
    assert unknown.status_code == 404

    cancelled = http.post(
        f"/runs/{run_id}/cancel", json={"reason": "done"}, headers=headers
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"


def test_run_events_stream_replays_history() -> None:
    http, _service, _client = _api()
    headers = {"Authorization": "Bearer tok"}
    created = http.post(
        "/runs",
        json={
            "workflow": "review",
            "ticketKey": "ABC-9",
            "caseId": "case-1",
            "input": {"repository": "acme/app"},
        },
        headers=headers,
    )
    run_id = created.json()["runId"]
    # Finish the run so the events endpoint serves a finite history replay.
    cancelled = http.post(
        f"/runs/{run_id}/cancel", json={"reason": "done"}, headers=headers
    )
    assert cancelled.status_code == 200
    with http.stream("GET", f"/runs/{run_id}/events", headers=headers) as response:
        assert response.status_code == 200
        events = [
            json.loads(line[6:])
            for line in response.iter_lines()
            if line.startswith("data: ")
        ]
    assert events[0]["type"] == "run.created"
    assert events[0]["runId"] == run_id
    assert events[-1]["type"] == "run.status"
    assert events[-1]["status"] == "cancelled"
    sequences = [event["sequence"] for event in events]
    assert sequences == sorted(sequences)

    # Transition events embed a full run snapshot (additive ``run`` key) so
    # live viewers can apply the change without refetching GET /runs/{run_id}.
    suspended = next(event for event in events if event["type"] == "run.suspended")
    snapshot = suspended["run"]
    assert snapshot["runId"] == run_id
    assert snapshot["status"] == "awaiting_human"
    assert snapshot["currentStepId"] == "select-pr"
    assert snapshot["steps"][0]["state"] == "awaiting_human"
    # run.created stays lean; enrichment is limited to transition events.
    assert "run" not in events[0]
    final = events[-1]["run"]
    assert final["runId"] == run_id
    assert final["status"] == "cancelled"


def test_runs_migration_forces_rls_and_removes_browser_grants() -> None:
    migrations = Path(__file__).parents[3] / "supabase" / "migrations"
    migration = (migrations / "202609120008_runs.sql").read_text(encoding="utf-8")
    for table in ("runs", "run_steps"):
        assert f"alter table public.{table} enable row level security" in migration
        assert f"alter table public.{table} force row level security" in migration
        assert f"revoke all on public.{table} from public, anon, authenticated" in migration
    assert "revoke all on sequence public.run_steps_id_seq" in migration
    assert "references public.runs (id) on delete cascade" in migration
    assert "unique (run_id, step_id)" in migration
    assert "status in" in migration and "awaiting_human" in migration


async def test_subscribe_streams_history_then_live_events() -> None:
    service = make_service()
    run = await start_review(service)
    stream = service.subscribe(run.run_id)
    try:
        first = await anext(stream)
        assert first["type"] == "run.created"
        second = await anext(stream)
        assert second["type"] == "run.suspended"
        await proceed(service, run.run_id, "select-pr")
        third = await anext(stream)
        assert third["type"] == "run.decision"
        fourth = await anext(stream)
        assert fourth["type"] == "run.suspended"
        assert fourth["stepId"] == "review-options"
    finally:
        await stream.aclose()


async def test_run_metrics_record_decisions_and_terminal_status() -> None:
    metrics = MetricsRegistry()
    service = make_service(metrics=metrics)
    run = await start_review(service)
    await proceed(service, run.run_id, "select-pr")
    edited = await service.decide(
        run_id=run.run_id,
        step_id="review-options",
        action="edit",
        principal=PRINCIPAL,
        edits={"guidance": "focus on error handling"},
    )
    assert edited.run.status == "awaiting_human"
    await proceed(service, run.run_id, "ai-review")
    await proceed(service, run.run_id, "complete")
    assert (await service.get(run.run_id, TENANT)).status == "completed"

    abortable = await start_review(service, ticket="ABC-2")
    await service.decide(
        run_id=abortable.run_id,
        step_id="select-pr",
        action="abort",
        principal=PRINCIPAL,
        comment="not needed",
    )

    failing = make_service(review_client(fail_steps=frozenset({"ai-review"})), metrics=metrics)
    broken = await start_review(failing, ticket="ABC-3")
    await proceed(failing, broken.run_id, "select-pr")
    await proceed(failing, broken.run_id, "review-options")
    failed = await proceed(failing, broken.run_id, "ai-review")
    assert failed.run.status == "failed"  # type: ignore[attr-defined]

    text = metrics.render().decode()
    assert 'runs_total{status="completed",workflow="review"} 1.0' in text
    assert 'runs_total{status="cancelled",workflow="review"} 1.0' in text
    assert 'runs_total{status="failed",workflow="review"} 1.0' in text
    assert 'run_decisions_total{action="proceed",workflow="review"} 6.0' in text
    assert 'run_decisions_total{action="edit",workflow="review"} 1.0' in text
    assert 'run_decisions_total{action="abort",workflow="review"} 1.0' in text


# ------------------------------------------------- topology (N1 read model)


def test_run_topology_enriches_static_fields_and_degrades_without_definition() -> None:
    run = WorkflowRun(
        run_id="run-t1",
        tenant_id=TENANT,
        workflow="review",
        ticket_key="ABC-7",
        case_id="case-1",
        input={},
        steps=[
            RunStep(
                step_id="select-pr",
                index=0,
                title="Select PR",
                state="done",
                receipt="rcpt-1",
                action_hash="hash-1",
            ),
            RunStep(step_id="mystery", index=1, title="Mystery", state="pending"),
            RunStep(
                step_id="complete",
                index=3,
                title="Complete",
                state="pending",
                artifact={"summary": "ready"},
            ),
        ],
        status="running",
        lock_target="github",
        lock_owner="agent-1",
    )
    run.side_effects["complete"] = {"receipt": {"id": "effect-1"}}

    topology = run_topology(run, WORKFLOW_DEFINITIONS["review"])
    assert topology["runId"] == "run-t1"
    assert topology["workflow"] == "review"
    assert topology["status"] == "running"
    assert topology["stepCount"] == 3
    assert topology["stepsDone"] == 1
    assert topology["currentStepId"] is None
    assert topology["lock"] == {"target": "github", "lockedBy": "agent-1"}
    # Static satellites come from the definition; unknown step ids degrade.
    first, mystery, complete = topology["steps"]
    assert first["sideEffecting"] is False and first["integrations"] == []
    assert mystery["sideEffecting"] is False and mystery["integrations"] == []
    assert complete["sideEffecting"] is True and complete["integrations"] == ["github"]
    assert complete["hasArtifact"] is True and complete["hasDecision"] is False
    # Receipt items cover decided steps and recorded side effects alike.
    assert topology["receipts"]["signed"] == 1
    items = topology["receipts"]["items"]
    assert items[0] == {
        "stepId": "select-pr",
        "receipt": "rcpt-1",
        "actionHash": "hash-1",
        "effectRecorded": False,
    }
    assert items[1]["stepId"] == "complete" and items[1]["effectRecorded"] is True
    assert all(step["updatedAt"] for step in topology["steps"])

    # Unknown workflows (no definition) degrade to empty satellites, never fail.
    fallback = run_topology(run, None)
    assert fallback["steps"][2]["sideEffecting"] is False
    assert fallback["steps"][2]["integrations"] == []
    assert fallback["receipts"]["signed"] == 1

    # A run with no lock exposure reports null instead of a half-filled dict.
    unlocked = run_topology(
        WorkflowRun(
            run_id="run-t2",
            tenant_id=TENANT,
            workflow="review",
            ticket_key="ABC-8",
            case_id="case-1",
            input={},
            steps=[RunStep(step_id="select-pr", index=0, title="Select PR")],
        ),
        WORKFLOW_DEFINITIONS["review"],
    )
    assert unlocked["lock"] is None
    assert unlocked["receipts"] == {"signed": 0, "items": []}


def test_run_topology_derives_its_header_from_run_snapshot() -> None:
    """The console read model and ``GET /runs/{run_id}`` can never disagree."""

    run = WorkflowRun(
        run_id="run-t3",
        tenant_id=TENANT,
        workflow="review",
        ticket_key="ABC-9",
        case_id="case-1",
        input={"repository": "acme/app"},
        steps=[
            RunStep(
                step_id="select-pr",
                index=0,
                title="Select PR",
                state="done",
                receipt="rcpt-9",
                action_hash="hash-9",
            ),
            RunStep(
                step_id="review-options",
                index=1,
                title="Review options",
                state="awaiting_human",
                artifact={"summary": "ready"},
            ),
        ],
        status="awaiting_human",
        attempt=2,
        lock_target="github",
        lock_owner="agent-2",
    )
    snapshot = run_snapshot(run)
    topology = run_topology(run, WORKFLOW_DEFINITIONS["review"])

    # Run-level header fields are literally the snapshot's.
    for key in (
        "runId",
        "workflow",
        "status",
        "attempt",
        "currentStepId",
        "stepCount",
        "stepsDone",
        "startedAt",
        "finishedAt",
    ):
        assert topology[key] == snapshot[key]
    assert topology["lock"] == {
        "target": snapshot["lockTarget"],
        "lockedBy": snapshot["lockedBy"],
    }
    assert topology["receipts"]["signed"] == 1

    # Step rows mirror the snapshot's step dicts for every shared key.
    snapshot_steps = snapshot["steps"]
    assert isinstance(snapshot_steps, list)
    assert isinstance(topology["steps"], list)
    assert len(topology["steps"]) == len(snapshot_steps)
    for row, raw in zip(topology["steps"], snapshot_steps, strict=True):
        assert isinstance(row, dict) and isinstance(raw, dict)
        assert row["stepId"] == raw["stepId"]
        assert row["index"] == raw["index"]
        assert row["title"] == raw["title"]
        assert row["state"] == raw["state"]
        assert row["receipt"] == raw["receipt"]
        assert row["actionHash"] == raw["actionHash"]
        assert row["regenerations"] == raw["regenerations"]
        assert row["updatedAt"] == raw["updatedAt"]
        assert row["hasArtifact"] is (raw["artifact"] is not None)
        assert row["hasDecision"] is (raw["decision"] is not None)


def test_run_topology_api_surface() -> None:
    http, _service, _client = _api()
    headers = {"Authorization": "Bearer tok"}
    body = {
        "workflow": "review",
        "ticketKey": "ABC-1",
        "caseId": "case-1",
        "input": {"repository": "acme/app", "prNumber": 7},
    }
    assert http.get("/runs/missing/topology").status_code == 401

    created = http.post("/runs", json=body, headers=headers)
    assert created.status_code == 201
    run_id = created.json()["runId"]
    assert http.get("/runs/nope/topology", headers=headers).status_code == 404

    # Any console role may read the topology; viewers included.
    viewer = http.get(f"/runs/{run_id}/topology", headers={"Authorization": "Bearer viewer"})
    assert viewer.status_code == 200
    topology = viewer.json()
    assert topology["runId"] == run_id
    assert topology["workflow"] == "review"
    assert topology["status"] == "awaiting_human"
    assert topology["currentStepId"] == "select-pr"
    assert topology["stepCount"] == 4
    assert topology["stepsDone"] == 0
    assert topology["lock"] is None
    assert topology["finishedAt"] is None
    first, last = topology["steps"][0], topology["steps"][-1]
    assert first["stepId"] == "select-pr"
    assert first["state"] == "awaiting_human"
    assert first["sideEffecting"] is False and first["integrations"] == []
    assert last["stepId"] == "complete"
    assert last["sideEffecting"] is True and last["integrations"] == ["github"]
    assert topology["receipts"]["signed"] == 0
    assert topology["receipts"]["items"] == []

    # After a decision the same payload exposes the signed receipt trail.
    decision = http.post(
        f"/runs/{run_id}/steps/select-pr/decision",
        json={"action": "proceed"},
        headers=headers,
    )
    assert decision.status_code == 200
    after = http.get(f"/runs/{run_id}/topology", headers=headers).json()
    assert after["currentStepId"] == "review-options"
    assert after["steps"][0]["receipt"]
    signed = [item for item in after["receipts"]["items"] if item["stepId"] == "select-pr"]
    assert len(signed) == 1
    assert signed[0]["receipt"] == after["steps"][0]["receipt"]
    assert signed[0]["actionHash"] == after["steps"][0]["actionHash"]
    assert signed[0]["effectRecorded"] is False
    assert after["receipts"]["signed"] == 1

    # The topology's run header is literally the detail surface's — one source.
    detail = http.get(f"/runs/{run_id}", headers=headers).json()
    for key in (
        "runId",
        "workflow",
        "status",
        "attempt",
        "currentStepId",
        "stepCount",
        "stepsDone",
        "startedAt",
        "finishedAt",
    ):
        assert after[key] == detail[key]
    assert after["lock"] is None
    assert detail["lockTarget"] is None and detail["lockedBy"] is None


# ------------------------------------------------------ data pills (N3)


def _pills_run() -> WorkflowRun:
    """One review-shaped run parked at Complete: every earlier output is
    referenceable, the checkpoint's own artifact and later steps are not."""

    return WorkflowRun(
        run_id="run-p1",
        tenant_id=TENANT,
        workflow="review",
        ticket_key="ABC-21",
        case_id="case-1",
        input={"repository": "acme/app", "prNumber": 77, "note": None, "empty": ""},
        steps=[
            RunStep(
                step_id="select-pr",
                index=0,
                title="Select PR",
                state="done",
                artifact={
                    "repository": "acme/app",
                    "prNumber": 77,
                    "ready": True,
                    "ratio": 0.5,
                },
            ),
            RunStep(
                step_id="review-options",
                index=1,
                title="Review options",
                state="done",
                artifact={"options": [{"label": "standard"}, {"label": "security"}]},
            ),
            RunStep(
                step_id="ai-review",
                index=2,
                title="AI review",
                state="done",
                artifact={
                    "review": {
                        "summary": "One policy citation applies.",
                        "citations": [
                            {"sourceId": "kb-remote-work", "span": "remote-work.md#L4-L9"},
                            {"sourceId": "kb-benefits"},
                            {"sourceId": ""},
                            {"span": "no source"},
                        ],
                    }
                },
            ),
            RunStep(
                step_id="complete",
                index=3,
                title="Complete",
                state="awaiting_human",
                artifact={"pr": {"number": 77}},
            ),
        ],
        status="awaiting_human",
    )


def _pill_map(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    pills = payload["pills"]
    assert isinstance(pills, list)
    rows: dict[str, dict[str, object]] = {}
    for item in pills:
        assert isinstance(item, dict)
        rows[str(item["ref"])] = item
    return rows


def test_run_pills_catalogs_trigger_and_earlier_outputs() -> None:
    run = _pills_run()
    payload = run_pills(run)
    assert payload["runId"] == "run-p1"
    assert payload["workflow"] == "review"
    assert payload["currentStepId"] == "complete"
    pills = _pill_map(payload)

    # Trigger input rides under the "Trigger" group.
    assert pills["trigger.repository"] == {
        "ref": "trigger.repository",
        "group": "trigger",
        "groupTitle": "Trigger",
        "label": "repository",
        "kind": "text",
        "preview": "acme/app",
        "stepIndex": -1,
    }
    # Empty strings and nulls carry nothing a field could mix in.
    assert "trigger.note" not in pills and "trigger.empty" not in pills

    # Earlier step artifacts are referenceable, typed and previewed.
    assert pills["steps.select-pr.prNumber"]["kind"] == "number"
    assert pills["steps.select-pr.prNumber"]["preview"] == "77"
    assert pills["steps.select-pr.ready"]["kind"] == "boolean"
    assert pills["steps.select-pr.ready"]["preview"] == "true"
    assert pills["steps.select-pr.ratio"]["preview"] == "0.5"

    # Loop items keep their index, so a pill stays scoped to its item.
    assert pills["steps.review-options.options[0].label"]["preview"] == "standard"
    assert pills["steps.review-options.options[1].label"]["preview"] == "security"

    # A {sourceId, span} record collapses into one composite citation pill.
    citation = pills["steps.ai-review.review.citations[0]"]
    assert citation["kind"] == "citation"
    assert citation["preview"] == "kb-remote-work @ remote-work.md#L4-L9"
    assert citation["label"] == "review.citations[0]"
    assert "steps.ai-review.review.citations[0].sourceId" not in pills

    # A spanless citation degrades to its sourceId leaf; junk is skipped.
    assert pills["steps.ai-review.review.citations[1].sourceId"]["preview"] == "kb-benefits"
    assert pills["steps.ai-review.review.citations[3].span"]["preview"] == "no source"
    assert all("citations[2]" not in ref for ref in pills)

    # The catalog stops at the checkpoint: the step under review is not a ref.
    assert all(not ref.startswith("steps.complete") for ref in pills)
    refs = list(pills)
    assert refs[0] == "trigger.repository"
    assert refs.index("steps.select-pr.repository") < refs.index(
        "steps.review-options.options[0].label"
    )


def test_run_pills_cover_a_terminal_runs_full_artifacts() -> None:
    run = _pills_run()
    run.status = "completed"
    for step in run.steps:
        step.state = "done"
    payload = run_pills(run)
    assert payload["currentStepId"] is None
    pills = _pill_map(payload)
    assert pills["steps.complete.pr.number"]["preview"] == "77"


def test_run_pills_stay_bounded() -> None:
    long_text = "x" * 300
    items = [f"value-{index}" for index in range(40)]
    deep = {"l1": {"l2": {"l3": {"l4": {"l5": {"l6": "edge", "l6b": {"l7": "past"}}}}}}}

    run = WorkflowRun(
        run_id="run-p2",
        tenant_id=TENANT,
        workflow="review",
        ticket_key="ABC-22",
        case_id="case-1",
        input={"long": long_text, "items": items, "deep": deep},
        steps=[],
        status="running",
    )
    pills = _pill_map(run_pills(run))

    # Previews truncate; list walks cap at twelve indexed items.
    preview = pills["trigger.long"]["preview"]
    assert isinstance(preview, str) and len(preview) == 80 and preview.endswith("…")
    assert "trigger.items[11]" in pills and "trigger.items[12]" not in pills
    # Container descent caps at six levels; past that the walk stops.
    assert pills["trigger.deep.l1.l2.l3.l4.l5.l6"]["preview"] == "edge"
    assert all("l6b" not in ref for ref in pills)

    # One group never floods the picker past its budget.
    flood = WorkflowRun(
        run_id="run-p3",
        tenant_id=TENANT,
        workflow="review",
        ticket_key="ABC-23",
        case_id="case-1",
        input={f"key{index}": index for index in range(80)},
        steps=[],
        status="running",
    )
    assert len(_pill_map(run_pills(flood))) == 60


def test_resolve_pill_value_replaces_tokens_and_reports_broken_refs() -> None:
    run = _pills_run()
    resolved = resolve_pill_value(
        {
            "summary": "PR {{trigger.repository}}#{{steps.select-pr.prNumber}}",
            "flag": "ready={{steps.select-pr.ready}} ratio={{steps.select-pr.ratio}}",
            "cite": "{{steps.ai-review.review.citations[0]}}",
            "nested": {"list": ["item {{steps.review-options.options[1].label}}"]},
            "untouched": "plain text {not a token}",
            "number": 7,
        },
        run,
        before_index=3,
    )
    assert resolved == {
        "summary": "PR acme/app#77",
        "flag": "ready=true ratio=0.5",
        "cite": "kb-remote-work @ remote-work.md#L4-L9",
        "nested": {"list": ["item security"]},
        "untouched": "plain text {not a token}",
        "number": 7,
    }

    assert (
        resolve_pill_text("focus on {{steps.select-pr.repository}}", run, before_index=3)
        == "focus on acme/app"
    )
    assert resolve_pill_text("no tokens here", run, before_index=3) == "no tokens here"

    # Broken refs reject loudly — nulls, out-of-scope artifacts, unknown
    # paths, malformed paths — and every ref is reported in one message.
    for bad in (
        "{{trigger.note}}",
        "{{steps.complete.pr.number}}",
        "{{steps.ghost.value}}",
        "{{nonsense}}",
        "{{steps.select-pr..prNumber}}",
    ):
        with pytest.raises(PillRefError) as info:
            resolve_pill_value({"summary": f"x {bad}"}, run, before_index=3)
        assert bad in str(info.value)
        assert "re-map" in str(info.value)

    with pytest.raises(PillRefError) as info:
        resolve_pill_value(
            {"a": "{{trigger.note}}", "b": "{{nonsense}}"}, run, before_index=3
        )
    message = str(info.value)
    assert "{{trigger.note}}" in message and "{{nonsense}}" in message
    assert "no longer exist" in message


async def test_decisions_resolve_pill_tokens_before_the_receipt_binds() -> None:
    service = make_service()
    run = await start_review(service)

    # An edit at the first checkpoint resolves against the trigger input; the
    # step's own artifact is out of scope there.
    with pytest.raises(RunConflictError, match="no longer exists"):
        await service.decide(
            run_id=run.run_id,
            step_id="select-pr",
            action="edit",
            principal=PRINCIPAL,
            edits={"note": "{{steps.select-pr.repository}}"},
        )
    edited = await service.decide(
        run_id=run.run_id,
        step_id="select-pr",
        action="edit",
        principal=PRINCIPAL,
        edits={"note": "repo {{trigger.repository}} pr {{trigger.prNumber}}"},
    )
    decision = edited.run.step("select-pr").decision  # type: ignore[attr-defined]
    assert decision is not None
    assert decision["edits"] == {"note": "repo acme/app pr 7"}

    await proceed(service, run.run_id, "review-options")
    await proceed(service, run.run_id, "ai-review")

    # A broken ref rejects the decision and leaves the run untouched.
    with pytest.raises(RunConflictError, match="no longer exists"):
        await service.decide(
            run_id=run.run_id,
            step_id="complete",
            action="edit",
            principal=PRINCIPAL,
            edits={"summary": "{{steps.ghost.value}}"},
        )
    stale = await service.get(run.run_id, TENANT)
    assert stale.status == "awaiting_human"
    assert stale.step("complete").decision is None
    assert stale.step("complete").regenerations == 0

    # Regenerate guidance resolves the same way, and a broken guidance run
    # never burns a regeneration.
    with pytest.raises(RunConflictError, match="no longer exists"):
        await service.decide(
            run_id=run.run_id,
            step_id="complete",
            action="regenerate",
            principal=PRINCIPAL,
            guidance="try {{nonsense}}",
        )
    assert (await service.get(run.run_id, TENANT)).step("complete").regenerations == 0
    regenerated = await service.decide(
        run_id=run.run_id,
        step_id="complete",
        action="regenerate",
        principal=PRINCIPAL,
        guidance="focus on {{steps.select-pr.stepId}}",
    )
    guid = regenerated.run.step("complete").decision  # type: ignore[attr-defined]
    assert guid is not None and guid["guidance"] == "focus on select-pr"


def test_run_pills_api_surface_and_auth() -> None:
    http, _service, _client = _api()
    headers = {"Authorization": "Bearer tok"}
    body = {
        "workflow": "review",
        "ticketKey": "ABC-1",
        "caseId": "case-1",
        "input": {"repository": "acme/app", "prNumber": 7},
    }
    assert http.get("/runs/missing/pills").status_code == 401

    created = http.post("/runs", json=body, headers=headers)
    run_id = created.json()["runId"]
    assert http.get("/runs/nope/pills", headers=headers).status_code == 404

    # Any console role may read the catalog; viewers included.
    viewer = http.get(f"/runs/{run_id}/pills", headers={"Authorization": "Bearer viewer"})
    assert viewer.status_code == 200
    payload = viewer.json()
    assert payload["runId"] == run_id
    assert payload["workflow"] == "review"
    assert payload["currentStepId"] == "select-pr"
    pills = _pill_map(payload)
    assert pills["trigger.repository"]["preview"] == "acme/app"
    assert pills["trigger.prNumber"]["kind"] == "number"
    # The checkpoint's own artifact is out of scope while it is undecided.
    assert all(not ref.startswith("steps.") for ref in pills)

    # After deciding select-pr its artifact opens up for the next step.
    decision = http.post(
        f"/runs/{run_id}/steps/select-pr/decision",
        json={"action": "proceed"},
        headers=headers,
    )
    assert decision.status_code == 200
    after = _pill_map(http.get(f"/runs/{run_id}/pills", headers=headers).json())
    assert after["steps.select-pr.stepId"]["preview"] == "select-pr"

    # A token-carrying edit resolves at the API boundary too.
    edited = http.post(
        f"/runs/{run_id}/steps/review-options/decision",
        json={
            "action": "edit",
            "edits": {"guidance": "keep {{trigger.repository}} in scope"},
        },
        headers=headers,
    )
    assert edited.status_code == 200
    steps = edited.json()["run"]["steps"]
    review = next(step for step in steps if step["stepId"] == "review-options")
    assert review["decision"]["edits"] == {"guidance": "keep acme/app in scope"}

    # A broken ref is a 409 with the re-map copy — nothing silently rides.
    broken = http.post(
        f"/runs/{run_id}/steps/ai-review/decision",
        json={"action": "edit", "edits": {"summary": "{{steps.ghost.value}}"}},
        headers=headers,
    )
    assert broken.status_code == 409
    assert "no longer exists" in broken.json()["detail"]
