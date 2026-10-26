"""MSP surface: connection settings, client and vendor registries, audit pack.

The surfaces share one tenant seam: the connection row gates client and
vendor registration, the console reads them back, the service-token lookup
answers the bills lane's sender questions in a shape its parser accepts, and
the audit pack proves one client's month from the immutable trail (archive
union registry, case ledger, receipts) with every decision re-verified.
"""

from __future__ import annotations

from datetime import UTC, datetime

from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.repositories import (
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
    InMemoryMspConnectionsRepository,
)
from allrounder_api.runs import (
    RunServiceConfig,
    ScriptedMastraRunClient,
    build_memory_run_service,
)
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = b"msp-receipt-secret-for-tests-0123456789ab"
PRINCIPAL = Principal("user-1", "mspco", frozenset({"agent", "approver", "admin"}))
VIEWER = Principal("user-2", "mspco", frozenset({"viewer"}))
TENANT = "mspco"
MSP_STEPS = ("intake", "ticket", "draft", "approve", "send")
# Pinned so the seeded run always falls inside the "2026-09" pack window.
CLOCK = datetime(2026, 9, 15, 12, 0, tzinfo=UTC)
EMAIL: dict[str, str] = {
    "messageId": "mail-1",
    "from": "jane@acme.example",
    "fromName": "Jane Doe",
    "to": "acme@in.mspco.example",
    "subject": "VPN drops every hour",
    "text": "Hi, my VPN session drops every hour. Can you help?",
    "receivedAt": "2026-09-15T09:00:00Z",
}
HEADERS = {"Authorization": "Bearer tok"}
VIEWER_HEADERS = {"Authorization": "Bearer viewer"}


def _api(
    *, service_token: str | None = None
) -> tuple[TestClient, InMemoryMspConnectionsRepository]:
    client = ScriptedMastraRunClient(
        {"mspFlow": MSP_STEPS},
        side_effecting=frozenset({"ticket", "send"}),
    )
    cases = InMemoryCaseRepository()
    signer = ApprovalReceiptSigner(SECRET)
    service = build_memory_run_service(
        signer=signer,
        # Both the approvals repo and the service run on the pinned clock, so
        # a receipt issued at decision time is not instantly "expired".
        approvals=InMemoryApprovalRepository(clock=lambda: CLOCK),
        cases=cases,
        mastra=client,
        config=RunServiceConfig(),
        clock=lambda: CLOCK,
    )
    connections = InMemoryMspConnectionsRepository()
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": PRINCIPAL, "viewer": VIEWER}),
        case_repository=cases,
        msp_connections=connections,
        receipt_signer=signer,
        runs_service=service,
        knowledge_service_token=service_token,
    )
    return TestClient(app), connections


def _seed_run(http: TestClient) -> dict[str, object]:
    """One intake email, one reviewed first step; the run parks at "ticket"."""

    created = http.post("/intake/email", json=EMAIL, headers=HEADERS)
    assert created.status_code == 201
    body = created.json()
    decision = http.post(
        f"/runs/{body['runId']}/steps/intake/decision",
        json={"action": "proceed"},
        headers=HEADERS,
    )
    assert decision.status_code == 200
    assert decision.json()["receipt"]
    return body


# --------------------------------------------------------------- settings


def test_connections_auth_and_role_gates() -> None:
    http, _connections = _api()
    assert http.get("/msp/connections").status_code == 401
    # Viewers may read the console state and download packs, never write.
    assert http.get("/msp/connections", headers=VIEWER_HEADERS).status_code == 200
    assert (
        http.put(
            "/msp/connections",
            json={"inboundDomain": "in.mspco.example"},
            headers=VIEWER_HEADERS,
        ).status_code
        == 403
    )
    assert (
        http.post("/msp/clients", json={"clientRef": "acme"}, headers=VIEWER_HEADERS).status_code
        == 403
    )
    assert http.delete("/msp/clients/acme", headers=VIEWER_HEADERS).status_code == 403


