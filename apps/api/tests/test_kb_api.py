"""Console knowledge base (U5): role gates, ingest, and cited reads.

The contract under test mirrors the upgrade's done-criterion: an uploaded
``hr_policy/*.md`` document comes back as a cited passage (``sourceId`` +
``span`` + ``sourceVersion``) with its stale flag, the team-canonical toggle
filters drafts out of retrieval, and the only write on the surface is the
admin-only document upsert. Support parity is asserted by searching both
partitions through the command bar's knowledge section.
"""

from __future__ import annotations

from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.knowledge import (
    DeterministicEmbeddingProvider,
    InMemoryKnowledgeStore,
)
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

TENANT = "omnidewalt"
ADMIN = Principal("user-1", TENANT, frozenset({"admin"}))
APPROVER = Principal("user-2", TENANT, frozenset({"approver"}))
VIEWER = Principal("user-3", TENANT, frozenset({"viewer"}))
GUEST = Principal("user-4", TENANT, frozenset({"guest"}))
OTHER_ADMIN = Principal("user-5", "otherco", frozenset({"admin"}))
AUTH = {"Authorization": "Bearer tok"}
APPROVER_AUTH = {"Authorization": "Bearer approver-token"}
OTHER_AUTH = {"Authorization": "Bearer other-token"}

LEAVE_CONTENT = (
    "Employees accrue 25 days of paid annual leave per calendar year. "
    "Annual leave requests must be submitted at least 10 calendar days "
    "before the first day of leave.\n\n"
    "Sick leave is tracked separately and does not draw down the annual "
    "balance."
)
SUPPORT_CONTENT = (
    "Reset the VPN client before the next shift. Escalate to tier two when "
    "the client cannot authenticate."
)


class BrokenStore(InMemoryKnowledgeStore):
    """A store whose retrieval is down; the page must degrade, not fail."""

    async def retrieve(self, *args: object, **kwargs: object):  # type: ignore[override]
        raise RuntimeError("pgvector is unreachable")


def _store() -> InMemoryKnowledgeStore:
    return InMemoryKnowledgeStore(DeterministicEmbeddingProvider("det-test", 16))


def _client(store: InMemoryKnowledgeStore | None = None) -> TestClient:
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier(
            {
                "tok": ADMIN,
                "approver-token": APPROVER,
                "viewer": VIEWER,
                "guest": GUEST,
                "other-token": OTHER_ADMIN,
            }
        ),
        knowledge_retriever=store,
    )
    return TestClient(app)


def _upload(
    client: TestClient,
    *,
    headers: dict[str, str] = AUTH,
    **overrides: object,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "domain": "hr:policy",
        "sourceId": "hr_policy/leave-and-time-off.md",
        "title": "Leave and Time Off",
        "content": LEAVE_CONTENT,
        "sourceVersion": "v1",
        "staleAfter": "2027-07-01T00:00:00Z",
        "canonical": True,
    }
    payload.update(overrides)
    response = client.post("/kb/documents", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body, dict)
    return body


def _search(
    client: TestClient,
    query: str,
    *,
    domain: str = "hr:policy",
    canonical: bool = False,
    headers: dict[str, str] = AUTH,
) -> dict[str, object]:
    response = client.get(
        "/kb/search",
        params={"q": query, "domain": domain, "canonical": str(canonical).lower()},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body, dict)
    return body


# ------------------------------------------------------------------- gates


def test_reads_require_a_signed_in_console_role() -> None:
    http = _client(_store())
    assert http.get("/kb/domains").status_code == 401
    denied = http.get("/kb/domains", headers={"Authorization": "Bearer guest"})
    assert denied.status_code == 403
    assert denied.json() == {"detail": "Not authorized"}
    assert (
        http.get("/kb/search", params={"q": "leave", "domain": "hr:policy"}).status_code
        == 401
    )
    assert (
        http.get(
            "/kb/documents", params={"domain": "hr:policy"}, headers=AUTH
        ).status_code
        == 200
    )


def test_upload_requires_the_admin_role() -> None:
    http = _client(_store())
    for headers in (APPROVER_AUTH, {"Authorization": "Bearer viewer"}):
        response = http.post(
            "/kb/documents",
            json={
                "domain": "hr:policy",
                "sourceId": "hr_policy/leave-and-time-off.md",
                "title": "Leave and Time Off",
                "content": LEAVE_CONTENT,
                "sourceVersion": "v1",
            },
            headers=headers,
        )
        assert response.status_code == 403
        assert response.json() == {"detail": "Not authorized"}


