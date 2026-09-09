# Coding Agent Architecture

> Reference doc for the **programming / coding lane** of AllRounderAgent.
> Last updated: 2026-09-09 · Source of truth: `src/mastra/agents/programming/**`

## 1. What this is

The coding agent turns a written problem statement (typically a Jira ticket
pasted by an operator) into a **Draft Pull Request** on an allowlisted GitHub
repository — *without giving the model any direct tool access*. Every
consequence-bearing action (patch planning, validation, commit, PR) is gated
by deterministic, policy-driven code; the LLM is only a **JSON-producing
service** that fills two data slots in the middle of the pipeline.

The lane ships as a Mastra workflow (`codingFlow`) with nine named steps.
There is also a deterministic class `CodingWorkflow` in
[`workflow.ts`](src/mastra/agents/programming/workflow.ts) that implements the
same contract as a plain orchestration skeleton. It is not wired into the
server — it exists as a **test oracle** so the Mastra step flow and the
deterministic reference are proven to expose one behavior
([`workflow.test.ts`](src/mastra/agents/programming/workflow.test.ts) vs
[`flow.test.ts`](src/mastra/agents/programming/flow.test.ts)).

## 2. Where it sits

```
src/mastra/
├── mastra.ts                     # createAllRounderMastra(): agents + workflows factory
├── instance.ts                   # env wiring: builds GitHub policy/tools, gates codingFlow
├── shared/model.ts               # single source of truth for the DeepSeek model config
└── agents/
    ├── registry.ts               # allRounderAgents(): 14 lane agents
    ├── script.ts                 # createStructuredAgent / createScriptedAgent factories
    └── programming/              # ← this document
        ├── index.ts              # barrel re-exports
        ├── flow.ts               # createCodingFlow(deps): the 9-step Mastra workflow
        ├── workflow.ts           # CodingWorkflowInput, CodingModel, stores, deterministic oracle class
        ├── contracts.ts          # all zod schemas (wire format of every step boundary)
        ├── flow.test.ts          # Mastra-flow tests (injected fake CodingModel)
        ├── workflow.test.ts      # deterministic-oracle parity tests
        ├── pr-proof.test.ts      # dormant live proof (E2E_PR_PROOF=1), opens a real Draft PR
        ├── agents/
        │   ├── actorAgent.ts         # "programming-actor"   (patch planner)
        │   ├── investigatorAgent.ts  # "programming-investigator" (diagnosis)
        │   ├── validatorAgent.ts     # "programming-validator" (report-only; model seam, not used by flow)
        │   ├── prompts.ts            # structuredAgentPrompt(): XML-block prompt builder
        │   ├── scripts.ts            # few-shot scenario pools
        │   └── index.ts
        └── tools/
            ├── github.ts         # transport, reader, writer, policy engine, patch hash
            └── validators.ts     # deterministic allowlisted validators (json/yaml/xml/basic-syntax)
```

Registration is **env-gated**: `instance.ts` only injects `{ coding }` when
`GITHUB_TOKEN` **and** `GITHUB_REPOSITORY_ALLOWLIST` are both set
([`instance.ts`](src/mastra/instance.ts)). Without them the server boots with
`financeFlow` only and logs a warning
([`mastra.ts`](src/mastra/mastra.ts) makes `coding` optional on purpose).

## 3. High-level flow

```mermaid
flowchart TD
    T[Manual trigger<br/>Jira ticket → CodingWorkflowInput] --> S1

    subgraph S["codingFlow (9 steps)"]
        S1[load-context<br/>parse + pin input] --> S2[investigate<br/>LLM: RCA JSON]
        S2 --> S3[strict-rca<br/>deterministic gates]
        S3 --> S4[plan-surgical-patch<br/>LLM: patch plan JSON]
        S4 --> S5[preflight<br/>policy + possible suspend]
        S5 --> S6[patch<br/>source-SHA recheck]
        S6 --> S7[validate<br/>deterministic validators + 1 LLM repair]
        S7 --> S8[draft-pr<br/>writer.apply + CI checks]
        S8 --> S9[evidence-close<br/>persist + emit output]
    end

    S3 -- "no evidence / low confidence / not fixable" --> E[escalate]
    S4 -- "contract violation" --> E
    S5 -- "destructive path, no grant" --> A[approval suspend]
    A -- "resume approved" --> S5
    A -- "rejected / expired" --> E
    S6 -- "base moved" --> E
    S7 -- "failed after 1 repair" --> E
    S8 -- "CI failure" --> E2[escalate ci_failed<br/>PR stays open]

    E --> O[terminal output: status=escalated]
    S9 --> O2[terminal output: draft_pr_opened | awaiting_ci]
```

