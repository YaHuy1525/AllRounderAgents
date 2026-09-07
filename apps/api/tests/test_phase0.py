from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path

import pytest
from allrounder_api.app import create_app
from allrounder_api.context import RequestContext
from allrounder_api.dispatcher import DeterministicDispatcher
from allrounder_api.idempotency import MemoryIdempotencyStore
from allrounder_api.jira import FakeJiraTransport, JiraTools
from allrounder_api.queueing import MemoryQueue
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = "phase-zero-secret"
FIXTURES = json.loads(
    (Path(__file__).parents[3] / "fixtures" / "phase0_tickets.json").read_text(encoding="utf-8")
)


def signature(body: bytes) -> str:
    return "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()


def build_client(
    *, max_body_bytes: int = 1_000_000
) -> tuple[TestClient, MemoryQueue, FakeJiraTransport]:
    queue = MemoryQueue()
    transport = FakeJiraTransport()
    app = create_app(
        settings=Settings(webhook_secret=SECRET, max_webhook_bytes=max_body_bytes),
        dedupe=MemoryIdempotencyStore(),
        queue=queue,
        jira=JiraTools(transport, MemoryIdempotencyStore()),
    )
    return TestClient(app), queue, transport


def post(client: TestClient, payload: dict[str, object], *, signed: bool = True):
    body = json.dumps(payload, separators=(",", ":")).encode()
    headers = {"content-type": "application/json"}
    if signed:
        headers["x-hub-signature-256"] = signature(body)
    return client.post("/webhooks/jira", content=body, headers=headers)


def test_rejects_missing_or_invalid_hmac() -> None:
    client, _, _ = build_client()
    payload = FIXTURES[0]["payload"]
    assert post(client, payload, signed=False).status_code == 401
    assert client.post(
        "/webhooks/jira",
        content=json.dumps(payload),
        headers={"x-hub-signature-256": "sha256=bad"},
    ).status_code == 401


def test_webhook_verification_fails_closed_without_a_secret() -> None:
    app = create_app(settings=Settings(webhook_secret=""))
    response = TestClient(app).post(
        "/webhooks/jira",
        content=json.dumps(FIXTURES[0]["payload"]),
        headers={"x-hub-signature-256": "sha256=attacker-controlled"},
    )
    assert response.status_code == 503


def test_rejects_oversized_payload_before_processing() -> None:
    client, queue, _ = build_client(max_body_bytes=32)
    response = post(client, FIXTURES[0]["payload"])
    assert response.status_code == 413
    assert queue.items == []


def test_normalizes_and_enqueues_ticket() -> None:
    client, queue, _ = build_client()
    response = post(client, FIXTURES[0]["payload"])
    assert response.status_code == 200
    assert response.json() == {"ticketKey": "ENG-101", "deduped": False}
    ticket = queue.items[0].ticket
    assert ticket.key == "ENG-101"
    assert ticket.project == "ENG"
    assert ticket.reporter == "acct-1"
    assert ticket.event_id


def test_duplicate_webhook_is_acknowledged_and_acted_once() -> None:
    client, queue, transport = build_client()
    payload = FIXTURES[-1]["payload"]
    assert post(client, payload).json()["deduped"] is False
    assert post(client, payload).json()["deduped"] is True
    assert len(queue.items) == 1
    assert len(transport.comments) == 1


def test_memory_idempotency_keys_expire() -> None:
    now = 10.0
    store = MemoryIdempotencyStore(clock=lambda: now)
    assert store.claim("event", ttl_seconds=5) is True
    assert store.claim("event", ttl_seconds=5) is False
    now = 16.0
    assert store.claim("event", ttl_seconds=5) is True


def test_enqueue_failure_goes_to_dlq_without_silent_drop() -> None:
    queue = MemoryQueue(fail_enqueue=True)
    app = create_app(
        settings=Settings(webhook_secret=SECRET),
        dedupe=MemoryIdempotencyStore(),
        queue=queue,
        jira=JiraTools(FakeJiraTransport(), MemoryIdempotencyStore()),
    )
    response = post(TestClient(app), FIXTURES[0]["payload"])
    assert response.status_code == 503
    assert len(queue.dead_letters) == 1
    assert queue.dead_letters[0].reason == "enqueue_failed"


def test_comment_failure_does_not_dead_letter_an_enqueued_ticket() -> None:
    class FailingCommentTransport(FakeJiraTransport):
        def add_comment(self, ticket_key: str, body: str) -> None:
            del ticket_key, body
            raise RuntimeError("simulated Jira outage")

    queue = MemoryQueue()
    app = create_app(
        settings=Settings(webhook_secret=SECRET),
        dedupe=MemoryIdempotencyStore(),
        queue=queue,
        jira=JiraTools(FailingCommentTransport(), MemoryIdempotencyStore()),
    )
    response = post(TestClient(app), FIXTURES[0]["payload"])
    assert response.status_code == 200
    assert len(queue.items) == 1
    assert queue.dead_letters == []


@pytest.mark.parametrize("fixture", FIXTURES, ids=[case["name"] for case in FIXTURES])
def test_ten_phase0_fixtures_route_safely(fixture: dict[str, object]) -> None:
    client, queue, transport = build_client()
    response = post(client, fixture["payload"])
    assert response.status_code == 200
    routed = queue.items[0]
    assert routed.verdict.domain.value == fixture["expectedDomain"]
    if fixture["expectedDomain"] == "unknown":
        assert routed.gate.value == "approval"
        assert routed.verdict.needs_human is True
        assert "escalat" in transport.comments[0].body.lower()
    else:
        assert "routed to" in transport.comments[0].body.lower()


def test_jira_tools_are_replay_safe() -> None:
    transport = FakeJiraTransport()
    tools = JiraTools(transport, MemoryIdempotencyStore())
    context = RequestContext(request_id="req-1", correlation_id="evt-1", actor="test")
    first = tools.comment(context, "ENG-101", "hello", idempotency_key="comment-1")
    replay = tools.comment(context, "ENG-101", "hello", idempotency_key="comment-1")
    tools.transition(context, "ENG-101", "In Progress", idempotency_key="transition-1")
    tools.transition(context, "ENG-101", "In Progress", idempotency_key="transition-1")
    assert first == replay
    assert len(transport.comments) == 1
    assert len(transport.transitions) == 1


def test_dispatcher_refuses_irreversible_high_blast_action() -> None:
    dispatcher = DeterministicDispatcher()
    ticket = dispatcher.normalize_for_test(FIXTURES[2]["payload"])
    routed = dispatcher.dispatch(
        ticket, planned_actions=["execute payment irreversible production"]
    )
    assert routed.gate.value == "refuse"
    assert routed.risk_scores[0].score >= 80

