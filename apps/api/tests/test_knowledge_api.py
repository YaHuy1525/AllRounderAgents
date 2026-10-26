"""The service-to-service knowledge search route.

The Mastra host grounds the MSP draft step here. The contract under test:
the route is mounted only when a retriever and a service token are both
configured, it accepts exactly the shared bearer (no console roles), it
forwards tenant and domain to the store untouched, and an empty scope is a
200 with no passages because escalation is the caller's decision.
"""

from __future__ import annotations

from allrounder_api.app import create_app
from allrounder_api.knowledge import (
    CitationSpan,
    CitedPassage,
    EmptyRetrievalError,
    RetrievalResult,
)
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

TOKEN = "knowledge-service-token-for-tests"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}
BODY = {
    "tenantId": "mspco",
    "domain": "msp:acme",
    "query": "vpn client drops every hour",
    "k": 3,
}


class RecordingRetriever:
    """A retriever that records the scope it was asked for and replays a result."""

    def __init__(self, result: RetrievalResult | Exception) -> None:
        self.calls: list[tuple[str, str, str, int]] = []
        self._result = result

    async def retrieve(
        self,
        tenant_id: str,
        domain: str,
        query: str,
        k: int,
        *,
        now: object = None,
    ) -> RetrievalResult:
        self.calls.append((tenant_id, domain, query, k))
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


def _result() -> RetrievalResult:
    return RetrievalResult(
        passages=[
            CitedPassage(
                content="Reset the VPN client before the next shift.",
                citation=CitationSpan(source_id="runbook-vpn", start=0, end=44),
                score=0.91,
                stale=False,
                source_version="v3",
                title="VPN runbook",
            ),
            CitedPassage(
                content="Escalate to tier two when the client cannot authenticate.",
                citation=CitationSpan(source_id="runbook-auth", start=10, end=70),
                score=0.55,
                stale=True,
                source_version="v1",
                rerank_score=0.42,
                title="Auth runbook",
            ),
        ],
        embedding_model="text-embedding-test",
        rerank_model="rerank-v3.5",
    )


def _client(
    retriever: RecordingRetriever | None = None,
    token: str | None = None,
) -> TestClient:
    app = create_app(
        settings=Settings(webhook_secret="test"),
        knowledge_retriever=retriever,  # type: ignore[arg-type]
        knowledge_service_token=token,
    )
    return TestClient(app)


# --------------------------------------------------------------- mounting


def test_route_mounts_only_with_retriever_and_token() -> None:
    retriever = RecordingRetriever(_result())
    # Either half missing keeps the route off the app: a token without a
    # store cannot answer, and a store without a token must not be exposed.
    assert _client().post("/knowledge/search", json=BODY).status_code == 404
    assert (
        _client(retriever=retriever).post("/knowledge/search", json=BODY).status_code == 404
    )
    assert _client(token=TOKEN).post("/knowledge/search", json=BODY).status_code == 404


def test_search_requires_the_service_bearer() -> None:
    retriever = RecordingRetriever(_result())
    http = _client(retriever=retriever, token=TOKEN)

    assert http.post("/knowledge/search", json=BODY).status_code == 401
    wrong = http.post(
        "/knowledge/search",
        json=BODY,
        headers={"Authorization": "Bearer some-other-token"},
    )
    assert wrong.status_code == 401
    assert wrong.json() == {"detail": "Invalid credentials"}
    # A console-style credential does not open this door; it is not a user route.
    scheme = http.post(
        "/knowledge/search",
        json=BODY,
        headers={"Authorization": "Basic dXNlcjpwYXNz"},
    )
    assert scheme.status_code == 401
    assert retriever.calls == []


# ------------------------------------------------------------------ search


def test_search_forwards_scope_and_maps_passages() -> None:
    retriever = RecordingRetriever(_result())
    http = _client(retriever=retriever, token=TOKEN)

    response = http.post("/knowledge/search", json=BODY, headers=HEADERS)
    assert response.status_code == 200
    assert retriever.calls == [("mspco", "msp:acme", BODY["query"], 3)]

    body = response.json()
    assert body["embeddingModel"] == "text-embedding-test"
    assert body["rerankModel"] == "rerank-v3.5"
    assert body["rerankDegraded"] is False
    assert body["passages"] == [
        {
            "sourceId": "runbook-vpn",
            "span": "0-44",
            "title": "VPN runbook",
            "text": "Reset the VPN client before the next shift.",
            "score": 0.91,
            "stale": False,
            "sourceVersion": "v3",
        },
        {
            "sourceId": "runbook-auth",
            "span": "10-70",
            "title": "Auth runbook",
            "text": "Escalate to tier two when the client cannot authenticate.",
            "score": 0.55,
            "stale": True,
            "sourceVersion": "v1",
        },
    ]


def test_search_defaults_k_and_answers_empty_scope_with_no_passages() -> None:
    retriever = RecordingRetriever(EmptyRetrievalError("no documents in scope"))
    http = _client(retriever=retriever, token=TOKEN)

    response = http.post(
        "/knowledge/search",
        json={"tenantId": "mspco", "domain": "msp:acme", "query": "printer offline"},
        headers=HEADERS,
    )
    assert response.status_code == 200
    assert retriever.calls == [("mspco", "msp:acme", "printer offline", 5)]
    assert response.json() == {
        "passages": [],
        "embeddingModel": None,
        "rerankModel": None,
        "rerankDegraded": False,
    }


def test_search_validation_rejects_malformed_requests() -> None:
    retriever = RecordingRetriever(_result())
    http = _client(retriever=retriever, token=TOKEN)

    bad_requests = [
        {"tenantId": "-leading", "domain": "msp:acme", "query": "q"},
        {"tenantId": "mspco", "domain": "MSP:ACME", "query": "q"},
        {"tenantId": "mspco", "domain": "msp:acme", "query": ""},
        {"tenantId": "mspco", "domain": "msp:acme", "query": "q", "k": 0},
        {"tenantId": "mspco", "domain": "msp:acme", "query": "q", "k": 21},
    ]
    for payload in bad_requests:
        rejected = http.post("/knowledge/search", json=payload, headers=HEADERS)
        assert rejected.status_code == 422, payload
    assert retriever.calls == []
