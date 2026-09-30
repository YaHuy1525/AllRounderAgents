"""Weekly written report for one MSP client, derived from the audit packs.

Builds the same audit pack JSON the console download serves (archive union
registry, case ledger, re-verified receipts) for every month the week touches,
then aggregates the week's runs into the pilot's three headline numbers:
emails processed, sends without a verified receipt (must stay zero), and a
quantified estimate of hours saved against a manual-handling baseline.

The report is written to stdout and, with ``--out``, to a file. Every number
comes from the immutable trail, so the founder can hand the same numbers and
the pack PDFs to the client.

Usage:
    python scripts/msp-report.py --tenant mspco --client acme
    python scripts/msp-report.py --tenant mspco --client acme --week 2026-09-28 --out report.md

Requires the same environment as the API (.env): DATABASE_URL, REDIS_URL and
APPROVAL_HMAC_SECRET. Assumption knobs: ``--minutes-per-email`` (manual cost
of one email, default 20) and ``--review-minutes`` (cost of one human review
action, default 3).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import Counter
from collections.abc import Coroutine
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from allrounder_api.approvals import ApprovalReceiptSigner
from allrounder_api.audit_pack import CLIENT_REF_RE, AuditPackBuilder
from allrounder_api.repositories import PostgresCaseRepository, PostgresRepositories
from allrounder_api.runs import WORKFLOW_DEFINITIONS, PostgresRunArchive
from allrounder_api.runs.registry import RedisRunRegistry
from allrounder_api.settings import Settings
from redis import Redis

DEFAULT_MINUTES_PER_EMAIL = 20.0
DEFAULT_REVIEW_MINUTES = 3.0


def week_window(spec: str, today: date) -> tuple[datetime, datetime]:
    """Monday-start UTC week as a half-open window; ``last`` is the previous week."""
    if spec.strip().lower() == "last":
        anchor = today - timedelta(days=7)
    else:
        try:
            anchor = datetime.strptime(spec.strip(), "%Y-%m-%d").date()
        except ValueError as error:
            raise ValueError("--week must be a YYYY-MM-DD date or 'last'") from error
    start = datetime(anchor.year, anchor.month, anchor.day, tzinfo=UTC) - timedelta(
        days=anchor.weekday()
    )
    return start, start + timedelta(days=7)


def month_span(start: datetime, end: datetime) -> list[str]:
    months: list[str] = []
    cursor = start.replace(day=1)
    last = (end - timedelta(microseconds=1)).replace(day=1)
    while cursor <= last:
        months.append(cursor.strftime("%Y-%m"))
        cursor = (cursor + timedelta(days=32)).replace(day=1)
    return months


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def collect_week(
    packs: list[dict[str, object]], start: datetime, end: datetime
) -> list[dict[str, object]]:
    """Runs started inside the window, merged across packs by run id."""
    runs: dict[str, dict[str, object]] = {}
    for pack in packs:
        for run in pack.get("runs") or []:
            if not isinstance(run, dict):
                continue
            started = _parse_iso(run.get("startedAt"))
            if started is not None and start <= started < end:
                runs[str(run.get("runId"))] = run
    return sorted(runs.values(), key=lambda run: str(run.get("startedAt")))


class WeekMetrics:
    """Everything the report prints, computed once from the pack payloads."""

    def __init__(
        self,
        runs: list[dict[str, object]],
        minutes_per_email: float,
        review_minutes: float,
    ) -> None:
        self.runs = runs
        self.emails = len(runs)
        self.statuses = Counter(str(run.get("status")) for run in runs)
        self.actions: Counter[str] = Counter()
        self.receipts_verified = 0
        self.receipts_failed = 0
        self.sends = 0
        self.unapproved_sends: list[str] = []
        self.escalated_runs = 0
        self.escalation_reasons: Counter[str] = Counter()
        self.awaiting_tickets: list[str] = []
        for run in runs:
            self._run(run)
        self.minutes_per_email = minutes_per_email
        self.review_minutes = review_minutes
        self.human_actions = sum(self.actions.values())

    def _run(self, run: dict[str, object]) -> None:
        steps = [step for step in run.get("steps") or [] if isinstance(step, dict)]
        steps_by_id = {str(step.get("stepId")): step for step in steps}
        for step in steps:
            decision = step.get("decision")
            if isinstance(decision, dict):
                self.actions[str(decision.get("action"))] += 1
                verification = step.get("verification")
                verified = (
                    isinstance(verification, dict)
                    and verification.get("receiptVerified") is True
                )
                if verified:
                    self.receipts_verified += 1
                elif not (
                    isinstance(verification, dict)
                    and verification.get("reason") == "no_receipt_required"
                ):
                    self.receipts_failed += 1
        side_effects = run.get("sideEffects")
        if isinstance(side_effects, dict) and "send" in side_effects:
            self.sends += 1
            send_step = steps_by_id.get("send") or {}
            verification = send_step.get("verification")
            if not (
                isinstance(verification, dict) and verification.get("receiptVerified") is True
            ):
                self.unapproved_sends.append(str(run.get("runId")))
        draft = steps_by_id.get("draft") or {}
        artifact = draft.get("artifact")
        if isinstance(artifact, dict) and artifact.get("escalated") is True:
            self.escalated_runs += 1
            for reason in artifact.get("escalations") or []:
                self.escalation_reasons[str(reason)] += 1
        if run.get("status") == "awaiting_human":
            self.awaiting_tickets.append(str(run.get("ticketKey")))

    @property
    def cases_opened(self) -> int:
        return len({str(run.get("caseId")) for run in self.runs})

    @property
    def hours_saved(self) -> float:
        baseline = self.emails * self.minutes_per_email
        human = self.human_actions * self.review_minutes
        return (baseline - human) / 60


def render_report(
    *,
    tenant: str,
    client: str,
    start: datetime,
    end: datetime,
    pack_keys: list[str],
    metrics: WeekMetrics,
    generated_at: datetime,
) -> str:
    last_day = (end - timedelta(days=1)).date()
    lines: list[str] = [
        f"# MSP weekly report · {client}",
        "",
        f"Tenant {tenant} · week {start.date()} to {last_day} (UTC) · generated"
        f" {generated_at.isoformat(timespec='seconds')}",
        "",
        f"Source audit packs: {', '.join(pack_keys)}. Every figure below is derived"
        " from the immutable trail, with each decision's receipt re-verified as of its"
        " decision time.",
        "",
        "## Throughput",
        "",
        f"- Emails processed: {metrics.emails}",
        f"- Cases opened: {metrics.cases_opened}",
        f"- Completed runs: {metrics.statuses.get('completed', 0)}",
        f"- Awaiting human review: {metrics.statuses.get('awaiting_human', 0)}",
        f"- Blocked runs: {metrics.statuses.get('blocked', 0)}",
        f"- Failed runs: {metrics.statuses.get('failed', 0)}",
        f"- Cancelled runs: {metrics.statuses.get('cancelled', 0)}",
    ]
    if metrics.awaiting_tickets:
        lines.append(f"- Open tickets: {', '.join(sorted(metrics.awaiting_tickets))}")
    lines += [
        "",
        "## Reply safety",
        "",
        f"- Sends executed: {metrics.sends}",
        f"- Sends without a verified receipt: {len(metrics.unapproved_sends)}",
    ]
    if metrics.unapproved_sends:
        lines.append(
            "  WARNING: these sends are not bound to a receipt that re-verified: "
            + ", ".join(metrics.unapproved_sends)
        )
    decision_breakdown = ", ".join(
        f"{action} {count}" for action, count in sorted(metrics.actions.items())
    )
    lines += [
        f"- Decisions recorded: {metrics.human_actions}"
        + (f" ({decision_breakdown})" if decision_breakdown else ""),
        f"- Receipts verified: {metrics.receipts_verified}",
        f"- Receipts failed verification: {metrics.receipts_failed}",
    ]
    if metrics.receipts_failed:
        lines.append("  WARNING: the audit pack lists receipts that did not verify.")
    reason_breakdown = ", ".join(
        f"{reason} {count}" for reason, count in sorted(metrics.escalation_reasons.items())
    )
    lines += [
        f"- Escalated drafts: {metrics.escalated_runs}"
        + (f" ({reason_breakdown})" if reason_breakdown else ""),
        "",
        "## Hours saved",
        "",
        f"- Assumptions: manual handling {metrics.minutes_per_email:g} min per email,"
        f" human review {metrics.review_minutes:g} min per decision (tune with"
        " --minutes-per-email and --review-minutes)",
        f"- Automated baseline: {metrics.emails} emails x {metrics.minutes_per_email:g}"
        f" min = {metrics.emails * metrics.minutes_per_email / 60:.1f} h",
        f"- Human time: {metrics.human_actions} decisions x {metrics.review_minutes:g}"
        f" min = {metrics.human_actions * metrics.review_minutes / 60:.1f} h",
        f"- Estimated hours saved: {metrics.hours_saved:.1f} h",
        "",
    ]
    return "\n".join(lines)


async def build(
    *,
    tenant: str,
    client: str,
    start: datetime,
    end: datetime,
    settings: Settings,
) -> tuple[list[dict[str, object]], list[str]]:
    database_url = settings.database_url.get_secret_value()
    archive = PostgresRunArchive(database_url)
    repositories = PostgresRepositories(database_url)
    cases = PostgresCaseRepository(repositories)
    signer = ApprovalReceiptSigner(settings.approval_hmac_secret.get_secret_value().encode())
    registry = RedisRunRegistry(Redis.from_url(settings.redis_url))
    builder = AuditPackBuilder(
        archive=archive,
        registry=registry,
        signer=signer,
        cases=cases,
        workflows=WORKFLOW_DEFINITIONS,
    )
    await archive.open()
    await repositories.open()
    try:
        packs: list[dict[str, object]] = []
        for month in month_span(start, end):
            packs.append(
                await builder.build(tenant_id=tenant, client_ref=client, month=month)
            )
    finally:
        await archive.close()
        await repositories.close()
    return collect_week(packs, start, end), [str(pack.get("packKey")) for pack in packs]


def run_async(coro: Coroutine[Any, Any, tuple[list[dict[str, object]], list[str]]]) -> tuple[
    list[dict[str, object]], list[str]
]:
    """Run the pipeline on a psycopg-compatible loop (the Windows default is not)."""
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    return asyncio.run(coro)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Weekly MSP report from the audit pack data."
    )
    parser.add_argument("--tenant", required=True, help="tenant id that owns the runs")
    parser.add_argument(
        "--client",
        required=True,
        help="client ref slug (the mailbox local part), e.g. acme",
    )
    parser.add_argument(
        "--week",
        default="last",
        help="a date inside the ISO week (YYYY-MM-DD) or 'last' for the previous week",
    )
    parser.add_argument(
        "--minutes-per-email",
        type=float,
        default=DEFAULT_MINUTES_PER_EMAIL,
        help="manual handling baseline per email in minutes"
        f" (default {DEFAULT_MINUTES_PER_EMAIL:g})",
    )
    parser.add_argument(
        "--review-minutes",
        type=float,
        default=DEFAULT_REVIEW_MINUTES,
        help="human review cost per decision in minutes"
        f" (default {DEFAULT_REVIEW_MINUTES:g})",
    )
    parser.add_argument("--out", default="", help="also write the report to this file")
    args = parser.parse_args()

    client = args.client.strip().lower()
    if CLIENT_REF_RE.match(client) is None:
        print("client must be a lowercase mailbox slug, e.g. acme", file=sys.stderr)
        return 1
    try:
        start, end = week_window(args.week, datetime.now(UTC).date())
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    if args.minutes_per_email < 0 or args.review_minutes < 0:
        print("minute assumptions must not be negative", file=sys.stderr)
        return 1

    settings = Settings()
    if settings.database_url.get_secret_value() == "":
        print("DATABASE_URL is required (set it in .env, see .env.example)", file=sys.stderr)
        return 1
    if len(settings.approval_hmac_secret.get_secret_value().encode()) < 32:
        print(
            "APPROVAL_HMAC_SECRET must contain at least 32 bytes to re-verify receipts",
            file=sys.stderr,
        )
        return 1

    runs, pack_keys = run_async(
        build(tenant=args.tenant.strip(), client=client, start=start, end=end, settings=settings)
    )
    metrics = WeekMetrics(runs, args.minutes_per_email, args.review_minutes)
    report = render_report(
        tenant=args.tenant.strip(),
        client=client,
        start=start,
        end=end,
        pack_keys=pack_keys,
        metrics=metrics,
        generated_at=datetime.now(UTC),
    )
    print(report)
    if args.out.strip():
        Path(args.out.strip()).write_text(report, encoding="utf-8")
        print(f"written to {args.out.strip()}", file=sys.stderr)
    if metrics.unapproved_sends or metrics.receipts_failed:
        print(
            "attention: the week holds sends without verified receipts or failed"
            " receipts; see the report",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