The LLM touches the flow at exactly two seams — `investigate` and
`plan-surgical-patch` (plus one bounded `repairPatch` retry inside
`validate`). Everything else is code.

## 4. Step-by-step semantics

| Step | Kind | Behavior |
|---|---|---|
| `load-context` | deterministic | Parses input through `CodingWorkflowInputSchema`, initializes empty validation state. |
| `investigate` | LLM seam | Calls `model.investigate(context)`; output parsed through `RootCauseAnalysisSchema`. On model failure it synthesizes an RCA with `confidence: 0` and escalates `insufficient_evidence`. |
| `strict-rca` | gate | Escalates `insufficient_evidence` when `evidence.length === 0` **or** `confidence < confidenceFloor` (default **0.8**); escalates `unfixable` when `fixable === false`. |
| `plan-surgical-patch` | LLM seam | Calls `model.planPatch(context, rca)`; parsed through `PatchPlanSchema`. Any parse/contract violation escalates `path_denied`. |
| `preflight` | gate + suspend | `writer.preflight(...)` runs repository/path/limit checks and computes the `PreviewManifest`. A destructive path without an approval grant raises `approval_required` → the step **suspends** with a signed `CodingApprovalSuspendPayload` (run/ticket/repo/branch, `actionHash`, per-file sha256+bytes, destructive paths). Resuming with `approved + receipt` re-runs preflight with the paths granted; `rejected/expired` escalates `approval_rejected`. Nothing has been written yet. |
| `patch` | gate | Re-reads the live base-branch SHA; if it no longer equals `input.sourceSha` → `stale_source` (no commit is ever made on drifted state). |
| `validate` | deterministic + 1 repair | Runs `ValidatorRegistry.validate(patch)` (attempt 1). On failure, exactly **one** LLM `repairPatch` round is allowed, then re-preflight and re-validate as `attempts = 2`. Second failure escalates `validation_failed_after_repair`; a repair that introduces a new destructive path escalates `approval_required`. |
| `draft-pr` | writer | `writer.apply(manifest, files, title, body)` commits and opens the **Draft PR**, then reads CI status (`writer.checks`) on the created commit. `ciStatus === "failure"` escalates `ci_failed` (PR left open for review); `pending` closes `awaiting_ci`, otherwise `draft_pr_opened`. |
| `evidence-close` | terminal | Persists the full `CodingRunRecord` to the run store and emits the typed `CodingWorkflowOutput`. |

### Escalation taxonomy

All escalations carry `diagnosisOnly: true` — the run never pretends it fixed
anything, and the artifacts it may carry (manifest, PR) are explicitly
labelled. Reasons:

`insufficient_evidence` · `unfixable` · `path_denied` · `approval_required` ·
`approval_rejected` · `stale_source` · `validation_failed_after_repair` ·
`ci_failed`

## 5. Data contracts (`contracts.ts`)

