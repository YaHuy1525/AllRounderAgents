from __future__ import annotations

import hashlib

from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.repositories import InMemoryFeedbackRepository
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

DIGEST = hashlib.sha256(b"how many tickets are open?").hexdigest()


def feedback_client(repository: InMemoryFeedbackRepository) -> TestClient:
    verifier = FakeBearerVerifier(
        {
            "viewer": Principal("user-1", "tenant-a", frozenset({"viewer"})),
            "guest": Principal("user-2", "tenant-a", frozenset({"guest"})),
        }
    )
    return TestClient(
        create_app(
            settings=Settings(webhook_secret="test"),
            auth_verifier=verifier,
            feedback_repository=repository,
        )
    )


def test_feedback_requires_authentication() -> None:
    client = feedback_client(InMemoryFeedbackRepository())
    response = client.post(
        "/chat/feedback",
        json={"messageSha256": DIGEST, "rating": "up"},
    )
    assert response.status_code == 401


def test_feedback_rejects_unauthorized_roles() -> None:
    client = feedback_client(InMemoryFeedbackRepository())
    response = client.post(
        "/chat/feedback",
        headers={"Authorization": "Bearer guest"},
        json={"messageSha256": DIGEST, "rating": "up"},
    )
    assert response.status_code == 403


def test_feedback_stores_hash_rating_and_reason() -> None:
    repository = InMemoryFeedbackRepository()
    client = feedback_client(repository)
    response = client.post(
        "/chat/feedback",
        headers={"Authorization": "Bearer viewer"},
        json={
            "messageSha256": DIGEST,
            "rating": "down",
            "reason": "missing context",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"stored": True}
    assert len(repository.entries) == 1
    entry = repository.entries[0]
    assert entry.tenant_id == "tenant-a"
    assert entry.message_sha256 == DIGEST
    assert entry.rating == "down"
    assert entry.reason == "missing context"


def test_feedback_normalizes_hash_case_and_blank_reason() -> None:
    repository = InMemoryFeedbackRepository()
    client = feedback_client(repository)
    response = client.post(
        "/chat/feedback",
        headers={"Authorization": "Bearer viewer"},
        json={"messageSha256": DIGEST.upper(), "rating": "report", "reason": "   "},
    )
    assert response.status_code == 200, response.text
    entry = repository.entries[0]
    assert entry.message_sha256 == DIGEST
    assert entry.reason is None


def test_feedback_rejects_invalid_payloads_without_storing() -> None:
    repository = InMemoryFeedbackRepository()
    client = feedback_client(repository)
    headers = {"Authorization": "Bearer viewer"}
    bad_rating = client.post(
        "/chat/feedback",
        headers=headers,
        json={"messageSha256": DIGEST, "rating": "sideways"},
    )
    bad_hash = client.post(
        "/chat/feedback",
        headers=headers,
        json={"messageSha256": "not-a-hash", "rating": "up"},
    )
    long_reason = client.post(
        "/chat/feedback",
        headers=headers,
        json={"messageSha256": DIGEST, "rating": "up", "reason": "x" * 201},
    )
    assert bad_rating.status_code == 422
    assert bad_hash.status_code == 422
    assert long_reason.status_code == 422
    assert repository.entries == []