def test_not_configured_app_reports_an_empty_state() -> None:
    http = _client(None)
    domains = http.get("/kb/domains", headers=AUTH).json()
    assert domains == {"domains": [], "configured": False}
    documents = http.get(
        "/kb/documents", params={"domain": "hr:policy"}, headers=AUTH
    ).json()
    assert documents == {"documents": [], "configured": False}
    passages = http.get(
        "/kb/search", params={"q": "leave", "domain": "hr:policy"}, headers=AUTH
    ).json()
    assert passages == {"passages": [], "degraded": False, "configured": False}
    upload = http.post(
        "/kb/documents",
        json={
            "domain": "hr:policy",
            "sourceId": "hr_policy/leave-and-time-off.md",
            "title": "Leave and Time Off",
            "content": LEAVE_CONTENT,
            "sourceVersion": "v1",
        },
        headers=AUTH,
    )
    assert upload.status_code == 503
    assert upload.json() == {"detail": "Knowledge store is not configured"}


# ------------------------------------------------------------------ upload


def test_upload_ingests_and_search_cites_the_span() -> None:
    http = _client(_store())
    result = _upload(http)
    assert result["sourceId"] == "hr_policy/leave-and-time-off.md"
    assert result["sourceVersion"] == "v1"
    assert isinstance(result["chunks"], int) and result["chunks"] >= 1

    body = _search(http, "annual leave")
    passages = body["passages"]
    assert isinstance(passages, list) and passages
    top = passages[0]
    assert top["sourceId"] == "hr_policy/leave-and-time-off.md"
    assert top["sourceVersion"] == "v1"
    assert top["domain"] == "hr:policy"
    assert top["stale"] is False
    assert top["title"] == "Leave and Time Off"
    start, _, end = str(top["span"]).partition("-")
    assert start.isdigit() and end.isdigit()
    assert "annual leave" in str(top["text"])


def test_upload_review_horizon_drives_the_stale_flag() -> None:
    http = _client(_store())
    _upload(
        http,
        sourceId="hr_policy/remote-work-legacy.md",
        title="Remote Work (Legacy)",
        content="Remote work is granted at the manager's discretion.",
        staleAfter="2025-01-10T00:00:00Z",
    )
    stale = _search(http, "remote work")
    assert stale["passages"][0]["stale"] is True

    _upload(
        http,
        sourceId="hr_policy/conduct-and-grievances.md",
        title="Conduct and Grievances",
        content="Grievances are raised in writing with the people partner.",
    )
    fresh = _search(http, "grievances")
    assert fresh["passages"][0]["stale"] is False


def test_upload_validation_rejects_malformed_requests() -> None:
    http = _client(_store())
    bad_uploads = [
        {"domain": "HR:policy"},
        {"domain": "random"},
        {"domain": "msp:"},
        {"sourceId": "-leading"},
        {"title": ""},
        {"content": ""},
    ]
    for overrides in bad_uploads:
        payload: dict[str, object] = {
            "domain": "hr:policy",
            "sourceId": "hr_policy/leave-and-time-off.md",
            "title": "Leave and Time Off",
            "content": LEAVE_CONTENT,
            "sourceVersion": "v1",
        }
        payload.update(overrides)
        response = http.post("/kb/documents", json=payload, headers=AUTH)
        assert response.status_code == 422, overrides
    # The domain vocabulary accepts the phase-1 partitions and both families.
    for domain in ("support", "msp:acme", "hr:policy"):
        response = http.post(
            "/kb/documents",
            json={
                "domain": domain,
                "sourceId": f"seed/{domain.replace(':', '-')}.md",
                "title": "Seed",
                "content": SUPPORT_CONTENT,
                "sourceVersion": "v1",
            },
            headers=AUTH,
        )
        assert response.status_code == 200, domain


# --------------------------------------------------------------- canonical


def test_canonical_toggle_filters_non_canonical_documents() -> None:
    http = _client(_store())
    _upload(http)
    _upload(
        http,
        sourceId="hr_policy/leave-draft.md",
        title="Leave Draft",
        content="Draft: annual leave may move to 27 days next year.",
        canonical=False,
    )
    team = _search(http, "annual leave", canonical=True)
    sources = {str(item["sourceId"]) for item in team["passages"]}
    assert "hr_policy/leave-draft.md" not in sources
    assert "hr_policy/leave-and-time-off.md" in sources

    everything = _search(http, "annual leave", canonical=False)
    assert "hr_policy/leave-draft.md" in {
        str(item["sourceId"]) for item in everything["passages"]
    }


