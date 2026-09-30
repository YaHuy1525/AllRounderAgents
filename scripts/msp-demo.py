"""Scripted MSP walkthrough: one email in, a parked run out, then the clicks.

Sends one email into the intake front door, waits for the run to park on its
first human checkpoint, and prints exactly what to do next in the console.
With ``--auto`` it proceeds every checkpoint itself, which is the fastest way
to prove a freshly onboarded tenant is wired end to end before recording.

Usage (repo root, API and console running):
    python scripts/msp-demo.py --client acme --token "$MSP_TOKEN"
    python scripts/msp-demo.py --client acme --token "$MSP_TOKEN" --auto --fresh

The demo address is real: the script reads the tenant's inbound domain from
``GET /msp/connections`` and sends to ``<client>@<domain>`` unless ``--to``
overrides it. ``--fresh`` mints a unique message id, so a demo files a new
case even inside the intake dedupe window. The token is a Supabase access
token for a user with agent or admin roles (env: MSP_TOKEN, else AUTH_TOKEN).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import UTC, datetime
from typing import Any

import httpx

TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
DEFAULT_TIMEOUT = 60.0

DEMO_SUBJECT = "Wi-Fi keeps dropping in the warehouse office"
DEMO_BODY = (
    "Hi team,\n\n"
    "Since yesterday the Wi-Fi in our warehouse office drops every few "
    "minutes. The access point shows green, and it comes back after a minute "
    "or so.\n\n"
    "Nothing changed on our side that we know of. Can you take a look?\n\n"
    "Thanks,\nJordan"
)


class ApiError(RuntimeError):
    """One failed API call, with the status the caller can branch on."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class Api:
    """Thin JSON client: bearer auth, readable errors, no retries."""

    def __init__(self, base_url: str, token: str) -> None:
        self._http = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30.0,
        )

    def request(
        self, method: str, path: str, payload: dict[str, object] | None = None
    ) -> dict[str, Any]:
        try:
            response = self._http.request(method, path, json=payload)
        except httpx.HTTPError as error:
            raise ApiError(0, f"{method} {path} did not complete ({error})") from error
        if response.status_code >= 400:
            raise ApiError(response.status_code, _detail(response))
        data = response.json()
        if not isinstance(data, dict):
            raise ApiError(0, f"{method} {path} returned an unexpected body")
        return data


def _detail(response: httpx.Response) -> str:
    """The API's own message when it sent one, else a trimmed raw body."""

    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    if isinstance(body, dict) and isinstance(body.get("detail"), str):
        return str(body["detail"])
    return json.dumps(body)[:200]


def _resolve_recipient(api: Api, client_ref: str, override: str) -> str:
    """The client's mailbox on the tenant's domain, unless --to overrides it."""

    if override != "":
        return override
    payload = api.request("GET", "/msp/connections")
    connection = payload.get("connection")
    if not isinstance(connection, dict) or not connection.get("inboundDomain"):
        raise ApiError(0, "no MSP connection is wired for this tenant")
    return f"{client_ref}@{connection['inboundDomain']}"


def _print_steps(run: dict[str, Any]) -> None:
    steps = run.get("steps")
    if not isinstance(steps, list):
        return
    for step in steps:
        if isinstance(step, dict):
            print(f"  {str(step.get('stepId')):<8} {step.get('state')}")


