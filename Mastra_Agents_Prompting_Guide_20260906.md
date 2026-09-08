# Mastra Agents — Complete Prompting & Creation Guide
**Date:** 2026-09-06 · **Folder:** `D:\Code\AllRounderAgent`
**Docs canon:** https://mastra.ai/docs (trust docs over training data) · model format: `'provider/model'`, e.g. `openai/gpt-5.6-sol`, `anthropic/...` · keys via env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`).
**Project context:** this is the agent-plane implementation guide for `AllRounderAgent_Master_Plan_20260906.md` (triage/researcher/actor/coach agents, approval gates, evals).

---

## 0. Setup (5 minutes)

```bash
npm create mastra@latest        # scaffold; pick Agents + RAG + example code
cd <project> && npm install
cp .env.example .env            # add OPENAI_API_KEY=... (or Anthropic/Google)
npx mastra dev                  # Studio at http://localhost:4111
```

Project shape to converge on (matches master plan §6–7):

```
src/mastra/
  agents/       # triage.ts, researcher.ts, actor.ts, coach.ts, brandGuard.ts, auditAgent.ts
  tools/        # searchDocs.ts, lookupOrder.ts, createTicket.ts, issueRefund.ts, escalate.ts, ...
  workflows/    # dispatcher.ts, supportFlow.ts, codingFlow.ts, financeFlow.ts, marketingFlow.ts
  memory.ts     # Memory instance + thread helpers
  index.ts      # new Mastra({ agents, workflows, tools, memory, storage })
```

Register everything in `index.ts` — only registered agents appear in Studio, workflows, and `mastra.getAgent(id)` lookups.

---

## 1. Creating an agent (the whole API surface that matters)

```ts
import { Agent } from '@mastra/core/agent';

export const triageAgent = new Agent({
  id: 'triage',                 // unique; used by getAgent('triage'), Studio, traces
  name: 'Triage',
  description: 'Classifies incoming tickets into domain + urgency', // REQUIRED for subagents: supervisor reads this to decide delegation
  instructions: `...`,          // string | SystemMessage | SystemMessage[] | (ctx) => ... (see §2)
  model: 'openai/gpt-5.6-sol',  // 'provider/model' — no provider import needed
  tools: { searchDocs },        // { toolName: tool } — key SHOULD match tool.id
  agents: { researcher },       // subagents → auto-exposed as agent-<key> tools (supervisor pattern)
  memory: new Memory(),         // threads/resources (§4)
  hooks: {                      // run around EVERY tool call (all sources)
    beforeToolCall: ({ toolName, input }) => console.log('→', toolName, input),
    afterToolCall: ({ toolName, output, error }) => console.log('←', toolName, !!error),
  },
});
```

Calling it — `generate` (one answer), `stream` (tokens + tool lifecycle events), from code or inside workflow steps:

```ts
const res = await triageAgent.generate(JSON.stringify(ticket), {
  memory: { resource: `jira:${ticket.reporter}`, thread: `ticket:${ticket.key}` },
  structuredOutput: { schema: TriageVerdictSchema },  // Zod → typed object out (§2.5)
});
```

Key facts: default agent I/O without options is `{prompt: string} → {text: string}`. `model` always comes from code (Studio Editor can never override id/name/model — lock the rest with `editor: false` when prompts must survive UI edits). Dynamic `instructions: ({requestContext}) => ...` lets you inject per-tenant policy (brand lists, allowlists) without forking agents.

---

## 2. Prompting guide — writing `instructions` that hold in production

### 2.1 The anatomy (every production prompt has all five blocks)

```
1. ROLE + SCOPE — who you are, what you own, what you never do
2. TOOLS — each tool, one line: when to call it AND when NOT to
3. PROCEDURE — numbered steps, in order, with the stop rule stated
4. OUTPUT CONTRACT — exact shape (fields, types, citing format), no prose outside it
5. CONSTRAINTS + ESCALATION — budgets, forbidden actions, what to do when unsure
```

### 2.2 Template — triage (cheap model, zero tools, JSON only)

