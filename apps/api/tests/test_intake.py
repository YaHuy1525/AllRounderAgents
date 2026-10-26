"""Email intake: one inbound mail becomes one MSP or bills run.

The MSP and bills lanes' front door. The suite pins both halves: the pure
normalizer (key spellings, derived ids, caller-safe rejections) and the HTTP
surfaces (auth gate, role gate, dedupe replay, parked first step) plus the
case row the run's events hang off. The bills route additionally pins the
vendor-ref derivation, which must mirror the flow's own slug helper.
"""

from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime

import pytest
from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.intake_api import (
    bill_case_id_for,
    bill_ticket_key_for,
    case_id_for,
    clean_vendor_ref,
    client_ref_for,
    derive_message_id,
    normalize_inbound_email,
    ticket_key_for,
    vendor_ref_for,
)
from allrounder_api.jira import JIRA_TICKET_KEY_PATTERN
from allrounder_api.repositories import (
    CaseRecord,
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
)
from allrounder_api.runs import (
    RunServiceConfig,
    ScriptedMastraRunClient,
    build_memory_run_service,
)
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = b"intake-receipt-secret-for-tests-0123456789"
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))
VIEWER = Principal("user-2", "omnidewalt", frozenset({"viewer"}))
TENANT = "omnidewalt"
MSP_STEPS = ("intake", "ticket", "draft", "approve", "send")
BILLS_STEPS = ("intake", "extract", "approve", "post")
EMAIL: dict[str, str] = {
    "messageId": "mail-1",
    "from": "jane@acme.example",
    "fromName": "Jane Doe",
    "to": "acme@in.msp.example",
    "subject": "VPN drops every hour",
    "text": "Hi, my VPN session drops every hour. Can you help?",
    "receivedAt": "2026-09-30T09:00:00Z",
}
BILL_EMAIL: dict[str, str] = {
    "messageId": "bill-mail-1",
    "from": "billing@acmepower.example",
    "fromName": "Acme Power Billing",
    "to": "bills@in.msp.example",
    "subject": "Invoice 4417",
    "text": "Invoice 4417 attached. Total $220.00, due 15 Oct 2026.",
    "receivedAt": "2026-09-30T10:00:00Z",
}


def _api(
    cases: InMemoryCaseRepository | None = None,
) -> tuple[TestClient, ScriptedMastraRunClient, InMemoryCaseRepository]:
    client = ScriptedMastraRunClient(
        {"mspFlow": MSP_STEPS, "billsFlow": BILLS_STEPS},
        side_effecting=frozenset({"ticket", "send", "post"}),
    )
    repository = cases or InMemoryCaseRepository()
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        cases=repository,
        mastra=client,
        config=RunServiceConfig(),
    )
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": PRINCIPAL, "viewer": VIEWER}),
        case_repository=repository,
        runs_service=service,
    )
    return TestClient(app), client, repository


def _case(repository: InMemoryCaseRepository, case_id: str) -> CaseRecord:
    return asyncio.run(repository.get(case_id, TENANT))


# ------------------------------------------------------------- normalizer


def test_normalizer_keeps_the_camel_spellings() -> None:
    email = normalize_inbound_email(EMAIL)
    assert email["messageId"] == "mail-1"
    assert email["from"] == "jane@acme.example"
    assert email["fromName"] == "Jane Doe"
    assert email["to"] == "acme@in.msp.example"
    assert email["subject"] == "VPN drops every hour"
    assert email["text"] == EMAIL["text"]
    assert email["receivedAt"].startswith("2026-09-30T09:00:00")


def test_normalizer_accepts_snake_and_postmark_spellings() -> None:
    snake = normalize_inbound_email(
        {
            "message_id": "mail-2",
            "from_email": "Jane@Acme.Example ",
            "to_email": "acme@in.msp.example",
            "text_body": "Please reset my password.",
            "received_at": "2026-09-30T09:00:00Z",
        }
    )
    assert snake["from"] == "Jane@Acme.Example"
    assert snake["subject"] == "(no subject)"
    assert snake["messageId"] == "mail-2"

    postmark = normalize_inbound_email(
        {
            "MessageID": "pm-1",
            "From": "jane@acme.example",
            "To": "acme@in.msp.example",
            "Subject": "  Password   reset  ",
            "TextBody": "Please reset my password.",
            "Date": "Wed, 30 Sep 2026 09:00:00 +0000",
        }
    )
    assert postmark["subject"] == "Password reset"
    assert postmark["receivedAt"] == "2026-09-30T09:00:00+00:00"


