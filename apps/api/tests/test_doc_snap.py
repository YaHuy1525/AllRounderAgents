"""Doc-snap (U7): a snapped document becomes an editable draft with checks.

Two layers are pinned here. The module: ABN normalization + checksum, the
expiry-window classifier, the deterministic text extraction (labelled and
bare ABNs, AU date formats, invoice numbers, totals), the base64/size
guards, and the draft builder's flag set (checksum ok/error, expiry
expired/expiring, duplicate against an earlier snap on the same case, and
the no-text fallback). The endpoint: base64 JSON snaps land as ``doc_snap``
case events behind the agent/approver/admin role gate, viewer may list,
unknown or foreign cases 404 — and the U7 done-criterion holds end to end:
a snap creates a draft with validation flags while the case cost and the
run state stay untouched ("snap never posts").
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
from collections.abc import Mapping
from datetime import date

import pytest
from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.doc_snap import (
    DOC_SNAP_MAX_BYTES,
    DocSnapError,
    DocSnapTooLarge,
    abn_checksum_valid,
    build_doc_snap,
    decode_snap_content,
    doc_snap_source_hashes,
    expiry_status,
    extract_text_fields,
    format_abn,
    normalize_abn,
)
from allrounder_api.repositories import CaseRecord, InMemoryCaseRepository
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

TENANT = "omnidewalt"
CASE_ID = "case-ABC-7"
TICKET = "ABC-7"
TODAY = date(2026, 10, 9)
VALID_ABN = "51824753556"  # the ATO's own example: passes the checksum
INVALID_ABN = "12345678901"
AUTH = {"Authorization": "Bearer tok"}
VIEWER_AUTH = {"Authorization": "Bearer viewer"}
GUEST_AUTH = {"Authorization": "Bearer guest"}
PRINCIPAL = Principal("user-1", TENANT, frozenset({"agent", "approver", "admin"}))
VIEWER = Principal("user-2", TENANT, frozenset({"viewer"}))
GUEST = Principal("user-3", TENANT, frozenset({"guest"}))

INVOICE_TEXT = (
    "TAX INVOICE\n"
    "Acme Services Pty Ltd\n"
    "ABN: 51 824 753 556\n"
    "Invoice No: INV-1042\n"
    "Total: $1,234.56\n"
    "Valid until 14/03/2027\n"
)


# ------------------------------------------------------------ validator pins


def test_abn_normalization_and_checksum() -> None:
    assert normalize_abn("51 824 753 556") == VALID_ABN
    assert normalize_abn("51-824-753-556") == VALID_ABN
    # Anything that is not exactly an 11-digit run normalizes to "".
    assert normalize_abn("51824") == ""
    assert normalize_abn("518247535560") == ""
    assert abn_checksum_valid(VALID_ABN)
    assert abn_checksum_valid("51 824 753 556")
    assert not abn_checksum_valid(INVALID_ABN)
    assert not abn_checksum_valid("")
    assert format_abn(VALID_ABN) == "51 824 753 556"
    assert format_abn("junk") == "junk"


def test_expiry_status_classifies_against_the_window() -> None:
    assert expiry_status("2026-08-28", today=TODAY) == ("expired", 42)
    assert expiry_status("2026-11-08", today=TODAY) == ("expiring", 30)
    assert expiry_status("2027-06-01", today=TODAY) == ("valid", 235)
    # The 90-day window is inclusive: day 90 still warns, day 91 is clear.
    assert expiry_status("2027-01-07", today=TODAY) == ("expiring", 90)
    assert expiry_status("2027-01-08", today=TODAY) == ("valid", 91)
    assert expiry_status("not-a-date", today=TODAY) is None


def test_extraction_reads_the_canonical_keys() -> None:
    extraction = extract_text_fields(INVOICE_TEXT)
    assert extraction.doc_type == "invoice"
    assert extraction.fields == {
        "abn": VALID_ABN,
        "expiry": "2027-03-14",
        "invoiceNumber": "INV-1042",
        "total": "$1,234.56",
    }


def test_extraction_parses_month_name_dates() -> None:
    extraction = extract_text_fields("Certificate of Currency\nExpires: 14 March 2027")
    assert extraction.doc_type == "certificate"
    assert extraction.fields["expiry"] == "2027-03-14"


def test_extraction_prefers_the_checksum_valid_bare_abn() -> None:
    extraction = extract_text_fields(f"Reference {INVALID_ABN} then {VALID_ABN}.")
    assert extraction.fields["abn"] == VALID_ABN


def test_extraction_reports_an_invalid_labelled_abn() -> None:
    extraction = extract_text_fields("ABN: 12 345 678 901")
    assert extraction.fields["abn"] == INVALID_ABN
    assert not abn_checksum_valid(extraction.fields["abn"])


def test_invoice_date_never_reads_as_an_invoice_number() -> None:
    extraction = extract_text_fields("Invoice date: 2026-01-05")
    assert "invoiceNumber" not in extraction.fields
    # ...and a word after the keyword is no document number either.
    assert "invoiceNumber" not in extract_text_fields("TAX INVOICE\nAcme Pty Ltd").fields


def test_unreadable_bytes_degrade_to_an_empty_extraction() -> None:
    extraction = extract_text_fields("\x00\x01\x02 \ufffd \x7f")
    assert extraction.doc_type == "unknown"
    assert extraction.fields == {}


# ------------------------------------------------------------- decode pins


def test_decode_snap_content_roundtrip_and_guards() -> None:
    data = b"tax invoice bytes"
    assert decode_snap_content(base64.b64encode(data).decode()) == data

    with pytest.raises(DocSnapError):
        decode_snap_content("not base64!!")
    with pytest.raises(DocSnapTooLarge):
        decode_snap_content(base64.b64encode(b"a" * (DOC_SNAP_MAX_BYTES + 1)).decode())


# ------------------------------------------------------------ builder pins


def _draft(
    text: str, *, prior: tuple[str, ...] = (), today: date = TODAY
) -> dict[str, object]:
    data = text.encode()
    return build_doc_snap(
        filename="doc.txt",
        content_type="text/plain",
        data=data,
        extraction=extract_text_fields(text),
        extractor="heuristic-v1",
        prior_sha256s=prior,
        today=today,
    ).to_payload()


def _flags(payload: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    flags = payload["flags"]
    assert isinstance(flags, list)
    return {flag["code"]: flag for flag in flags}


def test_build_doc_snap_assembles_the_draft_and_its_flags() -> None:
    data = INVOICE_TEXT.encode()
    sha256 = hashlib.sha256(data).hexdigest()
    payload = _draft(INVOICE_TEXT, prior=(sha256,))

    assert isinstance(payload["snapId"], str)
    assert payload["snapId"].startswith("snap-")
    assert payload["docType"] == "invoice"
    assert payload["extractor"] == "heuristic-v1"
    assert payload["source"] == {
        "filename": "doc.txt",
        "contentType": "text/plain",
        "sha256": sha256,
        "bytes": len(data),
    }
    assert payload["fields"] == {
        "abn": VALID_ABN,
        "expiry": "2027-03-14",
        "invoiceNumber": "INV-1042",
        "total": "$1,234.56",
    }
    assert isinstance(payload["createdAt"], str)

    flags = _flags(payload)
    assert flags["abn_checksum"]["severity"] == "ok"
    assert "51 824 753 556" in str(flags["abn_checksum"]["message"])
    # 2027-03-14 is 156 days out from TODAY: valid, not expiring.
    assert flags["expiry"]["severity"] == "ok"
    assert flags["expiry"]["message"] == "Valid until 2027-03-14 (156 day(s))."
    assert flags["duplicate"]["severity"] == "warning"


def test_expiry_window_flags_expiring_and_expired() -> None:
    expiring = _flags(_draft("Certificate\nExpires: 2026-11-08"))
    assert expiring["expiry"]["severity"] == "warning"
    assert expiring["expiry"]["message"] == "Expires in 30 day(s) (2026-11-08)."

    expired = _flags(_draft("Certificate\nExpires: 2026-09-01"))
    assert expired["expiry"]["severity"] == "error"
    assert expired["expiry"]["message"] == "Expired 38 day(s) ago (2026-09-01)."


def test_invalid_abn_and_no_text_flags() -> None:
    bad = _flags(_draft("ABN: 12 345 678 901"))
    assert bad["abn_checksum"]["severity"] == "error"

    empty = _draft("nothing recognizable here")
    assert empty["fields"] == {}
    assert _flags(empty)["no_text"]["severity"] == "warning"


def test_doc_snap_source_hashes_walks_payloads_defensively() -> None:
    payloads: list[dict[str, object]] = [
        {"source": {"sha256": "a"}},
        {"source": "junk"},
        {"source": {"sha256": 42}},
        {"source": {"sha256": ""}},
        {},
    ]
    assert doc_snap_source_hashes(payloads) == ("a",)


# ----------------------------------------------------------- endpoint pins


def _api() -> tuple[TestClient, InMemoryCaseRepository]:
    cases = InMemoryCaseRepository()
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier(
            {"tok": PRINCIPAL, "viewer": VIEWER, "guest": GUEST}
        ),
        case_repository=cases,
    )
    return TestClient(app), cases


def _seed_case(
    cases: InMemoryCaseRepository, *, tenant: str = TENANT, case_id: str = CASE_ID
) -> None:
    asyncio.run(
        cases.create(
            CaseRecord(
                id=case_id,
                tenant_id=tenant,
                ticket_key=TICKET,
                domain="support",
                status="open",
            )
        )
    )


def _snap_body(text: str, *, filename: str = "invoice.txt") -> dict[str, str]:
    return {
        "filename": filename,
        "contentType": "text/plain",
        "contentBase64": base64.b64encode(text.encode()).decode(),
    }


def test_doc_snap_creates_a_draft_with_flags_and_never_posts() -> None:
    http, cases = _api()
    _seed_case(cases)
    response = http.post(
        f"/cases/{CASE_ID}/doc-snaps", json=_snap_body(INVOICE_TEXT), headers=AUTH
    )
    assert response.status_code == 201
    draft = response.json()
    assert draft["docType"] == "invoice"
    assert draft["fields"]["abn"] == VALID_ABN
    assert draft["source"]["filename"] == "invoice.txt"
    assert draft["source"]["bytes"] == len(INVOICE_TEXT.encode())
    assert draft["extractor"] == "heuristic-v1"
    assert {flag["code"] for flag in draft["flags"]} == {"abn_checksum", "expiry"}

    # The draft landed on the case trail as a human event — nothing else moved.
    case = asyncio.run(cases.get(CASE_ID, TENANT))
    assert case.cost_usd_micro == 0
    assert [event.kind for event in case.events] == ["doc_snap"]
    assert case.events[0].actor == "human"

    listing = http.get(f"/cases/{CASE_ID}/doc-snaps", headers=VIEWER_AUTH)
    assert listing.status_code == 200
    assert [item["snapId"] for item in listing.json()["docSnaps"]] == [draft["snapId"]]


def test_doc_snap_flags_a_resnapped_duplicate_and_lists_newest_first() -> None:
    http, cases = _api()
    _seed_case(cases)
    first = http.post(
        f"/cases/{CASE_ID}/doc-snaps", json=_snap_body(INVOICE_TEXT), headers=AUTH
    )
    assert first.status_code == 201
    assert "duplicate" not in {flag["code"] for flag in first.json()["flags"]}

    second = http.post(
        f"/cases/{CASE_ID}/doc-snaps",
        json=_snap_body(INVOICE_TEXT, filename="copy.txt"),
        headers=AUTH,
    )
    assert second.status_code == 201
    flags = {flag["code"]: flag["severity"] for flag in second.json()["flags"]}
    assert flags["duplicate"] == "warning"

    listing = http.get(f"/cases/{CASE_ID}/doc-snaps", headers=AUTH)
    assert [item["source"]["filename"] for item in listing.json()["docSnaps"]] == [
        "copy.txt",
        "invoice.txt",
    ]


def test_doc_snap_role_gates_case_scoping_and_bad_input() -> None:
    http, cases = _api()
    _seed_case(cases)
    body = _snap_body(INVOICE_TEXT)
    assert http.post(f"/cases/{CASE_ID}/doc-snaps", json=body).status_code == 401
    assert (
        http.post(f"/cases/{CASE_ID}/doc-snaps", json=body, headers=GUEST_AUTH).status_code
        == 403
    )
    assert http.get(f"/cases/{CASE_ID}/doc-snaps", headers=GUEST_AUTH).status_code == 403
    # Viewer may list but not snap.
    assert http.get(f"/cases/{CASE_ID}/doc-snaps", headers=VIEWER_AUTH).status_code == 200
    assert (
        http.post(
            f"/cases/{CASE_ID}/doc-snaps", json=body, headers=VIEWER_AUTH
        ).status_code
        == 403
    )
    # Unknown case, malformed case id, and a model-level empty filename.
    assert (
        http.post("/cases/case-missing/doc-snaps", json=body, headers=AUTH).status_code
        == 404
    )
    assert (
        http.post("/cases/-leading/doc-snaps", json=body, headers=AUTH).status_code == 422
    )
    assert (
        http.post(
            f"/cases/{CASE_ID}/doc-snaps",
            json={"filename": "", "contentBase64": "aGk="},
            headers=AUTH,
        ).status_code
        == 422
    )


def test_doc_snap_rejects_bad_encoding_and_oversize() -> None:
    http, cases = _api()
    _seed_case(cases)
    bad = {"filename": "x.txt", "contentBase64": "not base64!!"}
    assert (
        http.post(f"/cases/{CASE_ID}/doc-snaps", json=bad, headers=AUTH).status_code == 422
    )
    oversize = {
        "filename": "big.bin",
        "contentBase64": base64.b64encode(b"a" * (DOC_SNAP_MAX_BYTES + 1)).decode(),
    }
    assert (
        http.post(f"/cases/{CASE_ID}/doc-snaps", json=oversize, headers=AUTH).status_code
        == 413
    )


def test_doc_snap_never_crosses_tenants() -> None:
    http, cases = _api()
    _seed_case(cases, tenant="otherco", case_id="case-otherco-1")
    body = _snap_body(INVOICE_TEXT)
    assert (
        http.post("/cases/case-otherco-1/doc-snaps", json=body, headers=AUTH).status_code
        == 404
    )
    assert http.get("/cases/case-otherco-1/doc-snaps", headers=AUTH).status_code == 404
