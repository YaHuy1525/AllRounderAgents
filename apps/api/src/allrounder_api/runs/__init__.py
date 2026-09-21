"""Parallel-safe run infrastructure.

Everything in this package is namespaced by ``runId``: registry records,
Redis keys, SSE events, receipts, and target locks. The service owns the
API → Mastra start/resume bridge; the router exposes it over HTTP.
"""

from __future__ import annotations

from .api import build_runs_router
from .ceilings import (
    APPLY_SLOT,
    RUN_SLOT,
    ConcurrencyCeiling,
    MemoryConcurrencyCeiling,
    RedisConcurrencyCeiling,
)
from .definitions import (
    ACCESSIBILITY_WORKFLOW,
    DEPENDENCIES_WORKFLOW,
    FEATURES_WORKFLOW,
    HR_HELP_WORKFLOW,
    ISSUES_WORKFLOW,
    LEAVE_WORKFLOW,
    OFFBOARDING_WORKFLOW,
    ONBOARDING_WORKFLOW,
    REVIEW_WORKFLOW,
    SCREENING_WORKFLOW,
    SECURITY_WORKFLOW,
    VENDORS_WORKFLOW,
    WORKFLOW_DEFINITIONS,
)
from .events import InMemoryRunEventBus, RedisRunEventBus, RunEventBus
from .factory import build_memory_run_service, build_redis_run_service
from .locks import LockInfo, MemoryTargetLockStore, RedisTargetLockStore, TargetLockStore
from .mastra_client import (
    HttpMastraRunClient,
    MastraClientError,
    MastraRunClient,
    ScriptedMastraRunClient,
    action_hash,
)
from .models import (
    ACTION_BAR_ACTIONS,
    DECISION_ACTIONS,
    MastraOutcome,
    RunStep,
    StepDefinition,
    WorkflowDefinition,
    WorkflowRun,
)
from .receipts import MemoryRunReceiptStore, RedisRunReceiptStore, RunReceiptStore
from .registry import InMemoryRunRegistry, RedisRunRegistry, RunRegistry
from .service import (
    DecisionResult,
    RunConflictError,
    RunMetrics,
    RunService,
    RunServiceConfig,
    UnknownWorkflowError,
)

__all__ = [
    "ACCESSIBILITY_WORKFLOW",
    "ACTION_BAR_ACTIONS",
    "APPLY_SLOT",
    "DECISION_ACTIONS",
    "DEPENDENCIES_WORKFLOW",
    "FEATURES_WORKFLOW",
    "HR_HELP_WORKFLOW",
    "ISSUES_WORKFLOW",
    "LEAVE_WORKFLOW",
    "OFFBOARDING_WORKFLOW",
    "ONBOARDING_WORKFLOW",
    "REVIEW_WORKFLOW",
    "RUN_SLOT",
    "SCREENING_WORKFLOW",
    "SECURITY_WORKFLOW",
    "VENDORS_WORKFLOW",
    "WORKFLOW_DEFINITIONS",
    "ConcurrencyCeiling",
    "DecisionResult",
    "HttpMastraRunClient",
    "InMemoryRunEventBus",
    "InMemoryRunRegistry",
    "LockInfo",
    "MastraClientError",
    "MastraOutcome",
    "MastraRunClient",
    "MemoryConcurrencyCeiling",
    "MemoryRunReceiptStore",
    "MemoryTargetLockStore",
    "RedisConcurrencyCeiling",
    "RedisRunEventBus",
    "RedisRunReceiptStore",
    "RedisRunRegistry",
    "RedisTargetLockStore",
    "RunConflictError",
    "RunEventBus",
    "RunMetrics",
    "RunReceiptStore",
    "RunRegistry",
    "RunService",
    "RunServiceConfig",
    "RunStep",
    "ScriptedMastraRunClient",
    "StepDefinition",
    "TargetLockStore",
    "UnknownWorkflowError",
    "WorkflowDefinition",
    "WorkflowRun",
    "action_hash",
    "build_memory_run_service",
    "build_redis_run_service",
    "build_runs_router",
]
