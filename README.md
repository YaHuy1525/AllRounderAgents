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
                        runs, Jira transports (Rovo MCP + REST), Supabase persistence
  approval-ui/          Minimal TypeScript SPA (Vite): Jira board + approval queue
src/mastra/             Mastra agent plane: agents (14 across 5 lanes), flows,
                        GitHub MCP/REST tools, dev host instance (instance.ts)
contracts/jsonschema/   Canonical Pydantic JSON Schemas: ticket, risk-score,
                        triage-verdict, evidence-pack
supabase/migrations/    6 ordered SQL migrations: foundation → phase 3 finance
fixtures/               Shared payloads used by Python and TypeScript parity tests
scripts/                Developer/verification helpers (MCP connectivity checks, …)
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

The Mastra dev host (`src/mastra/instance.ts`) always registers `financeFlow`; `codingFlow`
registers only when the `GITHUB_*` policy env block is present, and uses the GitHub MCP
backend by default. Deterministic engines (`reconcile`, `rca`, `proposePosting`, `audit`,
pilot metrics, dispatcher steps) are exported as plain functions so they are fully
testable without model credentials.

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

## Third-party access: MCP-first

The default for every third-party seam is an MCP server; REST remains as an explicit
fallback. The living register lives in
[docs/coding-agent-architecture.md §13](docs/coding-agent-architecture.md).

| Third party | Used for | Default backend | Config |
| --- | --- | --- | --- |
| GitHub | Coding-lane reads/writes, Draft PRs, Checks API | GitHub MCP server (`https://api.githubcopilot.com/mcp/`), bearer PAT | `GITHUB_ACCESS=mcp`, `GITHUB_MCP_TOKEN` |
| Atlassian Jira | Comments, transitions, JQL search, seed creation | Atlassian Rovo MCP (`https://mcp.atlassian.com/v2/mcp`) | `JIRA_TRANSPORT=mcp`, `JIRA_EMAIL` + agent-interface-scoped `JIRA_API_TOKEN` |
| Jira boards | Board listing (approval UI) | Read-only REST always (Rovo MCP has no agile-board tools) | `JIRA_BASE_URL` + same email/token |
| Models | Mastra agents + `/chat` | Model router (DeepSeek) | `DEEPSEEK_API_KEY` |

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
`JIRA_CLOUD_ID` block, `MODEL_*`, `DEEPSEEK_API_KEY`, `EMBEDDING_MODEL`,
`EMBEDDING_DIMENSIONS=1536`, and the `GITHUB_*` block.

**Browser-safe** (only these three, plus documented `NEXT_PUBLIC_*` equivalents):
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`. The approval UI never uses
the service-role key.

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
patch manifests, Draft PR receipts, durable idempotency), hardening, and Phase 3 finance
(runs, audit packs, postings). Every table has RLS enabled and forced; the API connects
server-side.

In Supabase Auth, assign authorization only in signed `app_metadata`, for example
`{"tenant_id":"tenant-a","roles":["approver"]}`. Supported roles are `viewer`, `agent`,
`approver`, and `admin` — never accept browser-provided profile/user metadata as roles.

Seed guidance: ingest versioned support docs and redacted resolved tickets through
`KnowledgeDocument`/`PostgresKnowledgeStore` with stable `source_id`, tenant,
`source_version`, and `stale_after`. Never seed raw customer PII or credentials.

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

Seed the four finance-lane demo tickets (idempotent — existing summaries are detected and
skipped via JQL):

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
`DATABASE_URL`, Supabase JWKS bearer verification, durable repositories, and the
configured Jira transport. Tests inject in-memory fakes, so the suite needs no Jira,
Supabase, Redis, model, or GitHub credentials.

Run the Mastra agent plane (Studio at the printed URL):

```powershell
npm run dev:mastra     # mastra dev --dir src/mastra  (loads .env, registers financeFlow + codingFlow when allowlisted)
npm run studio         # standalone Mastra Studio
```

Run the approval UI separately:

```powershell
npm run dev -w @allrounder/approval-ui
```

The UI uses Supabase magic-link auth and sends the access token as a bearer token. It
shows the Jira board (Backlog, To Do, Ready for Dev, In Progress, Done; links open in
Jira) and the approval queue. Set `JIRA_PROJECT_KEY` and
`JIRA_TENANT_PROJECT_ALLOWLIST`, then use **Refresh Jira** to load up to 100 issues via
backend-only credentials. All ticket/draft/evidence content is rendered with DOM
`textContent` only.

Leave `TRUSTED_PROXY_IPS=[]` for local development; in production list only the exact
ingress/load-balancer IPs whose `X-Forwarded-For` the API may trust.

## API surface

All endpoints below `/approvals`, `/coding`, `/finance`, `/jira`, and `/chat` require a
Supabase bearer token with tenant roles from signed `app_metadata`. The API adds
security headers, per-IP rate limiting (per `TRUSTED_PROXY_IPS`), and no-store caching.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/webhooks/jira` | Jira webhook entry: HMAC verification, dedupe, triage/pre-flight, enqueue + comment receipt (`deduped` on replay) |
| GET | `/health` | Liveness |
| POST | `/chat` | Chat completion through the model router |
| GET | `/jira/workspace` | Tenant-scoped project/board visibility (board UI) |
| GET | `/jira/issues` | Up to 100 issues via backend Jira credentials (board UI) |
| POST | `/coding/runs` | Start a coding run (RCA → patch → Draft PR) |
| GET | `/coding/runs/{run_id}` | Run status, evidence, PR receipts |
| POST | `/finance/runs` | Start a finance reconciliation run (ledger vs bank, audit pack) |
| GET | `/finance/runs/{run_id}` | Run, exceptions, audit pack |
| POST | `/finance/runs/{run_id}/post` | Post after an approved signed receipt (approver/admin) |
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

The Compose stack runs the FastAPI service, the static UI, and Redis; Supabase stays
hosted. Populate `.env`, apply the Supabase migrations, then:

```powershell
docker compose build
docker compose up -d
docker compose ps
```

Open the UI at `http://localhost:3000` and the health endpoint at
`http://localhost:8000/health`. The UI image receives only the `VITE_*` build arguments;
backend secrets remain in the API container at runtime. Stop with `docker compose down`;
add `--volumes` only when you intentionally want to delete Redis state.

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
- The coding and finance lanes execute end to end in tests and scripts; live model-driven
  runs need a real `DEEPSEEK_API_KEY`/`MODEL_API_KEY` (currently a placeholder) — the
  deterministic engines and approval/evidence plumbing run without it.
- The marketing lane has agents and contracts but no workflow yet.
- Board listing always uses read-only REST (Rovo MCP exposes no agile-board tools);
  legacy `JIRA_TRANSPORT=http` and `GITHUB_ACCESS=rest` fallbacks remain tested options.