def test_connection_upsert_and_read_back() -> None:
    http, _connections = _api()
    unconfigured = http.get("/msp/connections", headers=HEADERS)
    assert unconfigured.status_code == 200
    assert unconfigured.json() == {"connection": None, "clients": []}

    saved = http.put(
        "/msp/connections",
        json={"inboundDomain": " In.Mspco.Example ", "displayName": " MSP Co helpdesk "},
        headers=HEADERS,
    )
    assert saved.status_code == 200
    body = saved.json()
    assert body["inboundDomain"] == "in.mspco.example"
    assert body["displayName"] == "MSP Co helpdesk"
    assert body["createdAt"] and body["updatedAt"]

    read_back = http.get("/msp/connections", headers=HEADERS).json()
    assert read_back["connection"]["inboundDomain"] == "in.mspco.example"

    # Upserts refresh updatedAt but keep the original createdAt.
    again = http.put(
        "/msp/connections",
        json={"inboundDomain": "mail.mspco.example"},
        headers=HEADERS,
    )
    assert again.status_code == 200
    assert again.json()["createdAt"] == body["createdAt"]
    assert again.json()["displayName"] == ""

    for bad_domain in ("not a hostname", "nodots", "-leading.example"):
        rejected = http.put(
            "/msp/connections", json={"inboundDomain": bad_domain}, headers=HEADERS
        )
        assert rejected.status_code == 422


def test_client_registry_requires_connection_and_is_idempotent() -> None:
    http, _connections = _api()
    early = http.post("/msp/clients", json={"clientRef": "acme"}, headers=HEADERS)
    assert early.status_code == 409

    http.put(
        "/msp/connections",
        json={"inboundDomain": "in.mspco.example"},
        headers=HEADERS,
    )
    created = http.post(
        "/msp/clients",
        json={
            "clientRef": " Acme.Support ",
            "displayName": "Acme Support",
            "contactEmail": "help@acme.example",
            "deskProject": "ACME",
        },
        headers=HEADERS,
    )
    assert created.status_code == 200
    body = created.json()
    assert body["clientRef"] == "acme.support"
    assert body["deskProject"] == "ACME"

    updated = http.post(
        "/msp/clients",
        json={"clientRef": "acme.support", "displayName": "Acme Support Desk"},
        headers=HEADERS,
    )
    assert updated.status_code == 200
    assert updated.json()["displayName"] == "Acme Support Desk"
    assert updated.json()["createdAt"] == body["createdAt"]

    listed = http.get("/msp/connections", headers=HEADERS).json()
    assert [item["clientRef"] for item in listed["clients"]] == ["acme.support"]

    invalid = http.post("/msp/clients", json={"clientRef": "Acme Support!"}, headers=HEADERS)
    assert invalid.status_code == 422
    assert http.delete("/msp/clients/Acme", headers=HEADERS).status_code == 422

    assert http.delete("/msp/clients/acme.support", headers=HEADERS).status_code == 204
    assert http.delete("/msp/clients/acme.support", headers=HEADERS).status_code == 404
    assert http.get("/msp/connections", headers=HEADERS).json()["clients"] == []


# ---------------------------------------------------------------- vendors


def test_vendor_registry_requires_connection_and_normalizes() -> None:
    http, _connections = _api()
    assert http.get("/msp/vendors", headers=HEADERS).json() == {"vendors": []}
    early = http.post(
        "/msp/vendors",
        json={"vendorRef": "acme-power", "emails": ["billing@acmepower.example"]},
        headers=HEADERS,
    )
    assert early.status_code == 409

    http.put(
        "/msp/connections",
        json={"inboundDomain": "in.mspco.example"},
        headers=HEADERS,
    )
    created = http.post(
        "/msp/vendors",
        json={
            "vendorRef": " Acme-Power ",
            "name": " Acme Power Pty Ltd ",
            "emails": ["Billing@AcmePower.Example", "billing@acmepower.example"],
            "accountName": "Acme Power Pty Ltd",
            "bsb": "012345",
            "accountNumber": "12345678",
        },
        headers=HEADERS,
    )
    assert created.status_code == 200
    body = created.json()
    assert body["vendorRef"] == "acme-power"
    assert body["name"] == "Acme Power Pty Ltd"
    # Emails are lowercased and deduped; the rest is stored as registered.
    assert body["emails"] == ["billing@acmepower.example"]
    assert body["bsb"] == "012345"
    assert body["createdAt"] and body["updatedAt"]

    updated = http.post(
        "/msp/vendors",
        json={"vendorRef": "acme-power", "emails": ["accounts@acmepower.example"]},
        headers=HEADERS,
    )
    assert updated.status_code == 200
    assert updated.json()["createdAt"] == body["createdAt"]
    assert updated.json()["name"] == ""

    listed = http.get("/msp/vendors", headers=HEADERS).json()
    assert [item["vendorRef"] for item in listed["vendors"]] == ["acme-power"]

    invalid_ref = http.post(
        "/msp/vendors",
        json={"vendorRef": "Acme Power!", "emails": ["billing@acmepower.example"]},
        headers=HEADERS,
    )
    assert invalid_ref.status_code == 422
    empty_emails = http.post(
        "/msp/vendors",
        json={"vendorRef": "acme-power", "emails": []},
        headers=HEADERS,
    )
    assert empty_emails.status_code == 422
    bad_email = http.post(
        "/msp/vendors",
        json={"vendorRef": "acme-power", "emails": ["not-an-address"]},
        headers=HEADERS,
    )
    assert bad_email.status_code == 422

    assert http.delete("/msp/vendors/Acme", headers=HEADERS).status_code == 422
    assert http.delete("/msp/vendors/acme-power", headers=HEADERS).status_code == 204
    assert http.delete("/msp/vendors/acme-power", headers=HEADERS).status_code == 404
    assert http.get("/msp/vendors", headers=HEADERS).json() == {"vendors": []}