Every boundary is a strict zod schema — `.strict()` everywhere, so unknown
keys are rejected. The workflow validates inputs and outputs; the flow re-parses
every LLM payload through the same schemas (JSON is extracted from the agent
text via `extractJson`, which tolerates a ``` ```json ``` fence).

| Schema | Shape (essentials) |
|---|---|
| `CodingWorkflowInputSchema` | `runId`, `tenantId`, `ticketKey`, `owner`, `repo`, `baseBranch`, `sourceSha` (40–64 hex), `branch`, `problem` (≤ 4000), `approvedDestructivePaths` (default `[]`) |
| `RootCauseAnalysisSchema` | `summary`, `confidence` (0–1), `evidence[]` (≤ 20 × `path`/`startLine`/`endLine`/`excerpt`), `fixable` |
| `PatchPlanSchema` | `summary`, `files[]` (≤ 50 × `path`, `content` ≤ 1 MB, `validators[]`) — **full replacement content, never a diff** |
| `PreviewManifestSchema` | `repository`, `baseBranch`, `sourceSha`, `branch`, `patchHash` (sha256), per-file `sha256`/`bytes`/`validators`, `risk`, `evidence` |
| `ValidationReportSchema` | `passed`, `attempts` (1–2), `results[]`, optional `ciStatus` (`pending/success/failure/neutral`) |
| `PullRequestReceiptSchema` | `url`, `number`, `draft: true`, `branch`, `baseBranch`, `sourceSha`, `commitSha`, `patchHash`, `replayed` |
| `EscalationSchema` | `reason` (enum of 8), `diagnosisOnly`, `detail` |
| `CodingWorkflowOutputSchema` | `runId`, `status` (`draft_pr_opened`/`awaiting_ci`/`escalated`), `rca`, `validation`, optional `manifest`/`pr`/`escalation` |

Repository paths must be relative and normalized (`RepositoryPathSchema` — no
leading `/`, no `\`, no `.`/`..` segments); evidence line ranges are validated.

## 6. The model seam

```ts
interface CodingModel {
  investigate(context: InvestigationContext): Promise<RootCauseAnalysis>;
  planPatch(context: InvestigationContext, rca: RootCauseAnalysis): Promise<PatchPlan>;
  repairPatch(context, patch: PatchPlan, report: ValidationReport): Promise<PatchPlan>;
}
```

- **Default live implementation** — `createCodingAgentModel()` in
  [`flow.ts`](src/mastra/agents/programming/flow.ts) wraps the scripted
  Mastra agents `investigatorAgent` and `actorAgent` (`programming-*` in the
  registry), each call re-parsing the agent text through the zod contracts.
- **Deterministic output side** — the agents are configured with
  `temperature: 0` and structured XML-block prompts built by
  [`prompts.ts`](src/mastra/agents/programming/agents/prompts.ts):
  `<identity>`, `<primary_directive>` (+ quality bar), an analysis
  `<framework_tag>` with dimensions (e.g. `rca_analysis`,
  `patch_design`), `<output_format>` (+ IMPORTANT conditional rules),
  `<constraints>`, `<examples>` (few-shot scenarios from
  [`scripts.ts`](src/mastra/agents/programming/agents/scripts.ts)), and a
  `<verification>` checklist. Prompts are resolved at **run time** so a host
  can inject a `promptOverride` via the Mastra `RequestContext`.
- **Model config** — single source of truth in
  [`shared/model.ts`](src/mastra/shared/model.ts):
  `deepseek/deepseek-v4-flash` @ `https://api.deepseek.com`; key comes from
  `DEEPSEEK_API_KEY`/`MODEL_API_KEY` in `.env`.
- **Tests never touch the network** — both suites inject a fake `CodingModel`.

The agents have **no tools** and no filesystem/network side effects; the
actor's "source context" is read by the *flow*, sliced (≤ 6000 chars per
evidence file, ≤ 4 files), and pasted into the prompt.

## 7. GitHub tooling (`tools/github.ts`)

All GitHub access goes through a **`GitHubBackend` seam** with two
implementations, selected by `GITHUB_ACCESS` in
[`instance.ts`](src/mastra/instance.ts):

| Backend | File | Transport | Auth |
|---|---|---|---|
| `RestGitHubBackend` | `tools/github.ts` | `api.github.com` REST (legacy) | `GITHUB_TOKEN` |
| `McpGitHubBackend` | `tools/mcp.ts` | official GitHub MCP server, `https://api.githubcopilot.com/mcp/` (default) | `GITHUB_MCP_TOKEN` or `GITHUB_TOKEN` as bearer PAT |

