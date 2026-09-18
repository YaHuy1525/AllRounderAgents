"""API → Mastra bridge.

The runs service is the only component that talks to the Mastra server. The
HTTP implementation mirrors the server's ``start-async`` / ``resume-async``
workflow routes (same shape the e2e script uses); ``ScriptedMastraRunClient``
is a deterministic in-process stand-in used by tests and offline demos, with
the exact same decision/artifact/effect semantics as the real flows.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable
from typing import Protocol

import httpx

from .models import MastraOutcome

ArtifactBuilder = Callable[
    [str, str, dict[str, object], str | None], Awaitable[dict[str, object]]
]
"""``(workflow, step_id, run_input, guidance) -> artifact``."""


class MastraRunClient(Protocol):
    async def start(
        self, *, workflow: str, run_id: str, input_data: dict[str, object]
    ) -> MastraOutcome: ...

    async def resume(
        self,
        *,
        workflow: str,
        run_id: str,
        step_id: str,
        resume_data: dict[str, object],
    ) -> MastraOutcome: ...


class MastraClientError(RuntimeError):
    pass


class HttpMastraRunClient:
    """Talks to the Mastra server over its workflow HTTP API."""

    def __init__(
        self,
        base_url: str,
        timeout_seconds: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._transport = transport

    async def start(
        self, *, workflow: str, run_id: str, input_data: dict[str, object]
    ) -> MastraOutcome:
        return await self._post(
            f"/api/workflows/{workflow}/start-async",
            run_id,
            {"inputData": input_data},
        )

    async def resume(
        self,
        *,
        workflow: str,
        run_id: str,
        step_id: str,
        resume_data: dict[str, object],
    ) -> MastraOutcome:
        return await self._post(
            f"/api/workflows/{workflow}/resume-async",
            run_id,
            {"runId": run_id, "resumeData": resume_data},
        )

    async def _post(
        self, path: str, run_id: str, body: dict[str, object]
    ) -> MastraOutcome:
        url = f"{self._base_url}{path}"
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, transport=self._transport
            ) as client:
                response = await client.post(url, params={"runId": run_id}, json=body)
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as error:
            # Workflow routes answer 400/500 with a JSON body naming the
            # offending field; keep it in the run error so failures point at
            # the cause instead of a bare path.
            detail = _error_detail(error.response)
            raise MastraClientError(
                f"Mastra request failed: {path} "
                f"(HTTP {error.response.status_code}: {detail})"
            ) from error
        except (httpx.HTTPError, json.JSONDecodeError) as error:
            raise MastraClientError(
                f"Mastra request failed: {path} ({type(error).__name__}: {error})"
            ) from error
        if not isinstance(payload, dict):
            raise MastraClientError("Mastra returned an invalid response")
        return _normalize(payload)


def _error_detail(response: httpx.Response) -> str:
    """Reason text from a failed route response (JSON ``error`` first)."""
    try:
        payload = response.json()
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict) and payload.get("error") is not None:
        return str(payload["error"])[:500]
    text = response.text.strip()
    return text[:500] if text else "no response body"


def _error_text(error: object) -> str:
    """Human reason for a failed flow run (Mastra serialises error objects)."""
    if isinstance(error, dict):
        message = error.get("message")
        name = error.get("name")
        if message is not None:
            reason = str(message)
            return f"{name}: {reason}" if isinstance(name, str) and name else reason
    return str(error) if error is not None else "Mastra workflow failed"


def _normalize(payload: dict[str, object]) -> MastraOutcome:
    status = payload.get("status")
    effects = _effects_of(payload)
    if status in ("suspended", "waiting"):
        step_id, artifact, target = _suspend_details(payload.get("suspendPayload"))
        return MastraOutcome(
            status="suspended",
            step_id=step_id,
            artifact=artifact,
            target=target,
            effects=effects,
        )
    if status in ("success", "completed"):
        result = payload.get("result")
        return MastraOutcome(
            status="completed",
            effects=effects,
            output=result if isinstance(result, dict) else None,
        )
    if status == "failed":
        return MastraOutcome(
            status="failed",
            effects=effects,
            error=_error_text(payload.get("error")),
        )
    raise MastraClientError(f"Unexpected Mastra status: {status!r}")


def _suspend_details(
    suspend_payload: object,
) -> tuple[str | None, dict[str, object] | None, str | None]:
    if not isinstance(suspend_payload, dict) or not suspend_payload:
        return None, None, None
    step_key, raw = next(iter(suspend_payload.items()))
    step_id = str(step_key).lstrip(".")
    if not isinstance(raw, dict):
        return step_id, None, None
    artifact = raw.get("artifact")
    target = raw.get("target")
    return (
        step_id,
        artifact if isinstance(artifact, dict) else None,
        str(target) if target is not None else None,
    )


def _effects_of(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    raw = payload.get("effects")
    if not isinstance(raw, dict):
        result = payload.get("result")
        raw = result.get("effects") if isinstance(result, dict) else None
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in raw.items() if isinstance(value, dict)}


class ScriptedMastraRunClient:
    """Deterministic stand-in for the Mastra server.

    Applies the same decision semantics the real flows implement: a pass walks
    the workflow's steps in order, fast-forwards steps that carry a proceed or
    edit decision (reusing the reviewed artifact, never recomputing), executes
    side effects once per ``actionHash``, and suspends at the first step
    without a decision (computing its artifact first).
    """

    def __init__(
        self,
        workflows: dict[str, tuple[str, ...]],
        *,
        builder: ArtifactBuilder | None = None,
        side_effecting: frozenset[str] = frozenset(),
        fail_steps: frozenset[str] = frozenset(),
    ) -> None:
        self._workflows = workflows
        self._builder = builder or _default_builder
        self._side_effecting = side_effecting
        self._fail_steps = fail_steps
        self._calls: list[tuple[str, str, str]] = []
        self._inputs: list[dict[str, object]] = []
        self._effect_executions: list[str] = []

    @property
    def calls(self) -> list[tuple[str, str, str]]:
        """``(kind, workflow, run_id)`` trail for assertions."""
        return list(self._calls)

    @property
    def inputs(self) -> list[dict[str, object]]:
        """Envelope of every pass (for decision/artifact/effect assertions)."""
        return list(self._inputs)

    @property
    def effect_executions(self) -> list[str]:
        """Step ids whose side effect actually executed (replays excluded)."""
        return list(self._effect_executions)

    async def start(
        self, *, workflow: str, run_id: str, input_data: dict[str, object]
    ) -> MastraOutcome:
        self._calls.append(("start", workflow, run_id))
        self._inputs.append(input_data)
        return await self._walk(workflow, input_data)

    async def resume(
        self,
        *,
        workflow: str,
        run_id: str,
        step_id: str,
        resume_data: dict[str, object],
    ) -> MastraOutcome:
        self._calls.append(("resume", workflow, run_id))
        self._inputs.append(resume_data)
        decision = resume_data.get("decision")
        decisions = _mapping(resume_data.get("decisions"))
        if isinstance(decision, dict):
            decisions[step_id] = decision
        merged = {
            "runId": resume_data.get("runId", run_id),
            "input": resume_data.get("input", {}),
            "decisions": decisions,
            "artifacts": resume_data.get("artifacts", {}),
            "effects": resume_data.get("effects", {}),
        }
        return await self._walk(workflow, merged)

    async def _walk(
        self, workflow: str, input_data: dict[str, object]
    ) -> MastraOutcome:
        steps = self._workflows.get(workflow)
        if steps is None:
            return MastraOutcome(status="failed", error=f"Unknown workflow {workflow!r}")
        decisions = _mapping(input_data.get("decisions"))
        artifacts = _mapping(input_data.get("artifacts"))
        effects = _mapping(input_data.get("effects"))
        run_input = input_data.get("input")
        run_input = run_input if isinstance(run_input, dict) else {}
        for step_id in steps:
            raw_decision = decisions.get(step_id)
            decision: dict[str, object] = raw_decision if isinstance(raw_decision, dict) else {}
            action = decision.get("action")
            if action in ("proceed", "edit"):
                if action == "edit":
                    edits = _mapping(decision.get("edits"))
                    cached = _mapping(artifacts.get(step_id))
                    artifacts[step_id] = {**cached, **edits}
                if step_id in self._fail_steps:
                    return MastraOutcome(
                        status="failed", error=f"Step {step_id} failed"
                    )
                if step_id in self._side_effecting:
                    stored_hash = decision.get("actionHash")
                    action_hash = (
                        str(stored_hash) if stored_hash else _hash(artifacts.get(step_id))
                    )
                    raw_existing = effects.get(step_id)
                    existing_hash = (
                        raw_existing.get("actionHash")
                        if isinstance(raw_existing, dict)
                        else None
                    )
                    if existing_hash != action_hash:
                        self._effect_executions.append(step_id)
                        effects[step_id] = {
                            "actionHash": action_hash,
                            "receipt": {"id": f"effect-{step_id}-{action_hash[:8]}"},
                        }
                continue
            guidance = decision.get("guidance") if action == "regenerate" else None
            artifact = await self._builder(
                workflow, step_id, run_input, str(guidance) if guidance else None
            )
            target = artifact.get("target")
            return MastraOutcome(
                status="suspended",
                step_id=step_id,
                artifact=artifact,
                target=str(target) if target is not None else None,
                effects={
                    str(key): value
                    for key, value in effects.items()
                    if isinstance(value, dict)
                },
            )
        return MastraOutcome(
            status="completed",
            effects={str(key): value for key, value in effects.items() if isinstance(value, dict)},
            output={"effects": effects},
        )


def action_hash(action: dict[str, object]) -> str:
    encoded = json.dumps(action, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode()).hexdigest()


async def _default_builder(
    workflow: str, step_id: str, run_input: dict[str, object], guidance: str | None
) -> dict[str, object]:
    await asyncio.sleep(0)
    return {"workflow": workflow, "stepId": step_id, "guidance": guidance}


def _mapping(value: object) -> dict[str, dict[str, object]]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items() if isinstance(item, dict)}


def _hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


__all__ = [
    "ArtifactBuilder",
    "HttpMastraRunClient",
    "MastraClientError",
    "MastraRunClient",
    "ScriptedMastraRunClient",
    "action_hash",
]