```
You are the ticket triage classifier for AllRounderAgent. You own routing and nothing else.
You never answer the ticket, never call tools, never emit prose.

PROCEDURE:
1. Read the ticket summary + description + labels.
2. Choose exactly one domain: code | finance | marketing | support | unknown.
3. Score confidence 0..1. If < 0.6, choose "unknown".
4. Score urgency 1..5 (1 = FYI, 5 = outage/money-moving/blocked release).

OUTPUT (JSON only, no markdown fences):
{"domain": "...", "confidence": 0.0, "urgency": 1, "needsHuman": false, "rationale": "<25 words"}
```

### 2.3 Template — researcher (RAG, citations mandatory)

```
You are the support researcher. You answer ONLY from retrieved passages.
Tools: searchDocs (use FIRST, before any claim), ticketHistory (past tickets from this reporter).

PROCEDURE:
1. Call searchDocs with 2–3 query phrasings. If zero passages return, STOP and output {"answer": null, "escalate": true, "reason": "no sources"}.
2. Draft the answer using at most the top 5 passages.
3. Every factual sentence ends with [sourceId]. No citation → delete the sentence.

OUTPUT: {"answer": "...", "citations": ["doc-id#span", ...], "confidence": 0.0, "escalate": false}
CONSTRAINTS: never invent order numbers, links, or policy; never promise refunds; temperature-0 style: same input, same answer.
```

### 2.4 Template — actor (side effects, confirm gate)

```
You are the coding actor. You turn an approved RCA into a Draft PR and nothing else.
Tools: patchFile (GitHub Contents API, never clone), validate (lint/schema/CI), openPR (draft only).

PROCEDURE:
1. Re-read the RCA + confidence. If confidence < 0.7, output {"action": "escalate", ...} and STOP.
2. Fetch files, produce the SMALLEST diff that fixes the cause. No refactoring, no drive-bys.
3. Run validate. If it fails, repair once, re-run. Second failure → escalate with both diffs.
4. Open a DRAFT PR (never merge) with root cause + confidence + validation report in the description.

FORBIDDEN: cloning repos, touching files outside the RCA scope, running destructive commands,
merging, pushing to main. Violation = failed run.
```

### 2.5 Prompting rules that actually matter (from the winners + docs)

1. **Structured output > prose** for anything downstream consumes (triage, RCA, audit packs). Use `structuredOutput: {schema}` on the call or step — typed chaining, no regex parsing. (FinClose lesson.)
2. **Name tools in instructions, with negations.** "Use searchDocs FIRST" + "never promise refunds" beats tool lists. The model decides from descriptions — keep each tool description to one primary use case.
3. **State the stop rule explicitly.** "Second validation failure → escalate" / "zero passages → escalate" — this is your SpectreAI three-paths logic, in words before it's in code.
4. **Confidence is data, not vibes.** Force a 0..1 field on every judgment output; workflows branch on it (§3). Calibrate thresholds from golden runs, not guesses.
5. **Separate reader prompts from writer prompts.** Researcher prompts cite; actor prompts constrain. One agent with both jobs will freelance — the Investigation/Coding split exists for a reason.
6. **Version prompts like code.** Prompts live in `agents/*.ts`, reviewed in PRs, gated by goldens (§7). Studio Editor overrides are for experiments; `editor: false` protects production prompts.
7. **Dynamic instructions for tenancy.** `instructions: ({requestContext}) => ...` injects brand lists, allowlists, tenant policy — one agent definition, many tenants.

---

## 3. Workflows — agents as steps, gates as suspend()

