"""Seed the simulated company corpus into its own knowledge partitions.

``fixtures/agentcompany`` holds TheAgentCompany's service data (vendored at a
pinned commit), and most of it is *documents*: GitLab wiki pages for the
products the fictional firm maintains, and the ownCloud filing cabinet the
benchmark tasks reference. This script turns the prose in that cabinet into
retrievable knowledge, chunked and embedded with the same splitter and provider
the API uses at query time, so the seeded vectors match live retrieval.

Three partitions, kept apart on purpose:

    tac:wiki     GitLab wiki pages (node-red, llama.cpp, janusgraph, ...) --
                 the firm's own product documentation.
    tac:company  the firm's internal record: overview, policies, HR forms,
                 plans, taglines, resumes. Fiction, safe to answer from.
    tac:tech     real third-party papers and manuals (arXiv surveys, 10-Ks).
                 Opt in with ``--groups tech``: these are not the firm's
                 knowledge, so grounding a company answer on them misleads.

The cabinet also holds documents that must never become knowledge, and the
filters below are the reason each one exists:

* 500 one-page invoices (``Financials/invoices_pdf``) and the vendor quotes:
  near-identical prose that would flood the vector index with duplicates.
  Tabular records belong in Postgres behind a query tool, not in RAG.
* ``Human Resources Team/Employee Password``: credential material.
* stock Nextcloud demo files (``Readme.md``, ``Example.md``, ``*.odt``,
  the flyer): template prose about the file sync product, not the firm.
* media, archives and spreadsheets: no text layer to embed here.

Usage:
    python scripts/tac-kb-seed.py --tenant theagentcompany --dry-run
    python scripts/tac-kb-seed.py --tenant theagentcompany
    python scripts/tac-kb-seed.py --tenant theagentcompany --groups company
    python scripts/tac-kb-seed.py --tenant theagentcompany --dump-dir tmp/tac-kb
    python scripts/tac-kb-seed.py --tenant theagentcompany --query "reimbursement policy"

Requires the same environment as the API (.env): DATABASE_URL and, for the
default openai provider, MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME (or the
EMBEDDING_* overrides). Re-running with the same ``--version`` replaces that
revision's chunks in place; the version defaults to the pinned source commit,
so the corpus and its vectors always name the same upstream snapshot.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import docx
import fitz
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

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = REPO_ROOT / "fixtures" / "agentcompany"
SERVICES = FIXTURES / "services"
WIKIS_JSON = SERVICES / "gitlab" / "wikis.json"
CLOUD_DIR = SERVICES / "owncloud" / "files"

# Mirrors the tenant check on the knowledge route (knowledge_api.py).
TENANT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# Mirrors kb_api.py's _DOMAIN_PATTERN, which mirrors the kb_documents check.
DOMAIN_RE = re.compile(
    r"^(?:code|finance|marketing|support)$|^(?:msp|hr|tac):[a-z0-9][a-z0-9._-]*$"
)
# Mirrors kb_api.py's UploadDocument.source_id pattern.
SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
SOURCE_ID_MAX_CHARS = 200
# Mirrors kb_api.py's UploadDocument.content cap; content over it is rejected.
MAX_CONTENT_CHARS = 200_000
# kb_chunks.embedding_dimensions checks for exactly this value, so the
# deterministic smoke provider is pinned to it.
DETERMINISTIC_DIMENSIONS = 1536
# Documents shorter than this carry nothing a retrieval could cite.
MIN_CONTENT_CHARS = 80
# A fallback review horizon when a source carries no date of its own.
REVIEW_WINDOW_DAYS = 365

GROUP_DOMAINS = {"wiki": "tac:wiki", "company": "tac:company", "tech": "tac:tech"}
DEFAULT_GROUPS = ("wiki", "company")

# Paths under CLOUD_DIR that make a document unusable as knowledge: credentials,
# and high-volume transactional records that belong in a queryable table.
BANNED_PATH_PARTS = (
    "employee password",
    "invoices_pdf",
)

# The firm's own record. Anything in the cabinet outside this set is upstream
# template noise, third-party literature, or a non-textual asset.
COMPANY_FILES = frozenset(
    {
        "Documents/TAC_overview.md",
        "Documents/Administrative Specialist/Reimbursement Policy.pdf",
        "Documents/Administrative Specialist/products.pdf",
        "Documents/Admin/i-9.pdf",
        "Documents/Financials/Qualified_R&D_Activities.md",
        "Documents/Financials/expenses.pdf",
        "Documents/Financials/f6765.pdf",
        "Documents/Financials/f6765_instructions.pdf",
        "Documents/Q1 Planning and Allocation/Effort.Planning.2025.docx",
        "Documents/Human Resources Team/Software Engineer.pdf",
        "Documents/Human Resources Team/salary.txt",
        "Documents/Human Resources Team/salary_increase.txt",
        "Documents/Human Resources Team/Attendance/salary-rates.pdf",
        "Documents/Human Resources Team/resumes/Emily Johnson.pdf",
        "Documents/Human Resources Team/resumes/Jane_Lee.pdf",
        "Documents/Human Resources Team/resumes/Michael Davis.pdf",
        "Documents/Human Resources Team/resumes/Sarah Thompson.pdf",
        "Documents/Engineering/oncall_arrangement.txt",
        "Documents/Data Analysis/Coffee Shop/analysis.txt",
        "Documents/Research/Noise Simulation/noise_simulation_analysis_sheet.txt",
    }
)

# Product one-liners: many are under MIN_CONTENT_CHARS on their own, so the
# whole set ships as one document the wiki pages can be read alongside.
TAGLINE_SUFFIX = "_tagline.txt"
TAGLINE_SOURCE_ID = "tac/cloud/Documents/product-taglines"

# Real third-party literature, kept in its own partition by choice.
TECH_FILES = frozenset(
    {
        "Documents/Research/agent_workflow_memory.pdf",
        "Documents/Research/OpenHands.pdf",
        "Documents/Research/survey.pdf",
        "Documents/Research/tool-survey.pdf",
        "Documents/Research/Noise Simulation/noise_simulation_paper.pdf",
        "Documents/Quick_start_RisingWave.pdf",
        "Documents/Data Analysis/Annual Reports/2018-Annual-Report.pdf",
        "Documents/Data Analysis/Annual Reports/2022-alphabet-annual-report.pdf",
        "Documents/Data Analysis/Annual Reports/2023_Annual_Report.docx",
        "Documents/Data Analysis/Annual Reports/Amazon-com-Inc-2023-Annual-Report.pdf",
        "Documents/Data Analysis/Annual Reports/goog-10-k-2023.pdf",
        "Documents/Financials/Annual Reports/10Ks/adobe-10k-2023.pdf",
        "Documents/Financials/Annual Reports/10Ks/apple-10k-2023.pdf",
        "Documents/Financials/Annual Reports/10Ks/goog-10-k-2023.pdf",
        "Documents/Financials/Annual Reports/10Ks/meta-10k-2023.pdf",
        "Documents/Financials/Annual Reports/10Ks/microsoft-10k-2023.pdf",
        "Documents/Financials/Annual Reports/10Ks/nvidia-10k-2023.pdf",
        "Documents/Financials/Annual Reports/10Ks/oracle-10k-2023.pdf",
        "Documents/Financials/Annual Reports/10Ks/tesla-10k-2023.pdf",
    }
)

# Extensions with no text layer this script can read.
UNSUPPORTED_EXTENSIONS = frozenset(
    {".xlsx", ".xls", ".csv", ".ods", ".odt", ".doc", ".jpg", ".jpeg", ".png", ".gif",
     ".mp4", ".zip"}
)
EXTRACTABLE_EXTENSIONS = frozenset({".pdf", ".docx", ".txt", ".md"})


def normalize_path(path: Path) -> str:
    """Cabinet-relative path with forward slashes, stable across platforms."""
    return path.relative_to(CLOUD_DIR).as_posix()


def is_banned(relative_path: str) -> bool:
    lowered = relative_path.lower()
    return any(part in lowered for part in BANNED_PATH_PARTS)


def clean_source_id(raw: str) -> str:
    """Force an arbitrary upstream filename into the API's source_id pattern."""
    cleaned = re.sub(r"[^A-Za-z0-9._/-]+", "-", raw).strip("-._/")
    return cleaned[:SOURCE_ID_MAX_CHARS]