def test_missing_received_at_uses_the_injected_clock() -> None:
    moment = datetime(2026, 9, 30, 10, 30, tzinfo=UTC)
    email = normalize_inbound_email(
        {"messageId": "mail-9", "from": "a@b.co", "to": "c@d.co", "text": "hello"},
        now=moment,
    )
    assert email["receivedAt"] == "2026-09-30T10:30:00+00:00"


def test_normalizer_derives_a_stable_message_id() -> None:
    moment = datetime(2026, 9, 30, 9, 0, tzinfo=UTC)
    content = {
        "from": "jane@acme.example",
        "to": "acme@in.msp.example",
        "text": "Help please",
    }
    first = normalize_inbound_email({**content, "messageId": "   "}, now=moment)
    second = normalize_inbound_email(content, now=moment)
    assert first["messageId"] == second["messageId"]
    assert first["messageId"].startswith("derived-")
    assert first["messageId"] == derive_message_id(
        from_address="jane@acme.example",
        subject="(no subject)",
        received_at="2026-09-30T09:00:00+00:00",
        text="Help please",
    )


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        ("not-an-object", "must be an object"),
        ({**EMAIL, "from": "not-an-address"}, "sender address"),
        ({**EMAIL, "to": "   "}, "recipient address"),
        ({**EMAIL, "text": "   "}, "no text body"),
        ({**EMAIL, "receivedAt": "not-a-date"}, "invalid received date"),
        ({**EMAIL, "text": "x" * 20_001}, "exceeds 20000 characters"),
        ({**EMAIL, "from": "a@" + "b" * 400 + ".co"}, "exceed 320 characters"),
    ],
)
def test_normalizer_rejects_invalid_deliveries(payload: object, reason: str) -> None:
    with pytest.raises(ValueError, match=reason):
        normalize_inbound_email(payload)


# ------------------------------------------------------------- key minting


def test_client_ref_mirrors_the_mail_seam_helper() -> None:
    assert client_ref_for("acme+vpn@in.msp.example") == "acme"
    assert client_ref_for("Acme.Support@in.msp.example") == "acme.support"
    assert client_ref_for("we!rd@in.msp.example") == "we-rd"
    assert client_ref_for("@in.msp.example") == "client"
    assert client_ref_for("+@in.msp.example") == "client"


def test_ticket_key_and_case_id_are_deterministic() -> None:
    key = ticket_key_for("mail-1")
    assert key == ticket_key_for("mail-1")
    assert key != ticket_key_for("mail-2")
    assert re.fullmatch(JIRA_TICKET_KEY_PATTERN, key) is not None
    digits = key.removeprefix("MSP-")
    assert len(digits) == 6
    assert digits.isdigit()
    assert not digits.startswith("0")
    assert case_id_for("acme", "mail-1") == f"msp-acme-{digits}"


def test_bill_keys_and_vendor_refs_are_deterministic() -> None:
    key = bill_ticket_key_for("bill-mail-1")
    assert key == bill_ticket_key_for("bill-mail-1")
    assert key != bill_ticket_key_for("bill-mail-2")
    assert re.fullmatch(JIRA_TICKET_KEY_PATTERN, key) is not None
    digits = key.removeprefix("BILL-")
    assert len(digits) == 6
    assert not digits.startswith("0")
    assert bill_case_id_for("acmepower", "bill-mail-1") == f"bill-acmepower-{digits}"
    # The two lanes mint from the same message id independently.
    assert bill_ticket_key_for("mail-1") != ticket_key_for("mail-1")


