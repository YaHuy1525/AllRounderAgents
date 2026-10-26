"""Connector registry + vault (N2): Settings -> Connections.

Pins the endpoint contract (catalog order, write-only secrets, tenant
scoping, role gates) and the migration parity: the durable `connectors` seed
must match the reviewed ``policy/tools.yaml`` catalog exactly, so adding a
provider is a deliberate two-sided edit (policy + migration), never drift.
"""

from __future__ import annotations

from pathlib import Path

from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.policy import default_tool_matrix
from allrounder_api.repositories import InMemoryConnectorVaultRepository
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

VIEWER = {"Authorization": "Bearer viewer"}
OUTSIDER = {"Authorization": "Bearer outsider"}
AGENT = {"Authorization": "Bearer agent"}
AGENT_B = {"Authorization": "Bearer agent-b"}

# The connectable catalog in reviewed order (policy/tools.yaml `connectors:`).
CATALOG = ("github", "jira", "gmail", "calendar", "slack")


def _api() -> TestClient:
    verifier = FakeBearerVerifier(
        {
            "viewer": Principal("viewer-1", "tenant-a", frozenset({"viewer"})),
            "outsider": Principal("dev-1", "tenant-a", frozenset({"intern"})),
            "agent": Principal("agent-1", "tenant-a", frozenset({"agent"})),
            "agent-b": Principal("agent-2", "tenant-b", frozenset({"agent"})),
        }
    )
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=verifier,
        connector_vault=InMemoryConnectorVaultRepository(),
    )
    return TestClient(app)


def test_connectors_list_the_catalog_with_per_tenant_status() -> None:
    http = _api()
    assert http.get("/connectors").status_code == 401
    forbidden = http.get("/connectors", headers=OUTSIDER)
    assert forbidden.status_code == 403
    listed = http.get("/connectors", headers=VIEWER)
    assert listed.status_code == 200, listed.text
    connectors = listed.json()["connectors"]
    assert [item["provider"] for item in connectors] == list(CATALOG)
    for item in connectors:
        assert set(item) == {
            "provider",
            "description",
            "scope",
            "class",
            "connected",
            "secretHint",
            "connectedAt",
        }
        assert item["connected"] is False
        assert item["secretHint"] == ""
        assert item["connectedAt"] is None
    by_provider = {item["provider"]: item for item in connectors}
    # The reviewed scopes: gmail serves the hr-help:send receipt, slack is
    # approver-notify only, github stays a read-only home.
    assert by_provider["gmail"]["scope"] == "hr-help:send"
    assert by_provider["gmail"]["class"] == "approval"
    assert by_provider["slack"]["scope"] == "approver-notify"
    assert by_provider["github"]["class"] == "read-only"


def test_connect_hides_the_secret_and_rotates_in_place() -> None:
    http = _api()
    first = http.post(
        "/connectors/gmail/connect",
        headers=AGENT,
        json={"secret": "  app-password-abcd  "},
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["connected"] is True
    assert body["secretHint"] == "\u2026abcd"
    assert "app-password-abcd" not in first.text
    assert body["connectedAt"] is not None
    listed = http.get("/connectors", headers=VIEWER)
    gmail = next(
        item for item in listed.json()["connectors"] if item["provider"] == "gmail"
    )
    assert gmail == body
    assert "app-password-abcd" not in listed.text
    # Re-connecting rotates the credential but keeps the connection moment.
    rotated = http.post(
        "/connectors/gmail/connect",
        headers=AGENT,
        json={"secret": "app-password-wxyz"},
    )
    assert rotated.status_code == 200
    assert rotated.json()["secretHint"] == "\u2026wxyz"
    assert rotated.json()["connectedAt"] == body["connectedAt"]
    # Other providers stay disconnected.
    others = [
        item["provider"]
        for item in listed.json()["connectors"]
        if item["connected"]
    ]
    assert others == ["gmail"]


def test_connect_gates_roles_payload_and_known_providers() -> None:
    http = _api()
    assert (
        http.post("/connectors/gmail/connect", json={"secret": "abcdefgh"}).status_code
        == 401
    )
    denied = http.post(
        "/connectors/gmail/connect", headers=VIEWER, json={"secret": "abcdefgh"}
    )
    assert denied.status_code == 403
    unknown = http.post(
        "/connectors/zendesk/connect", headers=AGENT, json={"secret": "abcdefgh"}
    )
    assert unknown.status_code == 404
    malformed = http.post(
        "/connectors/Gmail!/connect", headers=AGENT, json={"secret": "abcdefgh"}
    )
    assert malformed.status_code == 422
    short = http.post(
        "/connectors/gmail/connect", headers=AGENT, json={"secret": "  abc  "}
    )
    assert short.status_code == 422


def test_disconnect_revokes_cleanly_and_is_tenant_scoped() -> None:
    http = _api()
    assert http.delete("/connectors/gmail", headers=AGENT).status_code == 404
    assert (
        http.post(
            "/connectors/gmail/connect", headers=AGENT, json={"secret": "abcdefgh"}
        ).status_code
        == 200
    )
    stolen = http.delete("/connectors/gmail", headers=AGENT_B)
    assert stolen.status_code == 404
    assert http.delete("/connectors/gmail", headers=VIEWER).status_code == 403
    revoked = http.delete("/connectors/gmail", headers=AGENT)
    assert revoked.status_code == 204
    listed = http.get("/connectors", headers=VIEWER).json()["connectors"]
    gmail = next(item for item in listed if item["provider"] == "gmail")
    assert gmail["connected"] is False
    assert gmail["secretHint"] == ""
    assert http.delete("/connectors/gmail", headers=AGENT).status_code == 404
    # The other tenant's connection state never leaks through.
    other = http.get("/connectors", headers=AGENT_B).json()["connectors"]
    assert all(item["connected"] is False for item in other)


def test_connectors_migration_forces_rls_and_seeds_the_catalog() -> None:
    migrations = Path(__file__).parents[3] / "supabase" / "migrations"
    migration = (migrations / "202610100015_connectors.sql").read_text(encoding="utf-8")
    for table in ("connectors", "connector_vault_refs"):
        assert f"alter table public.{table} enable row level security" in migration
        assert f"alter table public.{table} force row level security" in migration
        assert f"revoke all on public.{table} from public, anon, authenticated" in migration
    assert "references public.connectors (provider)" in migration
    # The durable seed mirrors the reviewed catalog provider by provider, so
    # adding one on either side without the other fails this test.
    for connector in default_tool_matrix().connectors:
        assert (
            f"('{connector.provider}', '{connector.scope}', "
            f"'{connector.approval_class.value}'"
        ) in migration, connector.provider
