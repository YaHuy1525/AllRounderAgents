# AllRounderAgent — Master Build Plan (In-Depth)
**Date:** 2026-09-06 · **Folder:** `D:\Code\AllRounderAgent`
**Vision:** One system that takes a Jira ticket in any domain — coding, finance, marketing, support — and drives it to a done state with evidence: triaged, risk-scored, executed by specialist agents, approved by humans where impact demands it, metered, logged, and continuously red-teamed.
**Method:** Competition-proven shapes (UiPath AgentHack 2026) re-implemented on an open stack you own end to end.
**Supersedes/extends:** `Jira_MultiDomain_Agent_Plan_20260906.md` (kept as the phase summary) and the Gatehouse serving plan (serving layer, §2 below).

---

## 0. Reading guide

- §1–2: what the system is (two planes + one governance spine).
- §3: every subsystem specified — responsibility, owns/doesn't-own, technology, interface, state, failure behavior, config knobs.
- §4–5: frozen data models and API contracts. Freeze these before code; everything builds to them.
- §6–7: agent cards and tool catalog — the complete roster.
- §8: 8 phases, each with goal → week-by-week tasks → exit criteria → demo script.
- §9–12: testing, security matrix, observability, eval design.
- §13–15: cost model, risks, competition traceability.
- §16: timeline, milestones, first-code checklist.

---

## 1. System map — two planes, one spine

```
                        ┌─── GOVERNANCE SPINE (applies to everything) ───┐
                        │ pre-flight risk scores · approvals · audit log │
                        │ golden evals · red-team · permission matrix    │
                        └───────────────────────┬───────────────────────┘
                                                ▼
┌─ SERVING PLANE (gatehouse: tokens in/out, reliably) ─────────────────┐
│ Edge → Identity → Policy/Limits → Sessions → Inference backends       │
│ → Delivery(SSE) → Metering → Observability · Release/Eval gates      │
│ Serves: the chat widget, agent model calls, batch eval traffic.       │
│ SLOs: p99 TTFT, TPOT, stream-break rate, cost/token.                  │
└───────────────────────────┬───────────────────────────────────────────┘
                            │ model routes + budgets + traces
                            ▼
┌─ AGENT PLANE (this plan's focus: tickets in, done out) ──────────────┐
│ Jira webhook → Ingestion → Dispatcher (triage + pre-flight)           │
│ → Domain workflows (code|finance|marketing|support)                   │
│ → Approval gates → Executors (tools) → Evidence back to Jira          │
│ → Case store → Nightly coach + goldens → KB distillation              │
│ SLOs: containment, escalation precision, approval wait, cost/ticket.  │
└───────────────────────────────────────────────────────────────────────┘
```

Why two planes: the serving plane is domain-blind infrastructure (any caller gets reliable tokens); the agent plane is domain-aware judgment (tickets become outcomes). The agent plane calls the serving plane for all model traffic, inheriting budgets, traces, and metering for free. Build serving first only if you need your own inference; otherwise point the agent plane at third-party models through the same gateway interface and backfill your own engine later — the seam is identical.

---

## 2. Serving plane spec (condensed — full detail lives in the phase tasks)

Nine subsystems, each one responsibility (§3 of the gatehouse design): Edge (HTTP boundary + RequestContext) · Identity (keys/scopes/revoke) · Policy (admit/throttle/shed: 429-vs-529) · Sessions (SSE resume via Last-Event-ID) · Inference (mock|ollama|vLLM behind one interface + cancel) · Delivery (SSE framing, backpressure, receipts) · Metering (integer micro-dollars, caps → 402) · Observability (JSON logs, OTel, Prometheus/Grafana, DCGM) · Release/Eval (golden gate + canary + rollback). Shared contracts: RequestContext object, Redis keyspace scheme, Postgres tables (api_keys, request_log, usage_daily), SSE/error envelopes. Non-goals: vector cache, multi-model router, training code. This plane is what makes every agent call below cheap, traced, and resumable.

---

## 3. Agent-plane subsystems (deep spec)

