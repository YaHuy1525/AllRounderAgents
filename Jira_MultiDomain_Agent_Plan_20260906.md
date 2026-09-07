# Jira-Driven Multi-Domain Agent Execution System — Full Build Plan
**Date:** 2026-09-06
**Vision:** Any Jira ticket — coding, finance, marketing, support — is triaged, risk-scored, executed by specialist agents, human-approved where impact demands it, and closed with evidence linked back. Nightly red-teaming and golden evals keep it honest.
**Method:** Competition-proven shapes (UiPath AgentHack 2026 winners) re-implemented on an open stack: Mastra (workflows/agents) + FastAPI (API/webhooks) + Postgres/pgvector + Redis.
**Primary references:** SpectreAI · PostAuto × BE-terna · InsureIQ · FinClose AI · FDE Agent · Gauntlet · FlakeWarden · Agent Factory · Maestro SupportIQ · FrostByte · Meridian/Vigilance 'Q' · Exchange Recon Cockpit · MindTheGap · SelfHeal QA/TestPilot · Agentproof · RTI Sahayak.

---

## 1. Target architecture (the complete workflow)

```
Jira (trigger: webhook on create/label/transition)
  │
  ▼
┌─ Ingestion API (FastAPI) ─────────────────────────────────┐
│ POST /webhooks/jira → verify signature → normalize ticket  │
│ {key, project, labels, priority, summary, description,      │
│  reporter, attachments} → idempotency key per event        │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌─ Dispatcher workflow (Mastra) ────────────────────────────┐
│ triageAgent (cheap model, Zod output):                     │
│   {domain: code|finance|marketing|support,                 │
│    confidence, urgency, needsHuman}                        │
│ preflightAgent (FDE pattern): risk score PER ACTION         │
│   {action, blastRadius, reversibility, score} →             │
│   route: auto | approval-required | refuse+escalate        │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌─ Domain workflows (Mastra, one per domain) ────────────────┐
│ codingFlow    researcher→actor→validate→Draft PR           │
│ financeFlow   reconcile→RCA→specialists→audit pack         │
│ marketingFlow brief→research→draft→brand-guardrail         │
│ supportFlow   triage→retrieve→draft→approval station       │
│ each ends in: suspend() gate calibrated per domain         │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌─ Execution + Evidence ────────────────────────────────────┐
│ tools act (GitHub/Jira/ERP/publish APIs) with idempotency  │
│ keys; evidence comment + attachments posted to Jira issue; │
│ issue transitioned; case record stored (transcript, docs,  │
│ tool calls, costs, decisions)                              │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌─ Nightly loop (off the hot path) ─────────────────────────┐
│ coachAgent red-teams staging (Gauntlet) → breaches file as │
│ regression cases; golden evals run (FlakeWarden split:     │
│ deterministic scorer + grounded classifier); KB distilled  │
│ from resolved tickets (SpectreKB), human-reviewed          │
└───────────────────────────────────────────────────────────┘
```

**Design laws (from the winners):** orchestration designed before agents (SpectreAI) · confidence drives routing; system knows what it doesn't know · nothing outward-facing or irreversible without approval (PostAuto) · evidence-cited reasoning everywhere (FlakeWarden) · read-only by default for money-adjacent work (Exchange Recon) · every decision logged, AI investigates / human decides (Meridian, Vigilance 'Q').

---

## 2. Tool & framework map (per part)

