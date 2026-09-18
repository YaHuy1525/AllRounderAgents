"""Composition helpers for the run service (in-memory + Redis adapters)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from redis import Redis
from redis.asyncio import Redis as AsyncRedis

from ..approvals import ApprovalReceiptSigner
from ..repositories import ApprovalRepository, CaseRepository
from .ceilings import (
    APPLY_SLOT,
    RUN_SLOT,
    MemoryConcurrencyCeiling,
    RedisConcurrencyCeiling,
)
from .definitions import WORKFLOW_DEFINITIONS
from .events import InMemoryRunEventBus, RedisRunEventBus
from .locks import MemoryTargetLockStore, RedisTargetLockStore, TargetLockStore
from .mastra_client import HttpMastraRunClient, MastraRunClient
from .models import WorkflowDefinition
from .receipts import MemoryRunReceiptStore, RedisRunReceiptStore
from .registry import InMemoryRunRegistry, RedisRunRegistry
from .service import RunMetrics, RunService, RunServiceConfig


def build_memory_run_service(
    *,
    signer: ApprovalReceiptSigner,
    approvals: ApprovalRepository,
    cases: CaseRepository | None = None,
    workflows: dict[str, WorkflowDefinition] | None = None,
    mastra: MastraRunClient | None = None,
    mastra_base_url: str = "http://localhost:4111",
    mastra_timeout_seconds: float = 60.0,
    max_concurrent: int = 5,
    max_concurrent_applies: int = 2,
    config: RunServiceConfig | None = None,
    clock: Callable[[], datetime] | None = None,
    locks: TargetLockStore | None = None,
    metrics: RunMetrics | None = None,
) -> RunService:
    """Single-process service with in-memory adapters (dev + tests)."""
    return RunService(
        workflows=workflows or WORKFLOW_DEFINITIONS,
        registry=InMemoryRunRegistry(),
        ceilings=MemoryConcurrencyCeiling(
            {RUN_SLOT: max_concurrent, APPLY_SLOT: max_concurrent_applies}
        ),
        locks=locks or MemoryTargetLockStore(),
        receipts=MemoryRunReceiptStore(),
        events=InMemoryRunEventBus(),
        mastra=mastra or HttpMastraRunClient(mastra_base_url, mastra_timeout_seconds),
        signer=signer,
        approvals=approvals,
        cases=cases,
        config=config,
        clock=clock,
        metrics=metrics,
    )


def build_redis_run_service(
    *,
    client: Redis,
    events_client: AsyncRedis | None = None,
    signer: ApprovalReceiptSigner,
    approvals: ApprovalRepository,
    cases: CaseRepository | None = None,
    workflows: dict[str, WorkflowDefinition] | None = None,
    mastra: MastraRunClient | None = None,
    mastra_base_url: str = "http://localhost:4111",
    mastra_timeout_seconds: float = 60.0,
    max_concurrent: int = 5,
    max_concurrent_applies: int = 2,
    config: RunServiceConfig | None = None,
    clock: Callable[[], datetime] | None = None,
    metrics: RunMetrics | None = None,
    registry_ttl_seconds: int = 604_800,
    receipt_ttl_seconds: int = 86_400,
    event_ttl_seconds: int = 86_400,
) -> RunService:
    """Multi-instance service: run state, ceilings, locks and replay records
    live in Redis so any API process can drive or observe any run; with an
    async client the event bus fans SSE out across instances."""
    return RunService(
        workflows=workflows or WORKFLOW_DEFINITIONS,
        registry=RedisRunRegistry(client, ttl_seconds=registry_ttl_seconds),
        ceilings=RedisConcurrencyCeiling(
            client, {RUN_SLOT: max_concurrent, APPLY_SLOT: max_concurrent_applies}
        ),
        locks=RedisTargetLockStore(client),
        receipts=RedisRunReceiptStore(client, ttl_seconds=receipt_ttl_seconds),
        events=(
            RedisRunEventBus(events_client, ttl_seconds=event_ttl_seconds)
            if events_client is not None
            else InMemoryRunEventBus()
        ),
        mastra=mastra or HttpMastraRunClient(mastra_base_url, mastra_timeout_seconds),
        signer=signer,
        approvals=approvals,
        cases=cases,
        config=config,
        clock=clock,
        metrics=metrics,
    )


__all__ = ["build_memory_run_service", "build_redis_run_service"]
