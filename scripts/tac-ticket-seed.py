"""Drive the live Jira tickets through the real intake spine.

The board shows what Jira holds, but public.tickets and public.dispatcher_jobs
stay empty until something calls ``POST /webhooks/jira``. That table pair is the
routing half of the audit trail: the recorded domain, the gate, the verdict and
the workflow the dispatcher chose. This script rebuilds each delivery from the
issue as Jira actually stores it, signs it with WEBHOOK_SECRET exactly like the
Jira Cloud webhook would, and posts it to a running API.

Read-only against Atlassian. The spine does write back to Jira after a
successful enqueue (the routing comment, and a cross-domain spawn for support
tickets carrying defect signals); those calls are wrapped in the route and only
logged when they fail, so start the API pointed at a dead local port to keep the
seed entirely on this machine::

    $env:JIRA_BASE_URL = "http://127.0.0.1:9"; $env:JIRA_TRANSPORT = "http"
    python -m uvicorn allrounder_api.production:create_production_app --factory --port 8000
    python scripts/tac-ticket-seed.py --dry-run
    python scripts/tac-ticket-seed.py

Deliveries are idempotent. The event id the API dedupes on is derived from the
issue key and Jira's own ``created`` timestamp, so a re-run of the same set is
answered ``deduped`` and no second row is written. Tickets that already have a
case are left alone: the console opens the case on demand when a run starts.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import sys
from datetime import UTC, datetime
from typing import Any

import httpx
from allrounder_api.dispatcher import DeterministicDispatcher, normalize_jira_payload
from allrounder_api.settings import Settings

WEBHOOK_EVENT = "jira:issue_created"
PAGE_SIZE = 50
MAX_PAGES = 20


def _millis(value: object) -> int:
    """Jira's ``created`` string to epoch milliseconds, the unit the webhook uses."""
    if not isinstance(value, str):
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp() * 1000)


def fetch_open_issues(client: httpx.Client, project: str, *, include_done: bool) -> list[dict]:
    """Every issue in the project, newest page first, following startAt paging."""
    jql = f'project = "{project}"' + ("" if include_done else " AND statusCategory != Done")
    issues: list[dict] = []
    for page in range(MAX_PAGES):
        response = client.get(
            "/rest/api/3/search/jql",
            params={
                "jql": jql,
                "startAt": page * PAGE_SIZE,
                "maxResults": PAGE_SIZE,
                "fields": ",".join(
                    [
                        "summary",
                        "labels",
                        "issuetype",
                        "priority",
                        "description",
                        "reporter",
                        "created",
                        "status",
                    ]
                ),
            },
        )
        if response.status_code != 200:
            msg = f"Jira search failed: HTTP {response.status_code} {response.text[:300]}"
            raise RuntimeError(msg)
        body: dict[str, Any] = response.json()
        batch = body.get("issues") or []
        issues.extend(batch)
        if len(batch) < PAGE_SIZE or len(issues) >= int(body.get("total") or 0):
            return issues
    print(f"paging stopped at {MAX_PAGES} pages", file=sys.stderr)
    return issues


