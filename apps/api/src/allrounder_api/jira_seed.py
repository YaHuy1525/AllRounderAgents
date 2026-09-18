"""Create workflow test tickets in the configured Jira project.

Idempotent: every ticket is deduped with an exact JQL summary search, so
re-runs skip what already exists. The set covers the finance-lane demo and
two test cases per console workflow (PR Review, Issue Resolution, Feature
Implementation, Dependency Update, Accessibility Audit, Vendor Onboarding).
"""

from __future__ import annotations

import sys
from typing import TypedDict

import httpx

from .jira_mcp import McpJiraTransport
from .settings import Settings


class TicketSpec(TypedDict):
    summary: str
    labels: list[str]
    description: str


TICKETS: tuple[TicketSpec, ...] = (
    # -- finance lane -------------------------------------------------------
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
    # -- PR Review ----------------------------------------------------------
    {
        "summary": "PR review: tenantId schema draft (AllRounderAgents PR 2, MCP proof)",
        "labels": ["review", "workflow-test"],
        "description": (
            "Workflow test case for PR Review. Review the open Draft PR 2 "
            "(\"Enhance ticket JSON schema with optional tenantId (MCP proof)\") "
            "in YaHuy1525/AllRounderAgents against main.\n\n"
            "Inspect the diff, confirm the schema change stays backwards compatible "
            "and post the verdict comment only — no merges. Start the run with "
            "repository YaHuy1525/AllRounderAgents and PR 2."
        ),
    },
    {
        "summary": "PR review: tenantId schema draft (AllRounderAgents PR 1, REST path)",
        "labels": ["review", "workflow-test"],
        "description": (
            "Workflow test case for PR Review. Review the open Draft PR 1 "
            "(\"Enhance ticket JSON schema with optional tenantId\") in "
            "YaHuy1525/AllRounderAgents against main.\n\n"
            "Inspect the diff, confirm the schema change stays backwards compatible "
            "and post the verdict comment only — no merges. Start the run with "
            "repository YaHuy1525/AllRounderAgents and PR 1."
        ),
    },
    # -- Issue Resolution ---------------------------------------------------
    {
        "summary": "Fix: unhandled API 500s bypass CORS and surface as network errors",
        "labels": ["bug", "workflow-test"],
        "description": (
            "Workflow test case for Issue Resolution. Unhandled exceptions in the "
            "FastAPI app are answered by Starlette's outermost error middleware, so "
            "the response bypasses CORSMiddleware and the console fetch shows "
            "\"The run could not reach the API\" instead of the real 500.\n\n"
            "Add CORS-safe JSON 500 responses so the console can read the status, "
            "keep the traceback in the API logs, and cover the behaviour with a test."
        ),
    },
    {
        "summary": "Fix: Mastra bridge failures drop the underlying cause from run errors",
        "labels": ["bug", "workflow-test"],
        "description": (
            "Workflow test case for Issue Resolution. When the Mastra start-async "
            "call fails, the run error is only \"Mastra request failed: "
            "/api/workflows/<flow>/start-async\" — the underlying httpx cause (for "
            "example connection refused when the Mastra host is down) is dropped.\n\n"
            "Include the underlying reason in MastraClientError so run failures "
            "point straight at the cause, and extend the bridge tests."
        ),
    },
    # -- Feature Implementation ---------------------------------------------
    {
        "summary": "Feature: show run duration and per-step timings in the run history",
        "labels": ["feature", "workflow-test"],
        "description": (
            "Workflow test case for Feature Implementation. Show elapsed time per "
            "step and the total duration of a run in the console run panel and the "
            "ticket run history.\n\n"
            "Derive the timings from existing run and step timestamps (started_at, "
            "step updated_at, finished_at); no new tables. Add a compact duration "
            "summary on completed runs."
        ),
    },
    {
        "summary": "Feature: expose per-workflow run counters on the metrics endpoint",
        "labels": ["feature", "workflow-test"],
        "description": (
            "Workflow test case for Feature Implementation. Expose per-workflow run "
            "counters on the metrics endpoint: started, completed, failed and "
            "awaiting-human totals per workflow id.\n\n"
            "Reuse the existing MetricsRegistry, keep the /metrics format "
            "Prometheus-compatible, and use a workflow label (for example "
            "allrounder_runs_total{workflow=...}) so Grafana can chart it."
        ),
    },
    # -- Dependency Update --------------------------------------------------
    {
        "summary": "Dependency upgrade: bump patch and minor versions across the npm workspace",
        "labels": ["dependency", "upgrade", "workflow-test"],
        "description": (
            "Workflow test case for Dependency Update. Scan the npm workspace "
            "manifests (root and approval-ui), group the safe patch and minor bumps "
            "(next, react, vitest, typescript and friends), apply them and run the "
            "build plus test suites.\n\n"
            "Leave major bumps out of the batch and present the grouped updates for "
            "the merge gate."
        ),
    },
    {
        "summary": "Dependency bump: align Python constraints in pyproject with installed versions",
        "labels": ["dependency", "bump", "workflow-test"],
        "description": (
            "Workflow test case for Dependency Update. Align the Python dependency "
            "ranges in pyproject.toml with the currently installed versions "
            "(fastapi, httpx, pydantic, psycopg, redis, structlog).\n\n"
            "Propose minimal range bumps only, run pytest, ruff and mypy, and stage "
            "the change for the merge gate."
        ),
    },
    # -- Accessibility Audit ------------------------------------------------
    {
        "summary": "Accessibility audit: console run panel keyboard access and contrast",
        "labels": ["accessibility", "a11y", "workflow-test"],
        "description": (
            "Workflow test case for Accessibility Audit. Crawl the approval console "
            "run panel (target URL http://localhost:3000) and collect the violations "
            "for keyboard access, focus order and colour contrast.\n\n"
            "Apply the fix set on the frontend markup and styles, re-scan to confirm "
            "the violations are resolved, then open the fix PR through the gate."
        ),
    },
    {
        "summary": "Accessibility audit: Jira board and ticket surfaces labels and focus order",
        "labels": ["accessibility", "a11y", "workflow-test"],
        "description": (
            "Workflow test case for Accessibility Audit. Crawl the Jira board and "
            "ticket surfaces of the console (target URL http://localhost:3000) and "
            "collect the violations for landmarks, labels and focus order.\n\n"
            "Apply the fix set, re-scan to confirm the violations are resolved, and "
            "open the fix PR through the gate."
        ),
    },
    # -- Vendor Onboarding --------------------------------------------------
    {
        "summary": "Vendor onboarding: Acme Analytics SaaS analytics US",
        "labels": ["vendor", "onboarding", "workflow-test"],
        "description": (
            "Workflow test case for Vendor Onboarding. Onboard Acme Analytics LLC "
            "(United States, tax id 88-1234567), a SaaS product-analytics vendor "
            "processing usage telemetry (no PII in this test).\n\n"
            "Requestor: finance operations. Collect the document set (SOC 2 report, "
            "DPA), verify the checks, score the risk and reach the create gate "
            "before the master record is written."
        ),
    },
    {
        "summary": "Vendor onboarding: Nordic Cloud Hosting AB infrastructure EU",
        "labels": ["vendor", "onboarding", "workflow-test"],
        "description": (
            "Workflow test case for Vendor Onboarding. Onboard Nordic Cloud Hosting "
            "AB (Sweden, tax id SE556123456701), an infrastructure hosting vendor "
            "with EU-only data residency.\n\n"
            "Requestor: platform engineering. Collect the security questionnaire and "
            "insurance certificate, verify the checks, score the risk and reach the "
            "create gate before the master record is written."
        ),
    },
)


