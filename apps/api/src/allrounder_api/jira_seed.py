"""Create finance-lane test issues in the configured Jira project."""

from __future__ import annotations

import sys
from typing import TypedDict

import httpx

from .settings import Settings


class TicketSpec(TypedDict):
    summary: str
    labels: list[str]
    description: str


TICKETS: tuple[TicketSpec, ...] = (
    {
        "summary": "Reconcile September month-end ledger against bank",
        "labels": ["finance", "reconciliation", "ledger"],
        "description": (
            "Compare the September ledger to bank deposits. Flag unmatched journal "
            "items and keep posting read-only until an approval receipt exists."
        ),
    },
    {
        "summary": "Invoice variance requires audit",
        "labels": ["finance", "invoice", "audit"],
        "description": (
            "INV-2 ledger and bank amounts differ. Produce an audit pack before any "
            "sandbox journal posting."
        ),
    },
    {
        "summary": "Unmatched bank deposit needs treasury RCA",
        "labels": ["finance", "bank", "treasury"],
        "description": (
            "DEP-9 arrived on the bank file with no ledger match. Route to treasury "
            "for cutoff and deposits-in-transit RCA."
        ),
    },
    {
        "summary": "Journal posting request for adjusting entry",
        "labels": ["finance", "journal", "variance"],
        "description": (
            "Request a sandbox journal for month-end adjusting entries. Do not post "
            "to any live ledger without a finance:post approval receipt."
        ),
    },
)


def _adf(text: str) -> dict[str, object]:
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": text}],
            }
        ],
    }


def main() -> int:
    settings = Settings()
    base_url = settings.jira_base_url.rstrip("/")
    email = settings.jira_email
    token = settings.jira_api_token.get_secret_value()
    project = settings.jira_project_key
    if not base_url or not email or not token or not project:
        print("jira_env_missing", file=sys.stderr)
        return 1
    created: list[str] = []
    with httpx.Client(
        base_url=base_url,
        auth=(email, token),
        headers={"accept": "application/json", "content-type": "application/json"},
        timeout=20,
    ) as client:
        for ticket in TICKETS:
            existing = client.post(
                "/rest/api/3/search",
                json={
                    "jql": f'project = "{project}" AND summary ~ "{ticket["summary"]}"',
                    "maxResults": 1,
                    "fields": ["summary"],
                },
            )
            if existing.status_code == 200:
                issues = existing.json().get("issues") or []
                if issues:
                    key = str(issues[0].get("key", ""))
                    if key:
                        created.append(key)
                        print(f"{key} exists")
                        continue
            response = client.post(
                "/rest/api/3/issue",
                json={
                    "fields": {
                        "project": {"key": project},
                        "issuetype": {"name": "Task"},
                        "summary": ticket["summary"],
                        "labels": ticket["labels"],
                        "description": _adf(ticket["description"]),
                    }
                },
            )
            if response.status_code >= 400:
                print(f"create_failed status={response.status_code}", file=sys.stderr)
                print(response.text, file=sys.stderr)
                return 1
            key = str(response.json().get("key", ""))
            if not key:
                print("create_failed missing_key", file=sys.stderr)
                return 1
            created.append(key)
            print(key)
    print("created=" + ",".join(created))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
