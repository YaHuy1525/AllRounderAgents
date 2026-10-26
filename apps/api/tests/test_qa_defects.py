"""The QA squad's one governed write: ``POST /agent-tools/qa/file-defect``.

The contract under test is the one that stops a nightly suite from producing a
ticket avalanche: the route is mounted only with the shared service token, it
files one defect per ``{storyKey}:{caseId}``, a re-run comments on that defect
instead of filing a twin, and a case that now passes resolves the record it
created. Nothing here needs Jira: the fake transport records every write.
"""

from __future__ import annotations

import httpx
from allrounder_api.app import create_app
from allrounder_api.idempotency import MemoryIdempotencyStore
from allrounder_api.jira import FakeJiraTransport, JiraTools
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

PATH = "/agent-tools/qa/file-defect"
TOKEN = "agent-tools-service-token-for-tests"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def body(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "storyKey": "OPS-123",
        "caseId": "QA-OPS-001",
        "correlationId": "OPS-123:QA-OPS-001",
        "targetKey": "local-console",
        "runId": "run-qa-1",
        "status": "failed",
        "title": "[QA] QA-OPS-001: the queue lists pending requests",
        "body": (
            "Case QA-OPS-001 failed against local-console for story OPS-123.\n"
            "Expected: the request appears with an Approve action.\n"
            "Observed: the queue renders `No pending requests`."
        ),
        "severity": "high",
        "evidenceRefs": ["qa:run-qa-1:QA-OPS-001:observed"],
    }
    payload.update(overrides)
    return payload


def _client(
    *,
    token: str | None = TOKEN,
    jira: JiraTools | None = None,
) -> TestClient:
    app = create_app(
        settings=Settings(webhook_secret="test"),
        knowledge_service_token=token,
        jira=jira,
    )
    return TestClient(app)


def _tools(transport: FakeJiraTransport, store: MemoryIdempotencyStore) -> JiraTools:
    return JiraTools(transport, store)


# --------------------------------------------------------------- mounting


def test_route_mounts_only_with_the_service_token() -> None:
    # Without the shared token the surface does not exist: a governed write
    # must not be reachable on an unconfigured app.
    assert _client(token=None).post(PATH, json=body()).status_code == 404


def test_requires_the_service_bearer_and_writes_nothing_without_it() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    assert http.post(PATH, json=body()).status_code == 401
    wrong = http.post(PATH, json=body(), headers={"Authorization": "Bearer nope"})
    assert wrong.status_code == 401
    assert wrong.json() == {"detail": "Invalid credentials"}
    scheme = http.post(PATH, json=body(), headers={"Authorization": "Basic dXNlcjpwYXNz"})
    assert scheme.status_code == 401
    assert transport.created == []


# ------------------------------------------------------------------ filing


def test_first_failure_files_one_bug_with_the_correlation_labels() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    answer = http.post(PATH, json=body(), headers=HEADERS)
    assert answer.status_code == 200
    assert answer.json() == {
        "ok": True,
        "action": "created",
        "ticketKey": "OPS-1000",
        "status": "succeeded",
        "caseId": "QA-OPS-001",
        "correlationId": "OPS-123:QA-OPS-001",
    }

    [created] = transport.created
    assert created.project == "OPS"
    assert created.issue_type == "Bug"
    assert created.summary == "[QA] QA-OPS-001: the queue lists pending requests"
    assert created.labels == ("qa-defect", "qa-ops-001", "ops-123")
    assert "Observed: the queue renders" in created.description


def test_a_repeat_failure_comments_on_the_same_ticket() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    first = http.post(PATH, json=body(), headers=HEADERS).json()
    second = http.post(PATH, json=body(runId="run-qa-2"), headers=HEADERS).json()

    assert first["action"] == "created"
    assert second["action"] == "commented"
    assert second["ticketKey"] == first["ticketKey"]
    # One ticket, one comment, and the comment names the run it came from.
    assert len(transport.created) == 1
    [comment] = transport.comments
    assert comment.ticket_key == first["ticketKey"]
    assert "failed again on run run-qa-2" in comment.body


