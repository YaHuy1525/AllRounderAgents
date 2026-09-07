from __future__ import annotations

from collections.abc import Sequence

import pytest
from allrounder_api.dispatcher import DeterministicDispatcher
from allrounder_api.persistence import PostgresTicketQueue, PsycopgExecutor


class RecordingExecutor:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Sequence[object]]] = []

    def execute(self, statement: str, parameters: Sequence[object]) -> None:
        self.calls.append((statement, parameters))


def test_postgres_queue_uses_executor_without_credentials() -> None:
    executor = RecordingExecutor()
    queue = PostgresTicketQueue(executor)
    dispatcher = DeterministicDispatcher()
    ticket = dispatcher.normalize_for_test(
        {
            "webhookEvent": "jira:issue_created",
            "timestamp": 1_788_720_000_001,
            "issue": {
                "key": "ENG-101",
                "fields": {
                    "project": {"key": "ENG"},
                    "issuetype": {"name": "Bug"},
                    "labels": ["code"],
                    "priority": {"name": "High"},
                    "summary": "Fix API bug",
                    "description": "Returns 500",
                    "reporter": {"accountId": "acct-1"},
                    "attachment": [],
                },
            },
        }
    )

    queue.enqueue(dispatcher.dispatch(ticket))

    assert len(executor.calls) == 1
    assert "insert into public.dispatcher_jobs" in executor.calls[0][0]
    assert executor.calls[0][1][2] == "ENG-101"


def test_direct_database_url_is_required() -> None:
    with pytest.raises(ValueError, match="DATABASE_URL"):
        PsycopgExecutor("")