def test_vendor_routes_honor_view_write_roles() -> None:
    http, _connections = _api()
    assert http.get("/msp/vendors").status_code == 401
    assert http.get("/msp/vendors", headers=VIEWER_HEADERS).status_code == 200
    vendor = {"vendorRef": "acme-power", "emails": ["billing@acmepower.example"]}
    assert (
        http.post("/msp/vendors", json=vendor, headers=VIEWER_HEADERS).status_code == 403
    )
    assert (
        http.delete("/msp/vendors/acme-power", headers=VIEWER_HEADERS).status_code == 403
    )


def test_vendor_lookup_is_service_token_only() -> None:
    # Without a configured service token the route is not mounted at all, so
    # no console credential can reach it either. Only the DELETE vendor route
    # matches the path, hence "method not allowed" rather than "not found".
    unconfigured, _ = _api()
    absent = unconfigured.post(
        "/msp/vendors/lookup",
        json={"tenantId": TENANT, "email": "billing@acmepower.example"},
        headers=HEADERS,
    )
    assert absent.status_code == 405

    http, _connections = _api(service_token="shared-secret")
    payload = {"tenantId": TENANT, "email": "billing@acmepower.example"}
    assert http.post("/msp/vendors/lookup", json=payload).status_code == 401
    assert (
        http.post(
            "/msp/vendors/lookup",
            json=payload,
            headers={"Authorization": "Bearer wrong"},
        ).status_code
        == 401
    )
    # The console bearer is not the service token.
    assert http.post("/msp/vendors/lookup", json=payload, headers=HEADERS).status_code == 401

    http.put(
        "/msp/connections",
        json={"inboundDomain": "in.mspco.example"},
        headers=HEADERS,
    )
    http.post(
        "/msp/vendors",
        json={
            "vendorRef": "acme-power",
            "name": "Acme Power Pty Ltd",
            "emails": ["billing@acmepower.example"],
            "accountName": "Acme Power Pty Ltd",
            "bsb": "012345",
            "accountNumber": "12345678",
        },
        headers=HEADERS,
    )
    http.post(
        "/msp/vendors",
        json={"vendorRef": "bare-supplies", "emails": ["pay@bare.example"]},
        headers=HEADERS,
    )
    service_headers = {"Authorization": "Bearer shared-secret"}

    found = http.post("/msp/vendors/lookup", json=payload, headers=service_headers)
    assert found.status_code == 200
    assert found.json() == {
        "vendor": {
            "ref": "acme-power",
            "name": "Acme Power Pty Ltd",
            "accountName": "Acme Power Pty Ltd",
            "bsb": "012345",
            "accountNumber": "12345678",
        }
    }

    # Case-insensitive match. Unstated details come back as null, never ""
    # (the bills lane's VendorRecord parser accepts null), and the name falls
    # back to the ref so the record always parses.
    bare = http.post(
        "/msp/vendors/lookup",
        json={"tenantId": TENANT, "email": "PAY@BARE.EXAMPLE"},
        headers=service_headers,
    )
    assert bare.json() == {
        "vendor": {
            "ref": "bare-supplies",
            "name": "bare-supplies",
            "accountName": None,
            "bsb": None,
            "accountNumber": None,
        }
    }

    unknown = http.post(
        "/msp/vendors/lookup",
        json={"tenantId": TENANT, "email": "nobody@elsewhere.example"},
        headers=service_headers,
    )
    assert unknown.json() == {"vendor": None}

    # The lookup never crosses tenants.
    other_tenant = http.post(
        "/msp/vendors/lookup",
        json={"tenantId": "otherco", "email": "billing@acmepower.example"},
        headers=service_headers,
    )
    assert other_tenant.json() == {"vendor": None}

    # The scope is pinned by the caller, never the body.
    missing_tenant = http.post(
        "/msp/vendors/lookup",
        json={"email": "billing@acmepower.example"},
        headers=service_headers,
    )
    assert missing_tenant.status_code == 422


