from __future__ import annotations

from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.metrics import MetricsRegistry
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient


def metrics_client() -> TestClient:
    verifier = FakeBearerVerifier(
        {
            "viewer": Principal("user-1", "omnidewalt", frozenset({"viewer"})),
            "approver": Principal("user-1", "tenant-a", frozenset({"approver"})),
        }
    )
    return TestClient(
        create_app(
            settings=Settings(webhook_secret="test"),
            auth_verifier=verifier,
            metrics=MetricsRegistry(),
        )
    )


def test_request_metrics_record_route_and_status() -> None:
    client = metrics_client()
    assert client.get("/health").status_code == 200
    text = client.get("/metrics").text
    assert 'http_requests_total{method="GET",route="/health",status="200"} 1.0' in text
    assert 'http_request_duration_seconds_count{route="/health"} 1.0' in text


def test_metric_labels_use_route_templates_not_ids() -> None:
    client = metrics_client()
    response = client.get("/approvals/abc-secret-id")
    assert response.status_code == 401
    text = client.get("/metrics").text
    assert 'route="/approvals/{approval_id}"' in text
    assert "abc-secret-id" not in text


def test_chat_counter_records_the_answer_source() -> None:
    client = metrics_client()
    response = client.post(
        "/chat",
        headers={"Authorization": "Bearer viewer"},
        json={"message": "How many tickets?", "tickets": []},
    )
    assert response.status_code == 200
    assert response.json()["source"] == "local"
    text = client.get("/metrics").text
    assert 'chat_requests_total{source="local"} 1.0' in text


def test_approval_decision_counters() -> None:
    client = metrics_client()
    headers = {"Authorization": "Bearer approver"}
    created = client.post(
        "/approvals",
        headers=headers,
        json={
            "caseId": "case-1",
            "tenantId": "tenant-a",
            "action": {"draft": "Answer [doc-1:0-12]"},
            "evidence": [{"sourceId": "doc-1", "span": "0-12"}],
            "approver": "user-1",
            "scope": "support:send",
            "expiresAt": "2030-01-01T00:00:00+00:00",
        },
    )
    assert created.status_code == 201, created.text
    approval_id = created.json()["id"]
    decision = client.post(
        f"/approvals/{approval_id}/decision",
        headers=headers,
        json={"decision": "approved", "comment": "ok"},
    )
    assert decision.status_code == 200, decision.text
    text = client.get("/metrics").text
    assert 'approval_decisions_total{decision="approved"} 1.0' in text
    assert 'gate_decisions_total{gate="support:send"} 1.0' in text


def test_security_counters_render_bounded_labels() -> None:
    metrics = MetricsRegistry()
    metrics.record_security_triage(classification="tp", severity="high", injection=True)
    metrics.record_security_triage(classification="fp", severity="low", injection=False)
    metrics.record_security_containment(outcome="contained", replayed=False)
    metrics.record_security_containment(outcome="contained", replayed=True)
    text = metrics.render().decode()
    assert (
        'security_triage_verdicts_total{classification="tp",injection="flagged",severity="high"} 1.0'
        in text
    )
    assert (
        'security_triage_verdicts_total{classification="fp",injection="clean",severity="low"} 1.0'
        in text
    )
    assert 'security_containment_total{outcome="contained",replayed="false"} 1.0' in text
    assert 'security_containment_total{outcome="contained",replayed="true"} 1.0' in text


def test_metrics_endpoint_is_present_without_a_registry() -> None:
    client = TestClient(create_app(settings=Settings(webhook_secret="test")))
    response = client.get("/metrics")
    assert response.status_code == 200
    assert "http_requests_total" not in response.text