# ----------------------------------------------------------------- catalog


def test_domains_roll_up_documents_stale_and_canonical() -> None:
    http = _client(_store())
    _upload(
        http,
        sourceId="hr_policy/remote-work-legacy.md",
        staleAfter="2025-01-10T00:00:00Z",
    )
    _upload(http, sourceId="hr_policy/leave-draft.md", canonical=False)
    _upload(
        http,
        domain="support",
        sourceId="runbooks/vpn.md",
        title="VPN runbook",
        content=SUPPORT_CONTENT,
    )
    body = http.get("/kb/domains", headers=AUTH).json()
    assert body["configured"] is True
    assert body["domains"] == [
        {
            "domain": "hr:policy",
            "documents": 2,
            "stale": 1,
            "canonical": 1,
            "updatedAt": body["domains"][0]["updatedAt"],
        },
        {
            "domain": "support",
            "documents": 1,
            "stale": 0,
            "canonical": 1,
            "updatedAt": body["domains"][1]["updatedAt"],
        },
    ]
    assert body["domains"][0]["updatedAt"] is not None


def test_documents_lists_version_rows_and_upserts_in_place() -> None:
    http = _client(_store())
    _upload(http, sourceVersion="v1")
    _upload(http, sourceVersion="v2", content=LEAVE_CONTENT + " Updated policy.")
    body = http.get(
        "/kb/documents", params={"domain": "hr:policy"}, headers=AUTH
    ).json()
    rows = body["documents"]
    assert [row["sourceVersion"] for row in rows] == ["v2", "v1"]
    assert all(row["sourceId"] == "hr_policy/leave-and-time-off.md" for row in rows)
    assert all(row["chunks"] >= 1 for row in rows)
    assert all(row["canonical"] is True for row in rows)
    assert all(row["stale"] is False for row in rows)
    assert all(row["createdAt"] is not None for row in rows)

    _upload(http, sourceVersion="v1")  # re-ingest replaces the version in place
    again = http.get(
        "/kb/documents", params={"domain": "hr:policy"}, headers=AUTH
    ).json()["documents"]
    assert len(again) == 2
    assert {row["sourceVersion"] for row in again} == {"v1", "v2"}


def test_documents_rejects_unsupported_domains() -> None:
    http = _client(_store())
    for domain in ("HR:policy", "random"):
        response = http.get(
            "/kb/documents", params={"domain": domain}, headers=AUTH
        )
        assert response.status_code == 422
        assert response.json() == {"detail": "Unsupported knowledge domain"}


# -------------------------------------------------------------- degradation


def test_search_empty_scope_is_a_200_with_no_passages() -> None:
    http = _client(_store())
    body = _search(http, "annual leave")
    assert body == {"passages": [], "degraded": False, "configured": True}


def test_search_degrades_instead_of_failing_on_a_store_outage() -> None:
    http = _client(BrokenStore(DeterministicEmbeddingProvider("det-test", 16)))
    body = _search(http, "annual leave")
    assert body == {"passages": [], "degraded": True, "configured": True}


# ------------------------------------------------------- tenant + bar wiring


def test_partitions_are_tenant_scoped() -> None:
    store = _store()
    http = _client(store)
    _upload(http, headers=OTHER_AUTH)
    assert _search(http, "annual leave")["passages"] == []
    assert http.get("/kb/domains", headers=OTHER_AUTH).json()["domains"] != []


def test_command_bar_cites_the_graduated_hr_partition() -> None:
    http = _client(_store())
    _upload(http)
    _upload(
        http,
        domain="support",
        sourceId="runbooks/vpn.md",
        title="VPN runbook",
        content=SUPPORT_CONTENT,
    )
    response = http.get("/search", params={"q": "annual leave VPN"}, headers=AUTH)
    assert response.status_code == 200
    kb = response.json()["kb"]
    domains = {str(item["sourceId"]) for item in kb}
    assert "hr_policy/leave-and-time-off.md" in domains
    assert "runbooks/vpn.md" in domains
    assert all(item["domain"] in {"support", "hr:policy"} for item in kb)
