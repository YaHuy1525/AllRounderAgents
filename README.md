# AllRounderAgent

AllRounderAgent is a hybrid multi-domain agent platform: it takes a Jira ticket in any
domain — **coding, finance, marketing, support** — and drives it to a done state with
evidence. Tickets are triaged and risk-scored, executed by specialist agents, gated by
human approval where impact demands it, metered, and logged end to end.

The system is built on two planes with one governance spine:

- a **serving plane** — a Python 3.12 FastAPI service (`apps/api`) that owns the Jira
  boundary (webhooks, deduplication, routing), the approval/audit stores, and every
  authenticated HTTP API;
- an **agent plane** — Mastra workflows and agents in TypeScript (`src/mastra`) that hold
  the domain judgment: dispatcher (triage + pre-flight), coding, finance, marketing, and
  support lanes;
- a **governance spine** that applies to everything — risk-scored routing gates, human
  approval with signed single-use receipts, tenant-scoped RLS, and a queryable audit
  case store.

```
Jira webhook ─▶ FastAPI serving plane ─▶ Redis dedupe ─▶ Dispatcher (triage → pre-flight risk)
                                                              │ gate: auto | approval | refuse
                                                              ▼
                                          ┌──────────────────────────────────────────┐
                                          │  Mastra agent plane (src/mastra)          │
                                          │  codingFlow · financeFlow · support lane   │
                                          │  marketing (agents scaffolded)             │
                                          └──────────────────────────────────────────┘
                                                              │
                                            approval gates (signed receipts) ── approval UI
                                                              ▼
                                          Evidence back to Jira · audit case store
```