| Part | Framework / tools | Why this choice |
|---|---|---|
| Ingestion API + webhooks | **FastAPI** + `httpx`, Pydantic v2, Jira webhook signatures, idempotency keys (Redis) | SSE/streaming + session skills transfer from gatehouse; signature verify + dedupe before any work |
| Orchestration (all workflows) | **Mastra** Workflows (steps, branches, `suspend()` gates) | Steps-with-branches fits triage→domain→gate; Studio traces = audit evidence |
| Agents | **Mastra** Agents, model-routed (cheap triage → mid research → frontier act/judge) | One framework for agents + memory + evals; provider-agnostic |
| Structured outputs | **Zod** schemas (intent, risk scores, RCA, audit packs) | FinClose lesson: Pydantic/Zod-strict schemas or agents drift |
| Knowledge / RAG | **Postgres + pgvector** (or Qdrant), chunked docs + resolved tickets, citations required | SpectreKB/InsureIQ pattern: grounded, compounding memory |
| Short-term state | **Redis** (sessions, replay buffers, rate counters, idempotency) | Same keyspace discipline as gatehouse plan |
| Durable records | **Postgres** (tickets, cases, approvals, usage, eval results) | Case layer = your audit trail (InsureIQ) |
| Coding tools | GitHub REST API (contents: fetch/patch/commit/PR, never clone — SpectreAI), XML/YAML validators, CI status checks | Zero-clone patching = no stale code, no env |
| Finance connectors | Read-only ERP/API clients first; posting adapters behind approval (Exchange Recon rule) | Money moves only through gates |
| Marketing checks | Brand-guardrail agent (banned claims, tone, legal list) + link/asset validators | Your novelty layer (thin in comp) |
| Evals | **Mastra evals** + golden JSONL sets + deterministic scorers (FlakeWarden split) in CI; nightly coach (Gauntlet) on staging | Quality as pipeline: block on goldens, learn from red-team |
| Observability | OTel traces + Prometheus/Grafana (TTFT/cost/tool success/escalation precision), Studio during dev | Same 10-panel discipline as serving work |
| Secrets/config | Env + vault (never in prompts/logs), per-domain tool scopes | Least privilege per agent (researcher reads, actor writes) |

---

## 3. Phase plan (each phase ends demoable)

### Phase 0 — Skeleton + contracts (week 1)
**Goal:** ticket in → classified → commented, no real actions yet.
- FastAPI: `POST /webhooks/jira` (verify, dedupe, normalize) + stub workflows per domain that only classify and post a "routed to X" comment.
- Zod contracts frozen: `Ticket`, `TriageVerdict{domain,confidence,urgency}`, `RiskScore{action,blastRadius,reversibility,score}`, `EvidencePack`.
- Tools: `jira_comment`, `jira_transition` (real, idempotent).
- **Tools/fw:** FastAPI, Pydantic, Redis (dedupe), Jira API.
- **Refs:** PostAuto (mailbox→classify shape), FDE (risk-score concept).
- **Acceptance:** create/label 10 test tickets → all routed correctly with comments; duplicate webhook delivered twice → acted once. **Demo:** ticket → correct domain comment in under a minute.

### Phase 1 — Support lane live (weeks 2–3)
**Goal:** first production value: questions answered, nothing sends unapproved.
- `supportFlow`: triage → RAG researcher (docs + resolved tickets, citations mandatory) → draft → **approval station** (`suspend()` with draft + transcript + suggested reply) → send + log case.
- Confidence threshold routes low-confidence straight to escalation with human buttons.
- **Tools/fw:** Mastra agents/workflows/memory threads, pgvector, temp≈0 cached FAQ answers.
- **Refs:** PostAuto (approval-before-send), InsureIQ (case tracking + validation checkpoints), Maestro SupportIQ (support loop).
- **Acceptance:** 20-ticket pilot: containment rate + escalation precision measured; zero unapproved sends (assert in tests); every case has transcript + citations. **Demo:** ticket → cited draft → approve → reply + case record.

### Phase 2 — Coding lane live (weeks 4–5)
**Goal:** bug tickets become Draft PRs with evidence.
- `codingFlow`: investigate (fetch logs/code context via APIs, query team KB) → RCA with confidence → surgical patch via GitHub Contents API (never clone) → validate (lint/XML/CI status) → Draft PR + evidence comment + confidence in description.
- Pre-flight risk score per action; destructive commands refused or gated.
- **Tools/fw:** GitHub REST, validators, CI checks API, sandbox preview for risky patches (Agent Factory pattern: manifest + tests + preview + audit).
- **Refs:** SpectreAI (investigate→patch→PR, three paths), Agent Factory (governed builds), SelfHeal QA (refuse real bugs → file defects), MindTheGap (spec quality + gates).
- **Acceptance:** 5 seeded bug tickets → Draft PRs with correct root cause + passing validation; 1 unfixable → escalated with diagnosis (not a bad patch). **Demo:** Jira bug → Draft PR in minutes, human merges.