Tool mapping (MCP backend; verified against the live server 2026-09-09):
`baseTipSha` → `get_commit` on the base branch; `fileContent` →
`get_file_contents` (resource-block text or base64, normalized); `commitFiles`
→ `push_files` (one commit, server-side ref CAS on the branch tip);
`openDraftPull` → `create_pull_request(draft: true)` (returns a minimal
`{id, url}` - the PR number is parsed from the URL); `listOpenPulls` →
`list_pull_requests(head, state)`; `checkRuns` → `pull_request_read` with
method `get_check_runs` (`pullNumber` param; older servers expose the granular
`get_pull_request_status` with `pull_number`). The backend asserts the live
tool list on first use and fails fast on missing tools.

Trade-off note: the git-data endpoints (blob/tree/commit with a pinned parent)
are not exposed as MCP tools, so an MCP commit lands on the **branch tip** at
write time rather than on the investigated SHA - the flow's pre-write SHA
recheck plus GitHub's own ref CAS still guarantee no silent drift (D1). The
REST strict-write hybrid is deliberately out of scope. Connectivity smoke
check: `node scripts/github-mcp-verify.mjs`.

Three classes over the transport (Bearer auth,
`X-GitHub-Api-Version: 2022-11-28`, per-request timeout in REST mode):

- **`GitHubSourceReader`** — read side: `assertRepository` (repo + base branch
  must be in policy), `assertPath` (glob allowlist/denylist), `isDestructive`,
  `sourceSha` (live base ref), `content` (raw file at a pinned SHA).
- **`GitHubWriter`** — write side, entirely **Git-data API** (no git binary):
  `preflight` → deterministic `PreviewManifest` (policy checks, patch-hash +
  per-file sha256); `apply` → `blob` per file → `tree` on the base tree →
  `commit` (parent = manifest `sourceSha`) → `refs/heads/<branch>` → Draft PR
  with `Patch hash: <sha256>` in the body; `checks` → combined CI status of the
  commit. `findDurableReplay` makes `apply` **idempotent**: if the branch
  already exists with a Draft PR whose body carries the same patch hash, the
  prior receipt is returned with `replayed: true`.
- **Policy engine** — `GitHubPolicy` + `globMatches` (supports `**`), branch
  name safety (`isSafeBranchName`), file-count and byte limits, and three
  error types: `RepositoryPolicyError` (codes `repository_denied`,
  `path_denied`, `approval_required`, `limits_exceeded`), `StaleSourceError`
  (thrown by `apply` when the live SHA drifted → mapped to `stale_source` in
  the flow), and transport errors.

### Environment policy (`instance.ts` → `GitHubPolicy`)

| Env var | Default | Meaning |
|---|---|---|
| `GITHUB_ACCESS` | `mcp` | Backend selector: `mcp` = official GitHub MCP server; `rest` = legacy `api.github.com` fetch transport |
| `GITHUB_MCP_TOKEN` | — | Classic/fine-grained PAT sent as bearer to the MCP server (`GITHUB_TOKEN` is the fallback); no OAuth app or DCR needed |
| `GITHUB_TOKEN` | — | Classic PAT with `repo` scope, or fine-grained PAT with **Contents** and **Pull requests** = Read-and-write (registration gate; also REST-mode token and MCP fallback) |
| `GITHUB_REPOSITORY_ALLOWLIST` | — | JSON array of `owner/repo` allowed to be read **and** written (registration gate) |
| `GITHUB_BASE_BRANCH` | `main` | Only branch that can receive Draft PRs |
| `GITHUB_PATH_ALLOWLIST` | `["src/**","tests/**","config/**","docs/**"]` | Glob allowlist for patchable files |
| `GITHUB_PATH_DENYLIST` | `[".github/workflows/**","infra/prod/**"]` | Deny beats allow |
| `GITHUB_DESTRUCTIVE_PATHS` | `["migrations/**","infra/**"]` | Touching these requires human approval (suspend/resume) |
| `GITHUB_MAX_PATCH_FILES` | `10` | Max files per patch |
| `GITHUB_MAX_PATCH_BYTES` | `250000` | Max total content bytes per patch |
| `GITHUB_REQUEST_TIMEOUT_SECONDS` | `10` | Per GitHub API call |