Third-party access is **MCP-first** (see [Third-party call policy](#third-party-access-mcp-first)):
the coding lane defaults to the official GitHub MCP server, the Python Jira stack defaults
to the Atlassian Rovo MCP server, and every legacy REST seam remains available as an
opt-out fallback.

## Repository layout

```
apps/
  api/                  Python 3.12 FastAPI serving plane (allrounder_api):
                        webhooks, auth, dispatcher, approvals, coding/finance/support
                        runs, the parallel-safe run service (runs/), Jira transports
                        (Rovo MCP + REST), Supabase persistence
  approval-ui/          Next.js (App Router) console, statically exported (out/):
                        Jira board + approval queue + per-run workflow panel
src/mastra/             Mastra agent plane: agents (32 across 16 lanes, incl. the HR
                        lanes), flows (incl. the review and issues lanes), GitHub
                        MCP/REST tools, dev host instance (instance.ts)
contracts/jsonschema/   Canonical Pydantic JSON Schemas: ticket, risk-score,
                        triage-verdict, evidence-pack
supabase/migrations/    10 ordered SQL migrations: foundation → phase 3 finance →
                        chat feedback → runs (run registry + steps, RLS forced) →
                        GitHub accounts → hybrid KB retrieval
fixtures/               Shared payloads used by Python and TypeScript parity tests
evals/                  Golden cases: dispatcher routing (scripts/golden-eval.py,
                        CI gate) and HR lane deterministic engines (replayed by
                        src/mastra/agents/hr/lane-evals.test.ts)
ops/                    Compose ops stack: Prometheus scrape config + Grafana
                        provisioning and the chat-stream dashboard
scripts/                Developer/verification helpers: golden-eval, loadtest/k6-chat.js,
                        MCP connectivity checks, …
docs/                   Architecture reference, incl. the third-party call register
```

The original `packages/orchestrator` workspace was consolidated into `src/mastra`; its
tests moved to `src/mastra/agents/*/*.test.ts` (vitest).

## Domain lanes

Each lane shares one skeleton — load context → plan → gather evidence → act → validate →
gate → close with evidence — and differs only in agents, tools, and gate calibration.

| Lane | Agents (registry.ts) | What it produces | Status |
| --- | --- | --- | --- |
| Dispatcher | `triageAgent`, `preflightAgent` | Domain routing + per-action risk scores and an `auto / approval / refuse` gate. Unknown or low-confidence triage always escalates. | Shipped (deterministic engine + agents) |
| Coding | `investigatorAgent`, `actorAgent`, `validatorAgent` | RCA with cited line evidence → bounded surgical patch → GitHub Draft PR → CI/checks follow-up. Never clones, never runs ticket-provided commands. | Shipped — `codingFlow` registers when `GITHUB_REPOSITORY_ALLOWLIST` is set |
| Finance | `glAgent`, `treasuryAgent`, `taxAgent`, `auditAgent` | Ledger/bank reconciliation → exception RCA → specialist findings → audit pack → approval-gated sandbox posting. | Shipped — `financeFlow` always registered |
| Support | `supportResearcherAgent`, `supportDrafterAgent` | Cited pgvector retrieval → draft → approval station → send with a signed single-use receipt. | Shipped |
| Marketing | `marketingResearcherAgent`, `marketingDrafterAgent`, `brandGuardrailAgent` | Brief research, drafting, brand-guardrail checks, contracts defined. | Agents scaffolded; workflow not yet wired |
| PR Review | `reviewReviewerAgent` | PR picker → review options → AI verdict, strengths, improvements and inline comments → posted-review receipt; follow-ups re-review deltas only. | Shipped — `reviewFlow` registers when GitHub policy + `GITHUB_TOKEN` are set |
| Issue Resolution | `issueAnalystAgent`, `issueEngineerAgent` | Bug-ticket selection → similar-updates callout and affected-files analysis with a regression-test cross-link → guarded patch with validators and a single repair pass → Draft PR, ticket transition and case record. | Shipped — `issuesFlow` registers when GitHub policy + `GITHUB_TOKEN` are set |
| Feature Implementation | `featurePlannerAgent`, `featureEngineerAgent` | Feature-ticket chips with an acceptance-criteria checklist → scope & design cards (UI / API & Data / State & Logic / Tests / Docs & Flags) with guidance → planned changes with diffs, cross-cutting notes, verdict and validators → Draft PR with per-criterion coverage and the PR Review cross-link. | Shipped — `featuresFlow` registers when GitHub policy + `GITHUB_TOKEN` are set |
| Leave | `leaveAdvisorAgent` | Leave intake → deterministic policy check (working days, balance, coverage, blackout, notice) → manager approval → idempotent calendar booking + payroll export row. | Shipped — `leaveFlow` always registered |
| Onboarding | `onboardingVerifierAgent`, `onboardingRiskAgent` | Document checklist with nudge counters → duplicate scoring plus manager and start-date checks → access-tier risk factors and approver matrix → signer chain → idempotent provisioning (accounts, equipment, payroll). | Shipped — `onboardingFlow` always registered |
| Offboarding | `offboardingAuditAgent` | Access audit with per-system blast radius and reversibility → per-item approval for high-blast revocations → idempotent per-system revocation → final-pay, equipment and case-close attestation with its own receipt. | Shipped — `offboardingFlow` always registered |
| Screening | `hrGuardrailAgent` | Requisition rubric (weighted criteria, must-haves) → per-candidate verdicts with citations → guardrail review for protected-attribute and non-rubric language → shortlist → idempotent interview invites. | Shipped — `screeningFlow` always registered |
| HR Help | `hrHelpDrafterAgent`, `hrHelpGuardrailAgent` | Question intake → fixture policy retrieval with citations (sourceId + span, stale flag, score) → cited answer draft → people-partner approval → idempotent send with receipt. | Shipped — `hrHelpFlow` always registered |

The Mastra dev host (`src/mastra/instance.ts`) always registers `financeFlow`, `vendorsFlow`
and the five HR lanes (`leaveFlow`, `onboardingFlow`, `offboardingFlow`, `screeningFlow`,
`hrHelpFlow`); `codingFlow`, `reviewFlow`, `issuesFlow`, `featuresFlow`, `dependenciesFlow`
and `accessibilityFlow` register only when the `GITHUB_*` policy env block is present
(coding also needs MCP or REST credentials), and coding uses the GitHub MCP backend by
default.
Deterministic engines (`reconcile`, `rca`, `proposePosting`, `audit`, pilot metrics,
dispatcher steps, and the HR lane policy, duplicate, blast-radius and retrieval math)
are exported as plain functions so they are fully testable without model credentials.

### HR data sources & upgrade path

No real HRIS or ATS is wired up: the lanes run fixture-backed so they need no
credentials. `fixtures/hr_directory.json` (people, managers, access tiers, systems),
`fixtures/hr_calendar.json` (holidays, blackout periods), `fixtures/hr_candidates.json`
(requisition rubric plus candidate evidence) and `fixtures/hr_policy/*.md` (the HR Help
corpus) stand in. Every seam is a named interface — `EmployeeDirectory`, `LeaveRegistry`,
`OnboardingRegistry`, `OffboardingRegistry`, the screening ATS and the HR Help
retriever — so a later MCP-first (then REST) HRIS/ATS swap changes only the tool
implementation, not the flows or the artifacts. For HR Help the documented upgrade is
to swap the fixture retriever for the existing pgvector knowledge store under an `hr`
domain; the citation discipline (`sourceId` + `span`, stale flag, score) already matches
the support lane's contract.

## Governance spine

- **Risk gates before action** — pre-flight scores every planned action
  (blast radius, reversibility, score). Irreversible or high-blast actions refuse and
  create a human task; they are never auto-run.
- **Approvals are signed and single-use** — `APPROVAL_HMAC_SECRET` signs receipts bound
  to an approval id, case id, action, and scope (`finance:post`, support sends, …).
  Executors verify the receipt, never the caller's claim, and replay is idempotent.
- **Comment-only until approved** — routing posts a Jira receipt comment describing the
  domain and rationale; no external action happens before a gate passes.
- **Audit trail** — every webhook, routing verdict, run, tool trail, approval, and send
  lands in the case store with integer micro-dollar cost rollups.
- **Tenant isolation** — every table has RLS enforced; browser roles have no grants;
  roles (`viewer`, `agent`, `approver`, `admin`) live only in signed Supabase
  `app_metadata`.

## Parallel-safe runs (developer workflows)

A second workflow surface for developer work sits beside the domain lanes: the
runs API (`apps/api/src/allrounder_api/runs/`, migration `202609120008_runs.sql`)
drives selectable workflows where **every step is an interactive checkpoint** — the
run suspends (`awaiting_human`), the console renders that step's surface, and the run
advances only on an explicit decision backed by a signed receipt.

- **Run isolation** — every run gets a uuid and namespaces all of its state (Mastra
  thread, Redis keys, case record, artifacts); same-workflow runs progress in
  parallel without leaking state (test-proven).
- **Ceilings & queueing** — configurable caps on concurrent runs; over-cap work
  queues visibly (`queued #2`) and promotes FIFO when a slot frees; cancels release
  slots immediately.
- **Target locks** — side-effecting targets (`pr:owner/repo#7`, manifests, …) carry a
  TTL lock owned by a runId; a conflicting run pauses with a "locked by run X" banner
  and resumes (`retry_lock`) or aborts on the user's choice.
- **Idempotency + receipts** — every decision stores `(runId, stepId, actionHash)`;
  replaying an identical action returns the original signed receipt and never
  re-executes the effect.
- **Per-run SSE** — `GET /runs/{runId}/events` streams that run's events
  (`run.suspended`, `run.decision`, `run.locked`, …) for live UI updates; the console
  falls back to polling when the stream drops.
- **Action bar on every step** — Back / Edit / Regenerate / Proceed / Abort; Back
  invalidates downstream steps and re-derives them on the way forward, Regenerate
  re-runs the step once with optional guidance and then escalates to a human choice,
  and expiry escalates — never auto-approves.

**A. PR Review**, **B. Issue Resolution**, **C. Feature Implementation**,
**D. Dependency Update**, **E. Accessibility Audit** and **F. Vendor Onboarding**
are shipped (scan → group → apply → validate → merge → one Draft bump PR per group
for D; issue selection → analysis → implementation → complete for B; feature
selection → scope & design → implementation → complete for C; crawl → violations →
fix → re-scan → one Draft fix PR for E, gated on zero open criticals or an approver
waiver with an expiry; collect → verify → risk-score → approve → create for F, with
reject-with-reason looping back to Collect and the master record created
idempotently by tax ID).

## Third-party access: MCP-first

The default for every third-party seam is an MCP server; REST remains as an explicit
fallback. The living register lives in
[docs/coding-agent-architecture.md §13](docs/coding-agent-architecture.md).

| Third party | Used for | Default backend | Config |
| --- | --- | --- | --- |
| GitHub | Coding-lane reads/writes, Draft PRs, Checks API | GitHub MCP server (`https://api.githubcopilot.com/mcp/`), bearer PAT | `GITHUB_ACCESS=mcp`, `GITHUB_MCP_TOKEN` |
| npm registry | Dependency Update scan (latest versions, publish dates, bulk advisory CVE tags) | Read-only REST (`registry.npmjs.org`) — no viable MCP server for the packument/advisory JSON | No key; advisory failures degrade to a tag-free inventory |
| Atlassian Jira | Comments, transitions, JQL search, seed creation | Atlassian Rovo MCP (`https://mcp.atlassian.com/v2/mcp`) | `JIRA_TRANSPORT=mcp`, `JIRA_EMAIL` + agent-interface-scoped `JIRA_API_TOKEN` |
| Jira boards | Board listing (approval UI) | Read-only REST always (Rovo MCP has no agile-board tools) | `JIRA_BASE_URL` + same email/token |
| Models | Mastra workflow agents | Model router (OpenRouter) | `OPENROUTER_API_KEY` |
| Console chat | `/chat` + SSE stream | OpenAI-compatible completer | `MODEL_API_KEY`, `MODEL_BASE_URL` |

Rationale: one tool protocol, streaming sessions, no per-API SDK churn; the REST paths
are kept and tested as fallbacks (see the register for the trade-offs, D1).

## Prerequisites

- Python **3.12** (`>=3.12,<3.13`)
- Node.js **22** and npm
- Redis (webhook dedupe, idempotency, run state)
- A Supabase project (hosted Postgres + pgvector) and the Supabase CLI
- For live runs: Jira (email + API token), GitHub (PAT), and a model-provider key
  (all tests are credential-free)

## Install

```powershell
Copy-Item .env.example .env
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
npm ci
```

## Configure (.env)

**Backend-only** (never expose these to browsers or client logs): `DATABASE_URL` (direct
Supabase Postgres connection string), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE`, `WEBHOOK_SECRET`,
`APPROVAL_HMAC_SECRET` (≥ 32 random bytes, stable across restarts), `REDIS_URL`,
`CORS_ALLOW_ORIGINS` (exact-origin JSON list; wildcards unsupported),
`TRUSTED_PROXY_IPS`, `RATE_LIMIT_PER_MINUTE`, the `JIRA_*` / `ATLASSIAN_MCP_URL` /
`JIRA_CLOUD_ID` block, `MODEL_*`, `OPENROUTER_API_KEY`, `EMBEDDING_MODEL`,
`EMBEDDING_DIMENSIONS=1536`, and the `GITHUB_*` block.

**Browser-safe** (only these three): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_API_URL`. `next.config.ts` bridges them to `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_API_URL` for the browser bundle, so the
root `.env` stays the single source of truth. The approval UI never uses the service-role
key.

`MODEL_NAME`, `MODEL_BASE_URL`, `EMBEDDING_MODEL`, and `EMBEDDING_DIMENSIONS=1536` pin
provider behavior and the migration's vector shape; keep them unchanged until a deliberate
re-embedding migration.

## Apply Supabase migrations

```powershell
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

The migrations create the Foundation/Phase 0 webhook queue and audit tables, Phase 1
support + RAG (pgvector knowledge store), Phase 2 tenant-scoped coding runs (RCA evidence,
patch manifests, Draft PR receipts, durable idempotency), hardening, Phase 3 finance
(runs, audit packs, postings), and the parallel-safe run registry
(`202609120008_runs.sql`: `runs` + `run_steps`, RLS forced, no browser grants). Every
table has RLS enabled and forced; the API connects server-side.

In Supabase Auth, assign authorization only in signed `app_metadata`, for example
`{"tenant_id":"tenant-a","roles":["approver"]}`. Supported roles are `viewer`, `agent`,
`approver`, and `admin` — never accept browser-provided profile/user metadata as roles.

Seed guidance: ingest versioned support docs and redacted resolved tickets through
`KnowledgeDocument`/`PostgresKnowledgeStore` with stable `source_id`, tenant,
`source_version`, and `stale_after`. Never seed raw customer PII or credentials.
Retrieval is hybrid: pgvector cosine fused with the generated `content_tsv` lexical
arm through reciprocal rank fusion, with an optional Cohere `rerank-v3.5` rerank;
a reranker outage degrades to the fused order (`rerank_degraded`) rather than failing.

## Jira credentials + seed

Jira access defaults to the Rovo MCP transport (`JIRA_TRANSPORT=mcp`). Two prerequisites
(both live-verified 2026-09-09):

1. Your org admin must enable API-token connections for the Rovo MCP server
   (admin.atlassian.com → Rovo → Rovo MCP server → Authentication).
2. Create the token at id.atlassian.com selecting the agent-interface scopes
   `read:jira:agent-interface`, `search:jira:agent-interface`, and
   `write:jira:agent-interface`. Classic REST-only tokens are rejected by the MCP server
   ("Insufficient scopes" / "missing the scope claim"); the token remains valid for the
   REST fallback and board listing.

`JIRA_CLOUD_ID` is optional — when empty the site URL (`JIRA_BASE_URL`) is sent and the
server resolves it. Set `JIRA_PROJECT_KEY` (it must appear in
`JIRA_TENANT_PROJECT_ALLOWLIST`) for the default board.

Seed the workflow test tickets (idempotent — existing summaries are detected and
skipped via JQL): the finance-lane demo plus two test cases per console workflow
(PR Review, Issue Resolution, Feature Implementation, Dependency Update,
Accessibility Audit, Vendor Onboarding).

```powershell
$env:PYTHONPATH = "apps/api/src"
python -m allrounder_api.jira_seed
```

The seed honors `JIRA_TRANSPORT`; the MCP path additionally requires the write scope above
(`createJiraIssue`).

## GitHub MCP setup (coding lane)

The coding lane writes through the official GitHub MCP server by default:

```powershell
# .env
GITHUB_ACCESS=mcp
GITHUB_MCP_TOKEN=github_pat_...   # fine-grained PAT, repositories + contents/pull-requests scope
GITHUB_REPOSITORY_ALLOWLIST=["owner/repo"]
GITHUB_BASE_BRANCH=main
node scripts/github-mcp-verify.mjs
```

- The MCP bearer PAT falls back to `GITHUB_TOKEN` when `GITHUB_MCP_TOKEN` is unset.
- Legacy REST transport (`GITHUB_ACCESS=rest`) uses a short-lived GitHub App
  installation token or fine-grained PAT through `GITHUB_TOKEN`.
- Path policy: JSON arrays in `GITHUB_PATH_ALLOWLIST`, `GITHUB_PATH_DENYLIST`
  (deny wins), `GITHUB_DESTRUCTIVE_PATHS` (exact approval required in the workflow
  input); bound by `GITHUB_MAX_PATCH_FILES`, `GITHUB_MAX_PATCH_BYTES`,
  `GITHUB_REQUEST_TIMEOUT_SECONDS`.
- Repository scope: the Mastra host discovers every repository `GITHUB_TOKEN` can
  see at startup and unions it with the allowlist, and the console start card
  lists every repository of the selected GitHub account (Settings → GitHub
  accounts); the allowlist stays the guaranteed floor.
- Dependency Update reads and writes the manifest + lockfile through the same GitHub
  tools: include those paths (e.g. `package.json`, `package-lock.json`) in
  `GITHUB_PATH_ALLOWLIST` so scan/apply/merge are not denied.
- No GitHub webhook is needed: CI is read from the Checks API after the Draft PR opens;
  a failing check escalates and leaves the PR in Draft. Writes are deduplicated by
  repository + branch + patch hash and require the exact source commit SHA.
- All GitHub variables are backend-only — never expose App keys, PATs, or
  `GITHUB_TOKEN` via `VITE_*`/`NEXT_PUBLIC_*`.

## Run locally

Start Redis first, then the API:

```powershell
uvicorn allrounder_api.production:create_production_app --factory --app-dir apps/api/src
```

The production factory wires Redis deduplication, `PostgresTicketQueue` over the direct
`DATABASE_URL`, Supabase JWKS bearer verification, durable repositories, Redis-backed
rate limiting (falling back to in-process enforcement when Redis is unhealthy),
Prometheus metrics, and the configured Jira transport. Start it from the repository root:
settings load `.env` relative to the working directory, so another CWD silently drops
browser-facing configuration such as `CORS_ALLOW_ORIGINS`. Tests inject in-memory
fakes, so the suite needs no Jira, Supabase, Redis, model, or GitHub credentials.

Run the Mastra agent plane (Studio at the printed URL):

```powershell
npm run dev:mastra     # mastra dev --dir src/mastra  (loads .env, registers financeFlow + codingFlow/reviewFlow when configured)
npm run studio         # standalone Mastra Studio
```

Run the approval UI separately (Next.js dev server pinned to `http://localhost:5173`, the
CORS-allowed origin):

```powershell
npm run dev -w @allrounder/approval-ui
```

The UI uses Supabase password auth (email sign-in links are turned off; a pasted
one-time code is accepted when present) and sends the access token as a bearer token. It
shows the Jira board (Backlog, To Do, Ready for Dev, In Progress, Done; links open in
Jira) and the approval queue. Set `JIRA_PROJECT_KEY` and
`JIRA_TENANT_PROJECT_ALLOWLIST`, then use **Refresh Jira** to load up to 100 issues via
backend-only credentials. All ticket/draft/evidence content is rendered with DOM
`textContent` only.

Leave `TRUSTED_PROXY_IPS=[]` for local development; in production list only the exact
ingress/load-balancer IPs whose `X-Forwarded-For` the API may trust.

## API surface

All endpoints below `/approvals`, `/coding`, `/finance`, `/runs`, `/jira`, and `/chat` require a
Supabase bearer token with tenant roles from signed `app_metadata`; `/health` and
`/metrics` stay unauthenticated. The API adds security headers, per-IP rate limiting
(Redis fixed window in production, in-process sliding window otherwise; a JSON `429` body
plus a `Retry-After` header in seconds when exceeded), and no-store caching. Outbound
Jira, MCP, and model calls retry transient
failures (transport errors and HTTP 429/5xx) with full-jitter backoff and honor
`Retry-After` up to 5 s.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/webhooks/jira` | Jira webhook entry: HMAC verification, dedupe, triage/pre-flight, enqueue + comment receipt (`deduped` on replay) |
| GET | `/health` | Liveness |
| GET | `/metrics` | Prometheus exposition: request/webhook counters, gate and approval decisions, chat answer sources and a `chat_first_token_seconds` TTFT histogram |
| POST | `/chat` | Chat completion through the model router |
| POST | `/chat/stream` | Same chat request streamed as SSE (`data:` JSON delta frames + a terminal `done` frame carrying `source` and `interrupted`) |
| POST | `/chat/feedback` | Rate a reply (`up`/`down`/`report`) by client-computed `messageSha256` with an optional ≤ 200-char reason; message text is never stored |
| GET | `/jira/workspace` | Tenant-scoped project/board visibility (board UI) |
| GET | `/jira/issues` | Up to 100 issues via backend Jira credentials (board UI) |
| POST | `/coding/runs` | Start a coding run (RCA → patch → Draft PR) |
| GET | `/coding/runs/{run_id}` | Run status, evidence, PR receipts |
| POST | `/finance/runs` | Start a finance reconciliation run (ledger vs bank, audit pack) |
| GET | `/finance/runs/{run_id}` | Run, exceptions, audit pack |
| POST | `/finance/runs/{run_id}/post` | Post after an approved signed receipt (approver/admin) |
| POST | `/runs` | Start a workflow run (workflow + ticket + case + input); suspends at the first checkpoint |
| GET | `/runs?ticket=` | Runs for a ticket (History), newest first |
| GET | `/runs/{runId}` | Run detail: status, steps, artifacts, decisions, side effects |
| GET | `/runs/{runId}/events` | Per-run SSE stream (history replay + live events) |
| POST | `/runs/{runId}/steps/{stepId}/decision` | Decide on a suspended step (`proceed` / `edit` / `regenerate` / `back` / `abort` / `retry_lock`) with a signed receipt |
| POST | `/runs/{runId}/cancel` | Cancel a run; releases ceiling slots and target locks |
| POST | `/approvals` · GET `/approvals` · GET `/approvals/{id}` | Approval queue operations |
| POST | `/approvals/{approval_id}/decision` | Approve/reject with signed receipt (approver/admin) |
| GET | `/cases/{case_id}` | Audit case record |
| GET | `/tickets/{ticket_key}/status` | Ticket state across lanes |
| POST | `/support/drafts/start` | Start a cited support draft |
| POST | `/support/send` | Send only with a signed single-use receipt |

There is no direct arbitrary patch/posting endpoint: coding and finance actions are
started as runs and only execute through their gates.

## Verify & quality gates

```powershell
python -m ruff check apps/api
python -m mypy                      # strict; packages allrounder_api
python -m pytest                    # offline; coverage gate ≥ 80 % (fail_under)
python scripts/golden-eval.py       # 12 golden routing cases; also a CI job step
npm run typecheck                   # tsc root + test config + approval-ui
npm test                            # vitest (src/mastra lanes) + approval-ui tests
npm run test:coverage
npm run build
```

Contract parity: canonical Pydantic JSON Schemas live in `contracts/jsonschema` (ticket,
risk-score, triage-verdict, evidence-pack); the Python tests regenerate and compare them,
and `fixtures/contract_parity.json` is shared with the TypeScript tests to check
Pydantic/Zod acceptance parity. Credential-free demonstration:

```powershell
python -m pytest apps/api/tests
npx vitest run src/mastra
```

## Docker

The Compose stack runs the FastAPI service, the static UI, Redis, and an ops pair:
Prometheus (~15 s scrape of `api:8000/metrics`) and Grafana with a provisioned
datasource plus the **AllRounder chat and API health** dashboard (`chat-stream`); both
read `ops/` config and keep state in named volumes. Supabase stays hosted. Populate
`.env`, apply the Supabase migrations, then:

```powershell
docker compose build
docker compose up -d
docker compose ps
```

Open the UI at `http://localhost:3000`, the health endpoint at
`http://localhost:8000/health`, Prometheus at `http://localhost:9090`, and Grafana at
`http://localhost:3001` (admin login from `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`,
defaulting to `admin` / `admin` for local use). The UI image receives only the
browser-safe `NEXT_PUBLIC_*` build arguments (mapped from the root `VITE_*` values in
`compose.yaml`); backend secrets remain in the API container at runtime. Stop with
`docker compose down`; add `--volumes` only when you intentionally want to delete Redis,
Prometheus, or Grafana state.

### Launching your first workflow run

Workflows are launched from inside a ticket tab, not from a menu: open a ticket from the
board and use the **Start a run** card. When the ticket has no case record yet the card
still renders — pressing **Start run** opens the case automatically (`POST /cases`)
before dispatching, so no manual seeding is needed. To launch one locally:

1. Sign in with a Supabase user whose `app_metadata` carries `roles` (`viewer`, `agent`,
   `approver`, or `admin`; starting runs needs `agent`/`admin`) and a `tenant_id` listed
   in `JIRA_TENANT_PROJECT_ALLOWLIST` — the board and run endpoints authorize from the
   signed JWT only.
2. Run the Mastra host on the same machine (`npm run dev:mastra`) and point the API
   container at it in `.env` (`MASTRA_BASE_URL=http://host.docker.internal:4111`), then
   `docker compose up -d api` — without a reachable Mastra host, starting a run cannot
   dispatch.
3. Open a ticket and start the run: pick one of the six workflows, fill the inputs, and
   **Start run** — the run suspends at step one and the action bar
   (Back / Edit / Regenerate / Proceed / Abort) drives every checkpoint with a signed
   receipt. The stepper shows one step at a time; select a step to inspect it.

`python scripts/seed-case.py SCRUM-12` remains available for seeding a case without
touching the UI (`--domain` / `--tenant` override the defaults).

## Load testing & evals

Chat load tests use k6 (`scripts/loadtest/k6-chat.js`, see the
[loadtest README](scripts/loadtest/README.md)): `chat` / `stream` / `mixed` flows, with
thresholds on failure rate, p95 latency, and checks; `429`s are expected traffic and are
validated for a numeric `Retry-After` instead of failing the run. Server-side TTFT
(`chat_first_token_seconds`, split by `source`) shows on `/metrics` and in the Grafana
dashboard while a run is in flight.

Routing golden cases live in `evals/golden_tickets.jsonl` (12 pinned domain + gate
expectations, including refuse and low-confidence escalation). Replay them with
`python scripts/golden-eval.py`; CI runs the same script as the **Golden ticket gate**
step.

HR lane golden cases live in `evals/hr_lane_cases.jsonl` (25 pinned deterministic-engine
expectations across leave, onboarding, offboarding, screening and HR Help — working-day
math, balances, duplicate scoring, blast-radius planning, rubric scores and retrieval
discipline). They replay through `src/mastra/agents/hr/lane-evals.test.ts` inside
`npm test`; a regression fails with the exact expected-vs-actual pair.

## Documentation

- `AllRounderAgent_Master_Plan_20260906.md` — two-plane vision, subsystem specs,
  data models, API contracts, agent cards, phases, testing and security matrix.
- `Jira_MultiDomain_Agent_Plan_20260906.md` — phase-by-phase plan (Jira flow).
- `Mastra_Agents_Prompting_Guide_20260906.md` — agent prompts and output-shape rules.
- `docs/coding-agent-architecture.md` — implementation architecture; §12 MCP
  prerequisites, §13 the third-party call register with the GitHub/Jira trade-offs.

## Status & known limits

- Phases 0–3 (foundation, dispatcher/support, coding lane, finance) are implemented with
  offline test suites; the Python suite and the Mastra lane tests are credential-free.
- The parallel-safe runs platform (PRs 1–6 of the six developer workflows) is shipped with
  the **PR Review**, **Issue Resolution**, **Feature Implementation**, **Dependency
  Update**, **Accessibility Audit** and **Vendor Onboarding** lanes: the `runs/` service +
  `/runs` API (registry, ceilings, target locks, idempotent receipts, per-run SSE) and the
  console run panel (action bar, queue and lock banners, History, inline edit surfaces).
  Dependency Update scans
  the manifest through a read-only npm-registry surface, lets the user
  regroup/exclude with reasons, toggles bumps per group (majors package-by-package only),
  validates install + tests per group (skip or abort on failures), and opens one Draft
  bump PR per group for a human to merge; the merge step carries the signed receipt.
  Accessibility Audit crawls the route tree (include/auth toggles with a live check
  estimate), groups the axe findings by impact with rule + WCAG ref + element path +
  screenshot, plans per-violation fixes (before/after diffs, bulk-apply for repeated
  rules, manual redesigns flagged separately), and re-scans on the fix branch — the
  Draft fix PR opens only when no critical stays open or an approver waiver with an
  expiry covers it, and the re-scan receipt carries the gate. Vendor Onboarding collects
  the checklist (upload/waive with reason, nudge counters), verifies the checks against
  the vendor registry (duplicate-candidate match scores, manual-review notes for every
  failing check), scores the risk (meter, tier, factor breakdown, approver matrix),
  tracks the approver chain (avatars, SLA age, nudges, comments — reject-with-reason
  walks the run back to Collect), and creates the master record idempotently by tax ID,
  carrying the vendor id and effective date in the receipt.
- The coding and finance lanes execute end to end in tests and scripts; live model-driven
  runs need a real `OPENROUTER_API_KEY`/`MODEL_API_KEY` (currently a placeholder) — the
  deterministic engines and approval/evidence plumbing run without it. Model wiring is
  OpenAI-compatible (`MODEL_BASE_URL`), so pointing it at a local server (Ollama `/v1`,
  vLLM) exercises `/chat` and `/chat/stream` end to end without an external key.
- The marketing lane has agents and contracts but no workflow yet.
- Board listing always uses read-only REST (Rovo MCP exposes no agile-board tools);
  legacy `JIRA_TRANSPORT=http` and `GITHUB_ACCESS=rest` fallbacks remain tested options.
