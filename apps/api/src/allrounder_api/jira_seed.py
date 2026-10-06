"""Create workflow test tickets in the configured Jira project.

Idempotent: every ticket is deduped with an exact JQL summary search, so
re-runs skip what already exists. The set covers the finance-lane demo and
two test cases per console workflow (PR Review, Issue Resolution, Feature
Implementation, Dependency Update, Accessibility Audit, Vendor Onboarding,
Leave Request, New-Hire Onboarding, Employee Offboarding, Candidate
Screening, HR Help), plus the two security-lane alerts in the ``SEC``
project. The MSP and Bills lanes start from email intake instead of Jira
tickets, so the demo scripts seed those two, not this one.
"""

from __future__ import annotations

import sys
from typing import NotRequired, TypedDict

import httpx

from .jira_mcp import McpJiraTransport
from .settings import Settings


class TicketSpec(TypedDict):
    summary: str
    labels: list[str]
    description: str
    # Tickets default to the configured project; SEC alerts target Jira's
    # security project so PROJECT_DOMAINS routes them into the security lane.
    project: NotRequired[str]


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
    # -- Leave Request ------------------------------------------------------
    {
        "summary": "Leave request: annual leave for Iris Lindqvist (October week)",
        "labels": ["leave", "workflow-test"],
        "description": (
            "Workflow test case for Leave Request. Iris Lindqvist (E-2016, Site "
            "Reliability Engineer) requests five working days of annual leave "
            "from 2026-10-19 to 2026-10-23. The policy checks should all pass: "
            "balance (20 days on file), no overlapping bookings, no blackout "
            "window inside the range, and notice well past the three-day "
            "target.\n\n"
            "Approve the request and confirm the booking is idempotent on a "
            "retry. Start the run with employee E-2016, leave type annual, "
            "start 2026-10-19, end 2026-10-23."
        ),
    },
    {
        "summary": "Leave request: year-end leave that crosses the close blackout",
        "labels": ["leave", "workflow-test"],
        "description": (
            "Workflow test case for Leave Request. Leo Bianchi (E-2044, Backend "
            "Engineer) requests annual leave from 2026-12-21 to 2026-12-30. The "
            "range sits inside the Year-end close blackout (2026-12-21 to "
            "2026-12-31), so the policy check returns exception_required and "
            "the approve gate carries the exception sign-off. The Christmas "
            "holidays inside the range are not deducted from the balance.\n\n"
            "This exercises the flagged path, not the happy path. Start the run "
            "with employee E-2044, leave type annual, start 2026-12-21, end "
            "2026-12-30."
        ),
    },
    # -- New-Hire Onboarding ------------------------------------------------
    {
        "summary": "New hire onboarding: backend engineer starting 2026-10-19",
        "labels": ["onboarding", "workflow-test"],
        "description": (
            "Workflow test case for New-Hire Onboarding. Sofia Lindgren joins "
            "as Backend Engineer in Engineering, working from Berlin, starting "
            "2026-10-19, reporting to manager E-2003, with a medium access "
            "tier (signers: People Partner and Department Head).\n\n"
            "Collect the paperwork, verify the checks, score the access risk, "
            "and reach the signer gate before provisioning; provisioning is "
            "idempotent by employee ID. Start the run with full name Sofia "
            "Lindgren, role Backend Engineer, department Engineering, location "
            "Berlin, start date 2026-10-19, manager E-2003, access tier medium."
        ),
    },
    {
        "summary": "New hire onboarding: finance director hire with high access",
        "labels": ["onboarding", "workflow-test"],
        "description": (
            "Workflow test case for New-Hire Onboarding. Amelia Ortiz joins as "
            "Director of Finance Operations in Finance, based in Lisbon, "
            "starting 2026-11-02, reporting to manager E-2094 (VP of Finance), "
            "with a high access tier. High tier raises the risk score and "
            "requires three signers: People Partner, Department Head, and "
            "People Ops Director.\n\n"
            "This exercises the elevated risk path and the full signer chain. "
            "Start the run with full name Amelia Ortiz, role Director of "
            "Finance Operations, department Finance, location Lisbon, start "
            "date 2026-11-02, manager E-2094, access tier high."
        ),
    },
    # -- Employee Offboarding -----------------------------------------------
    {
        "summary": (
            "Offboarding: Mona Marchetti, site reliability engineer, last day "
            "2026-10-31"
        ),
        "labels": ["offboarding", "workflow-test"],
        "description": (
            "Workflow test case for Employee Offboarding. Mona Marchetti "
            "(E-2053, Site Reliability Engineer, Engineering, high access "
            "tier) departs on 2026-10-31. Her eleven systems include aws, "
            "github and okta, so the blast-radius audit is expected to surface "
            "several high-blast revocations that need explicit per-item "
            "approval, and irreversible actions need an export first.\n\n"
            "Revocations are idempotent per employee and system; the case "
            "close is attested at the end. Start the run with employee E-2053, "
            "last day 2026-10-31, reason resignation accepted."
        ),
    },
    {
        "summary": "Offboarding: Felix Eriksen, sales engineer, last day 2026-11-13",
        "labels": ["offboarding", "workflow-test"],
        "description": (
            "Workflow test case for Employee Offboarding. Felix Eriksen "
            "(E-2093, Sales Engineer, Sales, low access tier) departs on "
            "2026-11-13. His nine systems are mostly sales tooling (gong, "
            "zendesk, workday) with aws, github and okta in the mix, a lighter "
            "contrast to the high-access offboarding case.\n\n"
            "Start the run with employee E-2093, last day 2026-11-13, reason "
            "voluntary departure."
        ),
    },
    # -- Candidate Screening ------------------------------------------------
    {
        "summary": "Candidate screening: senior backend engineer pipeline (REQ-5001)",
        "labels": ["screening", "recruiting", "workflow-test"],
        "description": (
            "Workflow test case for Candidate Screening. Screen the five "
            "REQ-5001 candidates against the weighted rubric from the "
            "requisition: API design and TypeScript are the must-haves, with "
            "distributed systems, testing and mentoring behind them. "
            "Interviewers are E-2002 and E-2003.\n\n"
            "Review the shortlist with citations and guardrail flags, then "
            "schedule the interviews. Start the run with requisition REQ-5001."
        ),
    },
    {
        "summary": "Candidate screening: growth marketer pipeline (REQ-5006)",
        "labels": ["screening", "recruiting", "workflow-test"],
        "description": (
            "Workflow test case for Candidate Screening. Screen the five "
            "REQ-5006 candidates against the requisition rubric: "
            "experimentation is the must-have, with analytics, SEO, "
            "copywriting and lifecycle as the weighted criteria. Interviewers "
            "are E-2160 and E-2161.\n\n"
            "Review the shortlist with citations and guardrail flags, then "
            "schedule the interviews. Start the run with requisition REQ-5006."
        ),
    },
    # -- HR Help ------------------------------------------------------------
    {
        "summary": (
            "HR help: what is the home office stipend and is the legacy figure "
            "still valid"
        ),
        "labels": ["hr-help", "handbook", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. Question: \"What is the monthly "
            "home office stipend for remote employees, and is the 500 EUR "
            "legacy figure still in force?\"\n\n"
            "The policy corpus holds a superseded legacy document, so the "
            "cited answer must quote the current Remote Work policy (300 EUR "
            "per month) and note that the legacy document is audit history "
            "only. Start the run with that question verbatim."
        ),
    },
    {
        "summary": "HR help: annual leave carry-over and sick leave interaction",
        "labels": ["hr-help", "handbook", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. Question: \"How many unused "
            "annual leave days can I carry into next year, by when must they "
            "be used, and does sick leave reduce my annual balance?\"\n\n"
            "The cited answer should quote the Leave and Time Off policy: up "
            "to five days carried, used before March 31, and sick leave does "
            "not reduce the annual balance. Start the run with that question "
            "verbatim."
        ),
    },
    # -- Security lane (SEC project) ----------------------------------------
    {
        "summary": "Security alert: credential phishing email reported by finance",
        "labels": ["security", "phishing", "workflow-test"],
        "project": "SEC",
        "description": (
            "Workflow test case for the security lane. A user reported a "
            "credential-harvesting page at https://evil-login.example/login that "
            "mimics the SSO portal (T1566 / T1566.001); no credentials were entered.\n\n"
            "Start the security run with alertSource email and the reported "
            "indicators; the lane resolves the URL and host before the decide gate."
        ),
    },
    {
        "summary": "Security alert: suspicious encoded PowerShell on fin-db-01 (EDR)",
        "labels": ["security", "edr", "workflow-test"],
        "project": "SEC",
        "description": (
            "Workflow test case for the security lane. EDR flagged powershell.exe "
            "running with -enc on fin-db-01 (user FIN\\svc-backup): the base64 "
            "payload registers a scheduled task named WinUpdate and beacons to "
            "203.0.113.77 (T1059.001, T1053.005, T1071).\n\n"
            "Start the security run with alertSource edr, host fin-db-01 and the c2 "
            "indicator; containment executes only with the signed security:contain "
            "receipt at the decide/approve/contain checkpoints."
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
            ticket_project = ticket.get("project", project)
            existing = transport.search_jql(
                f'project = "{ticket_project}" AND summary ~ "{ticket["summary"]}"',
                1,
            )
            if existing:
                key = existing[0].key
                created.append(key)
                print(f"{key} exists")
                continue
            key = transport.create_issue(
                ticket_project,
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
    failed: list[str] = []
    with httpx.Client(
        base_url=base_url,
        auth=(email, token),
        headers={"accept": "application/json", "content-type": "application/json"},
        timeout=20,
    ) as client:
        for ticket in TICKETS:
            ticket_project = ticket.get("project", project)
            existing = client.get(
                "/rest/api/3/search/jql",
                params={
                    "jql": f'project = "{ticket_project}" AND summary ~ "{ticket["summary"]}"',
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
                        "project": {"key": ticket_project},
                        "issuetype": {"name": "Task"},
                        "summary": ticket["summary"],
                        "labels": ticket["labels"],
                        "description": _adf(ticket["description"]),
                    }
                },
            )
            if response.status_code >= 400:
                failed.append(str(ticket["summary"]))
                print(
                    f"create_failed project={ticket_project} "
                    f"status={response.status_code}",
                    file=sys.stderr,
                )
                print(response.text, file=sys.stderr)
                continue
            key = str(response.json().get("key", ""))
            if not key:
                failed.append(str(ticket["summary"]))
                print("create_failed missing_key", file=sys.stderr)
                continue
            created.append(key)
            print(key)
    print("created=" + ",".join(created))
    if failed:
        print("failed=" + "|".join(failed), file=sys.stderr)
        return 1
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