def test_a_restart_replays_instead_of_filing_a_twin() -> None:
    transport = FakeJiraTransport()
    store = MemoryIdempotencyStore()

    created = _client(jira=_tools(transport, store)).post(PATH, json=body(), headers=HEADERS).json()
    assert created["action"] == "created"

    # A new process: the in-process ledger is empty, but the shared
    # idempotency store has already claimed this correlation.
    replayed = (
        _client(jira=_tools(transport, store)).post(PATH, json=body(), headers=HEADERS).json()
    )
    assert replayed["action"] == "replayed"
    assert replayed["ticketKey"] == ""
    assert len(transport.created) == 1


def test_reposting_one_run_comments_once() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    http.post(PATH, json=body(), headers=HEADERS)
    again = http.post(PATH, json=body(), headers=HEADERS).json()
    twice = http.post(PATH, json=body(), headers=HEADERS).json()

    assert again["action"] == "commented"
    assert twice["action"] == "commented"
    # The comment key includes the run, so one run cannot comment twice even
    # when the caller retries the post.
    assert len(transport.comments) == 1


# -------------------------------------------------------------- resolution


def test_a_passing_case_comments_that_it_passes() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    filed = http.post(PATH, json=body(), headers=HEADERS).json()
    resolved = http.post(
        PATH,
        json=body(runId="run-qa-2", status="passed", body="Observed: the request is listed."),
        headers=HEADERS,
    ).json()

    assert resolved["action"] == "commented"
    assert resolved["ticketKey"] == filed["ticketKey"]
    [comment] = transport.comments
    assert "now passes against story OPS-123" in comment.body
    assert "Run: run-qa-2" in comment.body


def test_a_passing_case_with_no_defect_writes_nothing() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    answer = http.post(PATH, json=body(status="passed"), headers=HEADERS).json()

    assert answer["action"] == "skipped"
    assert answer["ticketKey"] == ""
    assert answer["status"] == "no_defect"
    assert transport.created == []
    assert transport.comments == []


# --------------------------------------------------------------- refusals


def test_a_correlation_that_does_not_match_the_story_and_case_is_refused() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    answer = http.post(PATH, json=body(correlationId="OPS-123:QA-OPS-999"), headers=HEADERS)
    assert answer.status_code == 422
    assert "correlationId must be OPS-123:QA-OPS-001" in answer.json()["detail"]
    assert transport.created == []


def test_a_case_id_that_is_not_a_case_id_is_refused() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    answer = http.post(
        PATH,
        json=body(caseId="pending-requests", correlationId="OPS-123:pending-requests"),
        headers=HEADERS,
    )
    assert answer.status_code == 422
    assert transport.created == []


def test_a_story_key_without_a_project_is_refused() -> None:
    transport = FakeJiraTransport()
    http = _client(jira=_tools(transport, MemoryIdempotencyStore()))

    # `ops-123` fails the Jira key pattern before the project is derived.
    answer = http.post(
        PATH, json=body(storyKey="ops-123", correlationId="ops-123:QA-OPS-001"), headers=HEADERS
    )
    assert answer.status_code == 422


class FailingTransport(FakeJiraTransport):
    """Jira is down: the route reports it rather than raising at the caller."""

    def create_issue(self, *args: object, **kwargs: object) -> str:
        raise httpx.HTTPError("jira unreachable")


def test_a_jira_failure_is_a_receipt_not_an_exception() -> None:
    http = _client(jira=_tools(FailingTransport(), MemoryIdempotencyStore()))

    answer = http.post(PATH, json=body(), headers=HEADERS)
    assert answer.status_code == 200
    assert answer.json() == {
        "ok": True,
        "action": "failed",
        "ticketKey": "",
        "status": "jira_write_failed",
        "caseId": "QA-OPS-001",
        "correlationId": "OPS-123:QA-OPS-001",
    }
