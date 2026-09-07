from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .contracts import RoutedTicket, Ticket


class EnqueueError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class DeadLetter:
    ticket: Ticket
    reason: str
    error: str


class TicketQueue(Protocol):
    def enqueue(self, routed: RoutedTicket) -> None: ...

    def dead_letter(self, ticket: Ticket, reason: str, error: Exception) -> None: ...


class MemoryQueue:
    def __init__(self, *, fail_enqueue: bool = False) -> None:
        self.items: list[RoutedTicket] = []
        self.dead_letters: list[DeadLetter] = []
        self.fail_enqueue = fail_enqueue

    def enqueue(self, routed: RoutedTicket) -> None:
        if self.fail_enqueue:
            raise EnqueueError("simulated queue outage")
        self.items.append(routed)

    def dead_letter(self, ticket: Ticket, reason: str, error: Exception) -> None:
        self.dead_letters.append(DeadLetter(ticket=ticket, reason=reason, error=str(error)))

