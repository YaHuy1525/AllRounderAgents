from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .resilience import DEFAULT_ATTEMPTS, retry_async


class EmptyRetrievalError(LookupError):
    """Raised when grounding is unavailable and the caller must escalate."""


class EmbeddingProvider(Protocol):
    model: str
    dimensions: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass(frozen=True)
class KnowledgeDocument:
    source_id: str
    tenant_id: str
    domain: str
    title: str
    content: str
    source_version: str
    stale_after: datetime
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class CitationSpan:
    source_id: str
    start: int
    end: int

    @property
    def span(self) -> str:
        return f"{self.start}-{self.end}"


@dataclass(frozen=True)
class CitedPassage:
    """One retrieved passage.

    ``score`` is the effective ranking score of the stage that produced the
    final order: the fused reciprocal-rank-fusion score on the hybrid path,
    or the reranker's relevance after reranking. ``rerank_score`` repeats
    the relevance for provenance and is ``None`` unless reranking ran.
    """

    content: str
    citation: CitationSpan
    score: float
    stale: bool
    source_version: str
    rerank_score: float | None = None


@dataclass(frozen=True)
class RetrievalResult:
    """A retrieval pass; ``rerank_model`` is set only when reranking produced
    the returned order, and ``rerank_degraded`` is true when a configured
    reranker failed and the fused order was used instead."""

    passages: list[CitedPassage]
    embedding_model: str
    rerank_model: str | None = None
    rerank_degraded: bool = False


@dataclass(frozen=True)
class _Chunk:
    document: KnowledgeDocument
    ordinal: int
    start: int
    end: int
    content: str
    embedding: list[float]
    embedding_model: str
    embedding_dimensions: int


@dataclass(frozen=True)
class _Candidate:
    chunk_id: str
    content: str
    citation: CitationSpan
    stale: bool
    source_version: str


RRF_K = 60
RECALL_K = 30


def reciprocal_rank_fusion(
    arms: Sequence[Sequence[_Candidate]], *, k: int = RRF_K
) -> list[tuple[float, _Candidate]]:
    """Merge ranked arms with reciprocal rank fusion.

    Each hit scores ``1 / (k + rank)`` per arm and the scores sum across
    arms; ties break by chunk id so the merged order is deterministic.
    """
    merged: dict[str, tuple[float, _Candidate]] = {}
    for arm in arms:
        for rank, candidate in enumerate(arm, start=1):
            score = 1.0 / (k + rank)
            prior = merged.get(candidate.chunk_id)
            if prior is None:
                merged[candidate.chunk_id] = (score, candidate)
            else:
                merged[candidate.chunk_id] = (prior[0] + score, prior[1])
    return sorted(merged.values(), key=lambda item: (-item[0], item[1].chunk_id))


def _memory_chunk_id(chunk: _Chunk) -> str:
    document = chunk.document
    return f"{document.source_id}#{document.source_version}#{chunk.ordinal}"


def _memory_candidate(chunk: _Chunk, at: datetime) -> _Candidate:
    return _Candidate(
        chunk_id=_memory_chunk_id(chunk),
        content=chunk.content,
        citation=CitationSpan(chunk.document.source_id, chunk.start, chunk.end),
        stale=chunk.document.stale_after <= at,
        source_version=chunk.document.source_version,
    )


def _candidate_from_row(row: dict[str, Any]) -> _Candidate:
    return _Candidate(
        chunk_id=str(row["chunk_id"]),
        content=str(row["content"]),
        citation=CitationSpan(
            str(row["source_id"]), int(row["span_start"]), int(row["span_end"])
        ),
        stale=bool(row["stale"]),
        source_version=str(row["source_version"]),
    )


def _query_terms(query: str) -> list[str]:
    """Lowercased word tokens (3+ characters) for the in-memory lexical arm."""
    terms: list[str] = []
    for match in re.findall(r"[a-z][a-z0-9-]{2,}", query.lower()):
        if match not in terms:
            terms.append(match)
    return terms


