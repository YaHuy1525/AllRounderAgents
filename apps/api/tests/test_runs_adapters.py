"""Adapter-level tests for the runs package: Redis implementations + Mastra HTTP.

The Redis adapters take a redis client and call it synchronously (records,
ceilings, locks, receipts) or asynchronously (the event bus), so a small
in-process fake with the used command subset exercises every code path: key
namespacing, NX set semantics, Lua script dispatch, pipeline usage, and
pub/sub. The HTTP client is tested against ``httpx.MockTransport``.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from allrounder_api.app import create_app
from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import (
    HttpMastraRunClient,
    InMemoryRunEventBus,
    MastraClientError,
    MemoryRunReceiptStore,
    MemoryTargetLockStore,
    RedisConcurrencyCeiling,
    RedisRunEventBus,
    RedisRunReceiptStore,
    RedisRunRegistry,
    RedisTargetLockStore,
    ScriptedMastraRunClient,
    build_memory_run_service,
    build_redis_run_service,
)
from allrounder_api.runs.events import _load_event  # noqa: PLC2701 - unit coverage
from allrounder_api.runs.mastra_client import _hash, _normalize  # noqa: PLC2701
from allrounder_api.runs.models import RunStep, WorkflowRun
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

SECRET = b"run-receipt-secret-for-tests-0123456789"
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))


# ------------------------------------------------------------- sync fake redis


class FakePipeline:
    def __init__(self, client: FakeRedis) -> None:
        self._client = client

    def __enter__(self) -> FakePipeline:
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def set(self, key: str, value: object, **kwargs: object) -> None:
        self._client.set(key, value, **kwargs)

    def lrem(self, key: str, count: int, value: str) -> None:
        self._client.lrem(key, count, value)

    def lpush(self, key: str, value: str) -> None:
        self._client.lpush(key, value)

    def ltrim(self, key: str, start: int, end: int) -> None:
        self._client.ltrim(key, start, end)

    def expire(self, key: str, ttl: int) -> None:
        self._client.expire(key, ttl)

    def sadd(self, key: str, value: str) -> None:
        self._client.sadd(key, value)

    def srem(self, key: str, value: str) -> None:
        self._client.srem(key, value)

    def execute(self) -> list[object]:
        return [True]


class FakeRedis:
    """Sync redis subset: strings, lists, sets, sorted sets, pipeline, scripts."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.lists: dict[str, list[str]] = {}
        self.sets: dict[str, set[str]] = {}
        self.zsets: dict[str, dict[str, float]] = {}

    # strings ---------------------------------------------------------------
    def get(self, key: str) -> str | None:
        return self.store.get(key)

    def set(self, key: str, value: object, nx: bool = False, ex: int | None = None) -> bool | None:
        if nx and key in self.store:
            return None
        self.store[key] = str(value)
        return True

    def expire(self, key: str, ttl: int) -> bool:
        return key in self.store

    # lists -----------------------------------------------------------------
    def lpush(self, key: str, value: str) -> int:
        self.lists.setdefault(key, []).insert(0, value)
        return len(self.lists[key])

    def lrem(self, key: str, count: int, value: str) -> int:
        items = self.lists.get(key, [])
        removed = items.count(value)
        self.lists[key] = [item for item in items if item != value]
        return removed

    def ltrim(self, key: str, start: int, end: int) -> bool:
        items = self.lists.get(key, [])
        self.lists[key] = items[start:] if end == -1 else items[start : end + 1]
        return True

    def lrange(self, key: str, start: int, end: int) -> list[str]:
        items = self.lists.get(key, [])
        return list(items[start:]) if end == -1 else list(items[start : end + 1])

    # sets ------------------------------------------------------------------
    def sadd(self, key: str, value: str) -> int:
        before = len(self.sets.setdefault(key, set()))
        self.sets[key].add(value)
        return len(self.sets[key]) - before

    def srem(self, key: str, value: str) -> int:
        if value in self.sets.get(key, set()):
            self.sets[key].discard(value)
            return 1
        return 0

    def smembers(self, key: str) -> set[str]:
        return set(self.sets.get(key, set()))

    # sorted sets -----------------------------------------------------------
    def _ordered(self, key: str) -> list[str]:
        items = self.zsets.get(key, {})
        return [name for name, _ in sorted(items.items(), key=lambda item: (item[1], item[0]))]

    def zrank(self, key: str, value: str) -> int | None:
        ordered = self._ordered(key)
        return ordered.index(value) if value in ordered else None

    def zcard(self, key: str) -> int:
        return len(self.zsets.get(key, {}))

    # pipelines + scripts ---------------------------------------------------
    def pipeline(self, transaction: bool = True) -> FakePipeline:
        return FakePipeline(self)

    def register_script(self, script: str) -> Callable[..., object]:
        def runner(*, keys: list[str], args: list[object]) -> object:
            if "ZRANK" in script:
                return self._acquire(keys, args)
            if "ZRANGE" in script:
                return self._release(keys, args)
            if "EXPIRE" in script:  # lock compare-expire
                key, owner = keys[0], str(args[0])
                return 1 if self.store.get(key) == owner else 0
            if "DEL" in script:  # lock compare-delete
                key, owner = keys[0], str(args[0])
                if self.store.get(key) == owner:
                    del self.store[key]
                    return 1
                return 0
            raise AssertionError("unrecognized script")

        return runner

    def _acquire(self, keys: list[str], args: list[object]) -> int:
        slot_key, queue_key = keys
        limit, run_id, now = int(args[0]), str(args[1]), float(args[2])
        slot = self.zsets.setdefault(slot_key, {})
        queue = self.zsets.setdefault(queue_key, {})
        if run_id in slot:
            return 0
        if len(slot) < limit:
            slot[run_id] = now
            queue.pop(run_id, None)
            return 0
        queue[run_id] = now
        return self._ordered(queue_key).index(run_id) + 1

    def _release(self, keys: list[str], args: list[object]) -> str:
        slot_key, queue_key = keys
        run_id, now = str(args[0]), float(args[1])
        slot = self.zsets.get(slot_key, {})
        queue = self.zsets.get(queue_key, {})
        slot.pop(run_id, None)
        if queue.pop(run_id, None) is not None:
            return ""
        ordered = self._ordered(queue_key)
        if not ordered:
            return ""
        promoted = ordered[0]
        queue.pop(promoted, None)
        slot[promoted] = now
        return promoted


