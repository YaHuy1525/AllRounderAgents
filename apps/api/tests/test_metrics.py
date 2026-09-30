from __future__ import annotations

from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.metrics import MetricsRegistry
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import (
    RunServiceConfig,
    ScriptedMastraRunClient,
    build_memory_run_service,
)
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
        'security_triage_verdicts_total{classification="tp",injection="flagged",'
        'severity="high"} 1.0'
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


def test_summary_aggregates_runs_decisions_and_latency() -> None:
    metrics = MetricsRegistry()
    metrics.record_run(workflow="review", status="completed")
    metrics.record_run(workflow="review", status="completed")
    metrics.record_run(workflow="review", status="failed")
    metrics.record_run(workflow="leave", status="completed")
    metrics.record_run_decision(workflow="review", action="proceed")
    metrics.record_request("GET", "/runs", 200, 0.02)
    metrics.record_request("GET", "/runs", 200, 0.05)

    summary = metrics.summary(
        active_statuses=["running", "awaiting_human", "awaiting_human"]
    )

    assert summary["runs"] == {
        "total": 4,
        "completed": 3,
        "failed": 1,
        "cancelled": 0,
        "successRate": 0.75,
    }
    assert summary["workflows"] == [
        {"workflow": "review", "total": 3, "completed": 2, "failed": 1, "cancelled": 0},
        {"workflow": "leave", "total": 1, "completed": 1, "failed": 0, "cancelled": 0},
    ]
    assert summary["decisions"] == {"proceed": 1}
    assert summary["queue"] == {
        "active": 3,
        "queued": 0,
        "running": 1,
        "awaitingHuman": 2,
        "blocked": 0,
    }
    assert summary["latency"]["overall"] == {"count": 2, "p50": 0.025, "p95": 0.0475}
    assert summary["latency"]["http"] == [
        {"route": "/runs", "count": 2, "p50": 0.025, "p95": 0.0475}
    ]
    assert isinstance(summary["generatedAt"], str)


def test_summary_is_empty_before_any_traffic() -> None:
    summary = MetricsRegistry().summary()
    assert summary["runs"] == {
        "total": 0,
        "completed": 0,
        "failed": 0,
        "cancelled": 0,
        "successRate": None,
    }
    assert summary["workflows"] == []
    assert summary["decisions"] == {}
    assert summary["latency"]["overall"] == {"count": 0, "p50": None, "p95": None}
    assert summary["latency"]["http"] == []


def test_metrics_summary_requires_a_verified_viewer() -> None:
    client = metrics_client()
    assert client.get("/metrics/summary").status_code == 401
    assert (
        client.get(
            "/metrics/summary", headers={"Authorization": "Bearer missing"}
        ).status_code
        == 401
    )
    response = client.get("/metrics/summary", headers={"Authorization": "Bearer viewer"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["runs"]["total"] == 0
    assert payload["workflows"] == []
    assert payload["queue"]["active"] == 0


def test_metrics_summary_rejects_principals_without_a_view_role() -> None:
    verifier = FakeBearerVerifier(
        {"nobody": Principal("user-9", "tenant-z", frozenset())}
    )
    client = TestClient(
        create_app(
            settings=Settings(webhook_secret="test"),
            auth_verifier=verifier,
            metrics=MetricsRegistry(),
        )
    )
    response = client.get("/metrics/summary", headers={"Authorization": "Bearer nobody"})
    assert response.status_code == 403


def test_metrics_summary_reports_live_queue_depth_per_tenant() -> None:
    registry = MetricsRegistry()
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(b"metrics-summary-secret-for-tests-0001"),
        approvals=InMemoryApprovalRepository(),
        mastra=ScriptedMastraRunClient(
            {"reviewFlow": ("select-pr", "review-options", "ai-review", "complete")}
        ),
        max_concurrent=5,
        config=RunServiceConfig(),
        metrics=registry,
    )
    client = TestClient(
        create_app(
            settings=Settings(webhook_secret="test"),
            auth_verifier=FakeBearerVerifier(
                {
                    "agent": Principal("user-1", "tenant-a", frozenset({"agent"})),
                    "viewer": Principal("user-2", "tenant-a", frozenset({"viewer"})),
                    "outsider": Principal("user-3", "tenant-b", frozenset({"viewer"})),
                }
            ),
            metrics=registry,
            runs_service=service,
        )
    )
    created = client.post(
        "/runs",
        headers={"Authorization": "Bearer agent"},
        json={
            "workflow": "review",
            "ticketKey": "ENG-1",
            "caseId": "case-1",
            "input": {"repository": "acme/app", "prNumber": 7},
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["status"] == "awaiting_human"

    payload = client.get(
        "/metrics/summary", headers={"Authorization": "Bearer viewer"}
    ).json()
    assert payload["queue"] == {
        "active": 1,
        "queued": 0,
        "running": 0,
        "awaitingHuman": 1,
        "blocked": 0,
    }
    assert payload["runs"]["total"] == 0

    other = client.get(
        "/metrics/summary", headers={"Authorization": "Bearer outsider"}
    ).json()
    assert other["queue"]["active"] == 0
