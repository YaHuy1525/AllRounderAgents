# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""Read-only command-bar search across runs, approvals, and knowledge.

No step is executed, no decision is recorded, and raw receipt tokens never leave the
server: results carry ``run:step`` deep links so acting on a hit goes through the
existing receipt-gated decision endpoint. Intent resolution is deterministic rather
than an LLM, and structured hits and knowledge passages are returned in separate
arrays so their scores never mix.
"""

from __future__ import annotations

import contextlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from structlog.stdlib import BoundLogger

from .auth import AuthenticationError, BearerVerifier, Principal
from .logging import get_logger
from .repositories import ApprovalRepository, CaseRepository
from .runs import WORKFLOW_DEFINITIONS
from .runs.models import TERMINAL_RUN_STATUSES, WorkflowRun
from .runs.service import RunService

if TYPE_CHECKING:
    from .knowledge_api import KnowledgeRetriever

_READ_ROLES = ("viewer", "approver", "agent", "admin")

# Phrases that pin a list scope; checked before the navigate verbs so
# "show me blocked tickets" lists while "show me ABC-1" navigates.
_AWAITING_PHRASES = (
    "wait on me",
    "waiting on me",
    "waiting for me",
    "awaiting me",
    "awaiting my",
    "await me",
    "wait on my",
    "my queue",
)
_BLOCKED_PHRASES = ("blocked", "blocking")
_OVERDUE_PHRASES = ("overdue", "stalled", "stuck", "breached")
_LIST_PHRASES = (
    "which tickets",
    "what tickets",
    "list tickets",
    "all tickets",
    "open tickets",
    "which runs",
    "what runs",
    "list runs",
    "all runs",
    "active runs",
    "inbox",
)
_DO_PREFIXES = (
    "open ",
    "go to ",
    "goto ",
    "jump to ",
    "take me to ",
    "navigate to ",
    "show me ",
)

# Query filler that carries no matching signal once the intent is known.
_STOPWORDS = frozenset(
    {
        "the",
        "a",
        "an",
        "is",
        "are",
        "was",
        "were",
        "do",
        "does",
        "did",
        "my",
        "me",
        "i",
        "on",
        "in",
        "at",
        "for",
        "of",
        "to",
        "and",
        "or",
        "it",
        "this",
        "that",
        "why",
        "which",
        "what",
        "who",
        "how",
        "please",
        "wait",
        "waits",
        "waiting",
        "await",
        "awaiting",
        "blocked",
        "blocking",
        "pending",
        "stuck",
        "stalled",
        "overdue",
        "ticket",
        "tickets",
        "run",
        "runs",
        "show",
        "list",
        "open",
        "find",
        "see",
        "get",
        "any",
        "all",
    }
)

_MAX_TOKENS = 8
_MAX_WHY_RESULTS = 3
_MAX_RECEIPT_RESULTS = 5
_RECENT_RUNS = 50
_SNIPPET_CHARS = 400


@dataclass(frozen=True)
class SearchPlan:
    """The deterministic reading of one raw command-bar query."""

    intent: str  # "find" | "list" | "why" | "do"
    scope: str | None  # "awaiting" | "blocked" | "overdue" | "active"
    tokens: tuple[str, ...]


def resolve_search_intent(query: str) -> SearchPlan:
    """Map free text onto the four command-bar intents without an LLM."""

    normalized = re.sub(r"[''`]", "", query.lower())
    normalized = " ".join(normalized.split()).strip("?!. ")
    normalized = re.sub(r"^(please|can you|could you)\s+", "", normalized)
    if normalized.startswith("why"):
        rest = re.sub(r"^why(\s+(is|are|was|were|does|do|did|didn't|didnt))?", " ", normalized)
        return SearchPlan("why", None, _query_tokens(rest))
    scope: str | None = None
    if any(phrase in normalized for phrase in _AWAITING_PHRASES):
        scope = "awaiting"
    elif any(phrase in normalized for phrase in _BLOCKED_PHRASES):
        scope = "blocked"
    elif any(phrase in normalized for phrase in _OVERDUE_PHRASES):
        scope = "overdue"
    if scope is not None:
        return SearchPlan("list", scope, ())
    if any(phrase in normalized for phrase in _LIST_PHRASES):
        return SearchPlan("list", "active", ())
    for prefix in _DO_PREFIXES:
        if normalized.startswith(prefix):
            return SearchPlan("do", None, _query_tokens(normalized[len(prefix) :]))
    return SearchPlan("find", None, _query_tokens(normalized))


def build_search_router(
    *,
    verifier: BearerVerifier,
    service: RunService,
    approvals: ApprovalRepository | None = None,
    cases: CaseRepository | None = None,
    knowledge: KnowledgeRetriever | None = None,
    knowledge_domains: tuple[str, ...] = ("support",),
    overdue_after_seconds: int = 1_800,
    kb_results: int = 3,
) -> APIRouter:
    """Read-only search over runs (live + recent), approvals, and KB passages."""

    router = APIRouter(prefix="/search")
    logger = get_logger()

    async def principal(authorization: str | None = Header(default=None)) -> Principal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        try:
            return await verifier.verify(authorization[7:])
        except AuthenticationError as error:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials") from error

    def require_role(identity: Principal, *roles: str) -> None:
        if identity.roles.isdisjoint(roles):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")

    @router.get("")
    async def search_console(
        q: str = Query(min_length=1, max_length=200),
        intent: Literal["auto", "find", "list", "why", "do"] = "auto",
        limit: int = Query(default=10, ge=1, le=25),
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        """Resolve one command-bar query into deep-linkable hits. Zero writes."""

        require_role(identity, *_READ_ROLES)
        query = q.strip()
        resolved = resolve_search_intent(query)
        if intent == "auto":
            plan = resolved
        else:
            # An explicit intent overrides the deterministic reading but still
            # reuses its tokens when the reading agrees; list keeps its scope.
            tokens = resolved.tokens if resolved.intent == intent else _query_tokens(query)
            scope = (resolved.scope or "active") if intent == "list" else None
            plan = SearchPlan(intent, scope, tokens)

        now = datetime.now(UTC)
        runs = await _recent_runs(service, identity.tenant_id)
        hit_rows = _run_hits(plan, runs, now, overdue_after_seconds)
        if plan.intent == "why":
            hit_rows = await _attach_why_details(service, hit_rows)
        approval_rows: list[tuple[float, str, dict[str, object]]] = []
        if approvals is not None and plan.tokens:
            approval_rows = await _approval_hits(
                approvals, cases, identity.tenant_id, plan.tokens
            )
        kb_rows, kb_degraded = await _kb_passages(
            knowledge, knowledge_domains, identity.tenant_id, query, kb_results, logger
        )

        combined = sorted(
            [*hit_rows, *approval_rows], key=lambda row: (-row[0], row[1])
        )
        return {
            "query": query,
            "intent": plan.intent,
            "scope": plan.scope,
            "results": [row[2] for row in combined[:limit]],
            "kb": kb_rows,
            "kbDegraded": kb_degraded,
            "counts": {
                "runs": len(hit_rows),
                "approvals": len(approval_rows),
                "kb": len(kb_rows),
            },
        }

    return router


# ------------------------------------------------------------------ sources


async def _recent_runs(service: RunService, tenant_id: str) -> list[WorkflowRun]:
    """Live registry (active ∪ recent) deduplicated by run id."""

    active = await service.list_active(tenant_id)
    recent = await service.registry.list_recent(tenant_id, limit=_RECENT_RUNS)
    seen: set[str] = set()
    merged: list[WorkflowRun] = []
    for run in [*active, *recent]:
        if run.run_id in seen:
            continue
        seen.add(run.run_id)
        merged.append(run)
    return merged


def _run_hits(
    plan: SearchPlan,
    runs: list[WorkflowRun],
    now: datetime,
    overdue_after_seconds: int,
) -> list[tuple[float, str, dict[str, object]]]:
    if plan.intent == "list":
        return _scope_hits(plan.scope, runs, now, overdue_after_seconds)
    if plan.intent == "why":
        return _why_hits(plan.tokens, runs)
    return _token_hits(plan, runs, now)


def _scope_hits(
    scope: str | None,
    runs: list[WorkflowRun],
    now: datetime,
    overdue_after_seconds: int,
) -> list[tuple[float, str, dict[str, object]]]:
    rows: list[tuple[float, str, dict[str, object]]] = []
    for run in runs:
        waiting = max(0.0, (now - run.started_at).total_seconds())
        if scope == "awaiting" and run.status != "awaiting_human":
            continue
        if scope == "blocked" and run.status != "blocked":
            continue
        if scope == "overdue":
            if run.status in TERMINAL_RUN_STATUSES:
                continue
            if waiting <= overdue_after_seconds:
                continue
        if scope == "active" and run.status in TERMINAL_RUN_STATUSES:
            continue
        rows.append((waiting, run.run_id, _run_hit(run, score=waiting)))
    return rows


def _why_hits(
    tokens: tuple[str, ...],
    runs: list[WorkflowRun],
) -> list[tuple[float, str, dict[str, object]]]:
    matches = [run for run in runs if _matches(run, tokens)]
    # Prefer runs that genuinely wait for a human, then recency.
    matches.sort(
        key=lambda run: (
            0 if run.status == "blocked" else 1 if run.status == "awaiting_human" else 2,
            -run.started_at.timestamp(),
        )
    )
    rows: list[tuple[float, str, dict[str, object]]] = []
    for run in matches[:_MAX_WHY_RESULTS]:
        reason = _blocked_reason(run) or f"Status {run.status}"
        rank = 10.0 if run.status == "blocked" else 5.0 if run.status == "awaiting_human" else 0.0
        rows.append((rank, run.run_id, _run_hit(run, score=rank, reason=reason)))
    return rows


def _token_hits(
    plan: SearchPlan,
    runs: list[WorkflowRun],
    now: datetime,
) -> list[tuple[float, str, dict[str, object]]]:
    if not plan.tokens:
        # A bare navigate/find verb with no signal still answers "what is
        # live": degrade to the active list instead of returning nothing.
        return _scope_hits("active", runs, now, 0)
    rows: list[tuple[float, str, dict[str, object]]] = []
    for run in runs:
        if not _matches(run, plan.tokens):
            continue
        score = _match_score(run, plan.tokens)
        rows.append((score, run.run_id, _run_hit(run, score=score)))
    rows.sort(key=lambda row: (-row[0], row[1]))
    if any(token.startswith("receipt") for token in plan.tokens):
        rows.extend(_receipt_hits(runs, plan.tokens))
    return rows


def _receipt_hits(
    runs: list[WorkflowRun],
    tokens: tuple[str, ...],
) -> list[tuple[float, str, dict[str, object]]]:
    """Receipted steps as separate hits; tokens are never echoed, only hashes."""

    rows: list[tuple[float, str, dict[str, object]]] = []
    for run in runs:
        if not _matches(run, tokens):
            continue
        for step in run.steps:
            if step.receipt is None or step.action_hash is None:
                continue
            title = f"Receipt {step.step_id} - {run.ticket_key}"
            rows.append(
                (
                    2.0,
                    f"{run.run_id}:{step.step_id}",
                    {
                        "kind": "receipt",
                        "id": f"{run.run_id}:{step.step_id}",
                        "title": title,
                        "subtitle": f"{_workflow_title(run.workflow)} · {run.status}",
                        "snippet": f"signed action {step.action_hash[:12]}",
                        "score": 2.0,
                        "runId": run.run_id,
                        "workflow": run.workflow,
                        "ticketKey": run.ticket_key,
                        "stepId": step.step_id,
                        "stepTitle": step.title,
                        "status": run.status,
                        "reason": None,
                        "logLine": None,
                        "receipt": f"action:{step.action_hash[:12]}",
                    },
                )
            )
            if len(rows) == _MAX_RECEIPT_RESULTS:
                return rows
    return rows


async def _approval_hits(
    approvals: ApprovalRepository,
    cases: CaseRepository | None,
    tenant_id: str,
    tokens: tuple[str, ...],
) -> list[tuple[float, str, dict[str, object]]]:
    rows: list[tuple[float, str, dict[str, object]]] = []
    for approval in await approvals.list(tenant_id):
        ticket_key: str | None = None
        if cases is not None:
            try:
                record = await cases.get(approval.case_id, tenant_id)
                ticket_key = record.ticket_key
            except KeyError:
                ticket_key = None
        haystack = " ".join(
            [
                "approval approvals approval-gate",
                approval.id,
                approval.scope,
                approval.approver,
                approval.decision or "pending",
                ticket_key or "",
                json.dumps(approval.action, default=str),
                json.dumps(approval.evidence, default=str),
            ]
        ).lower()
        if not all(token in haystack for token in tokens):
            continue
        workflow = approval.scope.split(":", 1)[0] if ":" in approval.scope else None
        step_id = approval.scope.split(":", 1)[1] if ":" in approval.scope else None
        rows.append(
            (
                2.0,
                approval.id,
                {
                    "kind": "approval",
                    "id": approval.id,
                    "title": f"Approval {approval.scope}",
                    "subtitle": (
                        f"{approval.approver} · {approval.decision or 'pending'}"
                        + (f" · {ticket_key}" if ticket_key else "")
                    ),
                    "snippet": json.dumps(approval.action, default=str)[:_SNIPPET_CHARS],
                    "score": 2.0,
                    "runId": None,
                    "workflow": workflow,
                    "ticketKey": ticket_key,
                    "stepId": step_id,
                    "stepTitle": None,
                    "status": approval.decision or "pending",
                    "reason": None,
                    "logLine": None,
                    "receipt": None,
                },
            )
        )
    return rows


async def _kb_passages(
    knowledge: KnowledgeRetriever | None,
    domains: tuple[str, ...],
    tenant_id: str,
    query: str,
    limit: int,
    logger: BoundLogger,
) -> tuple[list[dict[str, object]], bool]:
    if knowledge is None or not query or not domains:
        return [], False
    passages: list[dict[str, object]] = []
    degraded = False
    for domain in domains:
        try:
            result = await knowledge.retrieve(tenant_id, domain, query, limit)
        except LookupError:
            # EmptyRetrievalError is a LookupError: an empty scope is normal.
            continue
        except Exception:
            # Knowledge is a bonus surface: its failure must never break the
            # bar, so degrade to no KB rows and say so in the envelope.
            degraded = True
            logger.warning("search_kb_failed", domain=domain)
            continue
        for passage in result.passages:
            passages.append(
                {
                    "sourceId": passage.citation.source_id,
                    "span": passage.citation.span,
                    "title": passage.title,
                    "text": passage.content[:_SNIPPET_CHARS],
                    "score": passage.score,
                    "stale": passage.stale,
                    "domain": domain,
                }
            )
    return passages, degraded


async def _attach_why_details(
    service: RunService,
    rows: list[tuple[float, str, dict[str, object]]],
) -> list[tuple[float, str, dict[str, object]]]:
    """Add the last run event (the log line) only to why-intent hits."""

    enriched: list[tuple[float, str, dict[str, object]]] = []
    for score, key, hit in rows:
        events = await service.history(str(hit["runId"]))
        if events:
            hit["logLine"] = _log_line(events[-1])
        enriched.append((score, key, hit))
    return enriched


# ------------------------------------------------------------------ matching


def _run_haystack(run: WorkflowRun) -> str:
    parts = [
        run.run_id,
        run.workflow,
        run.ticket_key,
        run.case_id,
        run.status,
        _workflow_title(run.workflow),
    ]
    for step in run.steps:
        parts.extend((step.step_id, step.title, step.state))
    if run.lock_target:
        parts.append(run.lock_target)
    if run.lock_owner:
        parts.append(run.lock_owner)
    if run.outcome:
        parts.append(run.outcome)
    if run.cancel_reason:
        parts.append(run.cancel_reason)
    if any(step.receipt is not None for step in run.steps):
        # Makes "receipt(s)" a first-class search term for receipted runs.
        parts.append("receipt receipts signed")
    with contextlib.suppress(TypeError, ValueError):
        parts.append(json.dumps(run.input, default=str))
    return " ".join(parts).lower()


def _matches(run: WorkflowRun, tokens: tuple[str, ...]) -> bool:
    haystack = _run_haystack(run)
    return all(token in haystack for token in tokens)


def _match_score(run: WorkflowRun, tokens: tuple[str, ...]) -> float:
    ticket = run.ticket_key.lower()
    run_id = run.run_id.lower()
    workflow = run.workflow.lower()
    score = 0.0
    for token in tokens:
        if token in ticket:
            score += 4.0
        elif token in run_id:
            score += 3.0
        elif token in workflow:
            score += 2.0
        else:
            score += 1.0
    return score


def _query_tokens(text: str) -> tuple[str, ...]:
    tokens: list[str] = []
    for token in re.findall(r"[a-z0-9][a-z0-9._-]*", text.lower()):
        if token in _STOPWORDS or token in tokens:
            continue
        tokens.append(token)
        if len(tokens) == _MAX_TOKENS:
            break
    return tuple(tokens)


# ------------------------------------------------------------------ shaping


def _workflow_title(workflow: str) -> str:
    definition = WORKFLOW_DEFINITIONS.get(workflow)
    return definition.title if definition is not None else workflow


def _run_hit(
    run: WorkflowRun,
    *,
    score: float,
    reason: str | None = None,
) -> dict[str, object]:
    current = run.current_step()
    step_id = current.step_id if current is not None else None
    step_title = current.title if current is not None else None
    receipts = sum(1 for step in run.steps if step.receipt is not None)
    step_hint = f" · step {step_id}" if step_id else ""
    subtitle = f"{run.status}{step_hint} · {_workflow_title(run.workflow)}"
    if run.queue_position is not None:
        subtitle = f"{subtitle} · queue #{run.queue_position}"
    snippet = reason or _run_snippet(run)
    return {
        "kind": "run",
        "id": run.run_id,
        "title": f"{_workflow_title(run.workflow)} - {run.ticket_key}",
        "subtitle": subtitle,
        "snippet": snippet[:_SNIPPET_CHARS],
        "score": score,
        "runId": run.run_id,
        "workflow": run.workflow,
        "ticketKey": run.ticket_key,
        "stepId": step_id,
        "stepTitle": step_title,
        "status": run.status,
        "reason": reason,
        "logLine": None,
        "receipt": None,
        "receiptCount": receipts,
    }


def _run_snippet(run: WorkflowRun) -> str:
    if run.lock_target:
        owner = run.lock_owner or "an unknown run"
        return f"Blocked on {run.lock_target}, held by {owner}"
    if run.cancel_reason:
        return f"Cancelled: {run.cancel_reason}"
    if run.outcome:
        return run.outcome
    current = run.current_step()
    if current is not None and current.state == "awaiting_human":
        return f"Waiting for a decision at {current.title or current.step_id}"
    return f"Case {run.case_id}"


def _blocked_reason(run: WorkflowRun) -> str | None:
    if run.status == "blocked" or any(step.state == "blocked" for step in run.steps):
        if run.status == "blocked" and run.lock_target:
            owner = run.lock_owner or "an unknown run"
            return f"Blocked on {run.lock_target}, held by {owner}"
        return "Blocked without a lock; retry the lock to resume"
    if run.status == "cancelled" and run.cancel_reason:
        return f"Cancelled: {run.cancel_reason}"
    if run.status == "failed":
        return run.outcome or "The run failed"
    current = run.current_step()
    if current is not None and current.state == "awaiting_human":
        return (
            f"Waiting for a human decision at {current.title or current.step_id} "
            f"({current.step_id})"
        )
    if run.outcome:
        return run.outcome
    return None


def _log_line(event: dict[str, object]) -> str:
    parts = [str(event.get("type", "event"))]
    for key in ("status", "stepId", "stepState", "target", "lockedBy", "error"):
        value = event.get(key)
        if isinstance(value, str) and value:
            parts.append(f"{key}={value}")
    sequence = event.get("sequence")
    if isinstance(sequence, int):
        parts.append(f"seq={sequence}")
    return " | ".join(parts)


__all__ = ["SearchPlan", "build_search_router", "resolve_search_intent"]