# ------------------------------------------------------------ async fake redis


class AsyncFakePipe:
    def __init__(self, client: AsyncFakeRedis) -> None:
        self._client = client

    async def __aenter__(self) -> AsyncFakePipe:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None

    def lpush(self, key: str, value: str) -> None:
        self._client.lists.setdefault(key, []).insert(0, value)

    def ltrim(self, key: str, start: int, end: int) -> None:
        items = self._client.lists.get(key, [])
        self._client.lists[key] = items[start:] if end == -1 else items[start : end + 1]

    def expire(self, key: str, ttl: int) -> None:
        return None

    def publish(self, channel: str, payload: str) -> None:
        self._client.channels.setdefault(channel, []).append(payload)

    async def execute(self) -> list[object]:
        return [True]


class FakePubSub:
    def __init__(self, client: AsyncFakeRedis) -> None:
        self._client = client
        self._subscribed: list[str] = []

    async def subscribe(self, channel: str) -> None:
        self._subscribed.append(channel)

    async def unsubscribe(self, channel: str) -> None:
        self._subscribed.remove(channel)

    async def close(self) -> None:
        return None

    async def get_message(
        self,
        ignore_subscribe_messages: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109 - redis-py pubsub signature
    ) -> dict[str, Any] | None:
        for channel in self._subscribed:
            queued = self._client.channels.get(channel, [])
            if queued:
                return {"type": "message", "channel": channel, "data": queued.pop(0).encode()}
        return None