def _print_pack_hint(base_url: str, client_ref: str, month: str) -> None:
    print("the pack proves it:")
    print(f"  {base_url}/msp/audit-pack?clientRef={client_ref}&month={month}&format=pdf")
    print("  or Settings -> MSP connection -> Download pack")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Send one demo email into the MSP lane and walk the run."
    )
    parser.add_argument("--client", required=True, help="client ref, e.g. acme")
    parser.add_argument(
        "--token",
        default=os.environ.get("MSP_TOKEN") or os.environ.get("AUTH_TOKEN", ""),
        help="Supabase access token for an agent or admin user",
    )
    parser.add_argument(
        "--base-url",
        default=(
            os.environ.get("MSP_API_URL")
            or os.environ.get("BASE_URL")
            or "http://localhost:8000"
        ),
        help="API origin",
    )
    parser.add_argument(
        "--ui-url",
        default=os.environ.get("MSP_UI_URL", "http://localhost:5173"),
        help="console origin printed in the walkthrough",
    )
    parser.add_argument("--from", dest="sender", default="", help="sender address")
    parser.add_argument("--to", dest="recipient", default="", help="recipient address")
    parser.add_argument("--subject", default=DEMO_SUBJECT)
    parser.add_argument("--body", default=DEMO_BODY)
    parser.add_argument(
        "--month",
        default=datetime.now(UTC).strftime("%Y-%m"),
        help="audit pack month printed at the end",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="mint a unique message id so the demo files a new case",
    )
    parser.add_argument(
        "--auto",
        action="store_true",
        help="proceed every checkpoint instead of waiting for console clicks",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help="overall budget in seconds for the run to advance",
    )
    args = parser.parse_args()

    client_ref = args.client.strip().lower()
    token = args.token.strip()
    if token == "":
        print(
            "token missing: pass --token or set MSP_TOKEN (a Supabase access token)",
            file=sys.stderr,
        )
        return 1

    base_url = args.base_url.rstrip("/")
    api = Api(base_url, token)
    try:
        recipient = _resolve_recipient(api, client_ref, args.recipient.strip())
    except ApiError as error:
        print(f"could not resolve the demo address: {error}", file=sys.stderr)
        print(
            "wire the tenant first: python scripts/msp-onboard.py --tenant <id> "
            f"--domain <inbound domain> --client {client_ref}",
            file=sys.stderr,
        )
        if error.status in (401, 403):
            print(
                "  the token was rejected: use a fresh token with the agent or admin role",
                file=sys.stderr,
            )
        return 1
    sender = args.sender.strip() or f"jordan@{client_ref}.example"

    delivery: dict[str, object] = {
        "from": sender,
        "to": recipient,
        "subject": args.subject,
        "text": args.body,
    }
    if args.fresh:
        delivery["messageId"] = f"msp-demo-{int(time.time())}"
    try:
        intake = api.request("POST", "/intake/email", delivery)
    except ApiError as error:
        print(f"intake rejected the delivery: {error}", file=sys.stderr)
        if error.status in (401, 403):
            print(
                "  use a fresh token for a user with the agent or admin role",
                file=sys.stderr,
            )
        return 1

    if intake.get("deduped") is True:
        print(f"already filed as {intake.get('caseId')} (replay protected)")
        print("pass --fresh to file a new case inside the dedupe window")
        return 0

    run_id = str(intake["runId"])
    print(f"email in: {sender} -> {recipient}")
    print(f"  ticket {intake['ticketKey']}  case {intake['caseId']}  run {run_id}")

    started = time.monotonic()
    deadline = started + max(args.timeout, 5.0)
    run: dict[str, Any] = {}
    announced = ""
    decided: str | None = None
    while time.monotonic() < deadline:
        try:
            run = api.request("GET", f"/runs/{run_id}")
        except ApiError as error:
            print(f"could not read the run: {error}", file=sys.stderr)
            return 1
        status = str(run.get("status"))
        current = str(run.get("currentStepId") or "")
        marker = f"{status}:{current}"
        if marker != announced:
            print(f"  run {status}" + (f" at {current}" if current else ""))
            announced = marker
        if status in TERMINAL_STATUSES or (status == "awaiting_human" and not args.auto):
            break
        if status == "awaiting_human" and current != decided:
            try:
                api.request(
                    "POST",
                    f"/runs/{run_id}/steps/{current}/decision",
                    {"action": "proceed"},
                )
                decided = current
                print(f"    proceeded {current}")
            except ApiError as error:
                if error.status != 409:
                    print(f"decision for {current} failed: {error}", file=sys.stderr)
                    return 1
                # Raced a concurrent decision: re-poll and re-check.
        time.sleep(0.5)

    status = str(run.get("status", "unknown"))
    elapsed = time.monotonic() - started
    if status == "completed":
        print(f"run completed in {elapsed:.0f}s")
        _print_steps(run)
        _print_pack_hint(base_url, client_ref, args.month)
        return 0
    if status == "awaiting_human":
        print(f'parked on "{run.get("currentStepId")}" waiting for a human. in the console:')
        print(f"  1. open {args.ui_url} and find ticket {intake['ticketKey']}")
        print("  2. review the artifact, then Approve (or Edit first)")
        print("  3. keep approving until Send completes, then download the pack:")
        print(f"  {base_url}/msp/audit-pack?clientRef={client_ref}&month={args.month}&format=pdf")
        return 0
    if status in TERMINAL_STATUSES:
        print(f"run {status} after {elapsed:.0f}s")
        _print_steps(run)
        if run.get("outcome"):
            print(f"  outcome: {run['outcome']}")
        if run.get("cancelReason"):
            print(f"  reason: {run['cancelReason']}")
        return 1
    print(f"run is still {status} after {elapsed:.0f}s; watch it in {args.ui_url}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
