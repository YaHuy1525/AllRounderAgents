"""Seed a policy corpus into an HR knowledge partition.

The HR help lane grounds each answer on retrieved policy passages. This script
loads every markdown file in a policy directory as one knowledge document in
the ``hr:<lane>`` partition (``hr:policy`` by default), chunked and embedded
with the same splitter and provider the API uses at query time, so the seeded
vectors match live retrieval. Source ids keep the lane's fixture spelling
(``hr_policy/<file>.md``) so citations read the same either way, and a
document's ``Reviewed: YYYY-MM-DD`` header sets ``stale_after`` at
reviewed + 365 days, the window the fixture corpus applies to the same files:
a long-unreviewed policy stays flagged stale instead of silently ageing out.

Usage:
    python scripts/hr-kb-seed.py --tenant omnidewalt
    python scripts/hr-kb-seed.py --tenant omnidewalt --dir fixtures/hr_policy
    python scripts/hr-kb-seed.py --tenant omnidewalt --query "home office stipend"

Requires the same environment as the API (.env): DATABASE_URL and, for the
default openai provider, MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME (or the
EMBEDDING_* overrides). Re-running with the same ``--version`` replaces each
revision's chunks in place; a new version adds a new revision. The
deterministic provider embeds with a hash function and is a smoke aid only.
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
# Mirrors kb_api.py's _DOMAIN_PATTERN, which mirrors the kb_documents check.
DOMAIN_RE = re.compile(
    r"^(?:code|finance|marketing|support)$|^(?:msp|hr|tac):[a-z0-9][a-z0-9._-]*$"
)
# Mirrors kb_api.py's UploadDocument.source_id pattern.
SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
DEFAULT_DOMAIN = "hr:policy"
DEFAULT_DIR = "fixtures/company/hr_policy"
# The fixture retriever's window (hr-policy.ts STALE_DAYS): reviewed + 365 days.
REVIEW_WINDOW_DAYS = 365
FALLBACK_REVIEW_DAYS = 365
# kb_chunks.embedding_dimensions checks for exactly this value, so the
# deterministic smoke provider is pinned to it.
DETERMINISTIC_DIMENSIONS = 1536


def document_title(content: str, fallback: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            heading = stripped[2:].strip()
            if heading:
                return heading[:200]
    return fallback[:200]


def reviewed_on(content: str) -> datetime | None:
    """The document's `Reviewed: YYYY-MM-DD` header, when it carries one."""
    match = re.search(r"^Reviewed:\s*(\d{4}-\d{2}-\d{2})\s*$", content, re.MULTILINE)
    if match is None:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y-%m-%d").replace(tzinfo=UTC)
    except ValueError:
        return None


def stale_after_for(content: str, now: datetime) -> tuple[datetime, str]:
    """Review horizon plus the reason, so the report can show where it came from."""
    reviewed = reviewed_on(content)
    if reviewed is None:
        return now + timedelta(days=FALLBACK_REVIEW_DAYS), "no Reviewed: header"
    return reviewed + timedelta(days=REVIEW_WINDOW_DAYS), f"reviewed {reviewed.date().isoformat()}"


def source_id_for(stem: str) -> str:
    """`leave-and-time-off` -> `hr_policy/leave-and-time-off.md`, the fixture spelling."""
    return f"hr_policy/{stem}.md"


def policy_files(directory: Path) -> list[Path]:
    return sorted(path for path in directory.glob("*.md") if path.is_file())


def build_documents(
    directory: Path,
    tenant: str,
    domain: str,
    version: str,
    now: datetime,
) -> list[KnowledgeDocument]:
    documents: list[KnowledgeDocument] = []
    for path in policy_files(directory):
        content = path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()
        if content == "":
            print(f"skipping empty file: {path}", file=sys.stderr)
            continue
        horizon, reason = stale_after_for(content, now)
        source_id = source_id_for(path.stem)
        documents.append(
            KnowledgeDocument(
                source_id=source_id,
                tenant_id=tenant,
                domain=domain,
                title=document_title(content, path.stem),
                content=content,
                source_version=version,
                stale_after=horizon,
                metadata={
                    "canonical": True,
                    "source_uri": f"file://{path.resolve().as_posix()}",
                    "seeded_by": "scripts/hr-kb-seed.py",
                    "review": reason,
                },
            )
        )
    return documents


async def seed(
    documents: list[KnowledgeDocument],
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
        total = 0
        for document in documents:
            written = await store.ingest(document)
            total += written
            print(
                f"  {document.source_id} version={document.source_version}"
                f" chunks={written} stale_after={document.stale_after.date().isoformat()}"
                f" title={document.title!r}"
            )
        print(f"seeded {total} chunk(s) across {len(documents)} document(s) into"
              f" {documents[0].tenant_id}/{documents[0].domain}")
        if probe_query:
            tenant, domain = documents[0].tenant_id, documents[0].domain
            try:
                result = await store.retrieve(tenant, domain, probe_query, 5)
            except EmptyRetrievalError:
                print(
                    "probe query retrieved nothing; check the tenant, the domain"
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
        description="Seed a markdown policy corpus into the HR knowledge partition."
    )
    parser.add_argument("--tenant", required=True, help="tenant id that owns the partition")
    parser.add_argument(
        "--dir",
        default=DEFAULT_DIR,
        help=f"policy directory holding the *.md corpus (default: {DEFAULT_DIR})",
    )
    parser.add_argument(
        "--domain",
        default=DEFAULT_DOMAIN,
        help=f"knowledge partition (default: {DEFAULT_DOMAIN})",
    )
    parser.add_argument(
        "--version", default="", help="revision string; defaults to today"
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

    tenant = args.tenant.strip()
    if TENANT_RE.match(tenant) is None:
        print(
            "tenant must start with a letter or digit and hold only letters,"
            " digits, dot, dash or underscore",
            file=sys.stderr,
        )
        return 1
    domain = args.domain.strip()
    if DOMAIN_RE.fullmatch(domain) is None:
        print(
            f"domain {domain!r} is not a knowledge partition the database allows"
            " (an HR corpus uses the hr:<lane> family, e.g. hr:policy)",
            file=sys.stderr,
        )
        return 1
    directory = Path(args.dir)
    if not directory.is_dir():
        print(f"policy directory not found: {directory}", file=sys.stderr)
        return 1

    now = datetime.now(UTC)
    version = args.version.strip() or now.strftime("%Y-%m-%d")
    documents = build_documents(directory, tenant, domain, version, now)
    if not documents:
        print(f"no markdown policy files found in: {directory}", file=sys.stderr)
        return 1
    invalid = [
        document.source_id
        for document in documents
        if SOURCE_ID_RE.fullmatch(document.source_id) is None
    ]
    if invalid:
        print(f"source ids rejected by the API pattern: {', '.join(invalid)}", file=sys.stderr)
        return 1

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

    print(
        f"{directory} -> tenant={tenant} domain={domain} version={version}"
        f" files={len(documents)} provider={args.provider} model={provider.model}"
        f" dimensions={provider.dimensions}"
    )
    if args.dry_run:
        for document in documents:
            print(
                f"  {document.source_id} chunks={len(chunk_text(document.content))}"
                f" stale_after={document.stale_after.date().isoformat()}"
                f" title={document.title!r}"
            )
        print("dry run: nothing written")
        return 0
    return run_async(seed(documents, provider, settings, args.query.strip()))


if __name__ == "__main__":
    raise SystemExit(main())
