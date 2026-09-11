from __future__ import annotations

import httpx
import pytest
from allrounder_api.jira import HttpJiraTransport
from allrounder_api.resilience import (
    MAX_RETRY_AFTER_SECONDS,
    default_should_retry,
    retry_after_seconds,
    retry_async,
    retry_sync,
)

JIRA_SITE = "https://jira.example"


def status_error(code: int, headers: dict[str, str] | None = None) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", f"{JIRA_SITE}/rest/api/3/issue/ENG-1")
    response = httpx.Response(code, headers=headers, request=request)
    return httpx.HTTPStatusError(f"status {code}", request=request, response=response)


def test_default_policy_retries_transient_failures_only() -> None:
    assert default_should_retry(httpx.ConnectError("down"))
    assert default_should_retry(httpx.ReadTimeout("slow"))
    assert default_should_retry(status_error(429))
    assert default_should_retry(status_error(500))
    assert default_should_retry(status_error(503))
    assert not default_should_retry(status_error(400))
    assert not default_should_retry(status_error(404))
    assert not default_should_retry(ValueError("bug"))


def test_retry_after_seconds_caps_and_ignores_garbage() -> None:
    assert retry_after_seconds(status_error(429, {"retry-after": "7"})) == (
        MAX_RETRY_AFTER_SECONDS
    )
    assert retry_after_seconds(status_error(429, {"retry-after": "1.5"})) == 1.5
    assert retry_after_seconds(status_error(503, {"retry-after": "soon"})) is None
    assert retry_after_seconds(httpx.ConnectError("x")) is None


async def test_retry_async_recovers_after_a_transient_failure() -> None:
    calls = 0
    sleeps: list[float] = []

    async def op() -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise status_error(503)
        return "ok"

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    assert await retry_async(op, sleep=fake_sleep) == "ok"
    assert calls == 2
    assert len(sleeps) == 1
    assert 0.0 <= sleeps[0] <= 0.2  # full jitter under the first-attempt ceiling


async def test_retry_async_honors_retry_after() -> None:
    calls = 0
    sleeps: list[float] = []

    async def op() -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise status_error(429, {"retry-after": "7"})
        return "ok"

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    assert await retry_async(op, sleep=fake_sleep) == "ok"
    assert sleeps == [MAX_RETRY_AFTER_SECONDS]


async def test_retry_async_stops_at_the_attempt_cap() -> None:
    calls = 0
    sleeps: list[float] = []

    async def op() -> str:
        nonlocal calls
        calls += 1
        raise status_error(502)

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    with pytest.raises(httpx.HTTPStatusError):
        await retry_async(op, attempts=3, sleep=fake_sleep)
    assert calls == 3
    assert len(sleeps) == 2


async def test_retry_async_does_not_retry_client_errors() -> None:
    calls = 0
    sleeps: list[float] = []

    async def op() -> str:
        nonlocal calls
        calls += 1
        raise status_error(400)

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    with pytest.raises(httpx.HTTPStatusError):
        await retry_async(op, sleep=fake_sleep)
    assert calls == 1
    assert sleeps == []


async def test_retry_async_rejects_zero_attempts() -> None:
    async def op() -> str:
        return "never"

    with pytest.raises(ValueError, match="attempts"):
        await retry_async(op, attempts=0)


def test_retry_sync_recovers_and_caps_attempts() -> None:
    calls = 0
    sleeps: list[float] = []

    def op() -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("dial failed")
        return "ok"

    assert retry_sync(op, sleep=sleeps.append) == "ok"
    assert calls == 2
    assert 0.0 <= sleeps[0] <= 0.2

    def always_failing() -> str:
        raise status_error(503)

    sleeps.clear()
    with pytest.raises(httpx.HTTPStatusError):
        retry_sync(always_failing, attempts=2, sleep=sleeps.append)
    assert len(sleeps) == 1


def test_http_jira_transport_retries_transient_status_then_succeeds() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if len(calls) == 1:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, json={"issues": []})

    with httpx.Client(base_url=JIRA_SITE, transport=httpx.MockTransport(handler)) as client:
        transport = HttpJiraTransport(JIRA_SITE, "user@example.com", "token", client=client)
        try:
            issues = transport.search_issues("ENG", 10)
        finally:
            transport.close()

    assert issues == []
    assert len(calls) == 2


def test_http_jira_transport_does_not_retry_client_errors() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(401, json={"errorMessages": ["Unauthorized"]})

    with httpx.Client(base_url=JIRA_SITE, transport=httpx.MockTransport(handler)) as client:
        transport = HttpJiraTransport(JIRA_SITE, "user@example.com", "token", client=client)
        try:
            with pytest.raises(httpx.HTTPStatusError):
                transport.search_issues("ENG", 10)
        finally:
            transport.close()

    assert len(calls) == 1
