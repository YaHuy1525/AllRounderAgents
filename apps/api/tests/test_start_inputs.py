"""Start-input contract tests: the published spec and the 422 it produces."""

from __future__ import annotations

import pytest
from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import (
    LEAVE_WORKFLOW,
    REVIEW_WORKFLOW,
    WORKFLOW_DEFINITIONS,
    ScriptedMastraRunClient,
    build_memory_run_service,
)
from allrounder_api.runs.models import START_FIELD_KINDS, StartField
from allrounder_api.runs.start_inputs import describe_problems, start_problems
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = b"start-input-secret-for-tests-0123456789"
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))
LEAVE_STEPS = ("intake", "policy-check", "approve", "apply")
QA_STEPS = (
    "intake",
    "analyse",
    "design",
    "approve-cases",
    "execute",
    "assess",
    "approve-defects",
    "file-defects",
    "close",
)
LEAVE_INPUT = {
    "employeeId": "EMP-1042",
    "leaveType": "annual",
    "startDate": "2026-11-02",
    "endDate": "2026-11-06",
}


# ------------------------------------------------------------- the declaration


def test_every_workflow_publishes_a_start_contract() -> None:
    # Every shipped workflow states what it needs before step one: an empty
    # declaration would let an incomplete start through the 422 gate.
    for definition in WORKFLOW_DEFINITIONS.values():
        assert definition.start_fields, f"{definition.id} declares no start fields"
        ids = [field.id for field in definition.start_fields]
        assert len(ids) == len(set(ids)), f"{definition.id} repeats a start field id"
        for field in definition.start_fields:
            assert field.kind in START_FIELD_KINDS
            assert field.label.strip(), f"{definition.id}.{field.id} has no label"
            if not field.required:
                # An optional field is only useful if it says what to type.
                assert field.example or field.help, (
                    f"{definition.id}.{field.id} is optional but undocumented"
                )
        # A required enum always lists its values, so the console can render a
        # picker instead of a text box that would 422 on a typo.
        for field in definition.start_fields:
            if field.kind == "enum":
                assert field.values


def test_start_field_rejects_specs_the_console_cannot_render() -> None:
    with pytest.raises(ValueError, match="unknown kind"):
        StartField(id="mystery", label="Mystery", kind="colour")
    with pytest.raises(ValueError, match="declares no values"):
        StartField(id="tier", label="Tier", kind="enum")
    with pytest.raises(ValueError, match="only enum fields take values"):
        StartField(id="role", label="Role", values=("admin",))


def test_start_field_lookup_by_id() -> None:
    assert LEAVE_WORKFLOW.start_field("leaveType").kind == "enum"
    with pytest.raises(KeyError, match="Unknown start field"):
        LEAVE_WORKFLOW.start_field("nope")


# --------------------------------------------------------------- the validate


def test_missing_required_fields_are_each_named() -> None:
    problems = start_problems(LEAVE_WORKFLOW, {})
    assert [problem["field"] for problem in problems] == [
        "employeeId",
        "leaveType",
        "startDate",
        "endDate",
    ]
    assert "Employee id is required." in problems[0]["problem"]
    assert describe_problems(problems).startswith("employeeId: ")
    assert "(+3 more field(s) to fix)" in describe_problems(problems)


def test_whitespace_only_value_counts_as_missing() -> None:
    problems = start_problems(LEAVE_WORKFLOW, {**LEAVE_INPUT, "employeeId": "   "})
    assert [problem["field"] for problem in problems] == ["employeeId"]


def test_shape_problems_name_the_field() -> None:
    problems = start_problems(
        LEAVE_WORKFLOW,
        {
            **LEAVE_INPUT,
            "leaveType": "Annual",  # the flow expects the lowercase value
            "startDate": "02/11/2026",
            "endDate": "2026-02-30",  # right shape, impossible day
        },
    )
    by_field = {problem["field"]: problem["problem"] for problem in problems}
    assert "one of: annual, sick, unpaid, parental" in by_field["leaveType"]
    assert "YYYY-MM-DD" in by_field["startDate"]
    assert "YYYY-MM-DD" in by_field["endDate"]


def test_valid_and_optional_values_pass() -> None:
    assert start_problems(LEAVE_WORKFLOW, LEAVE_INPUT) == []
    # A number may arrive as a string from the chat card; the flow decides.
    assert start_problems(REVIEW_WORKFLOW, {"repository": "acme/app", "prNumber": "7"}) == []
    assert start_problems(REVIEW_WORKFLOW, {"repository": "acme/app"}) == []


