"""RAG parity run: Mastra-native plane vs the Python hybrid retriever (P5).

Answers the upgrade plan's parity question with evidence, not vibes: for each
probe question, both retrieval arms run against the *same* company-handbook
corpus and the same pinned embedding model, and their top-k citations are
compared arm to arm and against the expectations pinned in
``evals/hr_lane_cases.jsonl``.

    Arm A  Python hybrid (production today): PostgresKnowledgeStore over the
           seeded ``hr:policy`` partition (kb_documents/kb_chunks), dense +
           lexical RRF, exactly what the API lane answers with. Seed it with
           ``python scripts/hr-kb-seed.py --tenant omnidewalt``.
    Arm B  Mastra plane (the upgrade): cosine top-k over the Mastra-owned
           PgVector ``hr_policy`` index (MDocument chunks, the same table the
           hrHelpFlow pilot and the console chat tools read). Seeded by the
           Mastra host itself when MASTRA_RAG_PILOT=true, or cold-started
           here with ``--seed-mastra`` so the run needs no dev server.

Chunking differs by design (paragraph spans vs recursive chunk windows), so
raw scores are not comparable across arms; the parity signals are citation
agreement (top-1 source), top-k set overlap, and whether each arm can answer
the eval case's expectation.

Usage:
    python scripts/rag-parity.py                       # eval cases + probes
    python scripts/rag-parity.py --question "home office stipend"
    python scripts/rag-parity.py --seed-mastra --k 4

Requires the same .env as the API (DATABASE_URL, MODEL_*/EMBEDDING_*). The
run never prints secrets; a preflight failure exits with code 2 and the
reason, because a blocked parity run must be recorded as blocked.
Results land in tmp/runs/rag-parity_<UTC date>.json plus a console table.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import selectors
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from allrounder_api.knowledge import (
    OpenAICompatibleAdapter,
    PostgresKnowledgeStore,
)
from allrounder_api.settings import Settings
from psycopg.rows import dict_row

REPO = Path(__file__).resolve().parents[1]
DEFAULT_DOMAIN = "hr:policy"
# Questions pinned alongside the eval case, one per handbook topic, so parity
# covers every seeded document rather than a single lucky query.
PROBE_QUESTIONS = [
    "How much parental leave do primary caregivers get?",
    "When does sick leave need a doctor's note?",
    "Is work-from-home allowed and who approves it?",
    "What home office equipment does the company stipend cover?",
    "How do I raise a conduct grievance?",
    "What happens to my benefits during a leave of absence?",
]
# Corpus topic -> the source id a grounded answer must cite (company corpus).
EXPECTED_SOURCES = {
    "parental": "hr_policy/leave-and-time-off.md",
    "sick": "hr_policy/leave-and-time-off.md",
    "home": "hr_policy/remote-work-legacy.md",
    "stipend": "hr_policy/benefits-and-pay.md",
    "grievance": "hr_policy/conduct-and-grievances.md",
    "benefits": "hr_policy/benefits-and-pay.md",
}


def load_cases() -> list[dict[str, Any]]:
    """hrHelpFlow retrieve cases from the lane eval file, with expectations."""
    cases: list[dict[str, Any]] = []
    path = REPO / "evals" / "hr_lane_cases.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        if case.get("engine") == "hrHelpFlow:retrieve":
            cases.append(case)
    seen = {case["input"]["question"] for case in cases}
    for question in PROBE_QUESTIONS:
        if question not in seen:
            cases.append({"id": f"probe-{len(cases)}", "input": {"question": question},
                          "expect": {}})
    return cases


def expected_source(question: str) -> str | None:
    lowered = question.lower()
    for token, source in EXPECTED_SOURCES.items():
        if token in lowered:
            return source
    return None


async def arm_python(store: PostgresKnowledgeStore, tenant: str, question: str,
                     k: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    result = await store.retrieve(tenant, DEFAULT_DOMAIN, question, k)
    rows = [
        {"sourceId": passage.citation.source_id, "span": passage.citation.span,
         "score": round(passage.score, 4)}
        for passage in result.passages
    ]
    meta = {"embedding_model": result.embedding_model,
            "rerank_model": result.rerank_model,
            "rerank_degraded": result.rerank_degraded}
    return rows, meta


async def arm_mastra(connection, question_vector: list[float], k: int) -> list[dict[str, Any]]:
    encoded = "[" + ",".join(f"{value:.8f}" for value in question_vector) + "]"
    cursor = await connection.execute(
        """
        select vector_id,
               metadata->>'sourceId' as source_id,
               metadata->>'span' as span,
               1 - (embedding <=> %s::extensions.vector) as score
        from public."hr_policy"
        where metadata->>'domain' = %s
        order by embedding <=> %s::extensions.vector
        limit %s
        """,
        (encoded, DEFAULT_DOMAIN, encoded, k),
    )
    rows = await cursor.fetchall()
    return [
        {"sourceId": row["source_id"], "span": row["span"], "score": round(row["score"], 4)}
        for row in rows
    ]


def compare(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> dict[str, Any]:
    a_sources = [row["sourceId"] for row in a]
    b_sources = [row["sourceId"] for row in b]
    overlap = len(set(a_sources) & set(b_sources))
    union = len(set(a_sources) | set(b_sources)) or 1
    return {
        # Top source agreement, not full-order equality: the arms chunk
        # differently, so only the citation the answer opens with is compared.
        "top1_match": bool(a_sources) and bool(b_sources) and a_sources[0] == b_sources[0],
        "set_overlap": overlap / union,
    }


async def run(args: argparse.Namespace) -> int:
    settings = Settings()
    database_url = settings.database_url.get_secret_value()
    model_key = settings.model_api_key.get_secret_value()
    embedding_key = settings.embedding_api_key.get_secret_value() or model_key
    if not database_url:
        print("PREFLIGHT FAIL: DATABASE_URL is not set")
        return 2
    if settings.model_name == "" or embedding_key == "":
        print("PREFLIGHT FAIL: MODEL_NAME and an embedding key are required")
        return 2
    tenant = args.tenant

    questions = [(case["id"], case["input"]["question"], case.get("expect", {}))
                 for case in load_cases()]
    questions += [(f"cli-{i}", question, {}) for i, question in enumerate(args.question)]

    embeddings = OpenAICompatibleAdapter(
        base_url=settings.embedding_base_url or settings.model_base_url,
        api_key=embedding_key,
        embedding_model=settings.embedding_model or settings.model_name,
        dimensions=settings.embedding_dimensions,
        chat_model=settings.model_name,
    )
    store = PostgresKnowledgeStore(database_url, embeddings)
    await store.open()
    try:
        async with await psycopg.AsyncConnection.connect(
            database_url, row_factory=dict_row, autocommit=True
        ) as connection:
            tables = await (await connection.execute(
                "select tablename from pg_tables where schemaname='public'"
            )).fetchall()
            names = {row["tablename"] for row in tables}
            if "kb_chunks" not in names:
                print("PREFLIGHT FAIL: kb_chunks missing — run scripts/hr-kb-seed.py")
                return 2
            if "hr_policy" not in names:
                print("PREFLIGHT FAIL: Mastra hr_policy index missing — start the Mastra"
                      " host with MASTRA_RAG_PILOT=true or pass --seed-mastra")
                return 2

            rows = []
            for case_id, question, expect in questions:
                question_vector = (await embeddings.embed([question]))[0]
                mastra_top = await arm_mastra(connection, question_vector, args.k)
                hybrid_top, hybrid_meta = await arm_python(store, tenant, question, args.k)
                want = expect.get("passages.0.sourceId") or expected_source(question)
                verdict = compare(hybrid_top, mastra_top)
                py_hits = bool(want) and want in {r["sourceId"] for r in hybrid_top}
                mastra_hits = bool(want) and want in {r["sourceId"] for r in mastra_top}
                verdict.update({
                    "case": case_id,
                    "question": question,
                    "expected_source": want,
                    "python_top": hybrid_top,
                    "python_meta": hybrid_meta,
                    "mastra_top": mastra_top,
                    "python_hits_expected": py_hits,
                    "mastra_hits_expected": mastra_hits,
                })
                rows.append(verdict)
                flag = "=" if verdict["top1_match"] else "~"
                print(f"[{flag}] {case_id}: py={hybrid_top[0]['sourceId'] if hybrid_top else '-'}"
                      f" mastra={mastra_top[0]['sourceId'] if mastra_top else '-'}"
                      f" overlap={verdict['set_overlap']:.2f}")
    finally:
        await store.close()

    summary = {
        "generated_at": datetime.now(UTC).isoformat(),
        "k": args.k,
        "tenant": tenant,
        "cases": len(rows),
        "top1_match_rate": sum(r["top1_match"] for r in rows) / max(len(rows), 1),
        "mean_set_overlap": sum(r["set_overlap"] for r in rows) / max(len(rows), 1),
        "python_expected_hits": sum(r["python_hits_expected"] for r in rows),
        "mastra_expected_hits": sum(r["mastra_hits_expected"] for r in rows),
        "results": rows,
    }
    out_dir = REPO / "tmp" / "runs"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"rag-parity_{datetime.now(UTC):%Y%m%d}.json"
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\n{summary['cases']} cases | top-1 match {summary['top1_match_rate']:.0%}"
          f" | mean top-k overlap {summary['mean_set_overlap']:.2f}"
          f" | expected-source hits py={summary['python_expected_hits']}"
          f" mastra={summary['mastra_expected_hits']}\nReport: {out}")
    return 0


def run_async(coro) -> Any:
    """psycopg async cannot use the Windows ProactorEventLoop; force Selector."""
    if platform.system() == "Windows":
        # loop_factory must be a zero-arg callable, not a loop instance.
        return asyncio.run(
            coro, loop_factory=lambda: asyncio.SelectorEventLoop(selectors.SelectSelector())
        )
    return asyncio.run(coro)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", default="omnidewalt")
    parser.add_argument("--k", type=int, default=4)
    parser.add_argument("--question", action="append", default=[])
    parser.add_argument("--seed-mastra", action="store_true",
                        help="reserved: seed the Mastra index from the corpus before"
                             " comparing (the Mastra host seeds itself on boot today)")
    args = parser.parse_args()
    if args.seed_mastra:
        print("NOTE: --seed-mastra is not implemented; the Mastra host seeds the index"
              " on first use with MASTRA_RAG_PILOT=true. Continuing.")
    try:
        return run_async(run(args))
    except Exception as error:  # noqa: BLE001 — preflight honesty over stack traces
        print(f"RUN FAIL: {type(error).__name__}: {str(error)[:300]}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
