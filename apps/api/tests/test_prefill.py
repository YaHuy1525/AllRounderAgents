"""Start-field prefill: what a record may fill, and who may ask for it."""

from __future__ import annotations

import pytest
from allrounder_api import directory as directory_module
from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.directory import (
    Employee,
    FixtureEmployeeDirectory,
    employee_payload,
    fixture_file,
)
from allrounder_api.runs import LEAVE_WORKFLOW, REVIEW_WORKFLOW, WORKFLOW_DEFINITIONS
from allrounder_api.runs.prefill import prefill_start_fields
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

AGENT = Principal("user-1", "omnidewalt", frozenset({"agent"}))
TOKEN = "shared-service-token"
HEADERS = {"Authorization": "Bearer tok"}
SERVICE = {"Authorization": f"Bearer {TOKEN}"}


def _directory() -> FixtureEmployeeDirectory:
    return FixtureEmployeeDirectory.default()


def _two_sams() -> FixtureEmployeeDirectory:
    # The fixture has one Sam; a tie is what the resolver must refuse.
    return FixtureEmployeeDirectory(
        employees=(
            Employee("E-1", "Sam Okafor", "Support", "Ops", None, "active", 3),
            Employee("E-2", "Sam Ortiz", "Support", "Ops", None, "active", 3),
        )
    )


# ------------------------------------------------------------- the directory


def test_the_fixture_is_readable() -> None:
    assert fixture_file().is_file()
    assert len(_directory().list()) >= 4


def test_lookup_by_id_ignores_case_and_padding() -> None:
    directory = _directory()
    found = directory.get("  e-1001 ")
    assert found is not None
    assert found.full_name == "Jordan Avery"
    assert directory.get("E-9") is None
    assert directory.get("  ") is None


def test_a_name_must_be_the_full_name_to_pick_a_subject() -> None:
    directory = _directory()
    assert [item.employee_id for item in directory.find_by_name("Jordan Avery")] == ["E-1001"]
    assert directory.find_by_name("Jordan") == ()
    assert directory.find_by_name("please give Jordan Avery leave") != ()


def test_search_falls_back_to_a_partial_name() -> None:
    # A question is not a run subject, so the lookup may be looser here.
    assert [item.employee_id for item in _directory().search("Jordan")] == ["E-1001"]
    assert [item.employee_id for item in _directory().search("Priya Raman")] == ["E-1002"]
    assert _directory().search("nobody") == ()


def test_a_tool_payload_never_carries_the_leave_balance() -> None:
    found = _directory().get("E-1001")
    assert found is not None
    payload = employee_payload(found)
    assert payload["employeeId"] == "E-1001"
    assert payload["department"] == "Engineering"
    assert "leaveBalanceDays" not in payload


def test_an_unreadable_fixture_degrades_to_empty(monkeypatch, tmp_path) -> None:
    # A missing fixture is a console that asks, not a page that fails.
    monkeypatch.setattr(directory_module, "fixture_file", lambda: tmp_path / "gone.json")
    empty = directory_module.load_directory()
    assert empty.list() == ()
    assert empty.get("E-1001") is None
    assert empty.search("Jordan") == ()


# -------------------------------------------------------------- the resolver


def test_a_full_name_fills_the_employee_id_with_its_source() -> None:
    result = prefill_start_fields(
        LEAVE_WORKFLOW, text="Jordan Avery is out", employees=_directory()
    )
    assert [(item.field_id, item.value) for item in result.suggestions] == [
        ("employeeId", "E-1001")
    ]
    assert result.suggestions[0].source == "directory: Jordan Avery (E-1001)"
    # What no record proves stays the human's to type.
    assert [field.id for field in result.missing] == ["leaveType", "startDate", "endDate"]


def test_dates_numbers_and_enums_are_never_guessed() -> None:
    result = prefill_start_fields(
        LEAVE_WORKFLOW,
        text="annual leave 2026-11-02 to 2026-11-06",
        employees=_directory(),
    )
    assert result.suggestions == ()
    assert [field.id for field in result.missing] == [
        "employeeId",
        "leaveType",
        "startDate",
        "endDate",
    ]


def test_a_suggestion_never_overwrites_a_value_the_caller_has() -> None:
    result = prefill_start_fields(
        LEAVE_WORKFLOW,
        text="Jordan Avery",
        values={"employeeId": "E-1003"},
        employees=_directory(),
    )
    assert result.suggestions == ()
    assert all(field.id != "employeeId" for field in result.missing)


def test_a_blank_caller_value_still_counts_as_empty() -> None:
    result = prefill_start_fields(
        LEAVE_WORKFLOW,
        text="Jordan Avery",
        values={"employeeId": "   "},
        employees=_directory(),
    )
    assert [(item.field_id, item.value) for item in result.suggestions] == [
        ("employeeId", "E-1001")
    ]


def test_two_matching_people_leave_the_choice_to_the_human() -> None:
    result = prefill_start_fields(LEAVE_WORKFLOW, text="Sam", employees=_two_sams())
    assert result.suggestions == ()
    assert result.missing[0].id == "employeeId"


def test_a_single_allowed_repository_is_filled_and_several_are_not() -> None:
    one = prefill_start_fields(REVIEW_WORKFLOW, repositories=("acme/app",))
    assert [(item.field_id, item.value) for item in one.suggestions] == [
        ("repository", "acme/app")
    ]
    assert one.suggestions[0].source == "allowed repositories"

    many = prefill_start_fields(REVIEW_WORKFLOW, repositories=("acme/app", "acme/web"))
    assert many.suggestions == ()
    assert [field.id for field in many.missing] == ["repository"]