class AsyncFakeRedis:
    """Async redis subset used by the event bus."""

    def __init__(self) -> None:
        self.store: dict[str, int] = {}
        self.lists: dict[str, list[str]] = {}
        self.channels: dict[str, list[str]] = {}

    async def incr(self, key: str) -> int:
        value = self.store.get(key, 0) + 1
        self.store[key] = value
        return value

    async def expire(self, key: str, ttl: int) -> bool:
        return True

    async def lrange(self, key: str, start: int, end: int) -> list[str]:
        items = self.lists.get(key, [])
        return list(items[start:]) if end == -1 else list(items[start : end + 1])

    def pipeline(self, transaction: bool = False) -> AsyncFakePipe:
        return AsyncFakePipe(self)

    def pubsub(self) -> FakePubSub:
        return FakePubSub(self)


def make_run(run_id: str = "run-1", *, status: str = "awaiting_human") -> WorkflowRun:
    moment = datetime(2026, 1, 1, tzinfo=UTC)
    step = RunStep(step_id="select-pr", index=0, title="Select PR")
    if status == "awaiting_human":
        step.state = "awaiting_human"
    return WorkflowRun(
        run_id=run_id,
        tenant_id="acme",
        workflow="review",
        ticket_key="ABC-1",
        case_id="case-1",
        input={"repository": "acme/app"},
        steps=[step],
        status=status,
        started_at=moment,
        heartbeat_at=moment,
    )


# --------------------------------------------------------- redis run registry


async def test_redis_registry_round_trip_and_active_set() -> None:
    registry = RedisRunRegistry(FakeRedis(), ttl_seconds=600)
    first = make_run("run-1")
    second = make_run("run-2", status="queued")
    await registry.save(first)
    await registry.save(second)

    stored = await registry.get("run-1", "acme")
    assert stored.run_id == "run-1"
    assert stored.current_step().step_id == "select-pr"  # type: ignore[union-attr]
    with pytest.raises(KeyError):
        await registry.get("run-1", "other-tenant")
    with pytest.raises(KeyError):
        await registry.get("missing", "acme")
    with pytest.raises(KeyError):
        await registry.get_internal("missing")

    history = await registry.list_for_ticket("ABC-1", "acme")
    assert [item.run_id for item in history] == ["run-2", "run-1"]
    active = await registry.list_active()
    assert {item.run_id for item in active} == {"run-1", "run-2"}

    first.status = "cancelled"
    await registry.save(first)
    remaining = await registry.list_active()
    assert [item.run_id for item in remaining] == ["run-2"]


# --------------------------------------------------------------- redis ceilings


async def test_redis_ceiling_queue_and_promotion() -> None:
    client = FakeRedis()
    ceilings = RedisConcurrencyCeiling(client, {"run": 1})
    assert await ceilings.acquire("run-1", "run") is None
    assert await ceilings.acquire("run-1", "run") is None  # already holds it
    assert await ceilings.acquire("run-2", "run") == 1
    assert await ceilings.acquire("run-3", "run") == 2
    assert await ceilings.position("run-2", "run") == 1
    assert await ceilings.active_count("run") == 1

    assert await ceilings.release("run-1", "run") == "run-2"
    assert await ceilings.position("run-3", "run") == 1
    assert await ceilings.release("run-2", "run") == "run-3"
    assert await ceilings.release("run-3", "run") is None
    assert await ceilings.position("run-3", "run") is None
    assert await ceilings.active_count("run") == 0


async def test_redis_ceiling_release_of_queued_run_returns_none() -> None:
    ceilings = RedisConcurrencyCeiling(FakeRedis(), {"run": 1})
    await ceilings.acquire("run-1", "run")
    await ceilings.acquire("run-2", "run")
    assert await ceilings.release("run-2", "run") is None  # was queued, not active
    assert await ceilings.position("run-2", "run") is None
    assert await ceilings.active_count("run") == 1


# ------------------------------------------------------------------ redis locks