# -------------------------------------------------------------- audit pack


def test_audit_pack_json_for_client_month() -> None:
    http, _connections = _api()
    seeded = _seed_run(http)

    response = http.get(
        "/msp/audit-pack",
        params={"clientRef": "acme", "month": "2026-09"},
        headers=HEADERS,
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    pack = response.json()
    assert pack["packVersion"] == "v0"
    assert pack["packKey"] == f"{TENANT}:acme:2026-09"
    assert pack["tenantId"] == TENANT
    assert pack["clientRef"] == "acme"
    assert pack["window"] == {
        "since": "2026-09-01T00:00:00+00:00",
        "until": "2026-10-01T00:00:00+00:00",
    }
    assert pack["summary"] == {
        "caseCount": 1,
        "runCount": 1,
        "completedRuns": 0,
        "failedRuns": 0,
        "cancelledRuns": 0,
        "decisionCount": 1,
        "receiptsVerified": 1,
        "receiptsFailed": 0,
        "eventCount": 1,
    }

    case_payload = pack["cases"][0]
    assert case_payload["caseId"] == seeded["caseId"]
    assert case_payload["ticketKey"] == seeded["ticketKey"]
    assert case_payload["domain"] == "msp"
    assert [event["kind"] for event in case_payload["events"]] == ["run_started"]

    run_payload = pack["runs"][0]
    assert run_payload["runId"] == seeded["runId"]
    assert run_payload["workflow"] == "msp"
    assert run_payload["status"] == "awaiting_human"
    intake_step = next(
        step for step in run_payload["steps"] if step["stepId"] == "intake"
    )
    assert intake_step["decision"]["approver"] == "user-1"
    assert intake_step["verification"] == {
        "actionHashMatches": True,
        "receiptVerified": True,
        "reason": None,
    }


def test_audit_pack_pdf_download_and_viewer_access() -> None:
    http, _connections = _api()
    _seed_run(http)

    pdf = http.get(
        "/msp/audit-pack",
        params={"clientRef": "acme", "month": "2026-09", "format": "pdf"},
        headers=VIEWER_HEADERS,
    )
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert (
        pdf.headers["content-disposition"]
        == 'attachment; filename="audit-pack-acme-2026-09.pdf"'
    )
    assert pdf.content.startswith(b"%PDF-")
    assert len(pdf.content) > 1_000


def test_audit_pack_rejects_bad_inputs_and_empty_months() -> None:
    http, _connections = _api()
    assert http.get("/msp/audit-pack", headers=HEADERS).status_code == 422
    bad_month = http.get(
        "/msp/audit-pack",
        params={"clientRef": "acme", "month": "2026-13"},
        headers=HEADERS,
    )
    assert bad_month.status_code == 422
    bad_ref = http.get(
        "/msp/audit-pack",
        params={"clientRef": "Acme Support", "month": "2026-09"},
        headers=HEADERS,
    )
    assert bad_ref.status_code == 422
    bad_format = http.get(
        "/msp/audit-pack",
        params={"clientRef": "acme", "month": "2026-09", "format": "csv"},
        headers=HEADERS,
    )
    assert bad_format.status_code == 422

    _seed_run(http)
    empty = http.get(
        "/msp/audit-pack",
        params={"clientRef": "acme", "month": "2026-08"},
        headers=HEADERS,
    )
    assert empty.status_code == 200
    assert empty.json()["summary"]["runCount"] == 0
    assert empty.json()["runs"] == []