## 8. Validators (`tools/validators.ts`)

`ValidatorRegistry.validate(patch, attempts)` runs each file's declared
validators against its **content**, deterministically, with no model in the
loop: `json` (parse), `yaml` (tab + mapping heuristics), `xml` (tag
stack), `basic-syntax` (balanced delimiters/quotes). Unknown validator names
are reported as failures. The validator set is deliberately small and
allowlisted — the actor may only declare these four.

## 9. Runtime surface & manual trigger

- The server runs as a Mastra app (`mastra dev --dir src/mastra`, Studio on
  `localhost:4111`); `codingFlow` appears under `/api/workflows/codingFlow`.
- **Start** (async, used by the operator path):

  ```
  POST /api/workflows/codingFlow/start-async?runId=<runId>
  { "inputData": { "runId": "...", "tenantId": "...", "ticketKey": "SCRUM-10",
      "owner": "YaHuy1525", "repo": "AllRounderAgents", "baseBranch": "main",
      "sourceSha": "<current main SHA>", "branch": "codex/scrum-10-...",
      "problem": "<problem text from the Jira ticket>",
      "approvedDestructivePaths": [] } }
  ```

  `inputData` must be nested in the envelope; the `runId` must be passed as a
  query parameter. See `scripts/e2e-enhancement.mjs` for a complete working
  trigger that creates a Jira ticket, resolves the live `sourceSha`, starts
  the run, and prints the run state.
- **Terminal state** is emitted by `evidence-close` (status
  `draft_pr_opened` / `awaiting_ci` / `escalated`, plus RCA, validation,
  manifest, PR receipt or escalation) and a `CodingRunRecord` is persisted to
  the run store (in-memory by default).
- Suspended approval runs are resumable through the workflow's suspend/resume
  primitives with `CodingApprovalSuspendPayload` / `CodingApprovalResumeSchema`
  (`approved` + receipt, or `rejected`/`expired`).

## 10. Security properties (by construction)

1. **The model cannot write.** No tools, no shell, no file system; only JSON
   text out of the agent calls, reparsed by zod.
2. **Policy runs before any write.** Repository, branch, path, size, and
   destructive-path checks all live in deterministic code that runs before
   the first byte reaches GitHub.
3. **Nothing is written before a human approves destructive paths.** The
   `preflight` suspend is the only way to obtain `grantedApprovals`; the
   `actionHash` binds the approval to the exact bytes.
4. **No silent drift.** `sourceSha` is checked at input, re-checked at the
   `patch` step, and enforced by `apply` (commit parent = manifest SHA).
5. **Always Draft PRs, always idempotent.** PRs open as `draft: true`; a
   rerun with the same patch hash reuses the existing PR (`replayed: true`).
6. **Deterministic validation.** Syntax checking is code, not a model; only
   one model repair attempt is allowed and `attempts` is capped at 2.
7. **Failures are first-class output.** Every escalation is structured
   (`EscalationSchema`) and persisted; the PR body always links ticket, source
   SHA, patch hash, RCA evidence, and validation results.

## 11. Testing

- `flow.test.ts` (556 lines) — exercises every step, gate, escalation reason,
  suspend/resume path, and repair attempt with an injected fake `CodingModel`.
- `workflow.test.ts` (320 lines) — parity tests against the deterministic
  `CodingWorkflow` oracle (same inputs → same decisions as the Mastra flow).
- `pr-proof.test.ts` — dormant live proof (`E2E_PR_PROOF=1`), drives the real
  writer against the allowlisted repo and asserts a Draft PR receipt; skipped
  in normal/CI runs. Proven 2026-09-09: Draft PR #1 on
  `YaHuy1525/AllRounderAgents` (tenantId schema enhancement).
- `pr-mcp-proof.test.ts` — dormant live proof (`E2E_MCP_PR_PROOF=1`), same
  writer through `McpGitHubBackend`; proven 2026-09-09: Draft PR #2 on
  `YaHuy1525/AllRounderAgents` with `replayed: true` on rerun (durable-replay
  dedupe works over MCP).
