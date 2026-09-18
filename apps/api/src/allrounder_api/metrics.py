"""Prometheus metrics registry for the serving plane.

One process-local :class:`MetricsRegistry` per app instance keeps unit tests
isolated (no default-collector duplicate registration). Label sets are
bounded: route labels use router path templates, never raw ids or ticket keys.
"""

from __future__ import annotations

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

    def render(self) -> bytes:
        return generate_latest(self.registry)
