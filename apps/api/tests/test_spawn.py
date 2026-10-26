"""Phase 5 cross-domain spawn suite: support -> linked ENG bug (Nexus pattern).

The planner is deterministic and policy-driven; the webhook path files the
spawned ticket with its evidence trail, links it back on the source ticket and
stays idempotent across duplicate deliveries and replayed events. Failure of
the spawn never fails the webhook — the routing comment is the durable step.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import replace

from allrounder_api.app import create_app
from allrounder_api.context import RequestContext
from allrounder_api.dispatcher import DeterministicDispatcher, normalize_jira_payload
from allrounder_api.idempotency import MemoryIdempotencyStore
from allrounder_api.jira import FakeJiraTransport, JiraTools
from allrounder_api.policy import RiskPolicy, default_risk_policy
from allrounder_api.queueing import MemoryQueue
from allrounder_api.settings import Settings
from allrounder_api.spawn import CrossDomainSpawner
from fastapi.testclient import TestClient

SECRET = "spawn-secret"
DEFECT_SUMMARY = "Checkout crashes with a stack trace"
DEFECT_DESCRIPTION = "The exception log shows a regression."


def _signature(body: bytes) -> str:
    return "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()


def _payload(
    key: str,
    summary: str,
    description: str = "",
    *,
    project: str = "SUP",
    timestamp: int = 1788800000000,
    labels: list[str] | None = None,
) -> dict[str, object]:
    return {
        "webhookEvent": "jira:issue_created",
        "timestamp": timestamp,
        "issue": {
            "id": key.split("-")[1],
            "key": key,
            "fields": {
                "project": {"key": project},
                "issuetype": {"name": "Service Request"},
                "labels": labels if labels is not None else ["customer"],
                "priority": {"name": "High"},
                "summary": summary,
                "description": description,
                "reporter": {"accountId": "acct-spawn"},
                "attachment": [],
            },
        },
    }


def _routed(payload: dict[str, object]):
    return DeterministicDispatcher().dispatch(normalize_jira_payload(payload))


def _post(client: TestClient, payload: dict[str, object]):
    body = json.dumps(payload, separators=(",", ":")).encode()
    return client.post(
        "/webhooks/jira",
        content=body,
        headers={"content-type": "application/json", "x-hub-signature-256": _signature(body)},
    )


def _build_client() -> tuple[TestClient, FakeJiraTransport]:
    transport = FakeJiraTransport()
    app = create_app(
        settings=Settings(webhook_secret=SECRET),
        dedupe=MemoryIdempotencyStore(),
        queue=MemoryQueue(),
        jira=JiraTools(transport, MemoryIdempotencyStore()),
    )
    return TestClient(app), transport


def _defect_plan(policy: RiskPolicy | None = None):
    spawner = CrossDomainSpawner(policy.spawn if policy is not None else None)
    return spawner.plan(_routed(_payload("SUP-700", DEFECT_SUMMARY, DEFECT_DESCRIPTION)))


def test_planner_files_linked_bug_with_evidence() -> None:
    plan = _defect_plan()
    assert plan is not None
    assert plan.target_project == "ENG"
    assert plan.issue_type == "Bug"
    assert plan.source_ticket_key == "SUP-700"
    assert plan.source_project == "SUP"
    assert plan.summary == f"[spawn] {DEFECT_SUMMARY}"
    assert "stack trace" in plan.signals
    assert "crash" in plan.signals
    assert "regression" in plan.signals
    assert "SUP-700" in plan.description
    assert "Signals: stack trace, exception, crash, regression" in plan.description
    assert "spawned-from-support" in plan.labels
    assert "source:sup-700" in plan.labels
    assert len(plan.correlation_id) == 12


def test_planner_ignores_clean_support_ticket() -> None:
    spawner = CrossDomainSpawner()
    assert spawner.plan(_routed(_payload("SUP-701", "Reset my password", "FAQ request"))) is None


def test_planner_ignores_defect_reports_outside_support() -> None:
    spawner = CrossDomainSpawner()
    payload = _payload("ENG-702", "API returns a stack trace", "regression", project="ENG")
    assert spawner.plan(_routed(payload)) is None


def test_planner_correlation_id_is_deterministic_per_signals() -> None:
    first = _defect_plan()
    second = _defect_plan()
    assert first is not None and second is not None
    assert first.correlation_id == second.correlation_id
    fewer = CrossDomainSpawner().plan(
        _routed(_payload("SUP-700", "Checkout crash", "no other clues"))
    )
    assert fewer is not None
    assert fewer.signals == ("crash",)
    assert fewer.correlation_id != first.correlation_id


def test_planner_redacts_pii_and_cites_the_clause() -> None:
    plan = CrossDomainSpawner().plan(
        _routed(_payload("SUP-703", "Sync error for jane.doe@example.com", "Customer crash."))
    )
    assert plan is not None
    assert "[REDACTED_EMAIL]" in plan.summary
    assert "jane.doe@example.com" not in plan.summary
    assert "Redacted per clause(s): pii/email" in plan.description


def test_planner_does_not_copy_raw_customer_text() -> None:
    secrets = "api_key=sk-live-abcdef123456"
    plan = CrossDomainSpawner().plan(
        _routed(_payload("SUP-704", "App crash", f"Stack trace includes {secrets}"))
    )
    assert plan is not None
    assert secrets not in plan.description
    assert "api_key" not in plan.description
    assert "SUP-704" in plan.description


def test_disabled_spawn_policy_produces_no_plan() -> None:
    disabled = replace(default_risk_policy().spawn, enabled=False)
    assert CrossDomainSpawner(disabled).plan(
        _routed(_payload("SUP-705", DEFECT_SUMMARY, DEFECT_DESCRIPTION))
    ) is None


def test_create_ticket_replays_and_never_double_files() -> None:
    store = MemoryIdempotencyStore()
    transport = FakeJiraTransport()
    tools = JiraTools(transport, store)
    context = RequestContext.for_webhook("evt-spawn")
    kwargs = {
        "project": "ENG",
        "summary": "s",
        "issue_type": "Bug",
        "labels": ["spawned-from-support"],
        "description": "d",
        "idempotency_key": "k1",
    }
    first = tools.create_ticket(context, **kwargs)
    assert first.action == "jira_create"
    assert first.ticket_key == "ENG-1000"
    assert first.status == "succeeded"
    memoized = tools.create_ticket(context, **kwargs)
    assert memoized.ticket_key == "ENG-1000"
    assert len(transport.created) == 1
    # A second process with the shared store cannot claim the key again and
    # reports an empty key, so the caller skips the link comment.
    other = JiraTools(transport, store)
    foreign = other.create_ticket(context, **kwargs)
    assert foreign.ticket_key == ""
    assert foreign.status == "replayed"
    assert len(transport.created) == 1


def test_webhook_spawns_linked_bug_and_links_back_on_the_source() -> None:
    client, transport = _build_client()
    response = _post(client, _payload("SUP-710", DEFECT_SUMMARY, DEFECT_DESCRIPTION))
    assert response.status_code == 200
    assert response.json() == {"ticketKey": "SUP-710", "deduped": False}
    assert len(transport.created) == 1
    created = transport.created[0]
    assert created.key == "ENG-1000"
    assert created.project == "ENG"
    assert created.issue_type == "Bug"
    assert created.summary == f"[spawn] {DEFECT_SUMMARY}"
    assert "source:sup-710" in created.labels
    assert "SUP-710" in created.description
    source_comments = [c for c in transport.comments if c.ticket_key == "SUP-710"]
    assert len(source_comments) == 2
    assert "Routed to the support comment-only workflow" in source_comments[0].body
    assert "Filed linked ticket ENG-1000" in source_comments[1].body
    assert "ENG-1000" in created.description or "ENG-1000" in source_comments[1].body


def test_webhook_spawn_is_idempotent_across_deliveries_and_events() -> None:
    client, transport = _build_client()
    payload = _payload("SUP-711", "Sync crash", "stack trace")
    first = _post(client, payload)
    assert first.json()["deduped"] is False
    assert len(transport.created) == 1
    duplicate = _post(client, payload)
    assert duplicate.json()["deduped"] is True
    assert len(transport.created) == 1
    replay_payload = _payload("SUP-711", "Sync crash", "stack trace", timestamp=1788800000555)
    replay = _post(client, replay_payload)
    assert replay.json()["deduped"] is False
    assert len(transport.created) == 1
    links = [c for c in transport.comments if "ENG-1000" in c.body]
    assert len(links) == 1


def test_webhook_clean_ticket_has_no_spawn() -> None:
    client, transport = _build_client()
    response = _post(client, _payload("SUP-712", "Reset my password", "FAQ request"))
    assert response.status_code == 200
    assert transport.created == []
    comments = [c for c in transport.comments if c.ticket_key == "SUP-712"]
    assert len(comments) == 1


def test_spawn_failure_is_isolated_from_the_webhook() -> None:
    class ExplodingTransport(FakeJiraTransport):
        def create_issue(
            self,
            project_key: str,
            summary: str,
            *,
            issue_type: str,
            labels: list[str],
            description: str,
        ) -> str:
            raise RuntimeError("jira unavailable")

    transport = ExplodingTransport()
    app = create_app(
        settings=Settings(webhook_secret=SECRET),
        dedupe=MemoryIdempotencyStore(),
        queue=MemoryQueue(),
        jira=JiraTools(transport, MemoryIdempotencyStore()),
    )
    client = TestClient(app)
    response = _post(client, _payload("SUP-713", DEFECT_SUMMARY, DEFECT_DESCRIPTION))
    assert response.status_code == 200
    assert transport.created == []
    comments = [c for c in transport.comments if c.ticket_key == "SUP-713"]
    assert len(comments) == 1