def extract_pdf(path: Path) -> str:
    """Page text, page-break separated, so a citation span stays inside a page."""
    with fitz.open(path) as document:
        pages = [str(page.get_text()) for page in document]
    return "\n\n".join(page.strip() for page in pages if page.strip())


def extract_docx(path: Path) -> str:
    """Paragraphs then tables; docx keeps them in separate object graphs."""
    document = docx.Document(str(path))
    blocks = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                blocks.append(" | ".join(cells))
    return "\n".join(blocks)


def extract_plain(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")


EXTRACTORS: dict[str, Callable[[Path], str]] = {
    ".pdf": extract_pdf,
    ".docx": extract_docx,
    ".txt": extract_plain,
    ".md": extract_plain,
}


def extract_text(path: Path) -> str:
    extractor = EXTRACTORS.get(path.suffix.lower())
    if extractor is None:
        return ""
    return extractor(path).strip()


def title_from(content: str, fallback: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            heading = stripped[2:].strip()
            if heading:
                return heading[:200]
    return fallback[:200]


def pinned_commit() -> str:
    """The upstream commit the corpus was harvested at, for the version string."""
    for candidate in (FIXTURES / "MANIFEST.json", SERVICES / "HARVEST.json"):
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        source = payload.get("source") if isinstance(payload, dict) else None
        commit = source.get("commit") if isinstance(source, dict) else None
        if isinstance(commit, str) and commit:
            return commit
    return ""


def pinned_commit_date() -> datetime | None:
    for candidate in (FIXTURES / "MANIFEST.json", SERVICES / "HARVEST.json"):
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        source = payload.get("source") if isinstance(payload, dict) else None
        committed = source.get("committedAt") if isinstance(source, dict) else None
        if isinstance(committed, str):
            try:
                return datetime.fromisoformat(committed.replace("Z", "+00:00"))
            except ValueError:
                return None
    return None


def make_document(
    *,
    source_id: str,
    tenant: str,
    domain: str,
    title: str,
    content: str,
    version: str,
    stale_after: datetime,
    source_uri: str,
    group: str,
    upstream_path: str,
) -> KnowledgeDocument:
    return KnowledgeDocument(
        source_id=source_id,
        tenant_id=tenant,
        domain=domain,
        title=title,
        content=content,
        source_version=version,
        stale_after=stale_after,
        metadata={
            "canonical": True,
            "source_uri": source_uri,
            "seeded_by": "scripts/tac-kb-seed.py",
            "group": group,
            "origin": "theagentcompany",
            "upstream_path": upstream_path,
        },
    )


def file_uri(absolute_path: Path) -> str:
    return f"file://{absolute_path.resolve().as_posix()}"


def wiki_documents(tenant: str, version: str, stale_after: datetime) -> list[KnowledgeDocument]:
    if not WIKIS_JSON.is_file():
        return []
    pages = json.loads(WIKIS_JSON.read_text(encoding="utf-8"))
    documents: list[KnowledgeDocument] = []
    for page in pages:
        content = str(page.get("content", "")).replace("\r\n", "\n").strip()
        if len(content) < MIN_CONTENT_CHARS or len(content) > MAX_CONTENT_CHARS:
            continue
        project = str(page.get("project", "unknown"))
        slug = str(page.get("slug", "page"))
        title = str(page.get("title") or slug)
        upstream = f"gitlab/wikis/{project}/{slug}"
        documents.append(
            make_document(
                source_id=clean_source_id(f"tac/wiki/{project}/{slug}"),
                tenant=tenant,
                domain=GROUP_DOMAINS["wiki"],
                title=title,
                content=content,
                version=version,
                stale_after=stale_after,
                source_uri=file_uri(WIKIS_JSON),
                group="wiki",
                upstream_path=upstream,
            )
        )
    return documents


def cloud_files(groups: tuple[str, ...]) -> tuple[list[Path], list[str], list[str]]:
    """Wanted cabinet files, plus tabular and unreadable skips for the report."""
    wanted: set[str] = set()
    if "company" in groups:
        wanted |= set(COMPANY_FILES)
    if "tech" in groups:
        wanted |= set(TECH_FILES)
    selected: list[Path] = []
    tabular: list[str] = []
    unsupported: list[str] = []
    if not CLOUD_DIR.is_dir():
        return selected, tabular, unsupported
    for path in sorted(CLOUD_DIR.rglob("*")):
        if not path.is_file():
            continue
        relative = normalize_path(path)
        if is_banned(relative):
            continue
        suffix = path.suffix.lower()
        if relative in wanted:
            selected.append(path)
        elif suffix == TAGLINE_SUFFIX:
            continue  # collected into one document by tagline_document()
        elif suffix in EXTRACTABLE_EXTENSIONS:
            unsupported.append(relative)  # a known filter, reported below
        elif suffix in UNSUPPORTED_EXTENSIONS:
            target = tabular if suffix in {".xlsx", ".csv", ".ods"} else unsupported
            target.append(relative)
        else:
            unsupported.append(relative)
    return selected, tabular, unsupported


def tagline_document(tenant: str, version: str, stale_after: datetime) -> KnowledgeDocument | None:
    """The product one-liners as one document (each is too short to stand alone)."""
    lines: list[str] = []
    sources: list[str] = []
    for path in sorted(CLOUD_DIR.rglob(f"*{TAGLINE_SUFFIX}")):
        relative = normalize_path(path)
        if is_banned(relative):
            continue
        product = path.name[: -len(TAGLINE_SUFFIX)] or path.stem
        text = extract_plain(path).strip()
        if text:
            lines.append(f"- **{product}**: {text}")
            sources.append(relative)
    if not lines:
        return None
    content = (
        "# Product taglines\n\n"
        "The Agent Company products and their one-line summaries.\n\n"
        + "\n".join(lines)
    )
    return make_document(
        source_id=clean_source_id(TAGLINE_SOURCE_ID),
        tenant=tenant,
        domain=GROUP_DOMAINS["company"],
        title="Product taglines",
        content=content,
        version=version,
        stale_after=stale_after,
        source_uri=file_uri(CLOUD_DIR / "Documents"),
        group="company",
        upstream_path="; ".join(sources),
    )


def cloud_documents(
    tenant: str, version: str, stale_after: datetime, groups: tuple[str, ...]
) -> tuple[list[KnowledgeDocument], list[str]]:
    """Extract every wanted cabinet file, plus notes on what was dropped."""
    selected, tabular, unsupported = cloud_files(groups)
    notes = [
        f"tabular files left for the Postgres load: {len(tabular)}",
        f"files outside the seeded groups (filter, media, archive): {len(unsupported)}",
    ]
    documents: list[KnowledgeDocument] = []
    for path in selected:
        relative = normalize_path(path)
        group = "tech" if relative in TECH_FILES else "company"
        try:
            content = extract_text(path)
        except Exception as error:  # one unreadable file must not stop the seed
            notes.append(f"extraction failed for {relative}: {error}")
            continue
        if len(content) < MIN_CONTENT_CHARS:
            notes.append(f"too little text, skipped: {relative}")
            continue
        if len(content) > MAX_CONTENT_CHARS:
            notes.append(f"over the {MAX_CONTENT_CHARS} character cap, skipped: {relative}")
            continue
        documents.append(
            make_document(
                source_id=clean_source_id(f"tac/cloud/{relative}"),
                tenant=tenant,
                domain=GROUP_DOMAINS[group],
                title=title_from(content, Path(relative).stem),
                content=content,
                version=version,
                stale_after=stale_after,
                source_uri=file_uri(path),
                group=group,
                upstream_path=relative,
            )
        )
    if "company" in groups:
        taglines = tagline_document(tenant, version, stale_after)
        if taglines is not None:
            documents.append(taglines)
    return documents, notes


def deduplicate(documents: list[KnowledgeDocument]) -> tuple[list[KnowledgeDocument], list[str]]:
    """Drop byte-identical bodies; the cabinet duplicates whole reports across folders."""
    seen: dict[str, str] = {}
    kept: list[KnowledgeDocument] = []
    notes: list[str] = []
    for document in documents:
        digest = hashlib.sha256(document.content.encode("utf-8")).hexdigest()
        if digest in seen:
            notes.append(f"duplicate of {seen[digest]}: {document.source_id}")
            continue
        seen[digest] = document.source_id
        kept.append(document)
    return kept, notes


async def seed(
    documents: list[KnowledgeDocument],
    provider: DeterministicEmbeddingProvider | OpenAICompatibleAdapter,
    settings: Settings,
    probe_query: str,
    pace_ms: int,
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
        for index, document in enumerate(documents):
            if index and pace_ms > 0:
                # The embedding key is metered per minute and every document costs
                # at least one request, so the loop is paced rather than leaving
                # the run to 429 retries.
                await asyncio.sleep(pace_ms / 1000)
            written = await store.ingest(document)
            total += written
            print(
                f"  [{document.domain}] {document.source_id}"
                f" chunks={written} title={document.title!r}"
            )
        partitions = sorted({document.domain for document in documents})
        print(
            f"seeded {total} chunk(s) across {len(documents)} document(s)"
            f" into {documents[0].tenant_id} ({', '.join(partitions)})"
        )
        if probe_query:
            return await probe(store, documents, probe_query)
    finally:
        await store.close()
        if isinstance(provider, OpenAICompatibleAdapter):
            await provider.close()
    return 0


async def probe(
    store: PostgresKnowledgeStore, documents: list[KnowledgeDocument], probe_query: str
) -> int:
    """Retrieve once per partition so every seeded partition proves it answers."""
    status = 0
    for domain in sorted({document.domain for document in documents}):
        sample = next(document for document in documents if document.domain == domain)
        try:
            result = await store.retrieve(sample.tenant_id, domain, probe_query, 5)
        except EmptyRetrievalError:
            print(f"  {domain}: probe query retrieved nothing", file=sys.stderr)
            status = 1
            continue
        print(f"  {domain}:")
        for passage in result.passages:
            print(
                f"    [{passage.citation.source_id}:{passage.citation.span}]"
                f" score={passage.score:.4f} stale={passage.stale}"
                f" title={passage.title}"
            )
    return status


def run_async(coro: Coroutine[Any, Any, int]) -> int:
    """Run the pipeline on a psycopg-compatible loop (the Windows default is not)."""
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    return asyncio.run(coro)


def dump(documents: list[KnowledgeDocument], directory: Path) -> None:
    """Write the extracted text so the filter can be reviewed without a database."""
    directory.mkdir(parents=True, exist_ok=True)
    for document in documents:
        name = document.source_id.replace("/", "__").strip("_") + ".md"
        header = (
            f"---\nsource_id: {document.source_id}\ndomain: {document.domain}\n"
            f"title: {document.title}\nchars: {len(document.content)}\n---\n\n"
        )
        (directory / name).write_text(header + document.content, encoding="utf-8")
    print(f"dumped {len(documents)} extracted document(s) to {directory}")


def parse_groups(raw: str) -> tuple[str, ...]:
    groups = tuple(part.strip() for part in raw.split(",") if part.strip())
    unknown = [group for group in groups if group not in GROUP_DOMAINS]
    if not groups or unknown:
        allowed = ", ".join(sorted(GROUP_DOMAINS))
        msg = f"--groups must name some of: {allowed}"
        if unknown:
            msg += f" (unknown: {', '.join(unknown)})"
        raise argparse.ArgumentTypeError(msg)
    return groups


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed the simulated company corpus into the tac: knowledge partitions."
    )
    parser.add_argument("--tenant", required=True, help="tenant id that owns the partitions")
    parser.add_argument(
        "--groups",
        type=parse_groups,
        default=DEFAULT_GROUPS,
        help=f"comma separated streams to seed (default: {','.join(DEFAULT_GROUPS)})",
    )
    parser.add_argument("--version", default="", help="revision string; defaults to the commit")
    parser.add_argument(
        "--provider",
        choices=("openai", "deterministic"),
        default="openai",
        help="embedding provider; deterministic is a smoke aid (default: openai)",
    )
    parser.add_argument("--query", default="", help="optional retrieval probe after the ingest")
    parser.add_argument(
        "--pace-ms",
        type=int,
        default=400,
        help="millisecond gap between documents, to stay inside the embedding key's per-minute"
        " quota (default: 400; 0 disables it)",
    )
    parser.add_argument(
        "--dump-dir", default="", help="write extracted text here and skip the database"
    )
    parser.add_argument("--dry-run", action="store_true", help="validate and report, write nothing")
    args = parser.parse_args()

    tenant = args.tenant.strip()
    if TENANT_RE.match(tenant) is None:
        print(
            "tenant must start with a letter or digit and hold only letters,"
            " digits, dot, dash or underscore",
            file=sys.stderr,
        )
        return 1
    for domain in GROUP_DOMAINS.values():
        if DOMAIN_RE.fullmatch(domain) is None:
            print(f"domain {domain!r} is not a partition the database allows", file=sys.stderr)
            return 1
    if not WIKIS_JSON.is_file() and not CLOUD_DIR.is_dir():
        print(f"no simulated company corpus under {SERVICES}", file=sys.stderr)
        return 1

    now = datetime.now(UTC)
    version = args.version.strip() or pinned_commit() or now.strftime("%Y-%m-%d")
    pinned = pinned_commit_date()
    stale_after = (
        (pinned or now) + timedelta(days=REVIEW_WINDOW_DAYS)
        if pinned is not None
        else now + timedelta(days=REVIEW_WINDOW_DAYS)
    )

    documents: list[KnowledgeDocument] = []
    notes: list[str] = []
    if "wiki" in args.groups:
        documents += wiki_documents(tenant, version, stale_after)
    if "company" in args.groups or "tech" in args.groups:
        cloud, cloud_notes = cloud_documents(tenant, version, stale_after, args.groups)
        documents += cloud
        notes += cloud_notes
    documents, dup_notes = deduplicate(documents)
    notes += dup_notes

    invalid = [
        document.source_id
        for document in documents
        if SOURCE_ID_RE.fullmatch(document.source_id) is None
    ]
    if invalid:
        print(f"source ids rejected by the API pattern: {', '.join(invalid[:5])}", file=sys.stderr)
        return 1
    if not documents:
        print("nothing to seed; check --groups and the fixture paths", file=sys.stderr)
        return 1

    by_domain: dict[str, int] = {}
    for document in documents:
        by_domain[document.domain] = by_domain.get(document.domain, 0) + 1
    partitions = ", ".join(f"{name}={count}" for name, count in sorted(by_domain.items()))
    print(
        f"tenant={tenant} version={version} groups={','.join(args.groups)}"
        f" documents={len(documents)} ({partitions})"
        f" stale_after={stale_after.date().isoformat()}"
    )
    for note in notes:
        print(f"  note: {note}")

    if args.dump_dir.strip():
        dump(documents, Path(args.dump_dir.strip()))
        return 0
    if args.dry_run:
        for document in documents:
            print(
                f"  [{document.domain}] {document.source_id}"
                f" chunks={len(chunk_text(document.content))}"
                f" chars={len(document.content)} title={document.title!r}"
            )
        print("dry run: nothing written")
        return 0

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

    return run_async(seed(documents, provider, settings, args.query.strip(), max(args.pace_ms, 0)))


if __name__ == "__main__":
    raise SystemExit(main())