### Phase 3 — Finance lane live (weeks 6–7)
**Goal:** reconciliation work with audit-grade evidence, humans own postings.
- `financeFlow`: reconcile datasets → detect exceptions → RCA per exception → fan out to specialist agents (GL/treasury/tax shaped to your books) → merge → **audit agent** validates evidence + compliance → Action-Center-style approval → post.
- Connectors read-only first; posting adapters unlock per-action approval.
- **Tools/fw:** read-only ERP/CSV/API clients, reconcilers, audit checklist agent, Zod-strict packs.
- **Refs:** FinClose AI (specialist fan-out + merge + audit), Exchange Recon Cockpit (read-only-by-design + HITL), PaySense/InvoiceShield (draft vs own split).
- **Acceptance:** month-end sample reconciled with exception report + audit pack; no posting without approval (test asserts). **Demo:** ticket → recon report → approve → posted + audit trail.

### Phase 4 — Marketing lane live (weeks 8–9, your differentiator)
**Goal:** briefs become publish-ready drafts that pass brand review.
- `marketingFlow`: brief ticket → researcher grounds claims (competitor/offer sources, FrostByte-style structuring) → drafter → **brand-guardrail agent** (banned claims, tone, legal, link/asset checks) → human approval → publish/schedule tool.
- **Tools/fw:** grounding search, guardrail lists as versioned config, scheduler/publish APIs behind approval.
- **Refs:** FrostByte (unstructured→verified JSON), ClearHire (chat-first flows), gap noted: no winner owned this end-to-end.
- **Acceptance:** 5 briefs → drafts with sourced claims + guardrail reports; 1 deliberately off-brand brief → blocked with reasons. **Demo:** brief → approved post with claim citations.