def build_payload(issue: dict, project: str) -> dict[str, object]:
    """Reshape a REST issue into the Jira Cloud webhook document.

    Only the fields the normaliser reads are carried; ``description`` stays in
    Atlassian Document Format because that is what the real webhook sends and
    what ``normalize_jira_payload`` expects to unfold.
    """
    fields: dict[str, Any] = issue.get("fields") or {}
    created = _millis(fields.get("created"))
    return {
        "webhookEvent": WEBHOOK_EVENT,
        "timestamp": created or int(datetime.now(UTC).timestamp() * 1000),
        "issue": {
            "key": issue["key"],
            "id": str(fields.get("id") or issue["key"]),
            "self": f"{project}/{issue['key']}",
            "fields": {
                "project": {"key": project, "name": project},
                "issuetype": {"name": (fields.get("issuetype") or {}).get("name") or "Task"},
                "priority": {
                    "name": (fields.get("priority") or {}).get("name") or "Medium"
                },
                "summary": fields.get("summary") or "",
                "description": fields.get("description"),
                "labels": fields.get("labels") or [],
                "reporter": {
                    "accountId": (fields.get("reporter") or {}).get("accountId") or "seed"
                },
                "attachment": [],
            },
        },
    }


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def deliver(
    api: httpx.Client, payload: dict[str, object], body: bytes, digest: str
) -> tuple[str, str]:
    """Post one delivery and classify it as delivered / deduped / refused."""
    response = api.post(
        "/webhooks/jira",
        content=body,
        headers={
            "content-type": "application/json",
            "x-hub-signature-256": digest,
            "x-hub-signature": digest,
        },
    )
    key = str(payload["issue"]["key"])  # type: ignore[index]
    if response.status_code == 200:
        verdict = response.json()
        return ("deduped" if verdict.get("deduped") else "delivered"), key
    if response.status_code == 503:
        return "dead-lettered", key
    return f"rejected-{response.status_code}", key


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--api-url", default="http://localhost:8000", help="running API base url"
    )
    parser.add_argument(
        "--project", default="", help="Jira project key; defaults to JIRA_PROJECT_KEY"
    )
    parser.add_argument(
        "--include-done", action="store_true", help="also deliver issues already Done"
    )
    parser.add_argument(
        "--limit", type=int, default=0, help="stop after this many tickets (0 = all)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="compute the routing locally and post nothing",
    )
    args = parser.parse_args()

    settings = Settings()
    project = args.project or settings.jira_project_key
    secret = settings.webhook_secret.get_secret_value()
    if not project:
        print("JIRA_PROJECT_KEY is unset and --project was not given", file=sys.stderr)
        return 2
    if not secret:
        print("WEBHOOK_SECRET is unset: the API would answer every post 503", file=sys.stderr)
        return 2

    base = settings.jira_base_url.rstrip("/")
    if not base or not settings.jira_email or not settings.jira_api_token.get_secret_value():
        print("JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN are not all set", file=sys.stderr)
        return 2

    dispatcher = DeterministicDispatcher()
    outcomes: dict[str, int] = {}
    posted = 0

    with httpx.Client(
        base_url=base,
        auth=(settings.jira_email, settings.jira_api_token.get_secret_value()),
        headers={"accept": "application/json"},
        timeout=60,
    ) as jira:
        issues = fetch_open_issues(jira, project, include_done=args.include_done)
    print(f"{project}: {len(issues)} issues")

    if not args.dry_run:
        api = httpx.Client(base_url=args.api_url, timeout=90)
    try:
        for issue in issues:
            if args.limit and posted >= args.limit:
                break
            payload = build_payload(issue, project)
            ticket = normalize_jira_payload(payload)
            verdict = dispatcher.triage(ticket)
            body = json.dumps(payload, sort_keys=True).encode()
            digest = sign(secret, body)
            status_name = ((issue.get("fields") or {}).get("status") or {}).get("name", "?")
            head = str(ticket.summary)[:64].replace("\n", " ")

            if args.dry_run:
                gate = dispatcher.dispatch(ticket).gate.value
                print(
                    f"  {ticket.key:10} {verdict.domain.value:9} {gate:8} "
                    f"{status_name:12} {head}"
                )
                outcomes[verdict.domain.value] = outcomes.get(verdict.domain.value, 0) + 1
                posted += 1
                continue

            outcome, key = deliver(api, payload, body, digest)
            print(f"  {key:10} {outcome:14} {verdict.domain.value:9} {head}")
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
            posted += 1
            if outcome == "dead-lettered":
                print(
                    f"    {key} reached the API but its insert failed; the row is in "
                    "public.dead_letters",
                    file=sys.stderr,
                )
    finally:
        if not args.dry_run:
            api.close()

    print(f"\ndelivered: {posted}")
    for label, count in sorted(outcomes.items()):
        print(f"    {label:14} {count}")
    if outcomes.get("dead-lettered"):
        return 1
    if any(label.startswith("rejected-") for label in outcomes):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
