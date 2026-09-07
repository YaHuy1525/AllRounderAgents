from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4


@dataclass(frozen=True, slots=True)
class RequestContext:
    request_id: str
    correlation_id: str
    actor: str

    @classmethod
    def for_webhook(cls, correlation_id: str) -> RequestContext:
        return cls(request_id=str(uuid4()), correlation_id=correlation_id, actor="jira-webhook")

