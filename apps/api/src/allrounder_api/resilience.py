"""Bounded retry with backoff for outbound calls.

Shared by the Jira REST transport, the Rovo MCP transport, and the
OpenAI-compatible model adapter. The default policy retries transport
failures, timeouts, and the transient HTTP statuses (429/500/502/503/504);
other client errors are never retried. ``Retry-After`` responses are honored,
capped at :data:`MAX_RETRY_AFTER_SECONDS`. Delays use full jitter:
``uniform(0, min(max_delay, base_delay * 2 ** (attempt - 1)))``.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable

import httpx

RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
MAX_RETRY_AFTER_SECONDS = 5.0
DEFAULT_ATTEMPTS = 3
DEFAULT_BASE_DELAY = 0.2
DEFAULT_MAX_DELAY = 2.0


def default_should_retry(error: BaseException) -> bool:
    """Retry transport failures and transient HTTP statuses; never other 4xx."""
    if isinstance(error, httpx.TransportError):
        return True
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in RETRYABLE_STATUS_CODES
    return False


def retry_after_seconds(error: BaseException) -> float | None:
    """The capped ``Retry-After`` delay when the error carries one."""
    if not isinstance(error, httpx.HTTPStatusError):
        return None
    raw = error.response.headers.get("retry-after")
    if raw is None:
        return None
    try:
        value = float(raw.strip())
    except ValueError:
        return None
    if value < 0:
        return None
    return min(value, MAX_RETRY_AFTER_SECONDS)


def _delay_for(
    attempt: int, base_delay: float, max_delay: float, retry_after: float | None
) -> float:
    if retry_after is not None:
        return retry_after
    ceiling = min(max_delay, base_delay * (2 ** (attempt - 1)))
    return random.uniform(0, ceiling)


async def retry_async[T](
    op: Callable[[], Awaitable[T]],
    *,
    attempts: int = DEFAULT_ATTEMPTS,
    base_delay: float = DEFAULT_BASE_DELAY,
    max_delay: float = DEFAULT_MAX_DELAY,
    should_retry: Callable[[BaseException], bool] = default_should_retry,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> T:
    """Run ``op`` with bounded retries; ``op`` must be safe to invoke again."""
    if attempts < 1:
        raise ValueError("attempts must be positive")
    pause = sleep if sleep is not None else asyncio.sleep
    for attempt in range(1, attempts + 1):
        try:
            return await op()
        except Exception as error:
            if attempt >= attempts or not should_retry(error):
                raise
            await pause(
                _delay_for(attempt, base_delay, max_delay, retry_after_seconds(error))
            )
    raise AssertionError("retry loop exited without a result")


def retry_sync[T](
    op: Callable[[], T],
    *,
    attempts: int = DEFAULT_ATTEMPTS,
    base_delay: float = DEFAULT_BASE_DELAY,
    max_delay: float = DEFAULT_MAX_DELAY,
    should_retry: Callable[[BaseException], bool] = default_should_retry,
    sleep: Callable[[float], None] | None = None,
) -> T:
    """Synchronous twin of :func:`retry_async` for ``httpx.Client`` call sites."""
    if attempts < 1:
        raise ValueError("attempts must be positive")
    pause = sleep if sleep is not None else time.sleep
    for attempt in range(1, attempts + 1):
        try:
            return op()
        except Exception as error:
            if attempt >= attempts or not should_retry(error):
                raise
            pause(_delay_for(attempt, base_delay, max_delay, retry_after_seconds(error)))
    raise AssertionError("retry loop exited without a result")
