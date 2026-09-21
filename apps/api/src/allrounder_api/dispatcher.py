from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime

from .contracts import (
    Attachment,
    Domain,
    Gate,
    RiskScore,
    RoutedTicket,
    Ticket,
    TriageVerdict,
)
from .policy import RiskPolicy, default_risk_policy, load_risk_policy

DOMAIN_TERMS: Mapping[Domain, frozenset[str]] = {
    Domain.CODE: frozenset({"bug", "code", "api", "compiler", "typescript", "build", "ci", "500"}),
    Domain.FINANCE: frozenset(
        {
            "finance",
            "invoice",
            "ledger",
            "journal",
            "reconcile",
            "reconciliation",
            "audit",
            "erp",
            "bank",
            "variance",
            "treasury",
            "unmatched",
        }
    ),
    Domain.MARKETING: frozenset(
        {"marketing", "campaign", "brand", "newsletter", "social", "launch", "copy"}
    ),
    Domain.SUPPORT: frozenset(
        {"support", "customer", "login", "password", "refund", "account", "faq", "help"}
    ),
    Domain.SECURITY: frozenset(
        {
            "alert",
            "ioc",
            "malware",
            "phishing",
            "ransomware",
            "siem",
            "edr",
            "intrusion",
            "mitre",
            "cve",
            "exploit",
            "soc",
            "triage",
        }
    ),
}
PROJECT_DOMAINS = {
    "ENG": Domain.CODE,
    "FIN": Domain.FINANCE,
    "MKT": Domain.MARKETING,
    "SUP": Domain.SUPPORT,
    "SEC": Domain.SECURITY,
}


class DeterministicDispatcher:
    """Provider-neutral Phase 0 dispatcher; replace triage behind this interface later.

    All thresholds (confidence math, pre-flight scores/gates, per-domain
    approval floors, sensitive markers) come from ``policy/risk.yaml`` v1 —
    this class contains no magic numbers of its own.
    """

    workflows: Mapping[Domain, str] = {
        Domain.CODE: "coding-comment-only",
        Domain.FINANCE: "finance-comment-only",
        Domain.MARKETING: "marketing-comment-only",
        Domain.SUPPORT: "support-comment-only",
        Domain.SECURITY: "security-comment-only",
        Domain.UNKNOWN: "escalation-comment-only",
    }

    def __init__(self, policy: RiskPolicy | None = None, *, policy_dir: str | None = None) -> None:
        if policy is None:
            policy = load_risk_policy(policy_dir) if policy_dir else default_risk_policy()
        self._risk = policy

    def normalize_for_test(self, payload: Mapping[str, object]) -> Ticket:
        return normalize_jira_payload(payload)

    def dispatch(
        self, ticket: Ticket, planned_actions: Sequence[str] | None = None
    ) -> RoutedTicket:
        verdict = self.triage(ticket)
        actions = list(planned_actions or ["jira_comment"])
        risks = [self.preflight(action, domain=verdict.domain) for action in actions]
        gate = max((risk.gate for risk in risks), key=_gate_rank)
        if verdict.needs_human and gate is Gate.AUTO:
            gate = Gate.APPROVAL
        return RoutedTicket(
            ticket=ticket,
            verdict=verdict,
            risk_scores=risks,
            gate=gate,
            workflow=self.workflows[verdict.domain],
        )

    def triage(self, ticket: Ticket) -> TriageVerdict:
        text = " ".join(
            [ticket.project, ticket.issue_type, ticket.summary, ticket.description, *ticket.labels]
        )
        tokens = frozenset(re.findall(r"[a-z0-9]+", text.lower()))
        policy = self._risk.triage
        scores = {
            domain: sum(term in tokens for term in terms) for domain, terms in DOMAIN_TERMS.items()
        }
        project_domain = PROJECT_DOMAINS.get(ticket.project)
        if project_domain:
            scores[project_domain] += policy.project_signal_bonus
        domain, score = max(scores.items(), key=lambda item: item[1])
        sensitive = self._sensitive_markers(text)
        if score == 0:
            return TriageVerdict(
                domain=Domain.UNKNOWN,
                confidence=0,
                urgency=_urgency(ticket.priority),
                needs_human=True,
                rationale=self._with_sensitive_note(
                    "No domain had sufficient deterministic evidence; escalate with context.",
                    sensitive,
                ),
            )
        confidence = min(
            policy.confidence_cap, policy.base_confidence + score * policy.signal_weight
        )
        return TriageVerdict(
            domain=domain,
            confidence=confidence,
            urgency=_urgency(ticket.priority),
            needs_human=confidence < policy.human_review_below or bool(sensitive),
            rationale=self._with_sensitive_note(
                f"Matched {score} deterministic project or content signals for {domain.value}.",
                sensitive,
            ),
        )

    def preflight(self, action: str, *, domain: Domain | None = None) -> RiskScore:
        lowered = action.lower()
        policy = self._risk.preflight
        irreversible = any(term in lowered for term in policy.irreversible_terms)
        high_blast = any(term in lowered for term in policy.high_blast_terms)
        if irreversible and high_blast:
            score = policy.score_both
        elif irreversible or high_blast:
            score = policy.score_single
        else:
            score = policy.score_benign
        gate = (
            Gate.REFUSE
            if score >= policy.refuse_at
            else Gate.APPROVAL
            if score >= policy.approval_at
            else Gate.AUTO
        )
        reasons = [f"policy/risk.yaml v{self._risk.version} deterministic pre-flight"]
        if domain is not None:
            floor = next(
                (term for term in policy.domain_terms.get(domain.value, ()) if term in lowered),
                None,
            )
            if floor is not None and gate is not Gate.REFUSE:
                # A domain floor only raises the gate (never lowers a refuse).
                if gate is Gate.AUTO:
                    gate = Gate.APPROVAL
                    score = max(score, policy.approval_at)
                reasons.append(f"{domain.value} lane policy floors '{floor}' to human approval")
        return RiskScore(
            action=action,
            blast_radius="high" if high_blast else "low",
            reversibility="irreversible" if irreversible else "reversible",
            score=score,
            gate=gate,
            reasons=reasons,
        )

    def _sensitive_markers(self, text: str) -> tuple[str, ...]:
        """Markers of sensitive tickets; matches force human approval."""

        lowered = " ".join(text.lower().split())
        return tuple(
            marker
            for marker in self._risk.sensitive.markers
            if re.search(rf"\b{re.escape(marker)}\b", lowered)
        )

    def _with_sensitive_note(self, rationale: str, sensitive: tuple[str, ...]) -> str:
        if not sensitive:
            return rationale
        clause = self._risk.sensitive.clause
        matched = ", ".join(sensitive)
        return (
            f"{rationale} Sensitive-ticket policy clause {clause} requires mandatory human "
            f"approval (matched: {matched})."
        )