def _matches_term(text: str, term: str) -> bool:
    """Word-boundary test so a short term never matches inside a longer word."""
    return re.search(rf"\b{re.escape(term)}\b", text.lower()) is not None


def chunk_text(
    content: str, chunk_size: int = 800, overlap: int = 100
) -> list[tuple[int, int, str]]:
    if chunk_size < 1 or overlap < 0 or overlap >= chunk_size:
        raise ValueError("chunk_size must be positive and overlap smaller than chunk_size")
    chunks: list[tuple[int, int, str]] = []
    start = 0
    while start < len(content):
        end = min(len(content), start + chunk_size)
        chunks.append((start, end, content[start:end]))
        if end == len(content):
            break
        start = end - overlap
    return chunks


class DeterministicEmbeddingProvider:
    """Credential-free embedding fake with stable normalized vectors."""

    def __init__(self, model: str, dimensions: int) -> None:
        self.model = model
        self.dimensions = dimensions

    async def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            vector = [0.0] * self.dimensions
            for token in text.lower().split():
                digest = hashlib.sha256(token.encode()).digest()
                vector[int.from_bytes(digest[:4], "big") % self.dimensions] += 1.0
            norm = math.sqrt(sum(value * value for value in vector)) or 1.0
            vectors.append([value / norm for value in vector])
        return vectors


def _sse_line_delta(line: str) -> tuple[bool, str] | None:
    """Decode one SSE line: (True, "") is the terminal marker, (False, text) a delta."""
    if not line.startswith("data:"):
        return None
    payload = line[5:].strip()
    if not payload:
        return None
    if payload == "[DONE]":
        return (True, "")
    try:
        value = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict):
        return None
    choices = value.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    delta = first.get("delta")
    if not isinstance(delta, dict):
        return None
    content = delta.get("content")
    if isinstance(content, str) and content:
        return (False, content)
    return None