- `mcp.test.ts` — offline suite: fake MCP session asserts the tool mapping,
  content decoding (structured/resource/text payloads), error mapping
  (conflict → `StaleSourceError`, auth/tool-missing → `GitHubMcpError`).
- Run: `npx vitest run` (root), typecheck: `npx tsc -p tsconfig.test.json`.

## 12. Operational prerequisites (as of 2026-09-09)

- A **valid DeepSeek key** in `DEEPSEEK_API_KEY`/`MODEL_API_KEY` — otherwise
  `investigate` fails and the run escalates `insufficient_evidence` cleanly
  (observed in production probing; no partial writes happen).
- **MCP-mode GitHub** (`GITHUB_ACCESS=mcp`): a PAT in `GITHUB_MCP_TOKEN`
  (fallback `GITHUB_TOKEN`) sent as a bearer header; the hosted server does
  not support OAuth dynamic client registration, so a plain PAT is the
  documented generic-host auth. Verify with
  `node scripts/github-mcp-verify.mjs`. REST regression mode:
  `GITHUB_ACCESS=rest` plus a write-capable `GITHUB_TOKEN`.
- **Jira MCP mode** (`JIRA_TRANSPORT=mcp`): live-verified 2026-09-09 against
  the omnidewalt site via headless Basic auth. Two org/user prerequisites had
  to be met: (1) the admin enables API-token connections under
  `admin.atlassian.com → Rovo → Rovo MCP server → Authentication` (classic
  tokens then pass transport auth but tool calls still fail with "missing the
  scope claim"); (2) the token must carry the Rovo **agent-interface scopes**
  `read:jira:agent-interface`, `search:jira:agent-interface`,
  `write:jira:agent-interface`, selected when creating it at
  `id.atlassian.com/manage-profile/security/api-tokens` (a REST-only token is
  rejected with "Insufficient scopes ... Required: [search:jira:agent-interface]").
  The site URL is accepted as the `cloudId` argument. Board listing keeps
  working via read-only REST regardless.
- A **write-capable GitHub token** for REST mode: classic PAT with `repo`
  scope, or fine-grained PAT with `Contents` and `Pull requests` = **Read and
  write**. Fine-grained tokens at default permissions return 403
  "Resource not accessible by personal access token" on the first blob write.

## 13. Third-party call policy (MCP-first rule)

Project rule (persisted as a development-practice memory, 2026-09-09): before
implementing any third-party tool call, **research for an official or
community MCP server first**; hand-hardcoding REST/httpx is reserved for a
documented fallback when no viable MCP server exists. Live call-site register
(future work tracker):

| Call site | Backend before | MCP-first replacement | Status |
|---|---|---|---|
| GitHub (TS): [github.ts](src/mastra/agents/programming/tools/github.ts) | `api.github.com` fetch transport | [mcp.ts](src/mastra/agents/programming/tools/mcp.ts) → official GitHub MCP server `https://api.githubcopilot.com/mcp/` (bearer PAT) | Shipped (phase A), live-proven 2026-09-09 |
| Jira (Python): [jira.py](apps/api/src/allrounder_api/jira.py) httpx REST (`jira_seed.py`, wired in `production.py`) | Jira Cloud REST (comments, transitions, JQL search, issue create) | [jira_mcp.py](apps/api/src/allrounder_api/jira_mcp.py) `McpJiraTransport` → Atlassian Rovo MCP `https://mcp.atlassian.com/v2/mcp` (Basic email+API token with agent-interface scopes); tools `addOrEditJiraIssueComment`, `transitionJiraIssue`, `searchJiraIssuesUsingJql` (view `evidence`), `createJiraIssue` (seed path); board listing = documented read-only REST (no Rovo board tools) | Shipped (phase B); offline-tested + headless live-verified 2026-09-09 |
| DeepSeek (model calls) | `api.deepseek.com` HTTP | N/A - LLM provider config, not tool calling | Unchanged (key still invalid, 2026-09-09) |