### 3.1 Ingestion — *owns the Jira boundary*
- **Responsibility:** convert Jira webhooks into normalized, deduplicated internal tickets. Nothing downstream ever touches raw webhook payloads.
- **Owns:** signature verification, event dedupe (Redis idempotency per `webhookEvent+issue+timestamp`), normalization to `Ticket`, attachment fetching, initial `received` comment.
- **Does NOT own:** any judgment (no classification here — Dispatcher owns it).
- **Technology:** FastAPI (`POST /webhooks/jira`), Pydantic v2, `httpx` to Jira REST, Redis dedupe keys (TTL 24h).
- **Interface out:** `Ticket{key, project, issueType, labels, priority, summary, description, reporter, attachments[], eventId}` onto the dispatcher queue.
- **State:** dedupe keys only; all else passed through.
- **Failure:** bad signature → 401 + alert (possible spoof); duplicate → 200 + `deduped:true`, zero reprocessing; Jira down → DLQ with backoff, never drop silently.
- **Config knobs:** `WEBHOOK_SECRET`, project→enabled map, max attachment MB, DLQ retries/backoff.

### 3.2 Dispatcher — *owns routing + risk, the highest-leverage 200 lines*
- **Responsibility:** decide *which* domain workflow runs, *whether* it may act, and *who* must approve. Two agents, strictly ordered: triage first, pre-flight second.
- **Owns:** `triageAgent` (cheap model, Zod-only output `{domain, confidence, urgency, needsHuman, rationale}`), `preflightAgent` (FDE pattern: scores EACH planned action `{action, blastRadius: low|med|high, reversibility: reversible|compensable|irreversible, score 0–100}`), routing table domain→workflow, confidence thresholds per domain.
- **Does NOT own:** execution (domain workflows), approvals UI (renders into the gate in §3.5), or the risk policy values (versioned config, human-owned).
- **Technology:** Mastra workflow `jiraDispatcher` (steps: normalize → triage → preflight → route), Zod schemas, thresholds in `policy/risk.yaml`.
- **Interface out:** `RoutedTicket{ticket, domain, confidence, riskScores[], gate: auto|approval|refuse}`.
- **Failure:** triage confidence < domain threshold → escalate-with-context (SpectreAI rule: system knows what it doesn't know); preflight flags irreversible+high-blast → refuse + human task, never auto-run; model timeout → safe default route = escalate.
- **Config knobs:** per-domain confidence thresholds, per-action-class risk weights, auto/approval/refuse bands, escalation targets per project.

### 3.3 Domain workflows — *own domain judgment*
Four Mastra workflows, identical skeleton, different agents/tools/gates:
- **Common skeleton:** `load-context → plan (structured) → retrieve/evidence → act (tools) → validate → gate → close-with-evidence`. Validation is a step, not a hope: every workflow has a `validate` step with domain checks before the gate.
- **codingFlow** (SpectreAI + Agent Factory): investigate (logs/code via APIs + team KB) → RCA `{cause, confidence, evidence[]}` → patch via GitHub Contents API (never clone) → validate (lint/schema/CI status) → Draft PR → evidence comment. Unfixable → escalate with diagnosis, never a bad patch (SelfHeal discipline).
- **financeFlow** (FinClose + Exchange Recon): reconcile → exceptions → RCA each → fan out to specialists (GL/treasury/tax shaped to your books) → merge gateway → **audit agent** (evidence + compliance checklist) → approval → post. Connectors read-only until the gate passes.
- **marketingFlow** (FrostByte + your gap): brief → researcher grounds every claim (sources attached) → drafter → **brand-guardrail agent** (versioned banned-claims/tone/legal lists + link/asset validators) → approval → publish/schedule.
- **supportFlow** (PostAuto + InsureIQ): triage → RAG researcher (docs + resolved tickets, citations mandatory) → draft → approval station → send + case log. Low confidence → human buttons immediately.
- **Technology:** Mastra Workflows + Agents + memory threads per ticket; pgvector KBs per domain; temp≈0 cached deterministic steps.
- **Interface out:** `DomainResult{actions[], evidence[], confidence, costUsd, gateDecision}` to §3.5/§3.6.
- **Failure:** any tool error → classify (transient → retry with idempotency; data → escalate with partial evidence; auth → halt + alert); validation fail → back to plan step once, then escalate (no infinite repair loops).

### 3.4 Knowledge (RAG + KBs) — *owns grounded memory*
- **Responsibility:** every claim an agent makes must resolve to a retrievable source. Plus compounding: resolved tickets distill into KB weekly, human-reviewed (SpectreKB).
- **Owns:** per-domain corpora (docs, runbooks, resolved tickets), chunking/embedding pipeline, citation format `{sourceId, span}`, distillation job + review queue.
- **Does NOT own:** generation (agents), or truth (sources are versioned; stale sources flagged, never silently trusted).
- **Technology:** Postgres + pgvector (or Qdrant), embedding model pinned + versioned, weekly `distill` workflow.
- **Interface:** `retrieve(domain, query, k) → CitedPassage[]`; `propose_distillation(case) → ReviewItem`.
- **Failure:** empty retrieval → agent must say so and escalate, never invent (tested: retrieval-empty golden cases).

### 3.5 Approval gates — *own human authority*
- **Responsibility:** the single choke point for outward-facing or irreversible acts. One gate component, calibrated per domain — not four different mechanisms.
- **Owns:** `suspend()` payloads `{draft/action, transcript, evidence, riskScores, suggestedReply, expiry}`, approver routing per project/domain, timeout policy (expire → escalate, never auto-approve), decision log.
- **Does NOT own:** the decision (human), or the action (executor replays it post-approval with the same idempotency key).
- **Technology:** Mastra `suspend()/resume()`, approval UI (minimal web or chat buttons), Postgres `approvals` table.
- **Calibration:** code (PR review suffices for low-risk; explicit approve for prod paths) · finance (always approve postings) · marketing-outbound (always approve) · support replies (approve station; auto-send only for allowlisted FAQ intents after Phase 7 metrics justify it).
- **Failure:** approver timeout → escalate up, ticket stays open with full context; approval service down → all gates fail closed (nothing acts).

### 3.6 Executors + evidence — *own side effects and their receipts*
- **Responsibility:** perform approved acts idempotently and post machine-checkable evidence back to Jira.
- **Owns:** tool implementations (GitHub/Jira/ERP/publish APIs), idempotency keys per action, evidence comment format (what ran, what changed, links: PR/commit/posting/ticket, cost, confidence), Jira transition.
- **Does NOT own:** permission to act (gate receipt required — executor verifies the approval token, never trusts caller claims).
- **Technology:** tool modules with `execute(ctx, approval)` signatures; retries only pre-effect with backoff+jitter.
- **Interface out:** `ExecutionReceipt{action, status, artifacts[], costUsd}` → case store + Jira comment.
- **Failure:** partial completion → compensate or escalate with exact state (never "half-done silently"); duplicate delivery → idempotency returns original receipt.

### 3.7 Case store — *owns the audit trail*
- **Responsibility:** one queryable record per ticket: transcript, retrieved passages, tool calls, decisions, approvals, costs, outcomes (InsureIQ/Meridian rule: every decision logged).
- **Owns:** Postgres `cases` (+ attachments refs), retention/redaction policy, per-case cost rollup, export for evals/KB.
- **Does NOT own:** live state (Redis/sessions) or metrics aggregation (Observability reads from here + serving metrics).
- **Technology:** Postgres + JSONB, PII redaction at write time (Presidio-style), ticket-key indexed.
- **Interface:** `append(caseId, event)`, `get(caseId) → full record`, `export(domain, window) → eval/KB feed`.

### 3.8 Nightly loop — *owns honesty*
- **Responsibility:** prove the system still deserves trust: red-team it, grade it, teach it.
- **Owns:** `coachAgent` (Gauntlet: attack staging per domain, file breaches as OWASP-tagged regression cases), golden eval runs (FlakeWarden split: deterministic scorers + grounded classifier judges), KB distillation proposals, drift reports (escalation rate, cost/ticket, containment trends).
- **Does NOT own:** production traffic (staging/cloned tickets only) or auto-merging fixes (proposes; human approves — Agentproof gate).
- **Technology:** scheduled Mastra workflows, JSONL goldens, CI job that blocks on regression, staging namespace.
- **Interface out:** `NightlyReport{breaches[], evalDeltas, distillProposals[], verdict: GREEN|HOLD}`. HOLD pages the owner and freezes prompt/model/workflow changes.

---

## 4. Frozen data models

```ts
// Ticket (ingestion output — only shape downstream ever sees)
Ticket { key: string; project: string; issueType: string; labels: string[];
  priority: "Highest"|"High"|"Medium"|"Low"|"Lowest";
  summary: string (<=500); description: string; reporter: string;
  attachments: {id, name, mime, bytes}[]; eventId: string; receivedAt: iso }
// TriageVerdict (cheap model, Zod-validated)
TriageVerdict { domain: "code"|"finance"|"marketing"|"support"|"unknown";
  confidence: 0..1; urgency: 1..5; needsHuman: boolean; rationale: string }
// RiskScore, per planned action (FDE pattern)
RiskScore { action: string; blastRadius: "low"|"med"|"high";
  reversibility: "reversible"|"compensable"|"irreversible"; score: 0..100;
  gate: "auto"|"approval"|"refuse"; reasons: string[] }
// EvidencePack (every domain result carries one)
EvidencePack { actions: {tool, args_redacted, status, artifactUrls[]}»;
  citations: {sourceId, span}[]; confidence: 0..1; costUsdMicro: int;
  transcriptRef: caseId; modelTrail: {step, model, tokens}[] }
// Case (audit record)
Case { caseId; ticketKey; domain; status; verdict; riskScores: RiskScore[];
  events: {t, actor: agent|human|system, kind, payload}[]; approvals: Approval[];
  evidence: EvidencePack; costUsdMicro: int; outcome: string }
// Approval
Approval { id; caseId; payload: {draft|action, evidence, riskScores, suggestedReply};
  approver; decision: approved|rejected|expired|null; decidedAt: iso|null; expiresAt: iso }
```

Money in integer micro-dollars everywhere. Secrets never in payloads (redacted at write). Zod (Mastra side) mirrors Pydantic (FastAPI side); a contract test asserts they accept/reject identically.

---

## 5. API contracts

```
POST /webhooks/jira            ingest (verify→dedupe→normalize→enqueue) → 200 {ticketKey, deduped}
GET  /tickets/{key}/status     dispatcher/domain state + gate state (for Jira panel / chat widget)
POST /approvals/{id}/decision  {decision, comment} → resumes workflow (human UI + chat buttons)
GET  /cases/{id}               full audit record (redacted per role)
POST /chat/stream (SSE)        support widget: {session_id, message} → cited draft stream + escalation events
GET  /usage/daily, /metrics, /health   (serving plane, reused)
POST /admin/policies/risk      versioned threshold updates (human-owned, audited)
```

---

## 6. Agent cards (complete roster)

| Agent | Model tier | Tools (least privilege) | Input → Output | Guardrails |
|---|---|---|---|---|
| triageAgent | cheap | none (classify only) | Ticket → TriageVerdict | confidence floor; unknown→escalate |
| preflightAgent | cheap/mid | policy tables (read) | planned actions → RiskScore[] | bands in versioned config; humans own values |
| supportResearcher | mid | searchDocs, ticketHistory | query → cited draft | citations mandatory; empty retrieval → escalate |
| supportActor | mid | reply (gated), createTicket, escalate | draft+gate → sent reply + case | approval station; allowlist auto-send only |
| codeInvestigator | mid | codeFetch (GitHub contents), logFetch, kbSearch | ticket → RCA{cause,confidence,evidence} | read-only; no exec |
| codePatcher | strong | patchFile, validate, openPR(draft) | RCA → PR URL + validation report | never clone; validate-before-commit; destructive refused |
| reconAgent | mid | datasetRead, erpRead | datasets → recon report + exceptions | read-only |
| rcaAgent | mid | evidenceStore, kbSearch | exception → cause + owner function | scoped per exception |
| domainSpecialists (GL/treasury/tax-shaped) | mid | ledgerRead, rulesCheck | exception → finding | no posting tools attached |
| auditAgent | mid/strong | checklist, evidenceVerify | findings → audit pack + readiness | blocks gate on missing evidence |
| briefResearcher | mid | webSearch, competitorDocs | brief → sourced claims | every claim cited or dropped |
| drafter | mid | styleGuide | claims → draft | no publish tool attached |
| brandGuard | cheap/mid | guardLists (versioned), linkCheck | draft → GuardReport{pass, violations[]} | block on violation; lists human-owned |
| coachAgent (nightly) | strong | staging-only toolset | domain → breaches[] | staging namespace; cannot touch prod |
| distiller (weekly) | mid | caseExport, kbPropose | cases → ReviewItems | human approves into KB |

---

## 7. Tool catalog (scope, idempotency, approval class)

| Tool | Scope | Idempotent? | Approval class |
|---|---|---|---|
| jira_comment / jira_transition | issues in scope | yes (eventId key) | auto |
| searchDocs / ticketHistory / codeFetch / logFetch / datasetRead / erpRead | read-only | n/a (reads) | auto |
| openPR (draft only) | repo allowlist | yes (branch+patch hash) | low-risk auto / prod-path approval |
| createTicket / linkTickets | projects in scope | yes (correlation id) | auto |
| postJournal / executePayment-class | finance adapters | yes (ledger key) — plus compensate plan | always approval |
| publishPost / schedulePost | channels in scope | yes (content hash) | always approval |
| sendReply | support channel | yes (draft hash) | approval station (allowlist auto-send later) |
| escalate | human queue | yes | auto (escalation is always allowed) |

---

## 8. Phases in depth (goal → tasks → exit → demo)

### Phase 0 — Skeleton + contracts (week 1)
**Goal:** ticket in → classified → commented. No real actions.
Tasks: FastAPI ingest (verify/dedupe/normalize) · Mastra `jiraDispatcher` stub (triage real via cheap model, domain workflows stubbed to comment-only) · freeze §4 models + contract tests (Zod⇄Pydantic parity) · `jira_comment/transition` tools live · Redis dedupe + DLQ · 10-ticket fixture set (2–3 per domain + 1 unknown + 1 duplicate delivery).
Exit: 10/10 routed correctly; duplicate acted once; unknown escalated with context. Demo: file ticket → domain comment <60s.

### Phase 1 — Support lane (weeks 2–3)
**Goal:** first production value; zero unapproved sends.
Tasks: pgvector corpus (docs + 20 seed resolved tickets) + `retrieve` with citation format · `supportFlow` (triage→research→draft→suspend approval→send→case) · approval UI minimal (web page + buttons) · confidence-threshold escalation · temp≈0 FAQ cache · case writer + redaction.
Exit: 20-ticket pilot with containment rate + escalation precision recorded; test asserts zero sends without approval receipt; all cases complete. Demo: ticket → cited draft → approve → reply + case.

### Phase 2 — Coding lane (weeks 4–5)
**Goal:** bugs become Draft PRs with evidence.
Tasks: GitHub Contents-API client (fetch/patch/commit/PR, no clone) · `codeInvestigator` (logs+code+KB → RCA schema) · `codePatcher` + validators (lint/schema/CI status) · per-action pre-flight scores; destructive-action deny list · sandbox preview job for risky patches (manifest+tests+preview+audit per Agent Factory).
Exit: 5 seeded bugs → correct-RCA Draft PRs passing validation; 1 unfixable → escalated diagnosis, no patch. Demo: Jira bug → Draft PR, human merges.

### Phase 3 — Finance lane (weeks 6–7)
**Goal:** audit-grade recon; humans own every posting.
Tasks: read-only connectors (CSV/API/ERP-sample) · reconciler + exception detector · per-exception RCA → specialist fan-out → merge gateway → `auditAgent` checklist → approval → posting adapter (sandboxed ledger first) · Zod-strict packs.
Exit: sample close reconciled with exception report + audit pack; posting-without-approval test fails closed. Demo: ticket → report → approve → posted + trail.

### Phase 4 — Marketing lane (weeks 8–9, differentiator)
**Goal:** briefs → publish-ready drafts that survive brand review.
Tasks: grounding researcher (sources attached per claim) · drafter · `brandGuard` with versioned lists (banned claims/tone/legal) + link/asset validators · publish/schedule tools behind approval.
Exit: 5 briefs → cited drafts + guard reports; 1 off-brand brief blocked with reasons. Demo: brief → approved post with citations.

### Phase 5 — Governance hardening (week 10)
**Goal:** one risk/approval/audit model everywhere.
Tasks: unify thresholds (`policy/risk.yaml` v1) · cross-domain spawn (support→bug linked ticket, Nexus pattern) · audit-first redaction (RTI pattern) · tool permission matrix + test suite (every tool asserts its scope + approval class) · read-only defaults audit.
Exit: matrix suite green; cross-domain demo works; redaction tests pass. Demo: support ticket → linked bug auto-filed with evidence.

### Phase 6 — Eval + red-team (week 11)
**Goal:** gates that bite.
Tasks: per-domain golden JSONL + deterministic scorers (format/citations/tool-shape) + grounded classifier judges · CI blocking on regression · nightly coach vs staging (OWASP-tagged breach filing) · fix-proposal loop (human approves) · Agentproof-style workflow-change gate.
Exit: planted prompt regression → CI HOLD; planted vuln → coach files it tagged. Demo: night report with new regression cases + held change.

### Phase 7 — Operate (week 12)
**Goal:** boring reliability.
Tasks: per-domain SLOs + Grafana (triage p95, containment, approval wait, cost/ticket, stream health) + alerts · tenant quotas/spend caps · runbooks · incident drills (kill mid-run→resume; revoke→401; provider outage→fallback) · cost report per domain · canary/rollback procedure for workflow changes.
Exit: dashboards live; drills recorded; 4 live tickets (one/domain) resolve through gates with Jira evidence. Demo: the full journey, end to end.

---

## 9. Testing strategy (per layer)

- **Contracts:** Zod⇄Pydantic parity tests; webhook signature/dedupe tests; SSE sequence tests; approval suspend/resume tests.
- **Unit:** limit math (injectable clock), money math (integers), cache-key rules, redaction, risk-band mapping, guardrail lists.
- **Golden (per domain):** JSONL cases with deterministic scorers in CI (must-pass to merge) + classifier judges nightly.
- **Adversarial:** planted vulns + planted regressions on schedule; coach corpus grows only via real findings.
- **Load/chaos:** k6 streaming load (TTFT/TPOT/goodput), disconnect storms, Redis-down drill (fail-open + alert), provider-outage drill (fallback path).
- **Acceptance:** each phase's exit criteria above are the test plan — no phase closes without its demo recorded.

---

## 10. Security & permission matrix

- Ticket content = untrusted input (injection-tested by coach). Agents never execute ticket text as instruction.
- Per-agent tool allowlists (§6); researchers have no write tools; executors verify approval receipts.
- Secrets in vault; per-domain model keys; raw keys never in logs/prompts/cases.
- Finance/marketing-outbound always human-approved; code prod-paths approved; support auto-send only for allowlisted intents post-metrics.
- Redaction at case-write; eval datasets contain no PII; staging isolated with production-shaped (not production) data.
- Quarterly review: permission matrix + approver roster + guardrail lists (versioned, diffed).

## 11. Observability (panels that run the system)

Serving (reused): p99 TTFT/TPOT, stream-break %, queue depth/time, GPU cache pressure, error % by code/model, cost/token. Agent: triage latency p95 + accuracy, containment rate, escalation precision/recall, approval wait p50/p99, tool success %, gate override rate, cost per resolved ticket per domain, coach breach count, golden pass trends, KB hit rate. Alerts: queue depth, error %, TTFT p99, HOLD verdicts, spend-cap approach, approval queue age.

## 12. Eval design (per domain, FlakeWarden split)

- **Deterministic scorers** (cheap, CI-blocking): schema validity, citation presence/format, tool-call shape, allowlist compliance, no-op on unknown, idempotency (replay twice → one effect).
- **Classifier judges** (nightly): grounded in retrieved evidence — answer correctness, RCA plausibility, audit completeness, brand-tone fit. Judges cite evidence spans or their verdict is discarded.
- **Red-team corpus** (nightly, growing): injection via ticket text, approval-bypass attempts, scope-escape attempts, spend-amplification. Each breach → regression case + fix proposal.
- **Anti-theater rules:** goldens versioned; baselines committed; planted regressions quarterly; judge-model rotated; human spot-checks sampled weekly.

## 13. Cost model

Per-ticket cost = triage (cheap, cached patterns) + retrieval (embedding + vector) + draft/act (mid/strong) + judge/guard passes + nightly amortized evals. Controls: model routing by step, temp≈0 caching, retrieval top-k budgets, per-tenant quotas + monthly caps, coach/goldens on cheap judges first. Report cost/resolved-ticket/domain weekly; containment improvements must beat model-cost growth or the roadmap is wrong.

## 14. Risks + mitigations (extended)

| Risk | Mitigation |
|---|---|
| Wrong autonomous action | Read-only defaults; pre-flight bands; approval on irreversible/outward; idempotency; executor verifies receipts |
| Injection via tickets | Untrusted-content discipline; allowlists; guardrail agents; coach-tested; redaction |
| Runaway cost | Routing + caching + quotas + caps + weekly cost/resolved review |
| Eval theater | Split scorers; planted drills; committed baselines; human spot-checks |
| Scope explosion | Domain-at-a-time gates; acceptance demos block next phase |
| Approver fatigue → rubber-stamping | Risk-ordered queues, expiry→escalate, override-rate metric, sampling audits |
| Vendor lock (models/Jira) | Gateway seam for models; ticket adapter interface (Jira first, others later) |

## 15. Competition traceability (why each reference is in the plan)

SpectreAI → dispatcher+three-paths+never-clone+KB (§3.2/§3.3/§6) · PostAuto → classify-retrieve-draft-approve + refinement honesty (§3.3 support, §8 Ph1) · InsureIQ → cases + checkpoints + explainability (§3.7, §8 Ph1) · FinClose → fan-out/merge/audit + strict schemas (§3.3 finance, §4) · FDE → per-action pre-flight bands (§3.2, §3.5) · Gauntlet → coach + breach-to-regression + tagging + fix loop (§3.8, §8 Ph6) · FlakeWarden → scorer/classifier split + evidence-cited verdicts (§12) · Agent Factory → governed builds: manifest/tests/preview/audit (§3.3 coding) · SupportIQ → support loop + improvement (§3.3) · FrostByte → unstructured→verified structuring (§3.3 marketing) · Nexus → cross-domain case spawn (§8 Ph5) · Meridian/Vigilance Q → escalate-only-needed + log-all (§3.5/§3.7) · Exchange Recon → read-only-by-design (§3.3 finance, §10) · MindTheGap → spec quality + gates + lessons (§3.4, §8 Ph2) · SelfHeal/TestPilot/ReqToTest → heal-vs-file + quarantine + req→tests (§3.3 coding, §12) · Penetron/Cricible/Agentproof → exploit-proof + resilience + deploy gates (§3.8) · RTI Sahayak → audit-first redaction + mandatory approval (§3.7, §10) · Do Not Consume → shared-key coordination + zero-tolerance structured output (§3.1 keys, §4 strictness) · PaySense/InvoiceShield/Loan Shield → draft-vs-own money split (§3.3 finance) · ClearHire/MediFlow/EpiAgent → chat-first + lifecycle + investigation shapes (§3.3 support) · ClearHire/ClearPath/Treatment → regulated-domain caution patterns (§10).

## 16. Timeline, milestones, first code

- Weeks 1–3: Phases 0–1 — **M1: support value live** (shippable milestone).
- Weeks 4–5: Phase 2 — **M2: first Draft PR from a ticket**.
- Weeks 6–9: Phases 3–4 — **M3: finance + marketing live** (all four lanes).
- Week 10: Phase 5 — **M4: unified governance**.
- Week 11: Phase 6 — **M5: gates that bite** (red-team + goldens blocking).
- Week 12: Phase 7 — **M6: operated system** (SLOs, drills, cost report).
- First code (Phase 0, in order): repo scaffold (API + Mastra + pgvector + Redis via compose) → §4 models + parity tests → webhook ingest + dedupe → `jira_comment/transition` → dispatcher stub → 10-ticket fixture + router test → demo script. Approve and I'll scaffold it here in `D:\Code\AllRounderAgent`.
