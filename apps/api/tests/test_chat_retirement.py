from __future__ import annotations

import hashlib

from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.metrics import MetricsRegistry
from allrounder_api.repositories import InMemoryFeedbackRepository
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

DIGEST = hashlib.sha256(b"which tickets look stuck?").hexdigest()


def client() -> TestClient:
    verifier = FakeBearerVerifier(
        {
            "viewer": Principal("user-1", "tenant-a", frozenset({"viewer"})),
        }
    )
    return TestClient(
        create_app(
            settings=Settings(webhook_secret="test"),
            auth_verifier=verifier,
            feedback_repository=InMemoryFeedbackRepository(),
        )
    )


def test_ladder_routes_are_gone() -> None:
    http = client()
    for path in ("/chat", "/chat/stream"):
        response = http.post(
            path,
            headers={"Authorization": "Bearer viewer"},
            json={"message": "Which tickets look stuck?", "tickets": []},
        )
        assert response.status_code == 404, path


def test_metrics_have_no_chat_series() -> None:
    # The registry renders a labelled series only once it has been touched, so an
    # untouched /metrics body proves nothing. The structural half does: with the
    # recorder gone there is no code path that can ever emit the series again.
    registry = MetricsRegistry()
    assert not hasattr(registry, "record_chat")
    assert not hasattr(registry, "record_chat_stream")
    assert not hasattr(registry, "chat_requests")
    assert not hasattr(registry, "chat_first_token")

    http = client()
    assert http.get("/health").status_code == 200
    text = http.get("/metrics").text
    assert "chat_requests_total" not in text
    assert "chat_first_token_seconds" not in text


def test_feedback_route_still_works() -> None:
    http = client()
    response = http.post(
        "/chat/feedback",
        headers={"Authorization": "Bearer viewer"},
        json={"messageSha256": DIGEST, "rating": "up"},
    )
    assert response.status_code == 200
    assert response.json() == {"stored": True}
