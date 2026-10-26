"""Create workflow test tickets in the configured Jira project.

Idempotent: every ticket is deduped with an exact JQL summary search, so
re-runs skip what already exists. The set covers two test cases per console
workflow (PR Review, Issue Resolution, Feature Implementation, Dependency
Update, Accessibility Audit, Vendor Onboarding, Leave Request, New-Hire
Onboarding, Employee Offboarding, Candidate Screening, HR Help), plus the
two security-lane alerts and the coding-lane refresh
batch anchored to the open Draft PRs. The MSP and Bills lanes start from
email intake instead of Jira tickets, so the demo scripts seed those two,
not this one.

``--match`` seeds only the tickets whose summary or labels contain the given
text.
"""

from __future__ import annotations

import argparse
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
    # -- Security lane (keyword-routed to the security workflow) ------------
    {
        "summary": "Security alert: credential phishing email reported by finance",
        "labels": ["security", "phishing", "workflow-test"],
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
    # -- coding lane refresh (docs drafts first, then self-contained work) ---
    {
        "summary": "PR review: smart-ac usage guide draft (smart-ac PR 2)",
        "labels": ["review", "workflow-test", "coding"],
        "description": (
            "Workflow test case for PR Review. Review the open Draft PR 2 "
            "(\"Add docs/usage.md: Smart AC usage guide\") in YaHuy1525/smart-ac "
            "against main.\n\n"
            "Inspect the diff, confirm the quick-start commands and the port table "
            "match the stack described in smart-ac/README.md, and post the verdict "
            "comment only — no merges. Start the run with repository "
            "YaHuy1525/smart-ac and PR 2."
        ),
    },
    {
        "summary": "PR review: coding lane smoke-test runbook draft (AllRounderAgents PR 3)",
        "labels": ["review", "workflow-test", "coding"],
        "description": (
            "Workflow test case for PR Review. Review the open Draft PR 3 "
            "(\"Add docs/coding-lane-smoke-test.md: coding lane smoke test\") in "
            "YaHuy1525/AllRounderAgents against main.\n\n"
            "Inspect the diff, check the seeding and start-run steps against the "
            "console flow, and post the verdict comment only — no merges. Start "
            "the run with repository YaHuy1525/AllRounderAgents and PR 3."
        ),
    },
    {
        "summary": "Fix: smart-ac README references architecture diagrams missing from the repo",
        "labels": ["bug", "workflow-test", "coding"],
        "description": (
            "Workflow test case for Issue Resolution. smart-ac/README.md renders "
            "two image references (../architecture_diagram.png and "
            "../data_flow_diagram.png) that do not exist anywhere in the "
            "repository, so both diagrams are broken on GitHub.\n\n"
            "Either commit the exported diagrams to the repository root or correct "
            "the references, keeping the README structure intact. Keep the change "
            "to the README plus the two assets."
        ),
    },
    {
        "summary": "Fix: list-gh-repos.mjs caps the listing at the first page of repositories",
        "labels": ["bug", "workflow-test", "coding"],
        "description": (
            "Workflow test case for Issue Resolution. scripts/list-gh-repos.mjs "
            "calls /user/repos with per_page=100 and never follows pagination, so "
            "accounts with more than 100 repositories are silently truncated.\n\n"
            "Follow the Link header (or loop pages) until the listing is "
            "exhausted, keep the current output format, and keep the guarantee "
            "that the token is never printed. Update the header comment if "
            "needed."
        ),
    },
    {
        "summary": "Feature: add JSON output to list-gh-repos.mjs",
        "labels": ["feature", "workflow-test", "coding"],
        "description": (
            "Workflow test case for Feature Implementation. Add a --json flag to "
            "scripts/list-gh-repos.mjs that prints the repository list as a JSON "
            "array of {full_name, private, default_branch, push} objects so "
            "scripts and CI can consume it.\n\n"
            "The default human-readable output must stay unchanged and the token "
            "must never appear in either format. Small change: one script."
        ),
    },
    {
        "summary": "Feature: add Jest coverage for the queue emulator semantics",
        "labels": ["feature", "workflow-test", "coding"],
        "description": (
            "Workflow test case for Feature Implementation. The queue emulator "
            "(smart-ac/services/queue, backed by its REST server.js) implements "
            "SQS-style semantics but ships without tests, and the tests/ "
            "directory the README's layout documents is absent from the repo.\n\n"
            "Recreate smart-ac/tests/ with Jest unit tests covering the "
            "documented queue behaviour: visibility timeout on receive, "
            "receipt-handle delete, at-least-once redelivery after expiry and "
            "the depth stats endpoint — no containers required. Keep the jest "
            "--runInBand setup working from smart-ac/."
        ),
    },
    {
        "summary": (
            "Dependency upgrade: smart-ac manifest audit "
            "(jest range and lockfile freshness)"
        ),
        "labels": ["dependency", "upgrade", "workflow-test", "coding"],
        "description": (
            "Workflow test case for Dependency Update. Audit smart-ac/package.json "
            "and smart-ac/package-lock.json: bump the jest dev dependency to the "
            "latest 29.x patch, sync the lockfile, and confirm npm test still "
            "passes from smart-ac/.\n\n"
            "No major version jumps; present the grouped change for the merge "
            "gate."
        ),
    },
    {
        "summary": "Accessibility audit: new-tab run launcher keyboard access and focus order",
        "labels": ["accessibility", "a11y", "workflow-test", "coding"],
        "description": (
            "Workflow test case for Accessibility Audit. Crawl the console "
            "run-launcher surfaces (target URL http://localhost:3000): the "
            "+ tab ticket picker, the workflow list, the describe-your-own-run "
            "form and the Start a run card.\n\n"
            "Collect the violations for labels, landmarks, focus order and "
            "keyboard reachability, apply the fix set on the frontend markup and "
            "styles, re-scan to confirm the violations are resolved, then open "
            "the fix PR through the gate."
        ),
    },
    # -- Wukong upgrade backlog (remaining N items) -------------------------
    {
        "summary": "Feature: branch, loop and delay step kinds with a merge-once receipt pilot",
        "labels": ["wukong", "coding", "workflow-test"],
        "description": (
            "Extend the run model beyond linear steps. StepDefinition gains kind "
            "(linear, branch, loop or delay) plus arms and merge metadata snapshotted "
            "at run start. A branch step fans into 2 to 11 arms that run in parallel "
            "where safe, loops repeat with per-iteration data pills, and delays wait "
            "before continuing. The merge requires every arm to finish and mints one "
            "single-use receipt for the whole fan-out.\n\n"
            "Pilot one lane first: the SOC investigate step as a 3-arm fan-out "
            "(identity, endpoint and network evidence) merged into the existing "
            "evidence pack output. Fan-out stays behind the existing ceilings and "
            "locks, side effects still happen only at merge with a single actionHash, "
            "and the graph stays a read-only overlay while the linear rail remains "
            "the source of truth (no free-form DAG saving).\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md section N4, "
            "slice 4 (automate). Done when the pilot branch runs its arms safely, "
            "merges once with a single receipt, and the governance suite stays green."
        ),
    },
    {
        "summary": "Feature: run triggers for schedule, webhook and callable entries",
        "labels": ["wukong", "coding", "workflow-test"],
        "description": (
            "Runs today start only from the Start-run card (plus the Jira webhook "
            "entry). Add three thin trigger entries that funnel into POST /runs with "
            "eventId idempotency and the existing policy gate: a schedule (cron with "
            "timezone, sequential wait or concurrent overlap), a per-workflow webhook "
            "URL for external pushes, and a callable entry so one run can invoke "
            "another synchronously (wait for the result) or asynchronously (fire and "
            "forget).\n\n"
            "No new execution path: every trigger produces the same receipted run "
            "history as a manual start, and callable runs carry the caller context "
            "only when explicitly configured. Expose the trigger settings on the "
            "workflow detail view.\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md section N5, "
            "slice 4. Done when a scheduled run and a webhook run both produce "
            "identically receipted histories as manual runs."
        ),
    },
    {
        "summary": "Feature: test-run sandbox with a dry-run flag and zero side effects",
        "labels": ["wukong", "coding", "workflow-test"],
        "description": (
            "Every run is live today, so users hesitate before pressing Proceed. Add "
            "a Test run action next to Start run: an input.dryRun flag runs the full "
            "pass with real inputs while every side-effecting step records what it "
            "would do and writes nothing. No receipt is minted and no external call "
            "is made. The run panel shows a DRY RUN banner with per-node inputs and "
            "outputs, then offers Discard or Activate, where Activate starts the live "
            "run from the same inputs.\n\n"
            "Enforce the regeneration budget through the existing regenerations cap "
            "and surface dry-run counters through metrics so adoption is "
            "measurable.\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md section N6, "
            "slice 4. Done when a dry run shows per-node input and output with no "
            "receipt minted and no external write, and the same inputs activate as a "
            "live run."
        ),
    },
    {
        "summary": "Feature: Slack approver mirror for run-step decisions",
        "labels": ["wukong", "workflow-test"],
        "description": (
            "Approvers live in chat, not in the console. Mirror awaiting decisions "
            "into Slack: a card per awaiting step (title, step, receipt hash, "
            "Approve and Deny buttons) posted to a channel scoped by tenant_id. "
            "Pressing a button calls the same decision endpoint with the same signed "
            "single-use receipt as the web action, so Slack and web approvals are "
            "interchangeable and a replay returns the original receipt.\n\n"
            "Mirror only: no inbound execution and no second writer. Add a "
            "slack:approve entry to policy/tools.yaml (class approval), keep "
            "ApprovalsView parity, and take the channel and workspace from the "
            "connector registry (N2).\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md section N8, "
            "slice 5 (scale). Done when a Slack approval and a web approval of the "
            "same step produce identical receipts."
        ),
    },
    {
        "summary": "Feature: eval workbench for datasets, experiments and scorer comparisons",
        "labels": ["wukong", "coding", "workflow-test"],
        "description": (
            "Evals are files today (evals/*.jsonl plus the lane-evals vitest "
            "harness) and invisible to users. Promote them to a Datasets page "
            "(import CSV or JSON, pin versions) and an Experiments page (run every "
            "item, attach scorers) with a side-by-side comparison of two runs and "
            "their score deltas.\n\n"
            "Reuse the test_knowledge_hybrid.py harness and the calibrated judge "
            "harness, and surface the per-tenant RetrievalTuning knobs (rrf_k, "
            "recall_k) in a Settings eval section. Keep the golden-eval gate for "
            "dispatcher routing intact.\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md section N9, "
            "slice 5. Done when a non-engineer runs an experiment and can cite the "
            "score delta in a decision."
        ),
    },
    {
        "summary": "Feature: knowledge catalog and lineage read-only views",
        "labels": ["wukong", "kb", "workflow-test"],
        "description": (
            "Auditors ask where an answer came from. Add read-only "
            "GET /knowledge/catalog and GET /knowledge/lineage endpoints over the "
            "existing kb_documents and kb_chunks tables (source, version, stale "
            "flag, pull time), plus an Observability tab section with a Sources page "
            "and a Lineage drawer that walks answer to note to roster to pull "
            "time.\n\n"
            "Strictly read-only: no write engine, no background auto-merge and no "
            "bulk ETL designer. Golden-record preview appears only inside "
            "receipt-bound steps (vendors:create by tax ID), and the per-line "
            "source chips on KB answers link into the lineage drawer.\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md section "
            "N10, slice 5. Done when any answer traces to its source, version and "
            "pull time in two clicks."
        ),
    },
    {
        "summary": "Feature: ranked board strips for blocked, overdue and awaiting-you cases",
        "labels": ["wukong", "coding", "workflow-test"],
        "description": (
            "Board columns are static lists with a user-chosen sort, so a lead "
            "with thirty open cases cannot see which ones need them first. Add "
            "ranked board strips where each strip sorts one result set by one "
            "plain question. Awaiting-you ranks cases assigned to the viewer "
            "that sit on a gate, blocked ranks cases stuck behind a ceiling, a "
            "lock or a failure, and overdue ranks cases past their SLA or due "
            "date. Build it once and reuse it on the board, runs, finance and "
            "hiring views, with the scoring formula swapped per lane.\n\n"
            "Scores must be deterministic arithmetic over data that already "
            "exists, following the deterministic-first rule of the plan. A rank "
            "is a sort hint and never an execution path. Awaiting steps keep "
            "their receipt chips and the manual sort stays available.\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md "
            "section F3, the board scores half of slice 2. Done when a lead "
            "opens the board, sees the top three awaiting cases in order and "
            "can explain every score from visible data."
        ),
    },
    {
        "summary": "Feature: save an approved draft as a reusable lane template",
        "labels": ["wukong", "coding", "workflow-test"],
        "description": (
            "The template gallery shows the twelve curated workflows, but the "
            "good answers people write at decision gates never come back. Add a "
            "save-as-template action to an approved decision: the draft text and "
            "its field map become a lane-scoped template any permitted agent can "
            "start from, and the card shows the author, the originating case and "
            "the approval behind it.\n\n"
            "Templates stay curated and reviewable. Saving requires the agent or "
            "admin role, the stored template keeps a provenance link to the "
            "approved run, and a run started from a template still walks the "
            "full gate chain, so no approval is skipped because the content "
            "looks trusted. No bulk import, the same governance line the "
            "gallery keeps.\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md "
            "section F10, the playbook reuse follow-on to slice 3. Done when a "
            "saved support reply appears in the gallery, launches a fresh run "
            "and that run cites the template provenance."
        ),
    },
    {
        "summary": "Feature: Gmail and Calendar vault consumption with cross-platform proof runs",
        "labels": ["wukong", "coding", "workflow-test"],
        "description": (
            "The connector registry lists Gmail and Calendar and the vault "
            "stores credentials, but no lane step reads them, so the promised "
            "cross-platform proof is unreachable. Wire the consumers: the hr "
            "lanes and the timeline read Gmail threads and calendar events "
            "through the vault reference for the tenant, filed into the merged "
            "case feed, and every new write gains a tool-matrix entry plus a "
            "side-effect scope before it ships.\n\n"
            "Nothing changes about how runs execute. Proof runs are receipted "
            "exactly like manual runs, and this wiring shares the one-writer "
            "rule with the Slack mirror.\n\n"
            "Plan: docs/AllRounderAgent_Wukong_Upgrade_Guide_20261006.md "
            "section N2, slice 4 (cross-platform proof). Done when an HR answer "
            "citing a Gmail thread and a timeline carrying a calendar event "
            "both complete end to end using vault-stored credentials only."
        ),
    },
    # -- Agent workflow benchmarking (A2I2 project alignment) ----------------
    {
        "summary": "Task: add bare, test-first and spec-driven workflow profiles for coding runs",
        "labels": ["benchmark", "coding", "workflow-test"],
        "description": (
            "The benchmark question is how the process around a coding agent "
            "changes what it produces, so the first requirement is a way to "
            "switch the process on and off. Add named workflow profiles to the "
            "coding lane intake: bare (vendor default, describe and go), "
            "test-first (failing tests authored before implementation and "
            "required green), and spec-driven (full written spec, contract "
            "output and the review gate, which is how the lanes run today). A "
            "profile is run input stored on the run record, never a hidden "
            "execution branch, and every gate a profile enables still needs "
            "its own human approval.\n\n"
            "Benchmark brief: Deakin A2I2 project 'Benchmarking Agent "
            "Workflows for Software Development', objective 1 (identify "
            "agentic workflows from no process to spec-driven). Done when "
            "one coding task can be launched under each of the three "
            "profiles and the run record shows which profile produced it."
        ),
    },
    {
        "summary": (
            "Feature: pin a benchmark task suite from board tickets and a small "
            "fresh project"
        ),
        "labels": ["benchmark", "coding", "workflow-test"],
        "description": (
            "Experiments need fixed material. Assemble the benchmark task "
            "suite: a pinned selection of representative coding tasks drawn "
            "from this repository (the coding lane refresh tickets are the "
            "candidate pool) plus one small greenfield project built only to "
            "host benchmark tasks. Pin every task to an immutable snapshot: "
            "repository, starting commit, task statement, and the checks "
            "that decide success, stored as a fixtures file next to the "
            "golden tickets so a rerun months later starts from the exact "
            "same state.\n\n"
            "Benchmark brief: objective 2 (coding tasks from an existing "
            "repository and a new small project). Done when the suite file "
            "lists at least eight tasks, each replayable from its pinned "
            "commit, and a smoke check proves the suite loads without "
            "touching live models."
        ),
    },
    {
        "summary": (
            "Task: build a benchmark runner that replays every task under every "
            "workflow profile"
        ),
        "labels": ["benchmark", "coding", "workflow-test"],
        "description": (
            "Add the experiment driver: for each task in the pinned suite and "
            "each workflow profile, launch the coding lane run, let it walk "
            "its gates in automated test mode, and archive the result. Every "
            "archived run carries the task id, the profile tag, the pinned "
            "commit and the full run log, so run_archive becomes the durable "
            "evidence store behind the harness. The runner is resumable, "
            "idempotent per task and profile pair, and bounded by the "
            "existing run ceilings so a full sweep cannot flood the serving "
            "plane or the model budget.\n\n"
            "Benchmark brief: objective 3 (run experiments across every "
            "task under every workflow) and expected outcome 1 (a working "
            "test harness with run logs for every workflow). Done when one "
            "command completes the full matrix and every cell has a "
            "terminal run with a retrievable log."
        ),
    },
    {
        "summary": "Feature: per-profile quality and cost comparison on the benchmark scorecard",
        "labels": ["benchmark", "coding", "workflow-test"],
        "description": (
            "The scorecard endpoint already aggregates terminal coding-lane "
            "runs into pass rate, cost per pass, approval gate counts and "
            "self-corrections. Extend it to group by workflow profile and "
            "task, so each profile shows its own pass rate, cost per pass, "
            "gate load and self-correction rate side by side. Add one "
            "quality column scored by the calibrated judge over the produced "
            "diff against the task's pinned checks, keeping aggregation "
            "deterministic arithmetic over archived runs.\n\n"
            "Benchmark brief: objective 4 (compare and analyse the "
            "results). Done when GET /metrics/benchmark returns a per-"
            "profile comparison table for the pinned suite and the numbers "
            "reconcile with run_archive."
        ),
    },
    {
        "summary": "Task: export a reproducible benchmark bundle of fixtures, logs and results",
        "labels": ["benchmark", "coding", "workflow-test"],
        "description": (
            "Reproducibility is an expected outcome, so add a one-command "
            "export that captures a benchmark experiment as a versioned "
            "bundle: the pinned task suite, the profile definitions, the "
            "runner scripts and their inputs, every run log, and the "
            "scorecard snapshot at export time. Re-importing a bundle into a "
            "clean environment must rebuild the same scorecard from the "
            "logs alone, with no live runs and no model calls, which is the "
            "check that the reported numbers can be regenerated exactly.\n\n"
            "Benchmark brief: expected outcome 2 (reproducible scripts and "
            "results). Done when an exported bundle passes its re-import "
            "check and the rebuilt scorecard matches the snapshot field for "
            "field."
        ),
    },
    {
        "summary": "Feature: analysis tables and charts from archived benchmark runs",
        "labels": ["benchmark", "coding", "workflow-test"],
        "description": (
            "For the write-up the raw scorecard is not enough. Add an "
            "analysis step that reads the archived runs of one experiment "
            "and produces report-ready artifacts: per-profile summary "
            "tables, cost and pass-rate charts across tasks, and the "
            "variance and effect sizes for each profile comparison, all "
            "generated from the bundle export so figures in any draft "
            "trace back to specific run logs.\n\n"
            "Benchmark brief: stretch outcome (a publication). Done when "
            "one command turns a completed sweep into a folder of tables "
            "and charts, and every figure cites the run ids behind it."
        ),
    },
    # -- Leave lane: real ledger edges from fixtures/company ----------------
    {
        "summary": "Leave: overlapping November bookings for Pavel Novak (E-2009)",
        "labels": ["leave", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Leave Request. The leave ledger holds three "
            "booked rows for E-2009 Pavel Novak: LR-1D6BDF80 covers 2026-11-02 to "
            "2026-11-04, LR-E84C284F covers 2026-11-04 to 2026-11-06, and "
            "LR-5981DF34 covers 2026-10-19 to 2026-10-26. The two November spans "
            "share 2026-11-04, so the same day is booked twice.\n\n"
            "Start the run with employee E-2009 and ask for the November bookings "
            "to be checked for overlap. Done when the run names both request ids, "
            "reports 2026-11-04 as the collided date, and refuses to approve the "
            "later request instead of silently accepting it."
        ),
    },
    {
        "summary": "Leave: four booked days against a zero balance (E-2124)",
        "labels": ["leave", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Leave Request, and a live data contradiction. "
            "The ledger row LR-42773ED6 books E-2124 Gina Eriksen (Operations, "
            "reports to E-2121) from 2027-02-01 to 2027-02-04 as four working days "
            "with status booked, while the directory carries her leaveBalanceDays as "
            "0. E-2065 Jasper Aalto is the other zero-balance employee.\n\n"
            "Start the run with the booked request LR-42773ED6. Done when the run "
            "surfaces the contradiction instead of approving the booked row, reports "
            "the balance and the booked span together, and asks a human which side "
            "is wrong before touching the ledger."
        ),
    },
    {
        "summary": "Leave: two reports of one manager booked the same week (E-2009, E-2051)",
        "labels": ["leave", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Leave Request. E-2003 Ines Vasquez is an "
            "Engineering Manager with eight reports. Two of them are booked over an "
            "overlapping week: LR-5981DF34 covers E-2009 Pavel Novak from 2026-10-19 "
            "to 2026-10-26, and LR-756FBEA5 covers E-2051 Katya Weber from 2026-10-19 "
            "to 2026-10-25.\n\n"
            "Start the run with a coverage question for team E-2003 in the week of "
            "2026-10-19. Done when the run finds both bookings, reports the shared "
            "days, notes that a third booking that week would leave the team short, "
            "and routes the coverage decision to the manager rather than cancelling "
            "either approved booking."
        ),
    },
    {
        "summary": "Leave: working-day count across the Thanksgiving holidays",
        "labels": ["leave", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Leave Request. The calendar lists Thanksgiving "
            "2026-11-26 and the day after 2026-11-27 as holidays. The leave engine "
            "counts working days between two dates while excluding the holiday "
            "list, and the expected answers are pinned in evals/hr_lane_cases.jsonl.\n\n"
            "Start the run with a request from 2026-11-23 to 2026-11-27 with those "
            "two holidays excluded, and a second request from 2026-10-12 to "
            "2026-10-18 with no holidays. Done when the run reports 3 working days "
            "for the first span and 5 for the second, and shows the weekend and "
            "holiday exclusions it applied."
        ),
    },
    {
        "summary": "Leave: absence request during the quarterly audit freeze (E-2103)",
        "labels": ["leave", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Leave Request. A second blackout period runs "
            "from 2027-03-29 to 2027-04-02 for the quarterly audit freeze. E-2103 "
            "Gina Quintana is a Financial Analyst in Lisbon who started 2026-07-03 "
            "and reports to E-2097.\n\n"
            "Start the run with a request for E-2103 covering 2027-03-29 to "
            "2027-04-01. Done when the run detects the freeze overlap, notes that "
            "four of the five working days fall inside it, and escalates to the "
            "controller rather than approving inside the freeze."
        ),
    },
    {
        "summary": "Leave: balance-exceeding week for Leo Iversen (E-2073)",
        "labels": ["leave", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Leave Request. E-2073 Leo Iversen is a Sales "
            "Development Rep in Remote (EU) with leaveBalanceDays 5, started "
            "2026-06-03, and reports to E-2058.\n\n"
            "Start the run with a seven working day request for E-2073 beginning "
            "2026-11-09. Done when the run computes the two-day shortfall against "
            "the balance, addresses the approval to the named manager E-2058, and "
            "asks whether the excess is unpaid leave or a balance advance."
        ),
    },
    # -- HR Help lane: one question per handbook added in 2026-10 ------------
    {
        "summary": "HR help: raising an anonymous concern about expense fraud",
        "labels": ["hr-help", "handbook", "sim", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. The handbook now carries a dedicated "
            "whistleblowing policy (serious-concerns-whistleblowing.md) alongside "
            "the conduct and grievances policy, and an expense policy "
            "(expenses-and-travel.md).\n\n"
            "Start the run with the question: an employee believes their manager "
            "has submitted personal purchases as company expenses and wants to "
            "report it without their name reaching the manager. Done when the "
            "answer cites the whistleblowing channel rather than the ordinary "
            "grievance route, names the retaliation protection, and does not "
            "invent a hotline number that the policy does not state."
        ),
    },
    {
        "summary": "HR help: right to disconnect for the Manila team",
        "labels": ["hr-help", "handbook", "sim", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. working-hours-and-disconnect.md is the "
            "only policy that answers out-of-hours contact, and the Manila "
            "(E-2001 is based there) and Lisbon teams sit nine hours behind Austin.\n\n"
            "Start the run with the question: a Manila employee is messaged on "
            "Slack at 22:30 local time by an Austin manager and asked to reply "
            "that night. Done when the answer grounds itself in the disconnect "
            "policy, distinguishes a genuine incident from an ordinary request, "
            "and gives the escalation route instead of telling the employee to "
            "ignore their manager."
        ),
    },
    {
        "summary": "HR help: exporting the candidate list to a personal drive",
        "labels": ["hr-help", "handbook", "sim", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. it-and-data-usage.md governs company "
            "data on personal devices and accounts. The recruiting fixtures hold "
            "26 named candidates with evidence spans, which makes this a real "
            "privacy question rather than a hypothetical.\n\n"
            "Start the run with the question: a hiring manager wants the REQ-5001 "
            "candidate notes copied into their personal Google Drive over a "
            "weekend. Done when the answer refuses the personal-copy route on "
            "policy grounds, offers the sanctioned access path, and flags that "
            "third-party candidate data is involved."
        ),
    },
    {
        "summary": "HR help: who approves a conference and the training budget",
        "labels": ["hr-help", "handbook", "sim", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. learning-and-development.md is the "
            "seeded ground for this probe (verified 2026-10-25: top hit for the "
            "query \"training budget conference approval\").\n\n"
            "Start the run with the question: an engineer wants EUR 2,400 for a "
            "two-day conference plus travel and asks who signs it off and whether "
            "it comes out of the team or personal budget. Done when the answer "
            "quotes the actual ceiling and approver from the policy, separates the "
            "learning budget from the travel budget, and says what happens when "
            "the personal allowance is already spent."
        ),
    },
    {
        "summary": "HR help: extending probation and who decides",
        "labels": ["hr-help", "handbook", "sim", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. probation-and-confirmation.md defines "
            "the probation length, the review point and the extension rules. Eight "
            "employees are inside their first 180 days as of 2026-10-25, including "
            "E-2069 Leo Zhang (5 days) and E-2167 Iris Eriksen (48 days).\n\n"
            "Start the run with the question: a manager wants to extend a "
            "probationary employee by three months because performance is unclear. "
            "Done when the answer states the maximum extension and notice period "
            "from the policy, names who signs, and warns that an extension is not "
            "a substitute for a performance plan."
        ),
    },
    {
        "summary": "HR help: does an internal transfer need the current manager first",
        "labels": ["hr-help", "handbook", "sim", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. internal-transfers-and-job-postings.md "
            "covers internal application rights, the notification order and the "
            "hold on posting after interviews. REQ-5005 (IT Support Specialist, "
            "Manila, junior) is a plausible internal target.\n\n"
            "Start the run with the question: an employee in Ops wants to apply "
            "for REQ-5005 but their manager is strongly against losing them. Done "
            "when the answer states whether the manager must be told before or "
            "after applying, what the policy protects the employee from, and the "
            "notice period a transfer must respect."
        ),
    },
    {
        "summary": "HR help: how calibration stops one lenient manager skewing ratings",
        "labels": ["hr-help", "handbook", "sim", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. performance-review-and-calibration.md "
            "is the new policy under test, and the company has a deep manager "
            "layer (E-2003 to E-2008 each carry several reports).\n\n"
            "Start the run with the question: one manager rates everyone at the top "
            "band and another rates everyone mid, and the reviews feed salary "
            "decisions. Done when the answer explains the calibration step from the "
            "policy, who chairs it, what evidence a manager must bring to defend a "
            "rating, and how an employee challenges an outcome."
        ),
    },
    {
        "summary": "HR help: harassment complaint intake and interim measures",
        "labels": ["hr-help", "handbook", "sim", "workflow-test"],
        "description": (
            "Workflow test case for HR Help. anti-harassment-and-diversity.md is the "
            "policy added in the 2026-10 corpus expansion, and "
            "conduct-and-grievances.md (reviewed 2024, past its horizon) covers the "
            "adjacent grievance route.\n\n"
            "Start the run with the question: an employee reports that a colleague "
            "keeps making comments about their appearance in team calls and they "
            "have been sharing a reporting line with that person for three weeks. "
            "Done when the answer takes the intake path from the anti-harassment "
            "policy, names the interim measures available before any investigation "
            "concludes, does not lean on the stale conduct revision for the "
            "procedure, and treats a report about a named person as a human step "
            "rather than an automated notification."
        ),
    },
    # -- Recruiting lane ----------------------------------------------------
    {
        "summary": (
            "Screening: payroll specialist pipeline with a gap on the heaviest "
            "criterion (REQ-5003)"
        ),
        "labels": ["screening", "recruiting", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Candidate Screening. REQ-5003 is a Payroll "
            "Specialist in Finance, Lisbon, mid, interviewers E-2094 and E-2095, "
            "with weighted criteria payroll-ops 35, compliance 25, erp 15, reporting "
            "15, automation 10. Four candidates are attached. C-5010 Yara Falk has "
            "no evidence at all for compliance and rates weak on the heaviest "
            "criterion payroll-ops, while C-5011 Iris Novak covers every criterion.\n\n"
            "Start the run with requisition REQ-5003. Done when the run weights the "
            "criteria rather than counting strengths, puts C-5011 above C-5010 despite "
            "the headline years, and shows the missing compliance evidence for C-5010 "
            "as a gap rather than inventing a span."
        ),
    },
    {
        "summary": "Screening: junior IT Support shortlist with thin evidence (REQ-5005)",
        "labels": ["screening", "recruiting", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Candidate Screening. REQ-5005 is an IT Support "
            "Specialist in Operations, Manila, junior, interviewers E-2120 and "
            "E-2121, criteria troubleshooting 35, identity 25, ticketing 15, "
            "hardware 15, communication 10. Four candidates are attached. C-5020 Vera "
            "Xu has three evidence items only (ticketing strong, hardware weak, "
            "communication weak) and nothing for troubleshooting or identity, while "
            "C-5018 Henrik Santos and C-5021 Celine Everly cover all five.\n\n"
            "Start the run with requisition REQ-5005. Done when the run reports the "
            "coverage gap on the two heaviest criteria for C-5020 rather than scoring "
            "an empty criterion as neutral, ranks the four candidates, and lists "
            "which interview slot should test what no cv span supports."
        ),
    },
    # -- On and offboarding: access tiers are real directory rows -----------
    {
        "summary": "Onboarding: provision the marketing stack for Henrik Alvarez (E-2163)",
        "labels": ["onboarding", "access", "sim", "workflow-test"],
        "description": (
            "Workflow test case for New-Hire Onboarding. E-2163 Henrik Alvarez is a "
            "Growth Marketer in Marketing, accessTier medium, status onboarding, with "
            "systems figma, hubspot, jira, notion, okta, slack, workday. REQ-5006 (the "
            "open Growth Marketer requisition) is the seat being filled, and "
            "onboarding-checklist.md is the policy source.\n\n"
            "Start the run with employee E-2163 and a start date of 2026-11-03. Done "
            "when the run returns the provisioning order from the checklist, puts okta "
            "ahead of the tools it feeds, flags the marketing automation and CRM "
            "accounts as the ones needing a data owner, and keeps the actual grants as "
            "approval-gated writes."
        ),
    },
    {
        "summary": "Offboarding: same-day banking and ERP removal for an accountant (E-2119)",
        "labels": ["offboarding", "access", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Employee Offboarding. E-2119 Amara Eriksen is an "
            "Accountant in Finance, status offboarding, accessTier medium, with "
            "banking, erp, looker, payroll, okta, jira, slack and workday. This is "
            "the money-adjacent case: two of the systems can move funds.\n\n"
            "Start the run with employee E-2119 and a departure date of 2026-10-30. "
            "Done when the run sequences banking, erp and payroll ahead of the "
            "collaboration tools, states a same-day cutoff for the payment systems, "
            "and names the finance approver who has to sign the access removal."
        ),
    },
    {
        "summary": "Onboarding: provision recruiting tooling for a new recruiter (E-2148)",
        "labels": ["onboarding", "access", "sim", "workflow-test"],
        "description": (
            "Workflow test case for New-Hire Onboarding. E-2148 Iris Delgado is a "
            "Recruiter in People with status onboarding, accessTier high, and "
            "systems aws, github, greenhouse, hr-console, jira, okta, slack, "
            "workday, zoom. onboarding-checklist.md is the policy source, and the "
            "high tier plus hr-console is the sensitive part of this bundle.\n\n"
            "Start the run with employee E-2148 and a start date of 2026-11-02. Done "
            "when the run returns the provisioning order from the checklist, calls "
            "out the background-check prerequisite (references-and-background-checks.md), "
            "and does not grant hr-console before the first-day review."
        ),
    },
    # -- Finance lane: the pinned phase3 reconciliation exceptions ---------
    {
        "summary": "Finance: amount mismatch on INV-2 blocks the period close",
        "labels": ["finance", "invoice", "reconcile", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Finance Reconciliation. fixtures/phase3_finance.json "
            "pins the expected exceptions for the period: an amount_mismatch on "
            "externalRef INV-2 owned by the gl specialist, alongside the matched "
            "ledger and bank rows for account 1000.\n\n"
            "Start the run with the period close for the fixture ledger. Done when "
            "the run isolates INV-2 as an amount mismatch rather than an unmatched "
            "line, reports both sides of the difference, and leaves the journal "
            "write to a human approval gate."
        ),
    },
    {
        "summary": "Finance: PAY-1 has a ledger entry with no bank counterpart",
        "labels": ["finance", "ledger", "reconcile", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Finance Reconciliation. The pinned exceptions "
            "list an unmatched_ledger on externalRef PAY-1 for the gl specialist: "
            "a payroll journal line the bank feed never carried.\n\n"
            "Start the run with the same period fixture. Done when the run classifies "
            "PAY-1 as ledger-side-only (not a variance), separates it from the INV-2 "
            "amount mismatch, and proposes the follow-up question to payroll rather "
            "than adjusting the journal."
        ),
    },
    {
        "summary": "Finance: unmatched bank deposit DEP-9 needs treasury tracing",
        "labels": ["finance", "bank", "treasury", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Finance Reconciliation. The third pinned "
            "exception is an unmatched_bank on externalRef DEP-9 owned by the "
            "treasury specialist: money arrived with no journal line behind it.\n\n"
            "Start the run with the same period fixture. Done when the run routes "
            "DEP-9 to treasury, states that an untraced deposit cannot be booked as "
            "revenue on the run's own authority, and asks the human to identify the "
            "payer before any posting."
        ),
    },
    {
        "summary": "Finance: month-end variance report across the fixture ledger",
        "labels": ["finance", "variance", "reconciliation", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Finance Reconciliation. The fixture period holds "
            "three ledger rows and three bank rows in USD against account 1000, with "
            "exactly three pinned exceptions, so a correct variance report must sum "
            "to the difference those three rows create.\n\n"
            "Start the run asking for the period variance summary. Done when the run "
            "reports matched totals, lists the three exceptions with their owner "
            "specialist, and keeps the arithmetic deterministic (no model-invented "
            "figures in the totals)."
        ),
    },
    {
        "summary": "Finance: expense claim above the travel policy ceiling",
        "labels": ["finance", "expense", "audit", "sim", "workflow-test"],
        "description": (
            "Workflow test case that pairs the finance and handbook planes. "
            "expenses-and-travel.md is seeded in hr:policy and sets the claim rules "
            "and ceilings; the finance lane decides what gets posted.\n\n"
            "Start the run with a claim for a Lisbon-to-Austin trip where the flight "
            "class and one undocumented dinner exceed the ceiling. Done when the run "
            "cites the policy ceiling it checked, splits the approvable part from the "
            "exception, and holds the undocumented item for human review instead of "
            "rejecting the whole claim."
        ),
    },
    {
        "summary": "Finance: assemble the audit pack for the period close",
        "labels": ["finance", "audit", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Finance Reconciliation with the audit-pack path. "
            "The close has three unresolved exceptions (INV-2, PAY-1, DEP-9) and the "
            "quarterly audit freeze lands 2027-03-29.\n\n"
            "Start the run asking for the evidence pack behind this period's close. "
            "Done when the pack carries each exception with both sides of the "
            "comparison, the run log that produced the classification, and the "
            "approval receipts, so an auditor can retrace every number without a "
            "live model call."
        ),
    },
    # -- Support lane -------------------------------------------------------
    {
        "summary": "Support: customer cannot log in after the identity migration",
        "labels": ["support", "customer", "login", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Support Triage. A customer reports that after "
            "the identity provider change their account password reset link loops "
            "back to the login page, and they cannot reach the account screen.\n\n"
            "Start the run with that customer description. Done when the run "
            "classifies the ticket into the support lane, asks for the account "
            "identifier before touching anything, proposes read-only diagnosis steps, "
            "and does not reset or merge an account without approval."
        ),
    },
    {
        "summary": "Support: duplicate charge refund request on one account",
        "labels": ["support", "customer", "refund", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Support Triage. A customer was billed twice for "
            "the same subscription month and wants the second charge refunded.\n\n"
            "Start the run with the refund request. Done when the run separates the "
            "verification step (both transactions, same account, same period) from "
            "the money movement, drafts the customer reply, and stops at the "
            "approval gate because a refund is an irreversible write."
        ),
    },
    # -- Marketing lane (absent from the current board spread) --------------
    {
        "summary": "Marketing: Q4 launch newsletter copy review before send",
        "labels": ["marketing", "newsletter", "campaign", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Marketing Draft. The launch newsletter copy for "
            "the Q4 campaign needs a review pass against the brand voice and the "
            "send date; no campaign calendar exists in the store yet, so the run has "
            "to work from the ticket body alone.\n\n"
            "Start the run with the draft in the ticket. Done when the run classifies "
            "into marketing, returns concrete edits rather than generic praise, and "
            "leaves the send to a human because publishing is an outbound write."
        ),
    },
    {
        "summary": "Marketing: brand refresh landing page for the product launch",
        "labels": ["marketing", "brand", "launch", "copy", "sim", "workflow-test"],
        "description": (
            "Workflow test case for Marketing Draft. A launch landing page needs "
            "headline, sub-headline and call-to-action copy in two tones so the team "
            "can pick one.\n\n"
            "Start the run with the product brief in the ticket. Done when the run "
            "produces both tone variants with the reason each fits, keeps claims "
            "non-fabricated (no invented pricing or customer counts), and asks for "
            "approval before anything goes live."
        ),
    },
    # -- DevOps lane --------------------------------------------------------
    {
        "summary": "DevOps: quarantine the flaky CI suite before the release build",
        "labels": ["devops", "ci", "build", "sim", "workflow-test"],
        "description": (
            "Workflow test case for the DevOps lane. The CI pipeline for this repo "
            "(see .github/workflows/ci.yml) intermittently fails on a test that "
            "passes on rerun, which blocks the release build and trains the team to "
            "rerun green rather than investigate.\n\n"
            "Start the run with the failing job name from the ticket. Done when the "
            "run identifies the flaky test, proposes a quarantine with an owner and "
            "an expiry instead of a permanent skip, and treats the pipeline edit as "
            "an approval-gated change."
        ),
    },
    {
        "summary": "DevOps: ArgoCD application stuck OutOfSync for the approval console",
        "labels": ["devops", "argocd", "deploy", "sim", "workflow-test"],
        "description": (
            "Workflow test case for the DevOps lane. The approval UI is deployed "
            "through the GitOps path in deploy/argocd and deploy/k8s, and the "
            "application shows OutOfSync against the manifest in git with no sync "
            "error in the app events.\n\n"
            "Start the run with the application name from the ticket. Done when the "
            "run reads the diff between the live and desired manifests, says which "
            "field drifted, and stops before the sync operation because syncing is "
            "a cluster write."
        ),
    },
    {
        "summary": "DevOps: per-lane cost and latency panels on the Grafana board",
        "labels": ["devops", "observability", "grafana", "sim", "workflow-test"],
        "description": (
            "Workflow test case for the DevOps lane. ops/grafana and "
            "deploy/observability hold the dashboard and scrape config, and the "
            "metrics endpoint already exposes per-workflow counters.\n\n"
            "Start the run asking for lane-level cost per run and step latency on the "
            "board. Done when the run proposes the exact metric and panel changes, "
            "names the label that splits lanes, keeps the Prometheus format "
            "compatible, and does not merge the dashboard JSON itself."
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
    tickets: tuple[TicketSpec, ...],
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
        for ticket in tickets:
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


def _seed_via_rest(
    base_url: str,
    email: str,
    token: str,
    project: str,
    tickets: tuple[TicketSpec, ...],
) -> int:
    """Legacy REST path: seed tickets over the Jira REST API (ADF bodies)."""
    created: list[str] = []
    failed: list[str] = []
    with httpx.Client(
        base_url=base_url,
        auth=(email, token),
        headers={"accept": "application/json", "content-type": "application/json"},
        timeout=20,
    ) as client:
        for ticket in tickets:
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


def _selected_tickets(match: str) -> tuple[TicketSpec, ...]:
    """All specs, or only the ones matching ``match`` (case-insensitive)."""
    if match == "":
        return TICKETS
    needle = match.lower()

    def haystack(ticket: TicketSpec) -> str:
        return f"{ticket['summary']} {' '.join(ticket['labels'])}".lower()

    return tuple(ticket for ticket in TICKETS if needle in haystack(ticket))


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the workflow test tickets.")
    parser.add_argument(
        "--match",
        default="",
        help="only seed tickets whose summary or labels contain this text",
    )
    args = parser.parse_args()
    settings = Settings()
    base_url = settings.jira_base_url.rstrip("/")
    email = settings.jira_email
    token = settings.jira_api_token.get_secret_value()
    project = settings.jira_project_key
    if not base_url or not email or not token or not project:
        print("jira_env_missing", file=sys.stderr)
        return 1
    tickets = _selected_tickets(args.match)
    if not tickets:
        print("no tickets matched", file=sys.stderr)
        return 1
    if settings.jira_transport == "mcp":
        return _seed_via_mcp(settings, base_url, email, token, project, tickets)
    return _seed_via_rest(base_url, email, token, project, tickets)


if __name__ == "__main__":
    raise SystemExit(main())