### Phase 5 — Governance hardening (week 10)
**Goal:** one approval/risk/audit model across all four lanes.
- Unified pre-flight scoring thresholds per domain; cross-domain escalation (e.g. support ticket revealing a bug spawns a linked coding ticket — Nexus Maestro's 1-case-multi-agent spirit).
- Audit-first redaction for sensitive tickets (RTI Sahayak: cite-clause redaction + mandatory approval).
- Read-only defaults review for every tool; permission matrix doc.
- **Refs:** FDE (unified risk), Nexus Maestro (multi-agent case), RTI Sahayak (audit-first), Meridian/Vigilance 'Q' (log every decision).
- **Acceptance:** permission matrix test suite green; cross-domain spawn works; redaction tests pass. **Demo:** support ticket → linked bug ticket auto-filed with evidence.

### Phase 6 — Eval + red-team loop (week 11)
**Goal:** quality gates that bite.
- Golden sets per domain in CI (FlakeWarden split: deterministic scorer for format/citations/tool-shape + grounded classifier for judgment calls); regressions block prompt/model/workflow changes.
- Nightly `coachAgent` attacks staging per domain (Gauntlet); breaches auto-filed as regression cases, OWASP-tagged; fix loop proposes prompt/scope patches for approval.
- Agentproof-style deployment gate for workflow changes.
- **Tools/fw:** Mastra evals, JSONL goldens, CI workflow, staging env.
- **Refs:** Gauntlet, FlakeWarden, Penetron, Agentproof, Cricible/Crucible.
- **Acceptance:** deliberately regress a prompt → CI holds; coach finds ≥1 planted vulnerability → filed + tagged. **Demo:** red-team night report with new regression cases.

### Phase 7 — Operate + harden (week 12)
**Goal:** boring reliability: SLOs, costs, on-call.
- Per-domain SLOs (triage latency, containment, approval wait, cost per resolved ticket), Grafana dashboards, alerts; per-tenant quotas + spend caps (gatehouse muscle reused); runbooks; incident drill (kill backend mid-run → resume; revoke key → 401).
- Docs: architecture, permission matrix, canary/rollback for workflow changes, cost report.
- **Acceptance:** SLO dashboard live; drill results recorded; cost-per-ticket reported per domain. **Demo:** full journey — 4 tickets (one per domain) filed live, all four resolve through gates with evidence on Jira.

---

## 4. Competition-reference index (what each project contributes)

| Project | Track/result | Contributes to this plan |
|---|---|---|
| SpectreAI | BPMN 1st | Trigger→investigate→patch→PR; confidence routing; three paths; never-clone patching; KB memory |
| PostAuto × BE-terna | Case honorable | Classify→retrieve→draft→approval-before-send; agent drafts + human refinement loop |
| InsureIQ | Case 1st + Best Demo | Case tracking; validation checkpoints; explainability; modular doc→analysis→recommendation |
| FinClose AI | Finalist | Specialist fan-out + merge gateway + audit agent + approval; strict schemas |
| FDE Agent | BPMN 3rd | Pre-flight per-node AI-delegation risk scoring → unified gate |
| Gauntlet | Grand Prize | Red-team coach; breach→regression-test pipeline; OWASP/MITRE tagging; fix recommender |
| FlakeWarden | Test Cloud 1st | Deterministic scorer + grounded classifier split; evidence-cited verdicts; human approves fixes |
| Agent Factory | Finalist | Request→governed build: clarification, approvals, manifest, tests, sandbox preview, audit |
| Maestro SupportIQ | Gallery | Support orchestration with continuous improvement loop |
| FrostByte | Operative 3rd | Unstructured material → verified structured output; multimodal grounding |
| Nexus Maestro | Most Creative | One case → multi-agent investigation with parallel calls + HITL |
| Meridian / Vigilance 'Q' | People's Choice | Escalate-only-when-needed; every decision logged; AI investigates / human decides |
| Exchange Recon Cockpit | Gallery | Read-only-by-design + HITL for money-adjacent work |
| MindTheGap | Gallery | Requirement structuring + enforced gates + lessons remembered |
| SelfHeal QA / TestPilot / ReqToTest | Gallery/Test | Heal-vs-file discipline; quarantine flakes; requirements→governed tests |
| Penetron / Cricible / Agentproof | Test Cloud | Exploit-to-prove vulns; resilience testing; deployment gates for agents |
| RTI Sahayak | Gallery | Audit-first redaction with cited clauses + mandatory approval |
| Do Not Consume | Case 2nd + People's Choice | Fragment-coordination around shared keys; zero-tolerance structured compliance output |
| PaySense / InvoiceShield / Loan Shield | Gallery | Draft-vs-own financial split; evidence triage |
| ClearHire-AI / MediFlow / EpiAgent | Gallery/finalists | Chat-first flows; referral-style lifecycles; ops investigation shape |

## 5. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Agent acts wrongly on live systems | Read-only defaults; pre-flight scores; approvals on irreversible/outward steps; idempotency everywhere |
| Prompt-injection via ticket text | Treat ticket content as untrusted (Gauntlet-tested); guardrail agents; tool allowlists per agent |
| Cost blowup (4 domains × frontier models) | Model routing (cheap triage, strong act); temp≈0 caching; per-tenant quotas + spend caps |
| Eval theater (goldens that always pass) | Deterministic scorers + adversarial coach + planted-regression drills |
| Scope explosion | One domain live before next starts; Phase gates require acceptance demos |

## 6. Timeline

Weeks 1–3: Phases 0–1 (support value live) · 4–5: coding · 6–7: finance · 8–9: marketing · 10: governance · 11: eval/red-team · 12: operate. ~12 weeks at steady pace; support lane alone (Phase 1) is a shippable milestone at week 3.

*Next step: approve Phase 0 contracts (§3) and the tool/framework map (§2), and I'll scaffold the ingestion API + dispatcher workflow + Jira tools as the first code.*
