"""U7 doc-snap: a snapped document becomes an editable draft with checks.

Field reality is paper — an invoice, a certificate, an ID. Snapping one
produces a *draft*, never an action: this module only reads the bytes and
reports what it saw (extracted canonical fields plus validation flags for
the ABN checksum, certificate expiry, and duplicates of earlier snaps on
the same case). Turning any of it into a change still goes through the
normal edit decision and its receipt gate, so a bad extraction can never
advance a run on its own.

The default :class:`HeuristicDocSnapExtractor` is deterministic and offline
(text-decodable payloads, regex extraction). The :class:`DocSnapExtractor`
protocol is the seam an OCR/vision backend slots into later without
touching the router, the draft shape, or the validators.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Protocol
from uuid import uuid4

# Snaps are evidence, not storage: keep them small and reject anything else.
DOC_SNAP_MAX_BYTES = 2 * 1024 * 1024
# A document expiring inside this window is flagged before it lapses.
EXPIRING_WINDOW_DAYS = 90


class DocSnapError(ValueError):
    """The snapped content cannot be used: bad encoding or bad shape."""


class DocSnapTooLarge(DocSnapError):
    """The decoded snap exceeds :data:`DOC_SNAP_MAX_BYTES`."""


# --- validators -------------------------------------------------------------

_ABN_WEIGHTS = (10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19)


def normalize_abn(value: str) -> str:
    """Digits only; empty when the value is not an 11-digit run."""

    digits = re.sub(r"\D", "", value)
    return digits if len(digits) == 11 else ""


def format_abn(value: str) -> str:
    """Group an 11-digit ABN the way the ATO prints it (51 824 753 556)."""

    digits = normalize_abn(value)
    if not digits:
        return value
    return f"{digits[:2]} {digits[2:5]} {digits[5:8]} {digits[8:]}"


def abn_checksum_valid(value: str) -> bool:
    """The ATO checksum: subtract 1 from the first digit, weighted mod 89."""

    digits = normalize_abn(value)
    if not digits:
        return False
    total = (int(digits[0]) - 1) * _ABN_WEIGHTS[0] + sum(
        int(digit) * weight
        for digit, weight in zip(digits[1:], _ABN_WEIGHTS[1:], strict=True)
    )
    return total % 89 == 0


def expiry_status(value: str, *, today: date | None = None) -> tuple[str, int] | None:
    """Classify an ISO expiry date as (status, days).

    Status is ``expired`` / ``expiring`` / ``valid``; ``days`` counts days
    since expiry (expired) or days remaining (otherwise). Returns None when
    the value is not an ISO date.
    """

    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    current = today or datetime.now(UTC).date()
    delta = (parsed - current).days
    if delta < 0:
        return ("expired", -delta)
    if delta <= EXPIRING_WINDOW_DAYS:
        return ("expiring", delta)
    return ("valid", delta)


# --- heuristic extraction ---------------------------------------------------

# Extraction keys are canonical: a declared FieldDefinition with a matching
# ``snap_key`` is auto-filled when the extraction carries it.
_ABN_LABELLED = re.compile(
    r"\b(?:abn|australian business number)\b[^\d]{0,16}(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})",
    re.IGNORECASE,
)
_ABN_BARE = re.compile(r"(?<!\d)(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})(?!\d)")
# d/m/Y is the AU convention this lane reads; month names cover certificates.
_EXPIRY_LABELLED = re.compile(
    r"\b(?:expir\w*|valid until|valid to|valid through)\b[^\d]{0,24}"
    r"(\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})",
    re.IGNORECASE,
)
_DOC_NUMBER = re.compile(
    r"\b(?:invoice|certificate|reference|document)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*"
    r"(?!(?:date|no|number|total|amount|to|period)\b)"
    r"(?=[A-Z0-9/-]*\d)([A-Z0-9][A-Z0-9/-]{2,24})",
    re.IGNORECASE,
)
_TOTAL = re.compile(
    r"\b(?:total|amount due|invoice total|gst inclusive total)\b[^\d$]{0,12}"
    r"\$\s*([\d,]+\.\d{2})",
    re.IGNORECASE,
)
_DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y", "%d %B %Y", "%d %b %Y")


@dataclass(frozen=True)
class DocSnapExtraction:
    """What one extractor read: an inferred doc type and canonical fields."""

    doc_type: str
    fields: Mapping[str, str]


class DocSnapExtractor(Protocol):
    """The seam an OCR/vision backend implements later."""

    name: str

    async def extract(
        self, *, filename: str, content_type: str, data: bytes
    ) -> DocSnapExtraction: ...


def _normalize_date(value: str) -> str:
    for date_format in _DATE_FORMATS:
        try:
            return datetime.strptime(value.strip(), date_format).date().isoformat()
        except ValueError:
            continue
    return ""


def _extract_abn(text: str) -> str:
    labelled = _ABN_LABELLED.search(text)
    candidates = [labelled.group(1)] if labelled is not None else []
    candidates.extend(match.group(1) for match in _ABN_BARE.finditer(text))
    normalized = [digits for value in candidates if (digits := normalize_abn(value))]
    for value in normalized:
        if abn_checksum_valid(value):
            return value
    return normalized[0] if normalized else ""


def _infer_doc_type(text: str) -> str:
    lowered = text.lower()
    if "invoice" in lowered:
        return "invoice"
    if "certificate" in lowered:
        return "certificate"
    if any(word in lowered for word in ("passport", "licence", "license", "identity card")):
        return "id"
    return "unknown"


def extract_text_fields(text: str) -> DocSnapExtraction:
    """Deterministic regex extraction of the canonical doc-snap keys."""

    fields: dict[str, str] = {}
    abn = _extract_abn(text)
    if abn:
        fields["abn"] = abn
    expiry = _EXPIRY_LABELLED.search(text)
    if expiry is not None and (iso := _normalize_date(expiry.group(1))):
        fields["expiry"] = iso
    number = _DOC_NUMBER.search(text)
    if number is not None:
        fields["invoiceNumber"] = number.group(1).upper()
    total = _TOTAL.search(text)
    if total is not None:
        fields["total"] = f"${total.group(1)}"
    return DocSnapExtraction(doc_type=_infer_doc_type(text), fields=fields)


class HeuristicDocSnapExtractor:
    """Default extractor: decode the snap as text and regex the fields out.

    Deterministic and offline; binary payloads (raw photos, compressed PDF
    streams) simply yield no fields — the draft stays editable so the user
    can type what the page says.
    """

    name = "heuristic-v1"

    async def extract(
        self, *, filename: str, content_type: str, data: bytes
    ) -> DocSnapExtraction:
        del filename, content_type
        return extract_text_fields(data.decode("utf-8", errors="ignore"))


# --- draft builder ----------------------------------------------------------


def decode_snap_content(content_base64: str) -> bytes:
    """Base64 -> bytes, rejecting malformed encodings and oversize snaps."""

    compact = "".join(content_base64.split())
    try:
        data = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as error:
        raise DocSnapError("contentBase64 is not valid base64") from error
    if len(data) > DOC_SNAP_MAX_BYTES:
        raise DocSnapTooLarge(
            f"Snapped content exceeds {DOC_SNAP_MAX_BYTES} bytes"
        )
    return data


@dataclass(frozen=True)
class DocSnapFlag:
    """One automatic check result; ``field`` names the canonical key it holds."""

    code: str
    severity: str  # ok | warning | error
    message: str
    field: str = ""


@dataclass(frozen=True)
class DocSnapDraft:
    """One editable draft: what was snapped, what was read, what was flagged."""

    snap_id: str
    doc_type: str
    filename: str
    content_type: str
    sha256: str
    size_bytes: int
    fields: Mapping[str, str]
    flags: tuple[DocSnapFlag, ...]
    extractor: str
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_payload(self) -> dict[str, object]:
        return {
            "snapId": self.snap_id,
            "docType": self.doc_type,
            "source": {
                "filename": self.filename,
                "contentType": self.content_type,
                "sha256": self.sha256,
                "bytes": self.size_bytes,
            },
            "fields": dict(self.fields),
            "flags": [
                {
                    "code": flag.code,
                    "severity": flag.severity,
                    "message": flag.message,
                    "field": flag.field,
                }
                for flag in self.flags
            ],
            "extractor": self.extractor,
            "createdAt": self.created_at.isoformat(),
        }


def _abn_flags(abn: str) -> list[DocSnapFlag]:
    if not abn:
        return []
    if abn_checksum_valid(abn):
        return [
            DocSnapFlag(
                code="abn_checksum",
                severity="ok",
                message=f"ABN {format_abn(abn)} passes the ATO checksum.",
                field="abn",
            )
        ]
    return [
        DocSnapFlag(
            code="abn_checksum",
            severity="error",
            message=(
                f"ABN {format_abn(abn)} fails the ATO checksum — re-check the "
                "digits before approving."
            ),
            field="abn",
        )
    ]


def _expiry_flags(expiry: str, *, today: date | None) -> list[DocSnapFlag]:
    if not expiry:
        return []
    status = expiry_status(expiry, today=today)
    if status is None:
        return [
            DocSnapFlag(
                code="expiry_unparsed",
                severity="warning",
                message=f"Could not parse the extracted expiry {expiry!r}.",
                field="expiry",
            )
        ]
    kind, days = status
    if kind == "expired":
        return [
            DocSnapFlag(
                code="expiry",
                severity="error",
                message=f"Expired {days} day(s) ago ({expiry}).",
                field="expiry",
            )
        ]
    if kind == "expiring":
        return [
            DocSnapFlag(
                code="expiry",
                severity="warning",
                message=f"Expires in {days} day(s) ({expiry}).",
                field="expiry",
            )
        ]
    return [
        DocSnapFlag(
            code="expiry",
            severity="ok",
            message=f"Valid until {expiry} ({days} day(s)).",
            field="expiry",
        )
    ]


def build_doc_snap(
    *,
    filename: str,
    content_type: str,
    data: bytes,
    extraction: DocSnapExtraction,
    extractor: str,
    prior_sha256s: Collection[str] = (),
    today: date | None = None,
) -> DocSnapDraft:
    """Assemble the draft: identity, extracted fields, and auto-check flags."""

    sha256 = hashlib.sha256(data).hexdigest()
    fields = {key: value for key, value in extraction.fields.items() if value}
    flags = [
        *_abn_flags(fields.get("abn", "")),
        *_expiry_flags(fields.get("expiry", ""), today=today),
    ]
    if sha256 in prior_sha256s:
        flags.append(
            DocSnapFlag(
                code="duplicate",
                severity="warning",
                message=(
                    "This exact document was already snapped on this case — "
                    "check it is not a duplicate."
                ),
            )
        )
    if not fields:
        flags.append(
            DocSnapFlag(
                code="no_text",
                severity="warning",
                message=(
                    "No readable text was found in the snap — type the fields "
                    "by hand; the draft is still saved."
                ),
            )
        )
    return DocSnapDraft(
        snap_id=f"snap-{uuid4().hex[:12]}",
        doc_type=extraction.doc_type,
        filename=filename,
        content_type=content_type,
        sha256=sha256,
        size_bytes=len(data),
        fields=fields,
        flags=tuple(flags),
        extractor=extractor,
    )


def doc_snap_source_hashes(payloads: Iterable[Mapping[str, object]]) -> tuple[str, ...]:
    """Digest values of earlier doc-snap payloads on the same case.

    The case trail is the whole store the duplicate check needs — the
    repository offers no tenant-wide listing, and "same case" is the scope
    that matters when someone re-snaps the same invoice.
    """

    hashes: list[str] = []
    for payload in payloads:
        source = payload.get("source")
        if not isinstance(source, Mapping):
            continue
        value = source.get("sha256")
        if isinstance(value, str) and value:
            hashes.append(value)
    return tuple(hashes)


__all__ = [
    "DOC_SNAP_MAX_BYTES",
    "EXPIRING_WINDOW_DAYS",
    "DocSnapDraft",
    "DocSnapError",
    "DocSnapExtraction",
    "DocSnapExtractor",
    "DocSnapFlag",
    "DocSnapTooLarge",
    "HeuristicDocSnapExtractor",
    "abn_checksum_valid",
    "build_doc_snap",
    "decode_snap_content",
    "doc_snap_source_hashes",
    "expiry_status",
    "extract_text_fields",
    "format_abn",
    "normalize_abn",
]