class OpenAICompatibleAdapter:
    """Provider-neutral adapter for OpenAI-compatible embedding and chat endpoints."""

    def __init__(
        self, *, base_url: str, api_key: str, embedding_model: str,
        dimensions: int, chat_model: str, client: httpx.AsyncClient | None = None,
    ) -> None:
        self.model = embedding_model
        self.dimensions = dimensions
        self.chat_model = chat_model
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._client = client or httpx.AsyncClient(timeout=30)
        self._owns_client = client is None

    async def embed(self, texts: list[str]) -> list[list[float]]:
        payload = await self._post(
            "/embeddings", {"model": self.model, "input": texts, "dimensions": self.dimensions}
        )
        return [item["embedding"] for item in payload["data"]]

    async def complete(self, system: str, user: str) -> str:
        payload = await self._post(
            "/chat/completions",
            {
                "model": self.chat_model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        )
        return str(payload["choices"][0]["message"]["content"])

    async def stream(self, system: str, user: str) -> AsyncIterator[str]:
        """Yield incremental chat deltas from the provider's SSE stream."""
        headers = {"Authorization": f"Bearer {self._api_key}"}
        body = {
            "model": self.chat_model,
            "temperature": 0,
            "stream": True,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        async with self._client.stream(
            "POST", f"{self._base_url}/chat/completions", json=body, headers=headers
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                response.raise_for_status()
            async for line in response.aiter_lines():
                parsed = _sse_line_delta(line)
                if parsed is None:
                    continue
                done, delta = parsed
                if done:
                    break
                yield delta

    async def _post(self, path: str, body: dict[str, object]) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self._api_key}"}

        async def send() -> dict[str, Any]:
            response = await self._client.post(
                f"{self._base_url}{path}", json=body, headers=headers
            )
            response.raise_for_status()
            value = response.json()
            if not isinstance(value, dict):
                raise ValueError("Provider returned an invalid response")
            return value

        return await retry_async(send)

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()


class Reranker(Protocol):
    """Cross-encoder rerank stage over a short candidate list."""

    model: str

    async def rerank(
        self, query: str, passages: list[CitedPassage], top_n: int
    ) -> list[CitedPassage]: ...


class NoopReranker:
    """Deterministic pass-through keeping the fused order (tests and CI)."""

    def __init__(self, model: str = "noop") -> None:
        self.model = model

    async def rerank(
        self, query: str, passages: list[CitedPassage], top_n: int
    ) -> list[CitedPassage]:
        return passages[:top_n]


class CohereReranker:
    """Hosted cross-encoder reranker over the Cohere v2 rerank API."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "rerank-v3.5",
        base_url: str = "https://api.cohere.com",
        attempts: int = DEFAULT_ATTEMPTS,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("COHERE_API_KEY is required")
        self.model = model
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._attempts = attempts
        self._client = client or httpx.AsyncClient(timeout=30)
        self._owns_client = client is None

    async def rerank(
        self, query: str, passages: list[CitedPassage], top_n: int
    ) -> list[CitedPassage]:
        if not passages:
            return []
        limit = max(1, min(top_n, len(passages)))

        async def send() -> httpx.Response:
            response = await self._client.post(
                f"{self._base_url}/v2/rerank",
                json={
                    "model": self.model,
                    "query": query,
                    "documents": [passage.content for passage in passages],
                    "top_n": limit,
                },
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
            response.raise_for_status()
            return response

        response = await retry_async(send, attempts=self._attempts)
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Reranker returned an invalid response")
        results = payload.get("results")
        if not isinstance(results, list) or not results:
            raise ValueError("Reranker returned no results")
        ranked: list[CitedPassage] = []
        seen: set[int] = set()
        for item in results:
            if not isinstance(item, dict):
                raise ValueError("Reranker returned an invalid result")
            index = item.get("index")
            relevance = item.get("relevance_score")
            if (
                not isinstance(index, int)
                or isinstance(index, bool)
                or not 0 <= index < len(passages)
                or index in seen
                or not isinstance(relevance, int | float)
                or isinstance(relevance, bool)
            ):
                raise ValueError("Reranker returned an invalid result")
            seen.add(index)
            score = float(relevance)
            ranked.append(replace(passages[index], score=score, rerank_score=score))
        return ranked

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()


async def _rerank_passages(
    reranker: Reranker | None, query: str, passages: list[CitedPassage], k: int
) -> tuple[list[CitedPassage], str | None, bool]:
    """Return (passages, rerank_model, rerank_degraded).

    A reranker outage degrades to the fused order instead of failing the
    retrieval; callers surface the degradation via the result flags.
    """
    if reranker is None:
        return passages[:k], None, False
    try:
        reranked = await reranker.rerank(query, passages, k)
    except Exception:  # noqa: BLE001 -- a reranker outage must not fail retrieval
        return passages[:k], None, True
    return reranked[:k], reranker.model, False


class InMemoryKnowledgeStore:
    def __init__(
        self,
        embeddings: EmbeddingProvider,
        *,
        reranker: Reranker | None = None,
        recall_k: int = RECALL_K,
    ) -> None:
        self._embeddings = embeddings
        self._reranker = reranker
        self._recall_k = recall_k
        self._chunks: list[_Chunk] = []

    async def ingest(
        self, document: KnowledgeDocument, *, chunk_size: int = 800, overlap: int = 100
    ) -> int:
        spans = chunk_text(document.content, chunk_size, overlap)
        vectors = await self._embeddings.embed([span[2] for span in spans])
        self._chunks = [
            chunk for chunk in self._chunks
            if not (
                chunk.document.tenant_id == document.tenant_id
                and chunk.document.source_id == document.source_id
                and chunk.document.source_version == document.source_version
            )
        ]
        self._chunks.extend(
            _Chunk(
                document,
                ordinal,
                start,
                end,
                content,
                vectors[ordinal],
                self._embeddings.model,
                self._embeddings.dimensions,
            )
            for ordinal, (start, end, content) in enumerate(spans)
        )
        return len(spans)

    async def retrieve(
        self, tenant_id: str, domain: str, query: str, k: int, *,
        now: datetime | None = None,
    ) -> RetrievalResult:
        if k < 1:
            raise ValueError("k must be positive")
        scoped = [
            chunk
            for chunk in self._chunks
            if (
                chunk.document.tenant_id == tenant_id
                and chunk.document.domain == domain
                and chunk.embedding_model == self._embeddings.model
                and chunk.embedding_dimensions == self._embeddings.dimensions
            )
        ]
        if not scoped:
            raise EmptyRetrievalError("No scoped knowledge was found; escalate")
        limit = max(self._recall_k, k)
        query_vector = (await self._embeddings.embed([query]))[0]
        dense = sorted(
            scoped,
            key=lambda chunk: self._cosine(query_vector, chunk.embedding),
            reverse=True,
        )[:limit]
        terms = _query_terms(query)
        lexical_scored: list[tuple[int, _Chunk]] = []
        for chunk in scoped:
            matched = sum(1 for term in terms if _matches_term(chunk.content, term))
            if matched > 0:
                lexical_scored.append((matched, chunk))
        lexical_scored.sort(key=lambda item: (-item[0], _memory_chunk_id(item[1])))
        lexical = [chunk for _, chunk in lexical_scored[:limit]]
        at = now or datetime.now(UTC)
        fused = reciprocal_rank_fusion(
            [
                [_memory_candidate(chunk, at) for chunk in dense],
                [_memory_candidate(chunk, at) for chunk in lexical],
            ]
        )
        passages = [
            CitedPassage(
                content=candidate.content,
                citation=candidate.citation,
                score=score,
                stale=candidate.stale,
                source_version=candidate.source_version,
            )
            for score, candidate in fused
        ]
        passages, rerank_model, rerank_degraded = await _rerank_passages(
            self._reranker, query, passages, k
        )
        return RetrievalResult(
            passages=passages,
            embedding_model=self._embeddings.model,
            rerank_model=rerank_model,
            rerank_degraded=rerank_degraded,
        )

    @staticmethod
    def _cosine(left: list[float], right: list[float]) -> float:
        return sum(a * b for a, b in zip(left, right, strict=True))


class PostgresKnowledgeStore:
    """Async, parameterized pgvector adapter for Supabase hosted Postgres."""

    def __init__(
        self,
        database_url: str,
        embeddings: EmbeddingProvider,
        *,
        reranker: Reranker | None = None,
        recall_k: int = RECALL_K,
    ) -> None:
        if not database_url:
            raise ValueError("DATABASE_URL is required")
        self._embeddings = embeddings
        self._reranker = reranker
        self._recall_k = recall_k
        self._pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = AsyncConnectionPool(
            conninfo=database_url, min_size=0, max_size=10, open=False,
            kwargs={"row_factory": dict_row},
        )

    async def open(self) -> None:
        await self._pool.open()

    async def close(self) -> None:
        await self._pool.close()

    async def ingest(
        self, document: KnowledgeDocument, *, chunk_size: int = 800, overlap: int = 100
    ) -> int:
        spans = chunk_text(document.content, chunk_size, overlap)
        vectors = await self._embeddings.embed([item[2] for item in spans])
        async with self._pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                """
                insert into public.kb_documents
                  (tenant_id, source_id, domain, source_uri, source_version, title,
                   content_sha256, stale_after, metadata)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (tenant_id, source_id, source_version) do update
                set title = excluded.title, content_sha256 = excluded.content_sha256,
                    stale_after = excluded.stale_after, metadata = excluded.metadata
                returning id
                """,
                (
                    document.tenant_id, document.source_id, document.domain,
                    document.metadata.get("source_uri", f"kb://{document.source_id}"),
                    document.source_version, document.title,
                    hashlib.sha256(document.content.encode()).hexdigest(),
                    document.stale_after, document.metadata,
                ),
            )
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError("Document upsert returned no id")
            document_id = row["id"]
            await connection.execute(
                "delete from public.kb_chunks where document_id = %s", (document_id,)
            )
            for ordinal, (start, end, content) in enumerate(spans):
                vector = _encode_vector(
                    vectors[ordinal],
                    self._embeddings.dimensions,
                )
                await connection.execute(
                    """
                    insert into public.kb_chunks
                      (document_id, ordinal, content, source_span, span_start, span_end,
                       embedding_model, embedding_dimensions, embedding, metadata)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s::extensions.vector, %s)
                    """,
                    (
                        document_id, ordinal, content, f"{start}-{end}", start, end,
                        self._embeddings.model, self._embeddings.dimensions, vector,
                        document.metadata,
                    ),
                )
        return len(spans)

    async def retrieve(
        self, tenant_id: str, domain: str, query: str, k: int, *,
        now: datetime | None = None,
    ) -> RetrievalResult:
        if k < 1:
            raise ValueError("k must be positive")
        vector = (await self._embeddings.embed([query]))[0]
        encoded = _encode_vector(vector, self._embeddings.dimensions)
        at = now or datetime.now(UTC)
        limit = max(self._recall_k, k)
        async with self._pool.connection() as connection:
            dense_cursor = await connection.execute(
                """
                select c.id::text as chunk_id, c.content, d.source_id,
                       c.span_start, c.span_end, d.source_version,
                       d.stale_after <= %s as stale
                from public.kb_chunks c
                join public.kb_documents d on d.id = c.document_id
                where d.tenant_id = %s and d.domain = %s
                  and c.embedding_model = %s and c.embedding_dimensions = %s
                order by c.embedding <=> %s::extensions.vector
                limit %s
                """,
                (
                    at, tenant_id, domain,
                    self._embeddings.model, self._embeddings.dimensions, encoded, limit,
                ),
            )
            dense_rows = await dense_cursor.fetchall()
            lexical_cursor = await connection.execute(
                """
                select c.id::text as chunk_id, c.content, d.source_id,
                       c.span_start, c.span_end, d.source_version,
                       d.stale_after <= %s as stale,
                       ts_rank_cd(c.content_tsv, websearch_to_tsquery('simple', %s)) as rank
                from public.kb_chunks c
                join public.kb_documents d on d.id = c.document_id
                where d.tenant_id = %s and d.domain = %s
                  and c.embedding_model = %s and c.embedding_dimensions = %s
                  and c.content_tsv @@ websearch_to_tsquery('simple', %s)
                order by rank desc, d.source_id, c.span_start
                limit %s
                """,
                (
                    at, query, tenant_id, domain,
                    self._embeddings.model, self._embeddings.dimensions, query, limit,
                ),
            )
            lexical_rows = await lexical_cursor.fetchall()
        fused = reciprocal_rank_fusion(
            [
                [_candidate_from_row(row) for row in dense_rows],
                [_candidate_from_row(row) for row in lexical_rows],
            ]
        )
        if not fused:
            raise EmptyRetrievalError("No scoped knowledge was found; escalate")
        passages = [
            CitedPassage(
                content=candidate.content,
                citation=candidate.citation,
                score=score,
                stale=candidate.stale,
                source_version=candidate.source_version,
            )
            for score, candidate in fused
        ]
        passages, rerank_model, rerank_degraded = await _rerank_passages(
            self._reranker, query, passages, k
        )
        return RetrievalResult(
            passages=passages,
            embedding_model=self._embeddings.model,
            rerank_model=rerank_model,
            rerank_degraded=rerank_degraded,
        )


def _encode_vector(vector: list[float], dimensions: int) -> str:
    if len(vector) != dimensions or not all(math.isfinite(value) for value in vector):
        raise ValueError("Embedding provider returned an invalid vector")
    return "[" + ",".join(str(value) for value in vector) + "]"