def _adf(text: str) -> dict[str, object]:
    paragraphs = [part.strip() for part in text.split("\n\n") if part.strip()]
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": part}],
            }
            for part in paragraphs
        ],
    }


def _seed_via_mcp(
    settings: Settings,
    base_url: str,
    email: str,
    token: str,
    project: str,
) -> int:
    """MCP path: dedupe + create tickets through the Rovo server."""
    transport = McpJiraTransport(
        base_url,
        email,
        token,
        mcp_url=settings.atlassian_mcp_url,
        cloud_id=settings.jira_cloud_id,
    )
    try:
        created: list[str] = []
        for ticket in TICKETS:
            existing = transport.search_jql(
                f'project = "{project}" AND summary ~ "{ticket["summary"]}"',
                1,
            )
            if existing:
                key = existing[0].key
                created.append(key)
                print(f"{key} exists")
                continue
            key = transport.create_issue(
                project,
                ticket["summary"],
                issue_type="Task",
                labels=list(ticket["labels"]),
                description=ticket["description"],
            )
            created.append(key)
            print(key)
        print("created=" + ",".join(created))
        return 0
    except httpx.HTTPError as error:
        print(f"mcp_seed_failed {error}", file=sys.stderr)
        return 1
    finally:
        transport.close()


def _seed_via_rest(base_url: str, email: str, token: str, project: str) -> int:
    """Legacy REST path: seed tickets over the Jira REST API (ADF bodies)."""
    created: list[str] = []
    with httpx.Client(
        base_url=base_url,
        auth=(email, token),
        headers={"accept": "application/json", "content-type": "application/json"},
        timeout=20,
    ) as client:
        for ticket in TICKETS:
            existing = client.get(
                "/rest/api/3/search/jql",
                params={
                    "jql": f'project = "{project}" AND summary ~ "{ticket["summary"]}"',
                    "maxResults": 1,
                    "fields": "summary",
                },
            )
            if existing.status_code >= 400:
                # Fail loudly: a broken search must never seed duplicates.
                print(f"search_failed status={existing.status_code}", file=sys.stderr)
                print(existing.text, file=sys.stderr)
                return 1
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


def main() -> int:
    settings = Settings()
    base_url = settings.jira_base_url.rstrip("/")
    email = settings.jira_email
    token = settings.jira_api_token.get_secret_value()
    project = settings.jira_project_key
    if not base_url or not email or not token or not project:
        print("jira_env_missing", file=sys.stderr)
        return 1
    if settings.jira_transport == "mcp":
        return _seed_via_mcp(settings, base_url, email, token, project)
    return _seed_via_rest(base_url, email, token, project)


if __name__ == "__main__":
    raise SystemExit(main())
