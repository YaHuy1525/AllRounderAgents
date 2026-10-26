from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from allrounder_api.knowledge import (
    RRF_K,
    CitationSpan,
    CitedPassage,
    CohereReranker,
    DeterministicEmbeddingProvider,
    InMemoryKnowledgeStore,
    KnowledgeDocument,
    NoopReranker,
    RetrievalTuning,
    _Candidate,
    reciprocal_rank_fusion,
)
from allrounder_api.settings import Settings

NOW = datetime(2026, 9, 12, tzinfo=UTC)


def passage(source_id: str) -> CitedPassage:
    return CitedPassage(
        content=source_id,
        citation=CitationSpan(source_id, 0, len(source_id)),
        score=0.5,
        stale=False,
        source_version="1",
    )


def candidate(chunk_id: str) -> _Candidate:
    return _Candidate(
        chunk_id=chunk_id,
        content=chunk_id,
        citation=CitationSpan(chunk_id, 0, 1),
        stale=False,
        source_version="1",
    )


def document(source_id: str, content: str, tenant: str = "tenant-a") -> KnowledgeDocument:
    return KnowledgeDocument(
        source_id=source_id,
        tenant_id=tenant,
        domain="support",
        title=source_id,
        content=content,
        source_version="1",
        stale_after=NOW + timedelta(days=30),
    )


class ReverseReranker:
    model = "reverse-v1"

    async def rerank(
        self, query: str, passages: list[CitedPassage], top_n: int
    ) -> list[CitedPassage]:
        return [
            replace(item, score=1.0 - index * 0.1, rerank_score=1.0 - index * 0.1)
            for index, item in enumerate(reversed(passages))
        ][:top_n]


class FailingReranker:
    model = "broken-v1"

    async def rerank(
        self, query: str, passages: list[CitedPassage], top_n: int
    ) -> list[CitedPassage]:
        raise RuntimeError("rerank backend down")


class RecordingReranker:
    model = "recording-v1"

    def __init__(self) -> None:
        self.seen: list[str] = []

    async def rerank(
        self, query: str, passages: list[CitedPassage], top_n: int
    ) -> list[CitedPassage]:
        self.seen = [item.citation.source_id for item in passages]
        return passages[:top_n]


def test_reciprocal_rank_fusion_merges_sums_and_breaks_ties() -> None:
    fused = reciprocal_rank_fusion(
        [[candidate("a"), candidate("b")], [candidate("b"), candidate("c")]]
    )
    assert [item.chunk_id for _, item in fused] == ["b", "a", "c"]
    expected = {
        "a": 1 / (RRF_K + 1),
        "b": 1 / (RRF_K + 1) + 1 / (RRF_K + 2),
        "c": 1 / (RRF_K + 2),
    }
    for score, item in fused:
        assert score == pytest.approx(expected[item.chunk_id])
    tied = reciprocal_rank_fusion([[candidate("z")], [candidate("y")]])
    assert [item.chunk_id for _, item in tied] == ["y", "z"]
    custom = reciprocal_rank_fusion([[candidate("a")]], k=1)
    assert custom[0][0] == pytest.approx(1 / 2)


@pytest.mark.asyncio
async def test_memory_hybrid_recall_merges_dense_and_lexical_arms() -> None:
    recorder = RecordingReranker()
    store = InMemoryKnowledgeStore(
        DeterministicEmbeddingProvider("fake-embed-v1", 64),
        reranker=recorder,
        tuning=RetrievalTuning(recall_k=1),
    )
    # Ingested out of alphabetical order: on the cosine tie the stable dense
    # sort keeps doc-b first, while the lexical arm re-ranks by chunk id.
    await store.ingest(document("doc-b", "beta"))
    await store.ingest(document("doc-a", "alpha"))
    result = await store.retrieve("tenant-a", "support", "alpha beta", 1, now=NOW)
    assert recorder.seen == ["doc-a", "doc-b"]
    assert [item.citation.source_id for item in result.passages] == ["doc-a"]
    # The document title travels with the passage for prompt display.
    assert result.passages[0].title == "doc-a"
    assert result.rerank_model == "recording-v1"
    assert result.rerank_degraded is False


@pytest.mark.asyncio
async def test_noop_reranker_passes_through_and_truncates() -> None:
    reranker = NoopReranker()
    passages = [passage("a"), passage("b")]
    assert await reranker.rerank("q", passages, 5) == passages
    assert await reranker.rerank("q", passages, 1) == passages[:1]
    assert reranker.model == "noop"


@pytest.mark.asyncio
async def test_store_rerank_reorders_and_replaces_scores() -> None:
    store = InMemoryKnowledgeStore(
        DeterministicEmbeddingProvider("fake-embed-v1", 64),
        reranker=ReverseReranker(),
    )
    await store.ingest(document("doc-a", "alpha"))
    await store.ingest(document("doc-b", "beta"))
    result = await store.retrieve("tenant-a", "support", "alpha beta", 2, now=NOW)
    assert [item.citation.source_id for item in result.passages] == ["doc-b", "doc-a"]
    first = result.passages[0]
    assert first.score == pytest.approx(1.0)
    assert first.rerank_score == pytest.approx(1.0)
    assert all(item.rerank_score is not None for item in result.passages)
    assert result.rerank_model == "reverse-v1"
    assert result.rerank_degraded is False


