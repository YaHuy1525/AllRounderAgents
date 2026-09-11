from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx
import pytest
from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.board_chat import ChatCompleter, local_answer, sanitize_tickets
from allrounder_api.knowledge import OpenAICompatibleAdapter
from allrounder_api.metrics import MetricsRegistry
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient


class FakeStreamer:
    def __init__(self, deltas: list[str], fail_after: int | None = None) -> None:
        self.deltas = deltas
        self.fail_after = fail_after
        self.calls: list[tuple[str, str]] = []

    async def complete(self, system: str, user: str) -> str:
        return "".join(self.deltas)

    async def stream(self, system: str, user: str) -> AsyncIterator[str]:
        self.calls.append((system, user))
        for index, delta in enumerate(self.deltas):
            if self.fail_after is not None and index >= self.fail_after:
                raise httpx.ConnectError("model stream failed")
            yield delta
        if self.fail_after is not None and self.fail_after >= len(self.deltas):
            raise httpx.ConnectError("model stream failed")


class CompleterOnly:
    async def complete(self, system: str, user: str) -> str:
        return "complete-only"


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


def stream_client(
    completer: ChatCompleter | None = None,
    metrics: MetricsRegistry | None = None,
) -> TestClient:
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
            metrics=metrics,
        )
    )


def posted(client: TestClient, message: str) -> httpx.Response:
    return client.post(
        "/chat/stream",
        headers={"Authorization": "Bearer viewer"},
        json={"message": message, "selectedKey": "SCRUM-5", "tickets": tickets()},
    )


def sse_events(response: httpx.Response) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for line in response.text.splitlines():
        if line.startswith("data: "):
            value = json.loads(line[6:])
            assert isinstance(value, dict)
            events.append(value)
    return events


def deltas_text(events: list[dict[str, object]]) -> str:
    return "".join(str(event["delta"]) for event in events[:-1])


def test_stream_requires_a_bearer_and_a_role() -> None:
    client = stream_client(FakeStreamer(["hi"]))
    payload = {"message": "What is SCRUM-5?", "tickets": tickets()}
    assert client.post("/chat/stream", json=payload).status_code == 401
    denied = client.post(
        "/chat/stream", headers={"Authorization": "Bearer none"}, json=payload
    )
    assert denied.status_code == 403


def test_stream_relays_model_deltas_in_order() -> None:
    streamer = FakeStreamer(["SCRUM-5 is ", "the month-end recon ticket."])
    response = posted(stream_client(streamer), "What is SCRUM-5?")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["x-accel-buffering"] == "no"
    assert response.text.endswith("\n\n")
    assert sse_events(response) == [
        {"delta": "SCRUM-5 is "},
        {"delta": "the month-end recon ticket."},
        {"done": True, "source": "model", "interrupted": False},
    ]
    assert streamer.calls[0][1] == "What is SCRUM-5?"


def test_stream_falls_back_locally_without_a_streamer() -> None:
    message = "How many tickets are on the board?"
    response = posted(stream_client(None), message)
    events = sse_events(response)
    assert events[-1] == {"done": True, "source": "local", "interrupted": False}
    expected = local_answer(message, sanitize_tickets(tickets()), "SCRUM-5")
    assert deltas_text(events) == expected
    assert "SCRUM-5" in expected


def test_stream_falls_back_locally_when_completer_cannot_stream() -> None:
    response = posted(stream_client(CompleterOnly()), "What is SCRUM-5?")
    events = sse_events(response)
    assert events[-1] == {"done": True, "source": "local", "interrupted": False}
    assert "SCRUM-5" in deltas_text(events)


def test_stream_falls_back_locally_when_model_fails_before_first_token() -> None:
    streamer = FakeStreamer(["never sent"], fail_after=0)
    response = posted(stream_client(streamer), "What is SCRUM-5?")
    events = sse_events(response)
    assert events[-1] == {"done": True, "source": "local", "interrupted": False}
    assert "SCRUM-5" in deltas_text(events)
    assert streamer.calls


def test_stream_marks_mid_stream_failure_as_interrupted() -> None:
    streamer = FakeStreamer(["partial answer"], fail_after=1)
    response = posted(stream_client(streamer), "What is SCRUM-5?")
    events = sse_events(response)
    assert events[0] == {"delta": "partial answer"}
    assert events[-1] == {"done": True, "source": "model", "interrupted": True}


def test_stream_records_time_to_first_token_by_source() -> None:
    metrics = MetricsRegistry()
    model_client = stream_client(FakeStreamer(["Hello ", "world"]), metrics)
    assert posted(model_client, "What is SCRUM-5?").status_code == 200
    exposition = model_client.get("/metrics").text
    assert 'chat_first_token_seconds_count{source="model"} 1.0' in exposition
    local_client = stream_client(None, metrics)
    assert posted(local_client, "How many tickets?").status_code == 200
    exposition = local_client.get("/metrics").text
    assert 'chat_first_token_seconds_count{source="local"} 1.0' in exposition


async def test_adapter_stream_parses_openai_sse_frames() -> None:
    captured: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body_json = json.loads(request.content)
        assert isinstance(body_json, dict)
        captured.append(body_json)
        body = (
            ": keep-alive\n\n"
            "data: not-json\n\n"
            'data: {"choices": [{"delta": {"content": "Hello "}}]}\n\n'
            'data: {"choices": [{"delta": {}}], "usage": {}}\n\n'
            'data: {"choices": [{"delta": {"content": "world"}}]}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(
            200, content=body, headers={"content-type": "text/event-stream"}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        adapter = OpenAICompatibleAdapter(
            base_url="https://model.example/v1",
            api_key="test-key",
            embedding_model="embed",
            dimensions=1536,
            chat_model="chat",
            client=client,
        )
        deltas = [delta async for delta in adapter.stream("system", "user")]
    finally:
        await client.aclose()
    assert deltas == ["Hello ", "world"]
    assert captured == [
        {
            "model": "chat",
            "temperature": 0,
            "stream": True,
            "messages": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "user"},
            ],
        }
    ]


async def test_adapter_stream_raises_on_provider_error_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        adapter = OpenAICompatibleAdapter(
            base_url="https://model.example/v1",
            api_key="test-key",
            embedding_model="embed",
            dimensions=1536,
            chat_model="chat",
            client=client,
        )
        with pytest.raises(httpx.HTTPStatusError):
            async for _ in adapter.stream("system", "user"):
                pass
    finally:
        await client.aclose()
