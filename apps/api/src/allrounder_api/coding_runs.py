from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from .repositories import redact

if TYPE_CHECKING:
    from .repositories import PostgresRepositories


@dataclass
class CodingRunRecord:
    id: str
    case_id: str
    tenant_id: str
    ticket_key: str
    repository: str
    base_branch: str
    source_sha: str
    branch: str
    problem: str
    idempotency_key: str
    status: str = "investigating"
    rca_evidence: list[dict[str, object]] = field(default_factory=list)
    patch_manifest: dict[str, object] | None = None
    validation_result: dict[str, object] | None = None
    pr_receipt: dict[str, object] | None = None


class CodingRunRepository(Protocol):
    async def create(self, run: CodingRunRecord) -> CodingRunRecord: ...
    async def get(self, run_id: str, tenant_id: str) -> CodingRunRecord: ...
    async def save_evidence(
        self, run_id: str, tenant_id: str, evidence: list[dict[str, object]]
    ) -> None: ...
    async def save_manifest(
        self, run_id: str, tenant_id: str, manifest: dict[str, object]
    ) -> None: ...
    async def save_validation(
        self, run_id: str, tenant_id: str, report: dict[str, object]
    ) -> None: ...
    async def save_pr_receipt(
        self, run_id: str, tenant_id: str, receipt: dict[str, object]
    ) -> None: ...


def _safe_run(run: CodingRunRecord) -> CodingRunRecord:
    safe = deepcopy(run)
    safe.problem = str(redact(safe.problem))
    evidence = redact(safe.rca_evidence)
    manifest = redact(safe.patch_manifest)
    validation = redact(safe.validation_result)
    receipt = redact(safe.pr_receipt)
    if not isinstance(evidence, list):
        raise TypeError("Invalid evidence")
    safe.rca_evidence = evidence
    safe.patch_manifest = manifest if isinstance(manifest, dict) else None
    safe.validation_result = validation if isinstance(validation, dict) else None
    safe.pr_receipt = receipt if isinstance(receipt, dict) else None
    return safe


class InMemoryCodingRunRepository:
    def __init__(self) -> None:
        self._runs: dict[str, CodingRunRecord] = {}
        self._idempotency: dict[tuple[str, str, str, str], str] = {}

    async def create(self, run: CodingRunRecord) -> CodingRunRecord:
        key = (run.tenant_id, run.repository, run.branch, run.idempotency_key)
        existing_id = self._idempotency.get(key)
        if existing_id is not None:
            return deepcopy(self._runs[existing_id])
        if run.id in self._runs:
            raise ValueError("Coding run already exists")
        safe = _safe_run(run)
        self._runs[safe.id] = safe
        self._idempotency[key] = safe.id
        return deepcopy(safe)

    async def get(self, run_id: str, tenant_id: str) -> CodingRunRecord:
        run = self._runs.get(run_id)
        if run is None or run.tenant_id != tenant_id:
            raise KeyError("Coding run not found")
        return deepcopy(run)

    async def save_evidence(
        self, run_id: str, tenant_id: str, evidence: list[dict[str, object]]
    ) -> None:
        run = await self._mutable(run_id, tenant_id)
        safe = redact(evidence)
        if not isinstance(safe, list):
            raise TypeError("Invalid evidence")
        run.rca_evidence = safe

    async def save_manifest(
        self, run_id: str, tenant_id: str, manifest: dict[str, object]
    ) -> None:
        await self._save_object(run_id, tenant_id, "patch_manifest", manifest)

    async def save_validation(
        self, run_id: str, tenant_id: str, report: dict[str, object]
    ) -> None:
        await self._save_object(run_id, tenant_id, "validation_result", report)

    async def save_pr_receipt(
        self, run_id: str, tenant_id: str, receipt: dict[str, object]
    ) -> None:
        await self._save_object(run_id, tenant_id, "pr_receipt", receipt)

    async def _mutable(self, run_id: str, tenant_id: str) -> CodingRunRecord:
        run = self._runs.get(run_id)
        if run is None or run.tenant_id != tenant_id:
            raise KeyError("Coding run not found")
        return run

    async def _save_object(
        self, run_id: str, tenant_id: str, field_name: str, value: dict[str, object]
    ) -> None:
        safe = redact(value)
        if not isinstance(safe, dict):
            raise TypeError("Invalid coding artifact")
        setattr(await self._mutable(run_id, tenant_id), field_name, safe)


