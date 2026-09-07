from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


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
    content: str
    citation: CitationSpan
    score: float
    stale: bool
    source_version: str


@dataclass(frozen=True)
class RetrievalResult:
    passages: list[CitedPassage]
    embedding_model: str


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

    async def _post(self, path: str, body: dict[str, object]) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self._api_key}"}
        response = await self._client.post(
            f"{self._base_url}{path}", json=body, headers=headers
        )
        response.raise_for_status()
        value = response.json()
        if not isinstance(value, dict):
            raise ValueError("Provider returned an invalid response")
        return value

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()


class InMemoryKnowledgeStore:
    def __init__(self, embeddings: EmbeddingProvider) -> None:
        self._embeddings = embeddings
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
        query_vector = (await self._embeddings.embed([query]))[0]
        candidates = [
            (self._cosine(query_vector, chunk.embedding), chunk)
            for chunk in self._chunks
            if (
                chunk.document.tenant_id == tenant_id
                and chunk.document.domain == domain
                and chunk.embedding_model == self._embeddings.model
                and chunk.embedding_dimensions == self._embeddings.dimensions
            )
        ]
        if not candidates:
            raise EmptyRetrievalError("No scoped knowledge was found; escalate")
        at = now or datetime.now(UTC)
        passages = [
            CitedPassage(
                content=chunk.content,
                citation=CitationSpan(chunk.document.source_id, chunk.start, chunk.end),
                score=score,
                stale=chunk.document.stale_after <= at,
                source_version=chunk.document.source_version,
            )
            for score, chunk in sorted(candidates, key=lambda value: value[0], reverse=True)[:k]
        ]
        return RetrievalResult(passages, self._embeddings.model)

    @staticmethod
    def _cosine(left: list[float], right: list[float]) -> float:
        return sum(a * b for a, b in zip(left, right, strict=True))


class PostgresKnowledgeStore:
    """Async, parameterized pgvector adapter for Supabase hosted Postgres."""

    def __init__(self, database_url: str, embeddings: EmbeddingProvider) -> None:
        if not database_url:
            raise ValueError("DATABASE_URL is required")
        self._embeddings = embeddings
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
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                """
                select c.content, d.source_id, c.span_start, c.span_end, d.source_version,
                       d.stale_after <= %s as stale,
                       1 - (c.embedding <=> %s::extensions.vector) as score
                from public.kb_chunks c
                join public.kb_documents d on d.id = c.document_id
                where d.tenant_id = %s and d.domain = %s
                  and c.embedding_model = %s and c.embedding_dimensions = %s
                order by c.embedding <=> %s::extensions.vector
                limit %s
                """,
                (
                    now or datetime.now(UTC), encoded, tenant_id, domain,
                    self._embeddings.model, self._embeddings.dimensions, encoded, k,
                ),
            )
            rows = await cursor.fetchall()
        if not rows:
            raise EmptyRetrievalError("No scoped knowledge was found; escalate")
        return RetrievalResult(
            [
                CitedPassage(
                    content=row["content"],
                    citation=CitationSpan(row["source_id"], row["span_start"], row["span_end"]),
                    score=float(row["score"]),
                    stale=bool(row["stale"]),
                    source_version=row["source_version"],
                )
                for row in rows
            ],
            self._embeddings.model,
        )


def _encode_vector(vector: list[float], dimensions: int) -> str:
    if len(vector) != dimensions or not all(math.isfinite(value) for value in vector):
        raise ValueError("Embedding provider returned an invalid vector")
    return "[" + ",".join(str(value) for value in vector) + "]"