def test_vendor_ref_mirrors_the_bills_flow_slug_helper() -> None:
    assert vendor_ref_for("billing@acmepower.example") == "acmepower"
    assert vendor_ref_for("Billing@Acme-Power.COM.AU") == "acme-power"
    assert vendor_ref_for("billing@we!rd.example") == "we-rd"
    assert vendor_ref_for("billing@no-dot-here") == "no-dot-here"
    assert vendor_ref_for("billing@.example") == "vendor"
    assert vendor_ref_for("billing@") == "vendor"
    # Caller-provided refs are normalized the same way before they key a case.
    assert clean_vendor_ref(" Acme-Power! ") == "acme-power"
    assert clean_vendor_ref("ACME_POWER") == "acme-power"
    assert clean_vendor_ref("x" * 50) == "x" * 40


# -------------------------------------------------------------- HTTP route


def test_intake_starts_a_suspended_run_and_dedupes_replays() -> None:
    http, client, cases = _api()
    headers = {"Authorization": "Bearer tok"}
    created = http.post("/intake/email", json=EMAIL, headers=headers)
    assert created.status_code == 201
    body = created.json()
    assert body["deduped"] is False
    assert body["ticketKey"].startswith("MSP-")
    assert body["caseId"].startswith("msp-acme-")

    # The case ledger anchor exists and already carries the run's first event,
    # which proves it was written before the engine started the run.
    case = _case(cases, body["caseId"])
    assert case.tenant_id == TENANT
    assert case.ticket_key == body["ticketKey"]
    assert case.domain == "msp"
    assert case.status == "open"
    assert [(event.actor, event.kind) for event in case.events] == [
        ("system", "run_started")
    ]

    detail = http.get(f"/runs/{body['runId']}", headers=headers).json()
    assert detail["workflow"] == "msp"
    assert detail["status"] == "awaiting_human"
    assert detail["ticketKey"] == body["ticketKey"]
    assert detail["caseId"] == body["caseId"]
    assert detail["currentStepId"] == "intake"
    assert [step["stepId"] for step in detail["steps"]] == list(MSP_STEPS)

    # The run input is the normalized email plus the derived client ref and
    # the tenant taken from the caller's credential.
    started = client.inputs[0]["input"]
    assert isinstance(started, dict)
    assert started["clientRef"] == "acme"
    assert started["tenantId"] == TENANT
    assert started["messageId"] == "mail-1"
    assert started["ticketKey"] == body["ticketKey"]

    replay = http.post("/intake/email", json=EMAIL, headers=headers)
    assert replay.status_code == 201
    assert replay.json() == {
        "ticketKey": body["ticketKey"],
        "caseId": body["caseId"],
        "deduped": True,
    }
    # The replay was claimed before it could reach the engine.
    assert len(client.calls) == 1


def test_intake_role_gate_explicit_client_ref_and_validation() -> None:
    http, client, cases = _api()
    assert http.post("/intake/email", json=EMAIL).status_code == 401
    assert (
        http.post(
            "/intake/email", json=EMAIL, headers={"Authorization": "Bearer viewer"}
        ).status_code
        == 403
    )
    headers = {"Authorization": "Bearer tok"}
    invalid = http.post("/intake/email", json={**EMAIL, "from": "nope"}, headers=headers)
    assert invalid.status_code == 422

    created = http.post(
        "/intake/email",
        json={**EMAIL, "messageId": "mail-7", "clientRef": "acme-vpn"},
        headers=headers,
    )
    assert created.status_code == 201
    assert created.json()["caseId"].startswith("msp-acme-vpn-")
    started = client.inputs[0]["input"]
    assert isinstance(started, dict)
    assert started["clientRef"] == "acme-vpn"
    assert started["tenantId"] == TENANT
    # No case row exists for the rejected deliveries, only for the accepted one.
    case = _case(cases, created.json()["caseId"])
    assert case.ticket_key == created.json()["ticketKey"]


def test_replayed_delivery_after_claim_expiry_reattaches_to_the_case() -> None:
    http, _client, cases = _api()
    headers = {"Authorization": "Bearer tok"}
    first = http.post("/intake/email", json=EMAIL, headers=headers)
    assert first.status_code == 201
    # A second app with a fresh dedupe store replays the same delivery: the
    # claim succeeds, the case already exists, and the replay attaches to the
    # original case instead of minting a second one or failing.
    replay_http, replay_client, _ = _api(cases)
    replay = replay_http.post("/intake/email", json=EMAIL, headers=headers)
    assert replay.status_code == 201
    assert replay.json()["deduped"] is False
    assert replay.json()["caseId"] == first.json()["caseId"]
    assert len(replay_client.calls) == 1
    case = _case(cases, first.json()["caseId"])
    assert [event.kind for event in case.events] == ["run_started", "run_started"]