def test_optional_fields_are_not_reported_missing() -> None:
    result = prefill_start_fields(REVIEW_WORKFLOW, repositories=("acme/app",))
    assert result.missing == ()
    assert "prNumber" not in [field.id for field in result.missing]


# ---------------------------------------------------------------- the console


def _app(directory=None, token: str | None = None) -> TestClient:
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": AGENT}),
        employee_directory=directory,
        knowledge_service_token=token,
    )
    return TestClient(app)


def test_prefill_serves_the_suggestion_and_the_gaps() -> None:
    http = _app(directory=_directory())
    served = http.post(
        "/runs/prefill",
        json={"workflow": "leave", "text": "Jordan Avery is out next week"},
        headers=HEADERS,
    )
    assert served.status_code == 200
    payload = served.json()
    assert payload["workflow"] == "leave"
    assert payload["fields"] == [
        {
            "id": "employeeId",
            "label": "Employee id",
            "value": "E-1001",
            "source": "directory: Jordan Avery (E-1001)",
        }
    ]
    assert [item["id"] for item in payload["missing"]] == [
        "leaveType",
        "startDate",
        "endDate",
    ]


def test_prefill_keeps_the_callers_values() -> None:
    http = _app(directory=_directory())
    served = http.post(
        "/runs/prefill",
        json={
            "workflow": "leave",
            "text": "Jordan Avery",
            "values": {"employeeId": "E-1003", "leaveType": "sick"},
        },
        headers=HEADERS,
    )
    assert served.status_code == 200
    assert served.json()["fields"] == []
    assert [item["id"] for item in served.json()["missing"]] == ["startDate", "endDate"]


def test_prefill_stays_a_404_for_an_unknown_workflow() -> None:
    http = _app(directory=_directory())
    served = http.post("/runs/prefill", json={"workflow": "nope"}, headers=HEADERS)
    assert served.status_code == 404


def test_prefill_needs_a_console_credential() -> None:
    http = _app(directory=_directory())
    assert http.post("/runs/prefill", json={"workflow": "leave"}).status_code == 401


def test_prefill_covers_every_runnable_workflow() -> None:
    # The card asks for all of them, so an unreadable spec would 404 only in
    # the console, which is the last place a gap should surface.
    http = _app(directory=_directory())
    for workflow in WORKFLOW_DEFINITIONS:
        served = http.post("/runs/prefill", json={"workflow": workflow}, headers=HEADERS)
        assert served.status_code == 200, workflow


# ------------------------------------------------------------ the agent tools


def test_agent_tools_mount_only_with_the_service_token() -> None:
    body = {"tenantId": "omnidewalt", "query": "E-1001"}
    assert _app(directory=_directory()).post("/agent-tools/employees", json=body).status_code == 404


def test_agent_tools_refuse_a_missing_or_wrong_token() -> None:
    http = _app(directory=_directory(), token=TOKEN)
    body = {"tenantId": "omnidewalt", "query": "E-1001"}
    assert http.post("/agent-tools/employees", json=body).status_code == 401
    wrong = {"Authorization": "Bearer console-token"}
    assert http.post("/agent-tools/employees", json=body, headers=wrong).status_code == 401
    assert http.post("/agent-tools/employees", json=body, headers=HEADERS).status_code == 401


def test_agent_tools_find_one_person_by_id_then_by_name() -> None:
    http = _app(directory=_directory(), token=TOKEN)
    by_id = http.post(
        "/agent-tools/employees",
        json={"tenantId": "omnidewalt", "query": "E-1002"},
        headers=SERVICE,
    )
    assert by_id.status_code == 200
    assert [item["fullName"] for item in by_id.json()["employees"]] == ["Priya Raman"]

    by_name = http.post(
        "/agent-tools/employees",
        json={"tenantId": "omnidewalt", "query": "Jordan"},
        headers=SERVICE,
    )
    assert [item["employeeId"] for item in by_name.json()["employees"]] == ["E-1001"]


def test_agent_tools_resolve_start_fields_for_a_workflow() -> None:
    http = _app(directory=_directory(), token=TOKEN)
    served = http.post(
        "/agent-tools/start-fields",
        json={
            "tenantId": "omnidewalt",
            "workflow": "leave",
            "text": "Jordan Avery is out next week",
        },
        headers=SERVICE,
    )
    assert served.status_code == 200
    payload = served.json()
    assert payload["ok"] is True
    assert payload["workflowLabel"]
    assert [(item["id"], item["value"]) for item in payload["fields"]] == [
        ("employeeId", "E-1001")
    ]
    assert [item["id"] for item in payload["missing"]] == [
        "leaveType",
        "startDate",
        "endDate",
    ]


def test_an_unknown_workflow_answers_ok_false_so_the_model_can_retry() -> None:
    http = _app(directory=_directory(), token=TOKEN)
    served = http.post(
        "/agent-tools/start-fields",
        json={"tenantId": "omnidewalt", "workflow": "leave-request"},
        headers=SERVICE,
    )
    assert served.status_code == 200
    assert served.json()["ok"] is False
    assert "leave-request" in served.json()["error"]


@pytest.mark.parametrize("missing", ["tenantId", "query"])
def test_agent_employee_lookup_requires_its_fields(missing: str) -> None:
    http = _app(directory=_directory(), token=TOKEN)
    body = {"tenantId": "omnidewalt", "query": "E-1001"}
    body.pop(missing)
    served = http.post("/agent-tools/employees", json=body, headers=SERVICE)
    assert served.status_code == 422