def test_optional_fields_are_not_required() -> None:
    assert start_problems(REVIEW_WORKFLOW, {"repository": "acme/app", "prNumber": None}) == []
    problems = start_problems(REVIEW_WORKFLOW, {"repository": "acme/app", "prNumber": "seven"})
    assert [problem["field"] for problem in problems] == ["prNumber"]


# ---------------------------------------------------------------- the surfaces


def _api() -> TestClient:
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        mastra=ScriptedMastraRunClient({"leaveFlow": LEAVE_STEPS, "qaFlow": QA_STEPS}),
    )
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": PRINCIPAL}),
        runs_service=service,
    )
    return TestClient(app)


def test_workflows_catalog_serves_the_start_fields() -> None:
    http = _api()
    headers = {"Authorization": "Bearer tok"}
    payload = http.get("/workflows", headers=headers).json()
    served = {item["id"]: item for item in payload["workflows"]}
    leave = served["leave"]
    assert [field["id"] for field in leave["startFields"]] == [
        "employeeId",
        "leaveType",
        "startDate",
        "endDate",
    ]
    leaveType = leave["startFields"][1]
    assert leaveType["kind"] == "enum"
    assert leaveType["values"] == ["annual", "sick", "unpaid", "parental"]
    assert leaveType["required"] is True
    # A workflow with nothing required still publishes its optional inputs.
    assert served["dependencies"]["startFields"][0]["required"] is False


def test_start_refuses_incomplete_input_with_422() -> None:
    http = _api()
    headers = {"Authorization": "Bearer tok"}
    body = {
        "workflow": "leave",
        "ticketKey": "HR-12",
        "caseId": "case-1",
        "input": {"employeeId": "EMP-1042", "leaveType": "annual"},
    }
    refused = http.post("/runs", json=body, headers=headers)
    assert refused.status_code == 422
    detail = refused.json()["detail"]
    assert detail["workflow"] == "leave"
    assert [item["field"] for item in detail["fields"]] == ["startDate", "endDate"]
    assert detail["message"].startswith("startDate: ")

    created = http.post(
        "/runs", json={**body, "input": LEAVE_INPUT}, headers=headers
    )
    assert created.status_code == 201
    assert created.json()["status"] == "awaiting_human"


def test_the_qa_lane_publishes_its_start_and_step_contract() -> None:
    qa = WORKFLOW_DEFINITIONS["qa"]
    assert [field.id for field in qa.start_fields] == [
        "storyKey",
        "scope",
        "target",
        "maxCases",
    ]
    # `target` stays optional because the flow's own input schema defaults it
    # to `local-console`; requiring it here would be a second, contradictory
    # rule, and the registry still refuses any key it does not know.
    assert [field.required for field in qa.start_fields] == [True, True, False, False]
    # The target is a registry key, so the card renders a picker rather than a
    # text box that would 422 on a typo.
    assert qa.start_field("target").values == ("local-console",)
    assert [step.id for step in qa.steps] == list(QA_STEPS)
    # Only the two outbound steps cross the receipt band: driving the approved
    # cases and filing the findings the human kept.
    assert [step.id for step in qa.steps if step.side_effecting] == [
        "execute",
        "file-defects",
    ]


def test_a_qa_run_without_a_scope_is_refused_by_name() -> None:
    http = _api()
    headers = {"Authorization": "Bearer tok"}
    body = {
        "workflow": "qa",
        "ticketKey": "OPS-123",
        "caseId": "case-qa-1",
        "input": {"storyKey": "OPS-123", "target": "local-console"},
    }
    refused = http.post("/runs", json=body, headers=headers)
    assert refused.status_code == 422
    detail = refused.json()["detail"]
    assert detail["workflow"] == "qa"
    assert [item["field"] for item in detail["fields"]] == ["scope"]

    created = http.post(
        "/runs",
        json={**body, "input": {**body["input"], "scope": "approving a leave request"}},
        headers=headers,
    )
    assert created.status_code == 201
    assert created.json()["status"] == "awaiting_human"


def test_unknown_workflow_stays_a_404_not_a_422() -> None:
    http = _api()
    headers = {"Authorization": "Bearer tok"}
    body = {"workflow": "nope", "ticketKey": "HR-12", "caseId": "case-1", "input": {}}
    assert http.post("/runs", json=body, headers=headers).status_code == 404
