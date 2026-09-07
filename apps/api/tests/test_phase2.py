from __future__ import annotations

from pathlib import Path

import pytest
from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.coding_runs import (
    CodingRunRecord,
    InMemoryCodingRunRepository,
    PostgresCodingRunRepository,
)
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient


def client_with_runs() -> tuple[TestClient, InMemoryCodingRunRepository]:
    verifier = FakeBearerVerifier(
        {
            "agent": Principal("agent-1", "tenant-a", frozenset({"agent"})),
            "admin": Principal("admin-1", "tenant-a", frozenset({"admin"})),
            "viewer": Principal("viewer-1", "tenant-a", frozenset({"viewer"})),
            "other": Principal("viewer-2", "tenant-b", frozenset({"viewer"})),
        }
    )
    runs = InMemoryCodingRunRepository()
    app = create_app(
        settings=Settings(
            webhook_secret="test",
            github_repository_allowlist=["acme/widget"],
            github_base_branch="main",
        ),
        auth_verifier=verifier,
        coding_runs=runs,
    )
    return TestClient(app), runs


def start_payload() -> dict[str, str]:
    return {
        "caseId": "11111111-1111-1111-1111-111111111111",
        "ticketKey": "ENG-42",
        "repository": "acme/widget",
        "baseBranch": "main",
        "sourceSha": "a" * 40,
        "branch": "agent/ENG-42-fix",
        "problem": "Fix malformed config",
        "idempotencyKey": "ticket-ENG-42-attempt-1",
    }


def test_start_and_read_coding_run_are_role_and_tenant_scoped() -> None:
    client, _runs = client_with_runs()
    agent = {"Authorization": "Bearer agent"}
    viewer = {"Authorization": "Bearer viewer"}

    assert client.post("/coding/runs", json=start_payload()).status_code == 401
    assert client.post("/coding/runs", headers=viewer, json=start_payload()).status_code == 403
    created = client.post("/coding/runs", headers=agent, json=start_payload())
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]
    assert created.json()["status"] == "investigating"

    assert client.get(f"/coding/runs/{run_id}", headers=viewer).status_code == 200
    assert client.get(
        f"/coding/runs/{run_id}", headers={"Authorization": "Bearer other"}
    ).status_code == 404
    assert client.get(f"/coding/runs/{run_id}", headers=agent).status_code == 403


def test_start_is_idempotent_and_rejects_repo_or_base_scope() -> None:
    client, _runs = client_with_runs()
    headers = {"Authorization": "Bearer admin"}
    first = client.post("/coding/runs", headers=headers, json=start_payload())
    second = client.post("/coding/runs", headers=headers, json=start_payload())
    assert first.json()["id"] == second.json()["id"]

    wrong_repo = start_payload() | {"repository": "evil/repo"}
    wrong_base = start_payload() | {"baseBranch": "production"}
    assert client.post("/coding/runs", headers=headers, json=wrong_repo).status_code == 403
    assert client.post("/coding/runs", headers=headers, json=wrong_base).status_code == 403