class PostgresCodingRunRepository:
    def __init__(self, database: PostgresRepositories) -> None:
        self._database = database

    async def create(self, run: CodingRunRecord) -> CodingRunRecord:
        safe = _safe_run(run)
        async with self._database.pool.connection() as connection:
            cursor = await connection.execute(
                """
                insert into public.coding_runs
                  (id, case_id, tenant_id, ticket_key, repository, base_ref, source_sha,
                   head_ref, problem_redacted, idempotency_key, status, root_cause)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, '{}'::jsonb)
                on conflict (tenant_id, repository, head_ref, idempotency_key)
                do update set idempotency_key = excluded.idempotency_key
                returning *
                """,
                (
                    safe.id, safe.case_id, safe.tenant_id, safe.ticket_key, safe.repository,
                    safe.base_branch, safe.source_sha, safe.branch, safe.problem,
                    safe.idempotency_key, safe.status,
                ),
            )
            row = await cursor.fetchone()
        if row is None:
            raise RuntimeError("Coding run upsert returned no row")
        return _run_from_row(row)

    async def get(self, run_id: str, tenant_id: str) -> CodingRunRecord:
        async with self._database.pool.connection() as connection:
            cursor = await connection.execute(
                """
                select r.*,
                    e.evidence as rca_evidence,
                    m.manifest as patch_manifest,
                    (select v.report from public.coding_validation_results v
                     where v.coding_run_id = r.id and v.tenant_id = r.tenant_id
                     order by v.attempt desc limit 1) as validation_result,
                    p.receipt as pr_receipt
                from public.coding_runs r
                left join public.coding_rca_evidence e
                    on e.coding_run_id = r.id and e.tenant_id = r.tenant_id
                left join public.coding_patch_manifests m
                    on m.coding_run_id = r.id and m.tenant_id = r.tenant_id
                left join public.coding_pr_receipts p
                    on p.coding_run_id = r.id and p.tenant_id = r.tenant_id
                where r.id = %s and r.tenant_id = %s
                """,
                (run_id, tenant_id),
            )
            row = await cursor.fetchone()
        if row is None:
            raise KeyError("Coding run not found")
        return _run_from_row(row)

    async def save_evidence(
        self, run_id: str, tenant_id: str, evidence: list[dict[str, object]]
    ) -> None:
        safe = redact(evidence)
        if not isinstance(safe, list):
            raise TypeError("Invalid RCA evidence")
        await self._execute_scoped(
            """
            insert into public.coding_rca_evidence
              (coding_run_id, tenant_id, evidence, confidence)
            select id, tenant_id, %s::jsonb, 0 from public.coding_runs
            where id = %s and tenant_id = %s
            on conflict (coding_run_id, tenant_id)
            do update set evidence = excluded.evidence
            returning coding_run_id
            """,
            (json.dumps(safe), run_id, tenant_id),
        )

    async def save_manifest(
        self, run_id: str, tenant_id: str, manifest: dict[str, object]
    ) -> None:
        safe = redact(manifest)
        patch_hash = safe.get("patchHash") if isinstance(safe, dict) else None
        if not isinstance(patch_hash, str):
            raise ValueError("Patch manifest requires patchHash")
        await self._execute_scoped(
            """
            insert into public.coding_patch_manifests
              (coding_run_id, tenant_id, patch_hash, manifest)
            select id, tenant_id, %s, %s::jsonb from public.coding_runs
            where id = %s and tenant_id = %s
            on conflict (coding_run_id, tenant_id)
            do update set patch_hash = excluded.patch_hash, manifest = excluded.manifest
            returning coding_run_id
            """,
            (patch_hash, json.dumps(safe), run_id, tenant_id),
        )

    async def save_validation(
        self, run_id: str, tenant_id: str, report: dict[str, object]
    ) -> None:
        safe = redact(report)
        if not isinstance(safe, dict):
            raise TypeError("Invalid validation report")
        attempt = safe.get("attempts")
        passed = safe.get("passed")
        if not isinstance(attempt, int) or not isinstance(passed, bool):
            raise ValueError("Validation report requires attempts and passed")
        await self._execute_scoped(
            """
            insert into public.coding_validation_results
              (coding_run_id, tenant_id, attempt, passed, report)
            select id, tenant_id, %s, %s, %s::jsonb from public.coding_runs
            where id = %s and tenant_id = %s
            on conflict (coding_run_id, tenant_id, attempt)
            do update set passed = excluded.passed, report = excluded.report
            returning coding_run_id
            """,
            (attempt, passed, json.dumps(safe), run_id, tenant_id),
        )

    async def save_pr_receipt(
        self, run_id: str, tenant_id: str, receipt: dict[str, object]
    ) -> None:
        safe = redact(receipt)
        if not isinstance(safe, dict):
            raise TypeError("Invalid PR receipt")
        repository = safe.get("repository")
        branch = safe.get("branch")
        patch_hash = safe.get("patchHash")
        if not all(isinstance(value, str) for value in (repository, branch, patch_hash)):
            raise ValueError("PR receipt requires repository, branch, and patchHash")
        await self._execute_scoped(
            """
            insert into public.coding_pr_receipts
              (coding_run_id, tenant_id, repository, branch, patch_hash, receipt)
            select id, tenant_id, %s, %s, %s, %s::jsonb from public.coding_runs
            where id = %s and tenant_id = %s
            on conflict (tenant_id, repository, branch, patch_hash)
            do update set receipt = excluded.receipt
            returning coding_run_id
            """,
            (repository, branch, patch_hash, json.dumps(safe), run_id, tenant_id),
        )

    async def _execute_scoped(
        self, statement: str, parameters: tuple[object, ...]
    ) -> None:
        async with self._database.pool.connection() as connection:
            cursor = await connection.execute(statement, parameters)
            if await cursor.fetchone() is None:
                raise KeyError("Coding run not found")