def normalize_jira_payload(payload: Mapping[str, object]) -> Ticket:
    issue = _mapping(payload.get("issue"))
    fields = _mapping(issue.get("fields"))
    key = str(issue.get("key", ""))
    timestamp = payload.get("timestamp", 0)
    event_seed = f"{payload.get('webhookEvent', '')}:{key}:{timestamp}"
    event_id = hashlib.sha256(event_seed.encode()).hexdigest()
    project = _mapping(fields.get("project"))
    issue_type = _mapping(fields.get("issuetype"))
    priority = _mapping(fields.get("priority"))
    reporter = _mapping(fields.get("reporter"))
    attachments = [
        Attachment(
            id=str(item.get("id", "")),
            name=str(item.get("filename", item.get("name", ""))),
            mime=str(item.get("mimeType", item.get("mime", "application/octet-stream"))),
            bytes=_as_int(item.get("size", item.get("bytes", 0))),
        )
        for raw in _sequence(fields.get("attachment"))
        if (item := _mapping(raw))
    ]
    received = datetime.fromtimestamp(_as_float(timestamp) / 1000, tz=UTC)
    return Ticket(
        key=key,
        project=str(project.get("key", "")),
        issue_type=str(issue_type.get("name", "")),
        labels=[str(label) for label in _sequence(fields.get("labels"))],
        priority=str(priority.get("name", "Medium")),
        summary=str(fields.get("summary", "")),
        description=_description_text(fields.get("description")),
        reporter=str(reporter.get("accountId") or reporter.get("displayName") or "unknown"),
        attachments=attachments,
        event_id=event_id,
        received_at=received,
    )


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    return value if isinstance(value, list) else []


def _as_int(value: object) -> int:
    if isinstance(value, int | str | bytes | bytearray):
        return int(value)
    raise ValueError("Expected an integer-compatible value")


def _as_float(value: object) -> float:
    if isinstance(value, int | float | str | bytes | bytearray):
        return float(value)
    raise ValueError("Expected a number-compatible value")


def _description_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, sort_keys=True)


def _urgency(priority: str) -> int:
    return {"Highest": 5, "High": 4, "Medium": 3, "Low": 2, "Lowest": 1}.get(priority, 3)


def _gate_rank(gate: Gate) -> int:
    return {Gate.AUTO: 0, Gate.APPROVAL: 1, Gate.REFUSE: 2}[gate]

