from __future__ import annotations

from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.board_chat import ChatCompleter, local_answer, sanitize_tickets, system_prompt
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient


class FakeCompleter:
    def __init__(self, reply: str = "SCRUM-5 is the month-end recon ticket.") -> None:
        self.reply = reply
        self.calls: list[tuple[str, str]] = []

    async def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        return self.reply


def tickets() -> list[dict[str, object]]:
    return [
        {
            "key": "SCRUM-5",
            "summary": "Reconcile September month-end ledger against bank",
            "status": "To Do",
            "issueType": "Task",
            "priority": "Medium",
            "assignee": None,
            "labels": ["finance", "ledger"],
        }
    ]


def chat_client(completer: ChatCompleter | None = None) -> TestClient:
    verifier = FakeBearerVerifier(
        {
            "viewer": Principal("user-1", "omnidewalt", frozenset({"viewer"})),
            "none": Principal("user-2", "omnidewalt", frozenset()),
        }
    )
    return TestClient(
        create_app(
            settings=Settings(webhook_secret="test"),
            auth_verifier=verifier,
            chat_completer=completer,
        )
    )


def test_sanitize_drops_unsafe_keys_and_local_answer_uses_snapshot() -> None:
    cleaned = sanitize_tickets(
        [tickets()[0], {"key": "../ADMIN", "summary": "nope"}, "bad"]
    )
    assert [item["key"] for item in cleaned] == ["SCRUM-5"]
    assert "SCRUM-5" in local_answer("Tell me about SCRUM-5", cleaned, None)
    assert "password" in local_answer("How do I sign in?", cleaned, None).lower()
    assert "sandbox" in local_answer("What does finance posting do?", cleaned, None)
    assert "There are 1 tickets" in local_answer("How many tickets?", cleaned, None)
    assert "SCRUM-5" in system_prompt(cleaned, "SCRUM-5")


def test_chat_requires_role_and_uses_the_model() -> None:
    completer = FakeCompleter()
    client = chat_client(completer)
    payload = {"message": "What is SCRUM-5?", "selectedKey": "SCRUM-5", "tickets": tickets()}
    assert client.post("/chat", json=payload).status_code == 401
    assert client.post(
        "/chat", headers={"Authorization": "Bearer none"}, json=payload
    ).status_code == 403
    response = client.post(
        "/chat", headers={"Authorization": "Bearer viewer"}, json=payload
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"] == "model"
    assert "SCRUM-5" in body["reply"]
    assert completer.calls[0][1] == "What is SCRUM-5?"


def test_chat_falls_back_locally_when_no_model_is_configured() -> None:
    client = chat_client(None)
    response = client.post(
        "/chat",
        headers={"Authorization": "Bearer viewer"},
        json={"message": "How many tickets are on the board?", "tickets": tickets()},
    )
    assert response.status_code == 200
    assert response.json()["source"] == "local"
    assert "SCRUM-5" in response.json()["reply"]


class BrokenCompleter:
    async def complete(self, system: str, user: str) -> str:
        raise ValueError("provider failed")


def test_chat_falls_back_locally_when_the_model_fails() -> None:
    client = chat_client(BrokenCompleter())
    response = client.post(
        "/chat",
        headers={"Authorization": "Bearer viewer"},
        json={"message": "What is SCRUM-5?", "tickets": tickets()},
    )
    assert response.status_code == 200
    assert response.json()["source"] == "local"
    assert "SCRUM-5" in response.json()["reply"]