def _run_from_row(row: dict[str, object]) -> CodingRunRecord:
    root_cause = row.get("root_cause")
    evidence_value = root_cause.get("evidence", []) if isinstance(root_cause, dict) else []
    stored_evidence = row.get("rca_evidence")
    evidence = (
        stored_evidence
        if isinstance(stored_evidence, list)
        else evidence_value if isinstance(evidence_value, list) else []
    )
    manifest = row.get("patch_manifest")
    validation = row.get("validation_result")
    receipt = row.get("pr_receipt")
    return CodingRunRecord(
        id=str(row["id"]),
        case_id=str(row["case_id"]),
        tenant_id=str(row["tenant_id"]),
        ticket_key=str(row["ticket_key"]),
        repository=str(row["repository"]),
        base_branch=str(row["base_ref"]),
        source_sha=str(row["source_sha"]),
        branch=str(row["head_ref"]),
        problem=str(row["problem_redacted"]),
        idempotency_key=str(row["idempotency_key"]),
        status=str(row["status"]),
        rca_evidence=[item for item in evidence if isinstance(item, dict)],
        patch_manifest=manifest if isinstance(manifest, dict) else None,
        validation_result=validation if isinstance(validation, dict) else None,
        pr_receipt=receipt if isinstance(receipt, dict) else None,
    )