async def test_redis_target_lock_store_flow() -> None:
    store = RedisTargetLockStore(FakeRedis())
    granted = await store.acquire("manifest:pkg", "run-1", ttl_seconds=30)
    assert granted is not None and granted.owner_run_id == "run-1"
    assert await store.acquire("manifest:pkg", "run-2", ttl_seconds=30) is None
    again = await store.acquire("manifest:pkg", "run-1", ttl_seconds=30)
    assert again is not None and again.owner_run_id == "run-1"

    owner = await store.inspect("manifest:pkg")
    assert owner is not None and owner.owner_run_id == "run-1"
    assert await store.refresh("manifest:pkg", "run-2", 30) is False
    assert await store.refresh("manifest:pkg", "run-1", 30) is True

    await store.release("manifest:pkg", "run-2")  # not the owner: no-op
    assert await store.inspect("manifest:pkg") is not None
    await store.release("manifest:pkg", "run-1")
    assert await store.inspect("manifest:pkg") is None


async def test_memory_lock_store_release_and_refresh_branches() -> None:
    clock = [0.0]
    store = MemoryTargetLockStore(clock=lambda: clock[0])
    await store.release("missing", "run-1")  # no entry: no-op
    await store.acquire("t", "run-1", ttl_seconds=10)
    assert await store.refresh("t", "run-1", ttl_seconds=10) is True
    await store.release("t", "run-2")  # wrong owner: keeps the lock
    assert await store.inspect("t") is not None
    await store.release("t", "run-1")
    assert await store.inspect("t") is None
    assert await store.refresh("t", "run-1", ttl_seconds=10) is False


# --------------------------------------------------------------- redis receipts


async def test_redis_receipt_store_remember_and_replay() -> None:
    client = FakeRedis()
    store = RedisRunReceiptStore(client, ttl_seconds=60)
    record = {"receipt": "r1", "action": "proceed"}
    assert await store.remember("run-1", "select-pr", "hash-1", record) == record
    original = await store.remember("run-1", "select-pr", "hash-1", {"receipt": "other"})
    assert original == record  # NX conflict returns the stored original
    assert await store.replay("run-1", "select-pr", "hash-1") == record
    assert await store.replay("run-1", "select-pr", "hash-2") is None

    client.store["allrounder:runs:run-1:step:select-pr:hash-3"] = "123"
    assert await store.remember("run-1", "select-pr", "hash-3", {"x": 1}) == {"x": 1}
    assert await store.replay("run-1", "select-pr", "hash-3") is None


async def test_memory_receipt_store_ttl_expiry() -> None:
    clock = [0.0]
    store = MemoryRunReceiptStore(clock=lambda: clock[0])
    await store.remember("r", "s", "h", {"a": 1})
    assert await store.remember("r", "s", "h", {"a": 2}) == {"a": 1}
    assert await store.replay("r", "s", "h") == {"a": 1}
    clock[0] = 90_000.0
    assert await store.replay("r", "s", "h") is None
    assert await store.remember("r", "s", "h", {"a": 3}) == {"a": 3}


# ------------------------------------------------------------------ event bus


async def test_redis_event_bus_history_and_live_subscribe() -> None:
    client = AsyncFakeRedis()
    bus = RedisRunEventBus(client, ttl_seconds=60, history_limit=10)
    await bus.publish("run-1", {"type": "run.created"})
    await bus.publish("run-1", {"type": "run.suspended"})
    history = await bus.history("run-1")
    assert [event["type"] for event in history] == ["run.created", "run.suspended"]
    assert [event["sequence"] for event in history] == [1, 2]
    assert history[0]["runId"] == "run-1"

    stream = bus.subscribe("run-1")
    try:
        first = await anext(stream)
        assert first["type"] == "run.created"
        second = await anext(stream)
        assert second["type"] == "run.suspended"
        await bus.publish("run-1", {"type": "run.decision"})
        third = await anext(stream)
        assert third["type"] == "run.decision"
        assert third["sequence"] == 3
        await bus.close("run-1")  # publishes run.closed onto the channel
        fourth = await anext(stream)
        assert fourth["type"] == "run.closed"
    finally:
        await stream.aclose()


async def test_memory_event_bus_close_and_clear() -> None:
    bus = InMemoryRunEventBus()
    await bus.publish("run-1", {"type": "run.created"})
    await bus.close("run-1")
    assert not bus._subscribers  # noqa: SLF001 - subscriber registry drained
    bus.clear("run-1")
    assert await bus.history("run-1") == []


