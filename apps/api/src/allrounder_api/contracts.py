from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


def alias_config() -> ConfigDict:
    return ConfigDict(
        alias_generator=lambda value: _to_camel(value),
        populate_by_name=True,
        extra="forbid",
    )


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(word.title() for word in rest)


class Contract(BaseModel):
    model_config = alias_config()


class Domain(StrEnum):
    CODE = "code"
    FINANCE = "finance"
    MARKETING = "marketing"
    SUPPORT = "support"
    UNKNOWN = "unknown"


class Gate(StrEnum):
    AUTO = "auto"
    APPROVAL = "approval"
    REFUSE = "refuse"


class Attachment(Contract):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    mime: str = Field(min_length=1)
    bytes: int = Field(ge=0)


class Ticket(Contract):
    key: str = Field(pattern=r"^[A-Z][A-Z0-9_]*-\d+$")
    project: str = Field(min_length=1)
    issue_type: str = Field(min_length=1)
    labels: list[str]
    priority: str = Field(pattern=r"^(Highest|High|Medium|Low|Lowest)$")
    summary: str = Field(min_length=1, max_length=500)
    description: str
    reporter: str = Field(min_length=1)
    attachments: list[Attachment]
    event_id: str = Field(min_length=1)
    received_at: datetime


class TriageVerdict(Contract):
    domain: Domain
    confidence: float = Field(ge=0, le=1)
    urgency: int = Field(ge=1, le=5)
    needs_human: bool
    rationale: str = Field(min_length=1)


class RiskScore(Contract):
    action: str = Field(min_length=1)
    blast_radius: str = Field(pattern=r"^(low|med|high)$")
    reversibility: str = Field(pattern=r"^(reversible|compensable|irreversible)$")
    score: int = Field(ge=0, le=100)
    gate: Gate
    reasons: list[str]


class ActionEvidence(Contract):
    tool: str
    args_redacted: dict[str, object]
    status: str
    artifact_urls: list[HttpUrl]


class Citation(Contract):
    source_id: str
    span: str


class ModelUse(Contract):
    step: str
    model: str
    tokens: int = Field(ge=0)


class EvidencePack(Contract):
    actions: list[ActionEvidence]
    citations: list[Citation]
    confidence: float = Field(ge=0, le=1)
    cost_usd_micro: int = Field(ge=0)
    transcript_ref: str = Field(min_length=1)
    model_trail: list[ModelUse]


class RoutedTicket(Contract):
    ticket: Ticket
    verdict: TriageVerdict
    risk_scores: list[RiskScore]
    gate: Gate
    workflow: str

