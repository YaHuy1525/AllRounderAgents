from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx

from .context import RequestContext
from .idempotency import IdempotencyStore


@dataclass(frozen=True, slots=True)
class ToolReceipt:
    action: str
    ticket_key: str
    idempotency_key: str
    status: str = "succeeded"


@dataclass(frozen=True, slots=True)
class JiraComment:
    ticket_key: str
    body: str


@dataclass(frozen=True, slots=True)
class JiraTransition:
    ticket_key: str
    transition: str


class JiraTransport(Protocol):
    def add_comment(self, ticket_key: str, body: str) -> None: ...

    def transition(self, ticket_key: str, transition: str) -> None: ...


class HttpJiraTransport:
    def __init__(self, base_url: str, email: str, api_token: str) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            auth=(email, api_token),
            headers={"accept": "application/json", "content-type": "application/json"},
            timeout=10,
        )

    def add_comment(self, ticket_key: str, body: str) -> None:
        response = self._client.post(
            f"/rest/api/3/issue/{ticket_key}/comment",
            json={
                "body": {
                    "type": "doc",
                    "version": 1,
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": body}],
                        }
                    ],
                }
            },
        )
        response.raise_for_status()

    def transition(self, ticket_key: str, transition: str) -> None:
        response = self._client.post(
            f"/rest/api/3/issue/{ticket_key}/transitions",
            json={"transition": {"id": transition}},
        )
        response.raise_for_status()

    def close(self) -> None:
        self._client.close()


class FakeJiraTransport:
    def __init__(self) -> None:
        self.comments: list[JiraComment] = []
        self.transitions: list[JiraTransition] = []

    def add_comment(self, ticket_key: str, body: str) -> None:
        self.comments.append(JiraComment(ticket_key, body))

    def transition(self, ticket_key: str, transition: str) -> None:
        self.transitions.append(JiraTransition(ticket_key, transition))


class JiraTools:
    def __init__(self, transport: JiraTransport, idempotency: IdempotencyStore) -> None:
        self._transport = transport
        self._idempotency = idempotency
        self._receipts: dict[str, ToolReceipt] = {}

    def comment(
        self,
        context: RequestContext,
        ticket_key: str,
        body: str,
        *,
        idempotency_key: str,
    ) -> ToolReceipt:
        del context
        receipt = self._receipts.get(idempotency_key)
        if receipt:
            return receipt
        if self._idempotency.claim(f"jira:comment:{idempotency_key}"):
            self._transport.add_comment(ticket_key, body)
        receipt = ToolReceipt("jira_comment", ticket_key, idempotency_key)
        self._receipts[idempotency_key] = receipt
        return receipt

    def transition(
        self,
        context: RequestContext,
        ticket_key: str,
        transition: str,
        *,
        idempotency_key: str,
    ) -> ToolReceipt:
        del context
        receipt = self._receipts.get(idempotency_key)
        if receipt:
            return receipt
        if self._idempotency.claim(f"jira:transition:{idempotency_key}"):
            self._transport.transition(ticket_key, transition)
        receipt = ToolReceipt("jira_transition", ticket_key, idempotency_key)
        self._receipts[idempotency_key] = receipt
        return receipt