# --------------------------------------------------------- vendor email route


def test_vendor_intake_starts_a_parked_bills_run_and_dedupes_replays() -> None:
    http, client, cases = _api()
    headers = {"Authorization": "Bearer tok"}
    created = http.post("/intake/vendor-email", json=BILL_EMAIL, headers=headers)
    assert created.status_code == 201
    body = created.json()
    assert body["deduped"] is False
    assert body["ticketKey"].startswith("BILL-")
    # The ref derives from the sender domain the same way the flow's intake
    # step derives it, so the case id and the flow's ref cannot drift apart.
    assert body["caseId"].startswith("bill-acmepower-")

    case = _case(cases, body["caseId"])
    assert case.tenant_id == TENANT
    assert case.ticket_key == body["ticketKey"]
    assert case.domain == "bills"
    assert case.status == "open"
    assert [(event.actor, event.kind) for event in case.events] == [
        ("system", "run_started")
    ]

    detail = http.get(f"/runs/{body['runId']}", headers=headers).json()
    assert detail["workflow"] == "bills"
    assert detail["status"] == "awaiting_human"
    assert detail["ticketKey"] == body["ticketKey"]
    assert detail["caseId"] == body["caseId"]
    assert detail["currentStepId"] == "intake"
    assert [step["stepId"] for step in detail["steps"]] == list(BILLS_STEPS)

    started = client.inputs[0]["input"]
    assert isinstance(started, dict)
    assert started["vendorRef"] == "acmepower"
    assert started["tenantId"] == TENANT
    assert started["messageId"] == "bill-mail-1"
    assert started["ticketKey"] == body["ticketKey"]

    replay = http.post("/intake/vendor-email", json=BILL_EMAIL, headers=headers)
    assert replay.status_code == 201
    assert replay.json() == {
        "ticketKey": body["ticketKey"],
        "caseId": body["caseId"],
        "deduped": True,
    }
    assert len(client.calls) == 1


def test_vendor_intake_role_gate_explicit_ref_and_validation() -> None:
    http, client, cases = _api()
    assert http.post("/intake/vendor-email", json=BILL_EMAIL).status_code == 401
    assert (
        http.post(
            "/intake/vendor-email",
            json=BILL_EMAIL,
            headers={"Authorization": "Bearer viewer"},
        ).status_code
        == 403
    )
    headers = {"Authorization": "Bearer tok"}
    invalid = http.post(
        "/intake/vendor-email", json={**BILL_EMAIL, "from": "nope"}, headers=headers
    )
    assert invalid.status_code == 422

    created = http.post(
        "/intake/vendor-email",
        json={**BILL_EMAIL, "messageId": "bill-mail-7", "vendorRef": " Acme-Power! "},
        headers=headers,
    )
    assert created.status_code == 201
    assert created.json()["caseId"].startswith("bill-acme-power-")
    started = client.inputs[0]["input"]
    assert isinstance(started, dict)
    assert started["vendorRef"] == "acme-power"
    case = _case(cases, created.json()["caseId"])
    assert case.ticket_key == created.json()["ticketKey"]


def test_lane_dedupe_keys_do_not_collide() -> None:
    """The same message id may cross both lanes without blocking either."""
    http, client, _cases = _api()
    headers = {"Authorization": "Bearer tok"}
    shared = {"messageId": "shared-mail-1"}
    client_mail = http.post(
        "/intake/email", json={**EMAIL, **shared}, headers=headers
    )
    vendor_mail = http.post(
        "/intake/vendor-email", json={**BILL_EMAIL, **shared}, headers=headers
    )
    assert client_mail.status_code == 201
    assert vendor_mail.status_code == 201
    assert client_mail.json()["deduped"] is False
    assert vendor_mail.json()["deduped"] is False
    assert client_mail.json()["caseId"] != vendor_mail.json()["caseId"]
    assert len(client.calls) == 2
