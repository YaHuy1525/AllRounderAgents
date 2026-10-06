"""Seed one client runbook into the MSP knowledge partition.

The MSP draft step grounds each reply on the client's own runbook. The
platform knowledge store holds it under the ``msp:<clientRef>`` domain, and
this script loads a markdown or text file as one knowledge document for a
tenant: chunked with the same splitter and embedded with the same provider
the API uses at query time, so the seeded vectors match live retrieval.
Re-running with the same ``--version`` replaces that revision's chunks in
place; a new version adds a new revision.

Usage:
    python scripts/msp-kb-seed.py --tenant mspco --client acme --file acme.md
    python scripts/msp-kb-seed.py --tenant mspco --client acme --file acme.md --query "vpn drops"

Requires the same environment as the API (.env): DATABASE_URL and, for the
default openai provider, MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME. Run
``supabase db push`` first: migration 202610010013 allows the msp: knowledge
partitions. The deterministic provider embeds with a hash function and is a
smoke aid only; its vectors match a retrieval running the same provider.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
from collections.abc import Coroutine
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from allrounder_api.audit_pack import CLIENT_REF_RE
from allrounder_api.knowledge import (
    DeterministicEmbeddingProvider,
    EmptyRetrievalError,
    KnowledgeDocument,
    OpenAICompatibleAdapter,
    PostgresKnowledgeStore,
    RetrievalTuning,
    chunk_text,
)
from allrounder_api.settings import Settings

# Mirrors the tenant check on the knowledge route (knowledge_api.py).
TENANT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
DEFAULT_REVIEW_DAYS = 180
# kb_chunks.embedding_dimensions checks for exactly this value, so the
# deterministic smoke provider is pinned to it.
DETERMINISTIC_DIMENSIONS = 1536


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return cleaned or "runbook"


def document_title(content: str, fallback: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            heading = stripped[2:].strip()
            if heading:
                return heading[:200]
    return fallback[:200]


def parse_day(value: str, flag: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=UTC)
    except ValueError:
        print(f"{flag} must be a YYYY-MM-DD date", file=sys.stderr)
        return None


async def seed(
    document: KnowledgeDocument,
    provider: DeterministicEmbeddingProvider | OpenAICompatibleAdapter,
    settings: Settings,
    probe_query: str,
) -> int:
    store = PostgresKnowledgeStore(
        settings.database_url.get_secret_value(),
        provider,
        tuning=RetrievalTuning.from_settings(settings),
        tenant_overrides=settings.retrieval_tenant_overrides,
    )
    await store.open()
    try:
        written = await store.ingest(document)
        print(f"seeded {written} chunk(s) into {document.tenant_id}/{document.domain}")
        if probe_query:
            try:
                result = await store.retrieve(
                    document.tenant_id, document.domain, probe_query, 5
                )
            except EmptyRetrievalError:
                print(
                    "probe query retrieved nothing; check the partition, the version"
                    " and the embedding provider",
                    file=sys.stderr,
                )
                return 1
            for passage in result.passages:
                print(
                    f"  [{passage.citation.source_id}:{passage.citation.span}]"
                    f" score={passage.score:.4f} stale={passage.stale}"
                    f" title={passage.title}"
                )
    finally:
        await store.close()
        if isinstance(provider, OpenAICompatibleAdapter):
            await provider.close()
    return 0


def run_async(coro: Coroutine[Any, Any, int]) -> int:
    """Run the pipeline on a psycopg-compatible loop (the Windows default is not)."""
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    return asyncio.run(coro)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed a client runbook into the MSP knowledge base."
    )
    parser.add_argument("--tenant", required=True, help="tenant id that owns the partition")
    parser.add_argument(
        "--client",
        required=True,
        help="client ref slug (the mailbox local part), e.g. acme or acme.support",
    )
    parser.add_argument(
        "--file", required=True, help="runbook file to ingest (markdown or text)"
    )
    parser.add_argument(
        "--title", default="", help="document title; defaults to the first # heading"
    )
    parser.add_argument(
        "--source-id",
        default="",
        help="source id; defaults to <client>-<file name>. must contain the client ref",
    )
    parser.add_argument("--version", default="", help="revision string; defaults to today")
    parser.add_argument(
        "--stale-after",
        default="",
        help=f"review date YYYY-MM-DD; defaults to today + {DEFAULT_REVIEW_DAYS} days",
    )
    parser.add_argument(
        "--provider",
        choices=("openai", "deterministic"),
        default="openai",
        help="embedding provider; deterministic is a smoke aid (default: openai)",
    )
    parser.add_argument(
        "--query", default="", help="optional retrieval probe after the ingest"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="validate and report, write nothing"
    )
    args = parser.parse_args()

    client = args.client.strip().lower()
    if CLIENT_REF_RE.match(client) is None:
        print("client must be a lowercase mailbox slug, e.g. acme", file=sys.stderr)
        return 1
    tenant = args.tenant.strip()
    if TENANT_RE.match(tenant) is None:
        print(
            "tenant must start with a letter or digit and hold only letters,"
            " digits, dot, dash or underscore",
            file=sys.stderr,
        )
        return 1
    path = Path(args.file)
    if not path.is_file():
        print(f"runbook file not found: {path}", file=sys.stderr)
        return 1
    content = path.read_text(encoding="utf-8").strip()
    if content == "":
        print(f"runbook file is empty: {path}", file=sys.stderr)
        return 1

    source_id = args.source_id.strip() or f"{client}-{slug(path.stem)}"
    if client not in source_id:
        print(
            f"source id {source_id!r} must contain the client ref {client!r}: source ids"
            " are unique per tenant, so two clients must never share one",
            file=sys.stderr,
        )
        return 1

    now = datetime.now(UTC)
    version = args.version.strip() or now.strftime("%Y-%m-%d")
    stale_after = now + timedelta(days=DEFAULT_REVIEW_DAYS)
    if args.stale_after.strip():
        parsed_day = parse_day(args.stale_after.strip(), "--stale-after")
        if parsed_day is None:
            return 1
        stale_after = parsed_day

    settings = Settings()
    if settings.database_url.get_secret_value() == "":
        print("DATABASE_URL is required (set it in .env, see .env.example)", file=sys.stderr)
        return 1

    provider: DeterministicEmbeddingProvider | OpenAICompatibleAdapter
    if args.provider == "deterministic":
        provider = DeterministicEmbeddingProvider("deterministic", DETERMINISTIC_DIMENSIONS)
        print(
            "deterministic provider: these vectors match only a retrieval running the"
            " same provider",
            file=sys.stderr,
        )
    else:
        model_key = settings.model_api_key.get_secret_value()
        embedding_key = settings.embedding_api_key.get_secret_value() or model_key
        if settings.model_name == "" or embedding_key == "":
            print(
                "MODEL_NAME and MODEL_API_KEY are required for the openai provider",
                file=sys.stderr,
            )
            return 1
        provider = OpenAICompatibleAdapter(
            base_url=settings.embedding_base_url or settings.model_base_url,
            api_key=embedding_key,
            embedding_model=settings.embedding_model or settings.model_name,
            dimensions=settings.embedding_dimensions,
            chat_model=settings.model_name,
        )

    document = KnowledgeDocument(
        source_id=source_id,
        tenant_id=tenant,
        domain=f"msp:{client}",
        title=args.title.strip() or document_title(content, path.stem),
        content=content,
        source_version=version,
        stale_after=stale_after,
        metadata={"source_uri": str(path.resolve()), "seeded_by": "scripts/msp-kb-seed.py"},
    )
    print(
        f"runbook {path} -> tenant={tenant} domain={document.domain} source={source_id}"
        f" version={version} chunks={len(chunk_text(content))}"
        f" stale_after={stale_after.date().isoformat()}"
        f" provider={args.provider} model={provider.model} title={document.title!r}"
    )
    if args.dry_run:
        print("dry run: nothing written")
        return 0
    return run_async(seed(document, provider, settings, args.query.strip()))


if __name__ == "__main__":
    raise SystemExit(main())
