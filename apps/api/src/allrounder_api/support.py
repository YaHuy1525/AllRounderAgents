from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DraftValidation:
    valid: bool
    escalate: bool
    reason: str | None = None


class SupportService:
    """Deterministic guard used before any support draft reaches approval."""

    def validate_draft(
        self, draft: str, citations: list[dict[str, str]]
    ) -> DraftValidation:
        if not draft.strip() or not citations:
            return DraftValidation(False, True, "Every support claim requires a citation")
        for citation in citations:
            source_id = citation.get("sourceId", "")
            span = citation.get("span", "")
            marker = f"[{source_id}:{span}]"
            if not source_id or not span or marker not in draft:
                return DraftValidation(False, True, "Unsupported claim or malformed citation")
        return DraftValidation(True, False)
