"""Audit pack exporter v0: per client per month, JSON plus PDF.

The pack is built only from the immutable trail: the run archive (unioned with
the live registry, so runs that have not archived yet still appear), the case
event ledger, and the approval receipts embedded in step decisions. Nothing is
recomputed by an engine and no live workflow state is consulted.

Every receipt-bearing decision is re-verified: the action hash is recomputed
from the surviving artifact and the receipt signature is validated with ``now``
pinned to the decision time (receipts expire one hour after issue, so
wall-clock validation would always fail). Regeneration decisions carry no
receipt by design: they are recorded and counted as decisions, never as
failed receipts.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .approvals import ApprovalReceiptSigner, ReceiptError
from .logging import get_logger
from .repositories import CaseRecord, CaseRepository
from .runs.archive import RunArchive
from .runs.definitions import side_effect_scope
from .runs.mastra_client import action_hash
from .runs.models import RunStep, WorkflowDefinition, WorkflowRun
from .runs.registry import RunRegistry
from .runs.service import content_hash

PACK_VERSION = "v0"

# Decisions that re-run a step instead of approving it (a send-back for a new
# draft). They persist a decision record but no receipt, so the pack shows
# them as recorded decisions with nothing to verify, never as failed receipts.
_RECEIPTLESS_ACTIONS = frozenset({"regenerate"})

_MONTH_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
# Mirrors the msp_clients.client_ref check constraint; client refs are the
# mailbox local-part slugs minted by intake (already lowercased).
CLIENT_REF_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,63}$")


def month_window(month: str) -> tuple[str, str]:
    """``YYYY-MM`` as a half-open UTC window ``[since, until)`` in ISO form."""
    match = _MONTH_RE.match(month)
    if match is None:
        raise ValueError("month must be formatted as YYYY-MM")
    year = int(match.group(1))
    month_number = int(match.group(2))
    since = datetime(year, month_number, 1, tzinfo=UTC)
    if month_number == 12:
        until = datetime(year + 1, 1, 1, tzinfo=UTC)
    else:
        until = datetime(year, month_number + 1, 1, tzinfo=UTC)
    return since.isoformat(), until.isoformat()


class AuditPackBuilder:
    """Assembles the JSON pack; ``render_pdf`` renders any built pack."""

    def __init__(
        self,
        *,
        archive: RunArchive,
        registry: RunRegistry,
        signer: ApprovalReceiptSigner,
        cases: CaseRepository | None,
        workflows: Mapping[str, WorkflowDefinition],
        clock: Callable[[], datetime] | None = None,
        registry_limit: int = 200,
        run_limit: int = 500,
    ) -> None:
        self._archive = archive
        self._registry = registry
        self._signer = signer
        self._cases = cases
        self._workflows = workflows
        self._clock = clock or (lambda: datetime.now(UTC))
        self._registry_limit = registry_limit
        self._run_limit = run_limit
        self._logger = get_logger()

    async def build(self, *, tenant_id: str, client_ref: str, month: str) -> dict[str, object]:
        if not CLIENT_REF_RE.match(client_ref):
            raise ValueError("clientRef must be a mailbox client ref slug")
        since, until = month_window(month)
        prefix = f"msp-{client_ref}-"

        runs_by_id: dict[str, WorkflowRun] = {}
        for run in await self._archive.list_full(
            tenant_id, case_id_prefix=prefix, since=since, until=until, limit=self._run_limit
        ):
            runs_by_id[run.run_id] = run
        # The archive wins for runs recorded on both sides; the registry adds
        # the runs that are still in flight (not yet archived).
        for run in await self._registry.list_recent(tenant_id, limit=self._registry_limit):
            if run.run_id in runs_by_id or not run.case_id.startswith(prefix):
                continue
            started = run.started_at.astimezone(UTC).isoformat()
            if since <= started < until:
                runs_by_id[run.run_id] = run
        runs = sorted(runs_by_id.values(), key=lambda item: (item.started_at, item.run_id))

        case_payloads: list[dict[str, object]] = []
        event_count = 0
        for case_id in sorted({run.case_id for run in runs}):
            record = await self._case(tenant_id, case_id)
            if record is not None:
                case_payloads.append(_case_payload(record))
                event_count += len(record.events)

        decision_count = 0
        verified_count = 0
        failed_count = 0
        run_payloads: list[dict[str, object]] = []
        for run in runs:
            payload, decisions, verified, failed = self._run_payload(run)
            decision_count += decisions
            verified_count += verified
            failed_count += failed
            run_payloads.append(payload)

        return {
            "packVersion": PACK_VERSION,
            "packKey": f"{tenant_id}:{client_ref}:{month}",
            "tenantId": tenant_id,
            "clientRef": client_ref,
            "month": month,
            "window": {"since": since, "until": until},
            "generatedAt": self._clock().astimezone(UTC).isoformat(),
            "summary": {
                "caseCount": len(case_payloads),
                "runCount": len(runs),
                "completedRuns": sum(1 for run in runs if run.status == "completed"),
                "failedRuns": sum(1 for run in runs if run.status == "failed"),
                "cancelledRuns": sum(1 for run in runs if run.status == "cancelled"),
                "decisionCount": decision_count,
                "receiptsVerified": verified_count,
                "receiptsFailed": failed_count,
                "eventCount": event_count,
            },
            "cases": case_payloads,
            "runs": run_payloads,
        }

    # ------------------------------------------------------------ internals

    async def _case(self, tenant_id: str, case_id: str) -> CaseRecord | None:
        if self._cases is None:
            return None
        try:
            return await self._cases.get(case_id, tenant_id)
        except KeyError:
            self._logger.info("audit_pack_case_missing", case_id=case_id)
            return None

    def _run_payload(
        self, run: WorkflowRun
    ) -> tuple[dict[str, object], int, int, int]:
        definition = self._workflows.get(run.workflow)
        steps: list[dict[str, object]] = []
        decision_count = 0
        verified_count = 0
        failed_count = 0
        for step in run.steps:
            entry: dict[str, object] = {
                "stepId": step.step_id,
                "title": step.title,
                "state": step.state,
                "updatedAt": step.updated_at.astimezone(UTC).isoformat(),
            }
            if step.artifact is not None:
                entry["artifact"] = step.artifact
            if step.decision is not None:
                decision_count += 1
                entry["decision"] = {
                    "action": step.decision.get("action"),
                    "approver": step.decision.get("approver"),
                    "approvalId": step.decision.get("approvalId"),
                    "receiptId": step.decision.get("receiptId"),
                    "decidedAt": step.decision.get("decidedAt"),
                    "actionHash": step.decision.get("actionHash"),
                    "edits": step.decision.get("edits"),
                }
                if step.decision.get("action") in _RECEIPTLESS_ACTIONS:
                    entry["verification"] = {
                        "actionHashMatches": None,
                        "receiptVerified": None,
                        "reason": "no_receipt_required",
                    }
                else:
                    verification = self._verify_decision(run, step, definition)
                    if verification["receiptVerified"] is True:
                        verified_count += 1
                    else:
                        failed_count += 1
                    entry["verification"] = verification
            steps.append(entry)
        payload: dict[str, object] = {
            "runId": run.run_id,
            "workflow": run.workflow,
            "ticketKey": run.ticket_key,
            "caseId": run.case_id,
            "status": run.status,
            "outcome": run.outcome,
            "cancelReason": run.cancel_reason,
            "attempt": run.attempt,
            "startedAt": run.started_at.astimezone(UTC).isoformat(),
            "finishedAt": (
                run.finished_at.astimezone(UTC).isoformat()
                if run.finished_at is not None
                else None
            ),
            "steps": steps,
            "sideEffects": run.side_effects,
        }
        return payload, decision_count, verified_count, failed_count

    def _verify_decision(
        self,
        run: WorkflowRun,
        step: RunStep,
        definition: WorkflowDefinition | None,
    ) -> dict[str, object]:
        """Re-derive the receipt binding exactly as ``RunService`` built it."""
        decision = step.decision or {}
        action_dict: dict[str, object] = {
            "workflow": run.workflow,
            "runId": run.run_id,
            "stepId": step.step_id,
            "action": decision.get("action"),
            "artifactHash": content_hash(step.artifact or {}),
        }
        edits = decision.get("edits")
        if edits is not None and isinstance(edits, dict):
            action_dict["editsHash"] = content_hash(edits)
        hash_ok = action_hash(action_dict) == str(decision.get("actionHash") or "")
        verification: dict[str, object] = {
            "actionHashMatches": hash_ok,
            "receiptVerified": False,
            "reason": None,
        }
        token = step.receipt
        if token is None:
            verification["reason"] = "missing_receipt"
            return verification
        if not hash_ok:
            verification["reason"] = "action_hash_mismatch"
            return verification
        decided_at = _parse_iso(decision.get("decidedAt"))
        if decided_at is None:
            verification["reason"] = "invalid_decided_at"
            return verification
        scope = self._scope(run, step.step_id, definition)
        try:
            self._signer.validate(
                token,
                approval_id=str(decision.get("approvalId") or ""),
                case_id=run.case_id,
                action=action_dict,
                scope=scope,
                run_id=run.run_id,
                now=decided_at,
            )
        except ReceiptError:
            verification["reason"] = "receipt_invalid"
            return verification
        verification["receiptVerified"] = True
        return verification

    def _scope(
        self, run: WorkflowRun, step_id: str, definition: WorkflowDefinition | None
    ) -> str:
        if definition is not None:
            try:
                if definition.step(step_id).side_effecting:
                    return side_effect_scope(run.workflow, step_id)
            except KeyError:
                pass
        return f"run:{run.workflow}"


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _case_payload(record: CaseRecord) -> dict[str, object]:
    return {
        "caseId": record.id,
        "ticketKey": record.ticket_key,
        "domain": record.domain,
        "status": record.status,
        "outcome": record.outcome,
        "costUsdMicro": record.cost_usd_micro,
        "events": [
            {
                "actor": event.actor,
                "kind": event.kind,
                "at": event.created_at.astimezone(UTC).isoformat(),
                "payload": event.payload,
            }
            for event in record.events
        ],
    }


# ----------------------------------------------------------------- PDF render

_PDF_FOOTER = (
    "Built only from the immutable trail: the run archive, the case-event "
    "ledger, and the approval receipts bound to each decision. Every decision "
    "is re-verified by recomputing its action hash and validating its receipt "
    "signature as of the decision time."
)


def render_pdf(pack: Mapping[str, object]) -> bytes:
    """Render a built pack as a printable PDF."""
    buffer = BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        title=f"Audit pack {_text(pack.get('packKey'))}",
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
    )
    styles = getSampleStyleSheet()
    body = styles["BodyText"]
    cell = ParagraphStyle("PackCell", parent=body, fontSize=7.5, leading=9.5)
    cell_head = ParagraphStyle("PackCellHead", parent=cell, fontName="Helvetica-Bold",)

    story: list[object] = []
    story.append(Paragraph("MSP audit pack", styles["Title"]))
    story.append(
        Paragraph(
            escape(
                f"Client {_text(pack.get('clientRef'))} · month {_text(pack.get('month'))} "
                f"· tenant {_text(pack.get('tenantId'))}"
            ),
            body,
        )
    )
    story.append(Spacer(1, 6))
    window = _as_dict(pack.get("window"))
    story.append(
        _table(
            [
                [_cell("Generated", cell_head), _cell("Window start", cell_head),
                 _cell("Window end", cell_head), _cell("Pack version", cell_head)],
                [_cell(pack.get("generatedAt"), cell), _cell(window.get("since"), cell),
                 _cell(window.get("until"), cell), _cell(pack.get("packVersion"), cell)],
            ]
        )
    )

    summary = _as_dict(pack.get("summary"))
    story.append(Paragraph("Summary", styles["Heading2"]))
    story.append(
        _table(
            [
                [_cell("Cases", cell_head), _cell("Runs", cell_head),
                 _cell("Decisions", cell_head), _cell("Receipts OK", cell_head),
                 _cell("Receipts failed", cell_head), _cell("Events", cell_head)],
                [_cell(summary.get("caseCount"), cell), _cell(summary.get("runCount"), cell),
                 _cell(summary.get("decisionCount"), cell),
                 _cell(summary.get("receiptsVerified"), cell),
                 _cell(summary.get("receiptsFailed"), cell),
                 _cell(summary.get("eventCount"), cell)],
            ]
        )
    )

    cases = _list_of_dicts(pack.get("cases"))
    story.append(Paragraph("Cases and event trail", styles["Heading2"]))
    if not cases:
        story.append(Paragraph("No cases in this window.", body))
    for case in cases:
        story.append(
            Paragraph(
                escape(
                    f"{_text(case.get('caseId'))} · {_text(case.get('ticketKey'))} "
                    f"· {_text(case.get('status'))}"
                ),
                styles["Heading3"],
            )
        )
        story.append(
            _table(
                [
                    [_cell("Actor", cell_head), _cell("Kind", cell_head),
                     _cell("At", cell_head), _cell("Payload", cell_head)],
                    *[
                        [_cell(event.get("actor"), cell), _cell(event.get("kind"), cell),
                         _cell(event.get("at"), cell), _cell(_payload_text(event), cell)]
                        for event in _list_of_dicts(case.get("events"))
                    ],
                ]
            )
        )
        story.append(Spacer(1, 4))

    runs = _list_of_dicts(pack.get("runs"))
    story.append(Paragraph("Runs and decisions", styles["Heading2"]))
    if not runs:
        story.append(Paragraph("No runs in this window.", body))
    for run in runs:
        story.append(
            Paragraph(
                escape(
                    f"{_text(run.get('runId'))} · {_text(run.get('status'))} "
                    f"· {_text(run.get('ticketKey'))}"
                ),
                styles["Heading3"],
            )
        )
        story.append(
            _table(
                [
                    [_cell("Started", cell_head), _cell("Finished", cell_head),
                     _cell("Attempt", cell_head), _cell("Outcome", cell_head)],
                    [_cell(run.get("startedAt"), cell), _cell(run.get("finishedAt"), cell),
                     _cell(run.get("attempt"), cell), _cell(run.get("outcome"), cell)],
                ]
            )
        )
        story.append(Spacer(1, 3))
        story.append(
            _table(
                [
                    [_cell("Step", cell_head), _cell("State", cell_head),
                     _cell("Decision", cell_head), _cell("Approver", cell_head),
                     _cell("Decided at", cell_head), _cell("Receipt", cell_head),
                     _cell("Verified", cell_head)],
                    *[
                        [
                            _cell(step.get("stepId"), cell),
                            _cell(step.get("state"), cell),
                            _cell(_decision_action(step), cell),
                            _cell(_decision_field(step, "approver"), cell),
                            _cell(_decision_field(step, "decidedAt"), cell),
                            _cell(_decision_field(step, "receiptId"), cell),
                            _cell(_verification_text(step), cell),
                        ]
                        for step in _list_of_dicts(run.get("steps"))
                    ],
                ]
            )
        )
        story.append(Spacer(1, 4))

    story.append(Spacer(1, 6))
    story.append(Paragraph(escape(_PDF_FOOTER), body))
    document.build(story)
    return buffer.getvalue()


def _table(rows: Sequence[Sequence[object]]) -> Table:
    table = Table([list(row) for row in rows], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c9ccd1")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f1f3")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return table


def _cell(value: object, style: ParagraphStyle) -> Paragraph:
    return Paragraph(escape(_text(value)), style)


def _text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, default=str)
    return str(value)


def _payload_text(event: Mapping[str, object]) -> str:
    text = _text(event.get("payload"))
    return text if len(text) <= 360 else f"{text[:357]}..."


def _decision_action(step: Mapping[str, object]) -> object:
    return _as_dict(step.get("decision")).get("action")


def _decision_field(step: Mapping[str, object], key: str) -> object:
    return _as_dict(step.get("decision")).get(key)


def _verification_text(step: Mapping[str, object]) -> str:
    verification = _as_dict(step.get("verification"))
    if verification.get("receiptVerified") is True:
        return "receipt verified"
    if verification.get("reason") == "no_receipt_required":
        return "no receipt required"
    reason = verification.get("reason")
    return f"failed: {_text(reason)}" if reason else "not verified"


def _as_dict(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return value
    return {}


def _list_of_dicts(value: object) -> list[Mapping[str, object]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, Mapping)]


__all__ = [
    "AuditPackBuilder",
    "CLIENT_REF_RE",
    "PACK_VERSION",
    "month_window",
    "render_pdf",
]
