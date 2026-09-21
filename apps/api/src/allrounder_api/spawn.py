"""Cross-domain spawn (Nexus pattern): a support ticket that exposes a
product defect files a linked bug ticket with its evidence trail.

The planner is deterministic and policy-driven (``policy/risk.yaml`` →
``spawn``): a matching ticket produces a stable correlation id, so the create
is idempotent and a replayed webhook can never file the same bug twice.

Audit-first: raw customer text is not copied into the spawned ticket — the
description carries the source key, matched signals and the (clause-cited,
redacted) routing rationale, so a mask applied to the rationale names the
clause that caused it.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .contracts import RoutedTicket
from .policy import SpawnPolicy, default_risk_policy
from .repositories import RedactionEntry, audit_redaction


@dataclass(frozen=True)
class SpawnPlan:
    """A ready-to-file linked ticket; ``correlation_id`` makes it idempotent."""

    source_ticket_key: str
    source_project: str
    target_project: str
    issue_type: str
    summary: str
    description: str
    labels: tuple[str, ...]
    correlation_id: str
    signals: tuple[str, ...]


class CrossDomainSpawner:
    """Support → code spawn rule; returns ``None`` when nothing must be filed."""

    def __init__(self, policy: SpawnPolicy | None = None) -> None:
        self._policy = policy if policy is not None else default_risk_policy().spawn

    @property
    def policy(self) -> SpawnPolicy:
        return self._policy

    def plan(self, routed: RoutedTicket) -> SpawnPlan | None:
        policy = self._policy
        if not policy.enabled or routed.verdict.domain.value != policy.from_domain:
            return None
        source = routed.ticket
        text = " ".join([source.summary, source.description, *source.labels]).lower()
        normalized = " ".join(text.split())
        signals = tuple(signal for signal in policy.signals if signal in normalized)
        if not signals:
            return None
        correlation_id = hashlib.sha256(
            f"{source.key}:{','.join(signals)}".encode()
        ).hexdigest()[:12].upper()
        summary_report = audit_redaction(source.summary)
        rationale_report = audit_redaction(routed.verdict.rationale)
        summary_text = str(summary_report.value)
        rationale_text = str(rationale_report.value)
        entries: tuple[RedactionEntry, ...] = (
            *summary_report.entries,
            *rationale_report.entries,
        )
        description_lines = [
            "Auto-filed by the cross-domain spawn policy (support to code): a "
            "customer-facing report describes a product defect.",
            "",
            f"Source: {source.key} — {summary_text}",
            f"Signals: {', '.join(signals)}",
            f"Routing: {rationale_text}",
            "",
            "Evidence: the full customer thread stays on the source ticket; only "
            "diagnostic signals are copied here.",
        ]
        if entries:
            clauses = ", ".join(sorted({entry.clause for entry in entries}))
            description_lines.append(f"Redacted per clause(s): {clauses}")
        return SpawnPlan(
            source_ticket_key=source.key,
            source_project=source.project,
            target_project=policy.target_project,
            issue_type=policy.issue_type,
            summary=f"[spawn] {summary_text}"[:240],
            description="\n".join(description_lines),
            labels=(*policy.labels, f"source:{source.key.lower()}"),
            correlation_id=correlation_id,
            signals=signals,
        )


__all__ = ["CrossDomainSpawner", "SpawnPlan"]