```ts
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { triageAgent } from '../agents/triage';
import { z } from 'zod';

// Agent as a step with typed I/O: .map shapes previous output into {prompt},
// structuredOutput enforces the Zod contract downstream steps receive.
const triageStep = createStep(triageAgent, {
  structuredOutput: { schema: TriageVerdictSchema },
});

const draftStep = createStep({
  id: 'draft',
  execute: async ({ inputData, mastra }) => {
    const researcher = mastra.getAgent('supportResearcher');
    const res = await researcher.generate(inputData.prompt, {
      memory: { resource: inputData.reporter, thread: inputData.ticketKey },
      structuredOutput: { schema: DraftSchema },
    });
    return res.object;                     // typed, citable draft
  },
});

const gateStep = createStep({
  id: 'approval-gate',
  execute: async ({ inputData }) => {
    if (inputData.confidence < 0.7 || inputData.outwardFacing) {
      await suspend({                       // PostAuto approval station
        draft: inputData.draft,
        evidence: inputData.evidence,
        suggestedReply: inputData.suggestedReply,
      });
    }
    return inputData;
  },
});

export const supportFlow = createWorkflow({ id: 'support-flow' })
  .map(({ inputData }) => ({ prompt: `Classify: ${inputData.ticketJson}` }))
  .then(triageStep)
  .branch(...)                              // route by domain/confidence
  .commit();
```

Rules: `.map()` between steps keeps transforms explicit; agent-steps stay declarative (persistable as dynamic workflows); `suspend()` payloads must contain everything the approver needs (draft + evidence + risk + suggested reply) because resume may happen much later, possibly by another human.

---

## 4. Tools — createTool deep cut (approvals, transforms, hooks)

```ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const issueRefund = createTool({
  id: 'issue-refund',                       // key in tools:{...} should match
  description: 'Issues a customer refund. Requires approval above the auto-limit.',
  inputSchema: z.object({
    orderId: z.string(),
    amountCents: z.number().int().positive(),
    reason: z.string().max(280),
    idempotencyKey: z.string().uuid(),      // never double-refund on retry
  }),
  outputSchema: z.object({ refundId: z.string(), status: z.string() }),
  execute: async ({ orderId, amountCens: _, ...rest }, { abortSignal }) => {
    /* preview → suspend-if-over-limit → commit; honor abortSignal */ 
  },
  // Phases: input → approval → suspend/resume → output; mask secrets per surface:
  transform: {
    display: { output: (o) => mask(o) },    // browser stream
    transcript: { output: (o) => mask(o) }, // stored transcript
  },
});
```

Plus: agent-level `hooks.beforeToolCall/afterToolCall` for logging, metering (count calls, sum cost), and policy (deny-list check before high-blast tools). Streaming lifecycle hooks (`onInputAvailable`, `onOutput`) feed progress events to your SSE layer. Subagents via `agents: {...}` with `description` become `agent-<key>` tools — that IS the supervisor pattern, no extra framework needed. Task tracking: `TaskSignalProvider` + memory gives one-`in_progress`-task discipline with thread-scoped persistence.

---

## 5. Memory — threads, resources, observational learning

```ts
// Call shape (every generate/stream):
memory: { resource: 'jira:reporter-123', thread: 'ticket:PROJ-456' }
// or with metadata: thread: { id, title: 'Billing dispute', metadata: { domain: 'support' } }
```

Model: `resource` = owner (reporter/tenant), `thread` = conversation (ticket/session). Working memory (recent turns) + observational memory (Observer/Reflector distill long-lived facts — your SpectreKB mechanism, configured via Agent Builder memory defaults). Storage adapter on the Mastra instance required for persistence. Distillation into KB stays human-reviewed (master plan §3.4) — observational memory proposes, reviewers dispose.

---

## 6. Prompting anti-patterns (failures seen in the comp)

| Anti-pattern | Symptom | Fix |
|---|---|---|
| One mega-agent, 12 tools | tool confusion, freelance writes | split reader/writer; supervisor delegates |
| Prose outputs parsed by regex | brittle chains, silent drift | structuredOutput schemas everywhere downstream |
| No negations in instructions | agent "helps" by doing forbidden acts | FORBIDDEN block per actor prompt |
| Thresholds in prose ("if unsure") | uncalibrated routing | numeric confidence + config-owned thresholds |
| Prompts edited in UI, ungated | regressions nobody can bisect | code-owned prompts + golden CI gate |
| No stop rule | repair loops, cost blowups | "repair once, then escalate" in every actor prompt |

---

## 7. Evals for prompts (prompt CI)

