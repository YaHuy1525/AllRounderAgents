"""Open a case record so a Jira ticket can start workflow runs from the console.

The console only renders the "Start a run" card when GET /tickets/<key>/status
finds a case; the Phase-0 routing worker that normally opens cases for webhook
traffic is not part of the compose stack. This helper inserts that row for a
ticket so the run panel becomes reachable locally.

Usage:
    python scripts/seed-case.py SCRUM-12
    python scripts/seed-case.py SCRUM-12 --domain finance --tenant omnidewalt
"""

from __future__ import annotations

import argparse
import sys

from allrounder_api.persistence import PsycopgExecutor
from allrounder_api.settings import Settings

DOMAINS = ("code", "finance", "marketing", "support", "unknown")


def main() -> int:
    parser = argparse.ArgumentParser(description="Open a case for a Jira ticket.")
    parser.add_argument("ticket_key", help="Jira ticket key, e.g. SCRUM-12")
    parser.add_argument("--domain", default="code", choices=DOMAINS)
    parser.add_argument(
        "--tenant",
        default="",
        help="tenant id; defaults to the first key of JIRA_TENANT_PROJECT_ALLOWLIST",
    )
    args = parser.parse_args()

    settings = Settings()
    tenant = args.tenant or next(iter(settings.jira_tenant_project_allowlist), "")
    if tenant == "":
        print(
            "tenant missing: pass --tenant or set JIRA_TENANT_PROJECT_ALLOWLIST",
            file=sys.stderr,
        )
        return 1

    executor = PsycopgExecutor(settings.database_url.get_secret_value())
    try:
        executor.execute(
            """
            insert into public.cases (ticket_key, domain, status, tenant_id)
            select %s, %s, 'open', %s
            where not exists (
                select 1 from public.cases
                where ticket_key = %s and tenant_id = %s
            )
            """,
            (args.ticket_key, args.domain, tenant, args.ticket_key, tenant),
        )
    finally:
        executor.close()
    print(f"case ready for {args.ticket_key} (domain={args.domain}, tenant={tenant})")
    print("reload the ticket tab to see the Start a run card")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