@pytest.mark.parametrize(
    "branch",
    [
        "../main",
        ".hidden",
        "agent//fix",
        "agent/fix.lock",
        "agent/feature.lock/fix",
        "agent/fix.",
    ],
)
def test_start_rejects_unsafe_git_branch_names(branch: str) -> None:
    client, _runs = client_with_runs()
    response = client.post(
        "/coding/runs",
        headers={"Authorization": "Bearer agent"},
        json=start_payload() | {"branch": branch},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_repository_redacts_artifacts_and_scopes_idempotency() -> None:
    repository = InMemoryCodingRunRepository()
    record = CodingRunRecord(
        id="run-1",
        case_id="case-1",
        tenant_id="tenant-a",
        ticket_key="ENG-42",
        repository="acme/widget",
        base_branch="main",
        source_sha="a" * 40,
        branch="agent/fix",
        problem="token github_pat_SECRET_VALUE",
        idempotency_key="key-1",
    )
    first = await repository.create(record)
    replay = await repository.create(record)
    assert first.id == replay.id
    await repository.save_evidence(
        "run-1",
        "tenant-a",
        [{
            "path": "src/a.py",
            "excerpt": "ghp_SECRET_VALUE eyJabcdefghijk.abcdefghijk.abcdefghijk",
        }],
    )
    stored = await repository.get("run-1", "tenant-a")
    assert "SECRET_VALUE" not in str(stored)
    with pytest.raises(KeyError):
        await repository.get("run-1", "tenant-b")

    other_tenant = record.__class__(
        **{**record.__dict__, "id": "run-2", "tenant_id": "tenant-b"}
    )
    assert (await repository.create(other_tenant)).id == "run-2"


@pytest.mark.asyncio
async def test_memory_repository_persists_all_artifact_types_and_errors() -> None:
    repository = InMemoryCodingRunRepository()
    record = CodingRunRecord(
        id="run-1", case_id="case-1", tenant_id="tenant-a", ticket_key="ENG-42",
        repository="acme/widget", base_branch="main", source_sha="a" * 40,
        branch="agent/fix", problem="fix", idempotency_key="key-1",
    )
    await repository.create(record)
    await repository.save_manifest("run-1", "tenant-a", {"patchHash": "b" * 64})
    await repository.save_validation(
        "run-1", "tenant-a", {"attempts": 1, "passed": True}
    )
    await repository.save_pr_receipt(
        "run-1", "tenant-a",
        {"repository": "acme/widget", "branch": "agent/fix", "patchHash": "b" * 64},
    )
    stored = await repository.get("run-1", "tenant-a")
    assert stored.patch_manifest == {"patchHash": "b" * 64}
    assert stored.validation_result == {"attempts": 1, "passed": True}
    assert stored.pr_receipt is not None
    with pytest.raises(KeyError):
        await repository.save_manifest("missing", "tenant-a", {})
    with pytest.raises(ValueError):
        await repository.create(record.__class__(
            **{**record.__dict__, "idempotency_key": "different"}
        ))


class FakeCursor:
    def __init__(self, row: dict[str, object] | None) -> None:
        self.row = row

    async def fetchone(self) -> dict[str, object] | None:
        return self.row


class FakeConnection:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def execute(
        self, statement: str, parameters: tuple[object, ...]
    ) -> FakeCursor:
        self.calls.append((statement, parameters))
        if "returning *" in statement or "select r.*" in statement:
            return FakeCursor({
                "id": "run-1", "case_id": "case-1", "tenant_id": "tenant-a",
                "ticket_key": "ENG-42", "repository": "acme/widget", "base_ref": "main",
                "source_sha": "a" * 40, "head_ref": "agent/fix",
                "problem_redacted": "fix", "idempotency_key": "key-1",
                "status": "investigating", "root_cause": {},
            })
        return FakeCursor({"id": "run-1"})


class FakeConnectionContext:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection

    async def __aenter__(self) -> FakeConnection:
        return self.connection

    async def __aexit__(self, *_args: object) -> None:
        return None


class FakePool:
    def __init__(self) -> None:
        self.value = FakeConnection()

    def connection(self) -> FakeConnectionContext:
        return FakeConnectionContext(self.value)


@pytest.mark.asyncio
async def test_postgres_coding_repository_uses_scoped_parameterized_writes() -> None:
    database = type("FakeDatabase", (), {"pool": FakePool()})()
    repository = PostgresCodingRunRepository(database)  # type: ignore[arg-type]
    record = CodingRunRecord(
        id="run-1", case_id="case-1", tenant_id="tenant-a", ticket_key="ENG-42",
        repository="acme/widget", base_branch="main", source_sha="a" * 40,
        branch="agent/fix", problem="fix", idempotency_key="key-1",
    )
    assert (await repository.create(record)).tenant_id == "tenant-a"
    assert (await repository.get("run-1", "tenant-a")).id == "run-1"
    await repository.save_evidence("run-1", "tenant-a", [{"path": "src/a.py"}])
    await repository.save_manifest(
        "run-1", "tenant-a", {"patchHash": "b" * 64}
    )
    await repository.save_validation(
        "run-1", "tenant-a", {"attempts": 1, "passed": True}
    )
    await repository.save_pr_receipt(
        "run-1", "tenant-a",
        {"repository": "acme/widget", "branch": "agent/fix", "patchHash": "b" * 64},
    )
    assert all("%s" in statement for statement, _ in database.pool.value.calls)
    assert all(
        "tenant-a" in parameters
        for statement, parameters in database.pool.value.calls
        if "coding_runs" in statement
    )


def test_no_direct_patch_endpoint_exists() -> None:
    client, _runs = client_with_runs()
    response = client.post(
        "/coding/patch",
        headers={"Authorization": "Bearer admin"},
        json={"path": "src/a.py", "content": "unsafe"},
    )
    assert response.status_code == 404


def test_phase2_migration_forces_rls_and_removes_browser_grants() -> None:
    migrations = Path(__file__).parents[3] / "supabase" / "migrations"
    migration = (migrations / "202609070005_phase2_coding_hardening.sql").read_text(
        encoding="utf-8"
    )
    phase2_foundation = (migrations / "202609070003_phase2_coding.sql").read_text(
        encoding="utf-8"
    )
    assert "alter table public.coding_runs force row level security" in phase2_foundation
    assert (
        "revoke all on public.coding_runs from public, anon, authenticated"
        in phase2_foundation
    )
    assert "alter table public.coding_runs force row level security" in migration
    assert "revoke all on public.coding_runs from public, anon, authenticated" in migration
    for table in (
        "coding_rca_evidence",
        "coding_patch_manifests",
        "coding_validation_results",
        "coding_pr_receipts",
    ):
        assert f"alter table public.{table} force row level security" in migration
        assert f"revoke all on public.{table} from public, anon, authenticated" in migration
    assert "unique (tenant_id, repository, branch, patch_hash)" in migration