def test_event_loader_decodes_payloads() -> None:
    assert _load_event(b'{"type": "x"}') == {"type": "x"}
    assert _load_event(b"not json") is None
    assert _load_event(b"[1, 2]") is None
    assert _load_event(None) is None


# ----------------------------------------------------------- mastra http client


def http_client(handler: Callable[[httpx.Request], httpx.Response]) -> HttpMastraRunClient:
    return HttpMastraRunClient(
        "http://mastra.test", timeout_seconds=5, transport=httpx.MockTransport(handler)
    )


async def test_http_mastra_client_start_normalizes_suspend() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/workflows/reviewFlow/start-async"
        assert request.url.params["runId"] == "run-1:a0"
        assert json.loads(request.content) == {"inputData": {"runId": "run-1"}}
        return httpx.Response(
            200,
            json={
                "status": "suspended",
                "suspendPayload": {
                    ".select-pr": {"artifact": {"pr": 7}, "target": "pr:acme/app#7"}
                },
                "effects": {"complete": {"actionHash": "abc"}},
            },
        )

    outcome = await http_client(handler).start(
        workflow="reviewFlow", run_id="run-1:a0", input_data={"runId": "run-1"}
    )
    assert outcome.status == "suspended"
    assert outcome.step_id == "select-pr"
    assert outcome.artifact == {"pr": 7}
    assert outcome.target == "pr:acme/app#7"
    assert outcome.effects == {"complete": {"actionHash": "abc"}}


async def test_http_mastra_client_resume_normalizes_completion() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/workflows/reviewFlow/resume-async"
        body = json.loads(request.content)
        assert body["runId"] == "run-1:a0"
        assert body["resumeData"]["decision"] == {"action": "proceed"}
        return httpx.Response(
            200,
            json={
                "status": "success",
                "result": {"effects": {"complete": {"actionHash": "xyz"}}},
            },
        )

    outcome = await http_client(handler).resume(
        workflow="reviewFlow",
        run_id="run-1:a0",
        step_id="complete",
        resume_data={"decision": {"action": "proceed"}},
    )
    assert outcome.status == "completed"
    assert outcome.output == {"effects": {"complete": {"actionHash": "xyz"}}}
    assert outcome.effects == {"complete": {"actionHash": "xyz"}}


async def test_http_mastra_client_error_paths() -> None:
    def server_error(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    with pytest.raises(MastraClientError):
        await http_client(server_error).start(workflow="wf", run_id="r", input_data={})

    def bad_json(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not-json")

    with pytest.raises(MastraClientError):
        await http_client(bad_json).start(workflow="wf", run_id="r", input_data={})

    def wrong_shape(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2])

    with pytest.raises(MastraClientError):
        await http_client(wrong_shape).start(workflow="wf", run_id="r", input_data={})

    def unknown_status(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "weird"})

    with pytest.raises(MastraClientError):
        await http_client(unknown_status).start(workflow="wf", run_id="r", input_data={})

    def failed(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "failed"})

    outcome = await http_client(failed).start(workflow="wf", run_id="r", input_data={})
    assert outcome.status == "failed"
    assert outcome.error == "Mastra workflow failed"


def test_normalize_suspend_and_failure_variants() -> None:
    empty = _normalize({"status": "waiting", "suspendPayload": {}})
    assert empty.status == "suspended"
    assert (empty.step_id, empty.artifact, empty.target) == (None, None, None)

    raw_step = _normalize({"status": "suspended", "suspendPayload": {"step-1": "raw"}})
    assert (raw_step.step_id, raw_step.artifact, raw_step.target) == ("step-1", None, None)

    numeric_target = _normalize(
        {"status": "suspended", "suspendPayload": {"x": {"target": 123}}}
    )
    assert numeric_target.target == "123"
    assert numeric_target.artifact is None
    assert numeric_target.effects == {}

    failure = _normalize({"status": "failed", "error": 500})
    assert failure.error == "500"

    void = _normalize({"status": "completed", "result": "nope"})
    assert void.status == "completed"
    assert void.output is None


