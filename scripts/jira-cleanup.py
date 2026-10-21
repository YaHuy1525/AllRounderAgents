"""Delete stale workflow test tickets (default: SCRUM-1..10).

One-off cleanup for the pre-refresh test batches. Deletes subtasks first,
then parent issues with ``deleteSubtasks=true``, and relists the project at
the end so the result is verifiable. Reads credentials from the shared
``Settings`` (.env) and never prints the token.

Usage:
    python scripts/jira-cleanup.py --dry-run
    python scripts/jira-cleanup.py
    python scripts/jira-cleanup.py --keys SCRUM-1,SCRUM-2
"""

from __future__ import annotations

import argparse
import sys

import httpx

from allrounder_api.jira import HttpJiraTransport
from allrounder_api.settings import Settings


def _default_keys() -> list[str]:
    return [f"SCRUM-{number}" for number in range(1, 11)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--keys",
        default="",
        help="comma-separated ticket keys; defaults to SCRUM-1..10",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="list what would be deleted without deleting anything",
    )
    args = parser.parse_args()

    settings = Settings()
    base_url = settings.jira_base_url.rstrip("/")
    email = settings.jira_email
    token = settings.jira_api_token.get_secret_value()
    if not base_url or not email or not token:
        print("jira_env_missing", file=sys.stderr)
        return 1

    keys = [key.strip() for key in args.keys.split(",") if key.strip()] or _default_keys()

    with httpx.Client(
        base_url=base_url,
        auth=(email, token),
        headers={"accept": "application/json"},
        timeout=20,
    ) as client:
        transport = HttpJiraTransport(base_url, email, token, client=client)

        # Subtasks go first (their parent's deleteSubtasks flag never has to
        # cope with an already-orphaned child), parents follow.
        entries: list[tuple[str, bool]] = []
        for key in keys:
            response = client.get(
                f"/rest/api/3/issue/{key}",
                params={"fields": "issuetype"},
            )
            if response.status_code == 404:
                print(f"{key} already gone")
                continue
            if response.status_code >= 400:
                print(f"{key} lookup_failed status={response.status_code}", file=sys.stderr)
                return 1
            fields = response.json().get("fields") or {}
            issue_type = fields.get("issuetype") or {}
            is_subtask = bool(issue_type.get("subtask")) or issue_type.get("name") == "Subtask"
            entries.append((key, not is_subtask))

        # Subtasks first: a parent delete with deleteSubtasks=true would
        # otherwise swallow its children and turn their deletes into 404s.
        entries.sort(key=lambda entry: entry[1])

        if args.dry_run:
            for key, delete_subtasks in entries:
                print(f"would delete {key} (deleteSubtasks={delete_subtasks})")
            return 0

        failures: list[str] = []
        for key, delete_subtasks in entries:
            try:
                transport.delete_issue(key, delete_subtasks=delete_subtasks)
            except httpx.HTTPStatusError as error:
                if error.response.status_code == 404:
                    print(f"{key} already gone")
                    continue
                failures.append(key)
                print(
                    f"{key} delete_failed status={error.response.status_code}",
                    file=sys.stderr,
                )
                continue
            print(f"{key} deleted")

        # Relist the project so the cleanup is verifiable at a glance.
        response = client.get(
            "/rest/api/3/search/jql",
            params={
                "jql": f'project = "{settings.jira_project_key}" ORDER BY key ASC',
                "maxResults": 100,
                "fields": "summary",
            },
        )
        if response.status_code >= 400:
            print(f"relist_failed status={response.status_code}", file=sys.stderr)
            return 1
        remaining = [str(issue.get("key")) for issue in response.json().get("issues") or []]
        print("remaining=" + ",".join(remaining))

        if failures:
            print("failed=" + ",".join(failures), file=sys.stderr)
            return 1
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