@pytest.mark.asyncio
async def test_store_rerank_failure_degrades_to_fused_order() -> None:
    plain = InMemoryKnowledgeStore(DeterministicEmbeddingProvider("fake-embed-v1", 64))
    failing = InMemoryKnowledgeStore(
        DeterministicEmbeddingProvider("fake-embed-v1", 64),
        reranker=FailingReranker(),
    )
    for store in (plain, failing):
        await store.ingest(document("doc-a", "alpha"))
        await store.ingest(document("doc-b", "beta"))
    expected = await plain.retrieve("tenant-a", "support", "alpha beta", 2, now=NOW)
    degraded = await failing.retrieve("tenant-a", "support", "alpha beta", 2, now=NOW)
    assert expected.rerank_degraded is False
    assert degraded.rerank_degraded is True
    assert degraded.rerank_model is None
    assert degraded.passages == expected.passages


@pytest.mark.asyncio
async def test_cohere_reranker_maps_relevance_scores() -> None:
    captured: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "results": [
                    {"index": 1, "relevance_score": 0.9},
                    {"index": 0, "relevance_score": 0.2},
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        reranker = CohereReranker(api_key="fake-key", client=client)
        ranked = await reranker.rerank("quarterly policy", [passage("a"), passage("b")], 5)
    assert [item.citation.source_id for item in ranked] == ["b", "a"]
    assert ranked[0].score == pytest.approx(0.9)
    assert ranked[0].rerank_score == pytest.approx(0.9)
    assert reranker.model == "rerank-v3.5"
    request = captured[0]
    assert request.url.path == "/v2/rerank"
    assert request.headers["authorization"] == "Bearer fake-key"
    body = json.loads(request.content)
    assert body["model"] == "rerank-v3.5"
    assert body["query"] == "quarterly policy"
    assert body["documents"] == ["a", "b"]
    assert body["top_n"] == 2


def test_cohere_reranker_requires_api_key() -> None:
    with pytest.raises(ValueError):
        CohereReranker(api_key="")


@pytest.mark.asyncio
async def test_cohere_reranker_rejects_invalid_results() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [{"index": 5, "relevance_score": 0.9}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        reranker = CohereReranker(api_key="fake-key", client=client)
        with pytest.raises(ValueError):
            await reranker.rerank("q", [passage("a")], 1)


@pytest.mark.asyncio
async def test_cohere_reranker_surfaces_http_errors_without_retry() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"message": "boom"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        reranker = CohereReranker(api_key="fake-key", attempts=1, client=client)
        with pytest.raises(httpx.HTTPStatusError):
            await reranker.rerank("q", [passage("a")], 1)


def test_retrieval_tuning_resolves_settings_and_per_tenant_overrides() -> None:
    settings = Settings(retrieval_rrf_k=10, retrieval_recall_k=5)
    tuning = RetrievalTuning.from_settings(settings)
    assert tuning.rrf_k == 10
    assert tuning.recall_k == 5
    overrides = {"tenant-a": {"recall_k": 50}, "tenant-b": {"rrf_k": 1}}
    merged = tuning.for_tenant("tenant-a", overrides)
    assert merged.recall_k == 50
    assert merged.rrf_k == 10
    other = tuning.for_tenant("tenant-b", overrides)
    assert other.rrf_k == 1
    assert other.recall_k == 5
    assert tuning.for_tenant("tenant-c", overrides) == tuning
    assert tuning.for_tenant("tenant-c", None) == tuning


@pytest.mark.asyncio
async def test_store_applies_per_tenant_tuning_overrides() -> None:
    recorder = RecordingReranker()
    store = InMemoryKnowledgeStore(
        DeterministicEmbeddingProvider("fake-embed-v1", 64),
        reranker=recorder,
        tuning=RetrievalTuning(recall_k=3),
        tenant_overrides={"tenant-a": {"rrf_k": 1, "recall_k": 1}},
    )
    for tenant in ("tenant-a", "tenant-b"):
        for source, content in (("doc-a", "alpha"), ("doc-b", "beta"), ("doc-c", "gamma")):
            await store.ingest(document(source, content, tenant=tenant))
    overridden = await store.retrieve("tenant-a", "support", "alpha beta gamma", 1, now=NOW)
    assert recorder.seen == ["doc-a"]  # recall_k 1 narrows both arms to one candidate
    assert overridden.passages[0].score == pytest.approx(1.0)  # rrf_k 1: 1/(1+1) per arm
    untouched = await store.retrieve("tenant-b", "support", "alpha beta gamma", 1, now=NOW)
    assert recorder.seen == ["doc-a", "doc-b", "doc-c"]  # store tuning recall_k 3
    assert untouched.passages[0].score == pytest.approx(2 / (RRF_K + 1))