async def test_scripted_client_unknown_workflow_and_effect_hash() -> None:
    client = ScriptedMastraRunClient({})
    unknown = await client.start(workflow="nope", run_id="r", input_data={})
    assert unknown.status == "failed"
    assert unknown.error is not None and "nope" in unknown.error

    effects_client = ScriptedMastraRunClient(
        {"wf": ("apply",)}, side_effecting=frozenset({"apply"})
    )
    outcome = await effects_client.resume(
        workflow="wf",
        run_id="r",
        step_id="apply",
        resume_data={"decision": {"action": "proceed"}},
    )
    assert outcome.status == "completed"
    assert effects_client.effect_executions == ["apply"]
    effect = outcome.effects["apply"]
    assert effect["actionHash"] == _hash(None)


# ----------------------------------------------- live SSE stream over the API


def test_run_events_stream_follows_live_run_to_terminal() -> None:
    service = build_memory_run_service(
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        mastra=ScriptedMastraRunClient(
            {"reviewFlow": ("select-pr", "review-options", "ai-review", "complete")}
        ),
    )
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": PRINCIPAL}),
        runs_service=service,
    )
    headers = {"Authorization": "Bearer tok"}
    collected: list[list[dict[str, object]]] = []
    errors: list[BaseException] = []

    # One shared TestClient/portal: the streaming request and the cancel run in
    # the same event loop, so the live event delivery is loop-safe.
    with TestClient(app) as client:
        created = client.post(
            "/runs",
            json={
                "workflow": "review",
                "ticketKey": "ABC-4",
                "caseId": "case-1",
                "input": {"repository": "acme/app"},
            },
            headers=headers,
        )
        run_id = created.json()["runId"]

        def consume() -> None:
            try:
                with client.stream(
                    "GET", f"/runs/{run_id}/events", headers=headers
                ) as response:
                    collected.append(
                        [
                            json.loads(line[6:])
                            for line in response.iter_lines()
                            if line.startswith("data: ")
                        ]
                    )
            except BaseException as error:  # pragma: no cover - thread boundary
                errors.append(error)

        thread = threading.Thread(target=consume)
        thread.start()
        time.sleep(0.3)  # let the live subscription attach before finishing the run
        cancelled = client.post(
            f"/runs/{run_id}/cancel", json={"reason": "done"}, headers=headers
        )
        assert cancelled.status_code == 200
        thread.join(timeout=10)

    assert not thread.is_alive()
    assert errors == []
    events = collected[0]
    assert events[0]["type"] == "run.created"
    assert events[-1]["type"] == "run.status"
    assert events[-1]["status"] == "cancelled"


# -------------------------------------------------- redis-backed service factory


async def test_build_redis_run_service_drives_a_full_flow_on_fakes() -> None:
    fake = FakeRedis()
    async_fake = AsyncFakeRedis()
    service = build_redis_run_service(
        client=fake,  # type: ignore[arg-type] - command-compatible fake
        events_client=async_fake,  # type: ignore[arg-type]
        signer=ApprovalReceiptSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        mastra=ScriptedMastraRunClient(
            {"reviewFlow": ("select-pr", "review-options", "ai-review", "complete")},
            side_effecting=frozenset({"complete"}),
        ),
    )
    run = await service.start(
        workflow="review",
        ticket_key="ABC-9",
        case_id="case-1",
        run_input={"repository": "acme/app"},
        principal=PRINCIPAL,
    )
    assert run.status == "awaiting_human"
    for step_id in ("select-pr", "review-options", "ai-review", "complete"):
        await service.decide(
            run_id=run.run_id, step_id=step_id, action="proceed", principal=PRINCIPAL
        )
    final = await service.get(run.run_id, PRINCIPAL.tenant_id)
    assert final.status == "completed"
    assert f"allrounder:runs:record:{run.run_id}" in fake.store
    history = await service.history(run.run_id)
    assert history[0]["type"] == "run.created"
    assert history[-1]["type"] == "run.status"
    assert history[-1]["status"] == "completed"
