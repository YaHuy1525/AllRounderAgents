"""Prometheus metrics registry for the serving plane.

One process-local :class:`MetricsRegistry` per app instance keeps unit tests
isolated (no default-collector duplicate registration). Label sets are
bounded: route labels use router path templates, never raw ids or ticket keys.

The registry doubles as the console's data source: :meth:`MetricsRegistry.summary`
turns the raw counters and histogram buckets into a small JSON document for
``GET /metrics/summary`` (runs by workflow/status, decisions, queue depth, and
latency percentiles), while ``GET /metrics`` keeps the Prometheus exposition.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)

METRICS_CONTENT_TYPE = CONTENT_TYPE_LATEST


class MetricsRegistry:
    """Counters and histograms exposed on ``GET /metrics``."""

    def __init__(self) -> None:
        self.registry = CollectorRegistry()
        self.http_requests = Counter(
            "http_requests_total",
            "HTTP requests by route and status.",
            ["method", "route", "status"],
            registry=self.registry,
        )
        self.http_request_duration = Histogram(
            "http_request_duration_seconds",
            "HTTP request duration in seconds.",
            ["route"],
            registry=self.registry,
        )
        self.webhook_received = Counter(
            "webhook_received_total",
            "Jira webhooks received, by dedupe outcome.",
            ["deduped"],
            registry=self.registry,
        )
        self.gate_decisions = Counter(
            "gate_decisions_total",
            "Human gate decisions by approval scope.",
            ["gate"],
            registry=self.registry,
        )
        self.approval_decisions = Counter(
            "approval_decisions_total",
            "Approval decisions by outcome.",
            ["decision"],
            registry=self.registry,
        )
        self.chat_requests = Counter(
            "chat_requests_total",
            "Chat replies by answer source.",
            ["source"],
            registry=self.registry,
        )
        self.chat_first_token = Histogram(
            "chat_first_token_seconds",
            "Time from chat stream start to the first streamed delta.",
            ["source"],
            buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0),
            registry=self.registry,
        )
        self.runs = Counter(
            "runs_total",
            "Workflow runs by terminal status.",
            ["workflow", "status"],
            registry=self.registry,
        )
        self.run_decisions = Counter(
            "run_decisions_total",
            "Human decisions on runs by action.",
            ["workflow", "action"],
            registry=self.registry,
        )
        self.security_triage_verdicts = Counter(
            "security_triage_verdicts_total",
            "Security triage verdicts by classification, severity and injection flag.",
            ["classification", "severity", "injection"],
            registry=self.registry,
        )
        self.security_containment = Counter(
            "security_containment_total",
            "Security containment receipts; a replay skipped execution.",
            ["outcome", "replayed"],
            registry=self.registry,
        )

    def record_request(
        self, method: str, route: str, status_code: int, duration_seconds: float
    ) -> None:
        self.http_requests.labels(method=method, route=route, status=str(status_code)).inc()
        self.http_request_duration.labels(route=route).observe(duration_seconds)

    def record_webhook(self, *, deduped: bool) -> None:
        self.webhook_received.labels(deduped="true" if deduped else "false").inc()

    def record_gate_decision(self, gate: str) -> None:
        self.gate_decisions.labels(gate=gate).inc()

    def record_approval_decision(self, decision: str) -> None:
        self.approval_decisions.labels(decision=decision).inc()

    def record_chat(self, source: str) -> None:
        self.chat_requests.labels(source=source).inc()

    def record_chat_stream(self, source: str, first_token_seconds: float) -> None:
        self.chat_first_token.labels(source=source).observe(first_token_seconds)

    def record_run(self, *, workflow: str, status: str) -> None:
        self.runs.labels(workflow=workflow, status=status).inc()

    def record_run_decision(self, *, workflow: str, action: str) -> None:
        self.run_decisions.labels(workflow=workflow, action=action).inc()

    def record_security_triage(
        self, *, classification: str, severity: str, injection: bool
    ) -> None:
        self.security_triage_verdicts.labels(
            classification=classification,
            severity=severity,
            injection="flagged" if injection else "clean",
        ).inc()

    def record_security_containment(self, *, outcome: str, replayed: bool) -> None:
        self.security_containment.labels(
            outcome=outcome, replayed="true" if replayed else "false"
        ).inc()

    def summary(self, *, active_statuses: Iterable[str] = ()) -> dict[str, object]:
        """JSON snapshot for the console observability view.

        Counters are read from the registry; live queue depth is injected by
        the caller (the run service owns the active runs). Histogram
        percentiles are interpolated from the bucket samples.
        """

        workflows: dict[str, dict[str, int]] = {}
        decisions: dict[str, int] = {}
        route_buckets: dict[str, list[tuple[float, float]]] = {}
        route_counts: dict[str, int] = {}
        for metric in self.registry.collect():
            for sample in metric.samples:
                if sample.name == "runs_total":
                    row = workflows.setdefault(
                        sample.labels["workflow"],
                        {"total": 0, "completed": 0, "failed": 0, "cancelled": 0},
                    )
                    row["total"] += int(sample.value)
                    status = sample.labels["status"]
                    if status in row:
                        row[status] += int(sample.value)
                elif sample.name == "run_decisions_total":
                    action = sample.labels["action"]
                    decisions[action] = decisions.get(action, 0) + int(sample.value)
                elif sample.name == "http_request_duration_seconds_bucket":
                    route_buckets.setdefault(sample.labels["route"], []).append(
                        (float(sample.labels["le"]), sample.value)
                    )
                elif sample.name == "http_request_duration_seconds_count":
                    route_counts[sample.labels["route"]] = int(sample.value)
        return _summary_payload(
            workflows=workflows,
            decisions=decisions,
            route_buckets=route_buckets,
            route_counts=route_counts,
            active_statuses=tuple(active_statuses),
        )

    def render(self) -> bytes:
        return generate_latest(self.registry)


def empty_summary() -> dict[str, object]:
    """Zeroed summary shape served when no metrics registry is wired."""

    return _summary_payload(
        workflows={},
        decisions={},
        route_buckets={},
        route_counts={},
        active_statuses=(),
    )


def _summary_payload(
    *,
    workflows: dict[str, dict[str, int]],
    decisions: dict[str, int],
    route_buckets: dict[str, list[tuple[float, float]]],
    route_counts: dict[str, int],
    active_statuses: tuple[str, ...],
) -> dict[str, object]:
    ordered = sorted(workflows.items(), key=lambda item: (-item[1]["total"], item[0]))
    completed = sum(counts["completed"] for _, counts in ordered)
    failed = sum(counts["failed"] for _, counts in ordered)
    cancelled = sum(counts["cancelled"] for _, counts in ordered)
    total = completed + failed + cancelled

    merged: dict[float, float] = {}
    for buckets in route_buckets.values():
        for bound, cumulative in buckets:
            merged[bound] = merged.get(bound, 0.0) + cumulative
    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "runs": {
            "total": total,
            "completed": completed,
            "failed": failed,
            "cancelled": cancelled,
            "successRate": round(completed / total, 4) if total > 0 else None,
        },
        "workflows": [
            {
                "workflow": workflow,
                "total": counts["total"],
                "completed": counts["completed"],
                "failed": counts["failed"],
                "cancelled": counts["cancelled"],
            }
            for workflow, counts in ordered
        ],
        "decisions": {action: decisions[action] for action in sorted(decisions)},
        "queue": {
            "active": len(active_statuses),
            "queued": active_statuses.count("queued"),
            "running": active_statuses.count("running"),
            "awaitingHuman": active_statuses.count("awaiting_human"),
            "blocked": active_statuses.count("blocked"),
        },
        "latency": {
            "overall": {
                "count": sum(route_counts.values()),
                "p50": _round_seconds(_bucket_quantile(sorted(merged.items()), 0.5)),
                "p95": _round_seconds(_bucket_quantile(sorted(merged.items()), 0.95)),
            },
            "http": [
                {
                    "route": route,
                    "count": route_counts.get(route, 0),
                    "p50": _round_seconds(_bucket_quantile(sorted(buckets), 0.5)),
                    "p95": _round_seconds(_bucket_quantile(sorted(buckets), 0.95)),
                }
                for route, buckets in sorted(route_buckets.items())
            ],
        },
    }


def _bucket_quantile(
    buckets: Sequence[tuple[float, float]], quantile: float
) -> float | None:
    """Prometheus-style percentile: linear interpolation inside the bucket
    where the rank lands; an ``+Inf`` bound falls back to the last finite bound.
    ``None`` when the histogram has no observations."""

    if not buckets:
        return None
    total = buckets[-1][1]
    if total <= 0:
        return None
    rank = quantile * total
    lower_bound = 0.0
    lower_count = 0.0
    for upper_bound, cumulative in buckets:
        if cumulative >= rank:
            if math.isinf(upper_bound):
                return lower_bound
            span = cumulative - lower_count
            if span <= 0:
                return upper_bound
            fraction = (rank - lower_count) / span
            return lower_bound + fraction * (upper_bound - lower_bound)
        lower_bound = upper_bound
        lower_count = cumulative
    return lower_bound


def _round_seconds(value: float | None) -> float | None:
    return None if value is None else round(value, 4)