- **Deterministic:** schema validity, citation presence/format, forbidden-action attempts (must be zero), stop-rule compliance (escalation fires on planted low-evidence cases).
- **Judge-graded:** answer correctness grounded in retrieved spans, RCA plausibility, tone/brand fit — judges cite spans or verdict is discarded.
- **Red-team:** injection-via-ticket, approval-bypass phrasing, scope-escape ("also refund my friend"). Breaches → regression goldens (Gauntlet loop).
- Run in CI on every prompt/tool/workflow diff; nightly full sweep + coach on staging.

---

## 8. GitHub projects building agents with Mastra (study list)

**Official templates (clone first — canonical patterns):**
- **Docs Chatbot** — MCP server + agent over docs; your RAG researcher skeleton. https://mastra.ai/templates/docs-chatbot · repo in `mastra-ai/mastra` under `templates/template-docs-chatbot`
- **GitHub PR Code Review** (`mastra-ai/template-github-review-agent`) — 2 agents + 1 tool + 1 workflow; workspace skills for review standards; observational memory across large PRs; adaptive depth by PR size; Sonnet-review/Haiku-verify model routing. Your codingFlow reference implementation. https://mastra.ai/templates/github-pr-code-review-agent
- **Slack Agent** — chat-surface agent; your widget/approval-button patterns. https://mastra.ai/templates (Slack Agent)
- **Accounts Payable / Invoice Processing** — extract → verify vendor → match PO/receipt → detect duplicates → route approvals → post to QuickBooks. Your financeFlow reference. https://mastra.ai/templates
- **KYC & Customer Onboarding** — identity verification + risk assessment + compliance routing. Your gate/escalation reference.
- **Agent Harness** — general-purpose agent: local workspace, shell tools, memory, task tracking, web access, recurring schedules. Your coach/nightly shape.
- **Customer Feedback Summarization** — feedback → actionable summaries. Your distiller shape.
- **Weather Agent / Chat-with-PDF / Deep Search / Text-to-SQL** — minimal agent+tool+workflow anatomy; read one when learning `createStep`/`createTool` wiring.

**Community builds (bigger, opinionated):**
- **ssdeanx/AgentStack** — production-grade multi-agent platform on Mastra: 50+ tools, 25+ specialist agents, 10+ workflows, supervisor networks with delegation hooks, A2A/MCP orchestration, RAG pipelines, finance-intelligence focus, observability + governance, LibSQL persistence, chat UI. The closest thing to your master plan already built — study its supervisor/delegation and governance layout, don't clone blindly. https://github.com/ssdeanx/AgentStack
- **BunsDev/mastra-starter** (MIT, 10★) — clean minimal starter: `agents/ tools/ workflows/ index.ts`, Studio dev loop, API usage examples. Best first-clone for repo shape. https://github.com/BunsDev/mastra-starter
- **cometchat/ai-agent-mastra-examples** — 6 self-contained samples: knowledge agent with citations, frontend-actions agent, orchestrator agent, PDF knowledge agent, product-hunt agent. Best per-pattern micro-reads (citations, orchestration). https://github.com/cometchat/ai-agent-mastra-examples

**Docs pages to keep open:** Agents overview · Agent class reference · using-tools (createTool, hooks, transforms, approvals) · workflows/agents-and-tools (agent-steps, structuredOutput) · memory (threads/resources, observational) · RAG pipeline · evals · Studio/Editor · templates index · llms.txt index.

---

## 9. Mapping to AllRounderAgent (build order)

1. Clone `BunsDev/mastra-starter` → repo shape + dev loop. Read Docs Chatbot template → researcher skeleton.
2. Write triage + supportResearcher prompts (§2.2–2.3) → `supportFlow` with `suspend()` gate (§3).
3. Add actor tools with idempotency + transforms (§4) → approval payloads.
4. Read GitHub PR review template → build codingFlow; AP-invoice template → financeFlow.
5. Study AgentStack's supervisor/governance → pre-flight + audit agents; cometchat orchestrator → dispatcher.
6. Golden evals per §7 → Nightly coach → KB distillation (§5).

*Next: say which agent to scaffold first (triage recommended) and I'll write its file + Zod schemas + golden fixtures.*
