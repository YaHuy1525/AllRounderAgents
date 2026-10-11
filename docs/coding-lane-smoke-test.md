# Coding Lane Smoke Test

A repeatable end-to-end pass over the coding workflows using the seeded Jira
test backlog. Run it after touching the run service, the coding lane agent
definitions or the console start flow: every lane gets a real ticket, a real
repository and a real checkpoint sequence, so a regression shows up as a
stuck step instead of a silent diff.

Coding lanes covered: **PR Review**, **Issue Resolution**, **Feature
Implementation**, **Dependency Update**, **Accessibility Audit**.

## Prerequisites

- The compose stack is up: API, Mastra host, approval console and the
  supporting services.
- Jira credentials are configured in `.env` (`JIRA_BASE_URL`,
  `JIRA_EMAIL`, `JIRA_API_TOKEN`) and the API is started with them.
- `GITHUB_TOKEN` is set and `GITHUB_REPOSITORY_ALLOWLIST` covers the target
  repositories — a run started against any other repository is rejected with
  a 403.
- The approval console is reachable at <http://localhost:3000> (the
  accessibility tickets target that URL).

## 1. Seed the test tickets

```powershell
python -m allrounder_api.jira_seed
```

The seeder is idempotent: every ticket is deduped with an exact JQL summary
search, so re-runs only print `<KEY> exists` for what is already there. It
creates the workflow test backlog in the configured Jira project — two
tickets per console workflow, including the coding lanes used below:

- the review tickets point at the open Draft PRs of the allowlisted repos;
- the issues tickets carry `bug` labels and `Fix:` summaries;
- the accessibility tickets target the console at `http://localhost:3000`.

## 2. Open the case for a ticket

The ticket tab renders the **Start a run** card only when the case lookup
(`GET /tickets/<key>/status`) finds a case; the routing worker that normally
opens cases from webhook traffic is not part of the compose stack. Seed the
case locally:

```powershell
python scripts/seed-case.py SCRUM-<n>
```

Reload the ticket tab afterwards — the start card appears.

## 3. Start a run

1. Open the console and use the **+** tab, then pick the test ticket.
2. The workflow list is limited to the lanes the ticket supports: keyword
   matches (leave, onboarding, dependencies, accessibility and friends) win
   outright; keyword-free tickets fall through to the Jira type rules (bugs
   resolve, stories and tasks implement and review).
3. Choose the lane and fill its inputs — the dropdown stays limited to the
   supported list.
4. **Start a run.** The run opens in the ticket tab and pauses at every
   checkpoint for your review; approving a side-effecting step requires the
   action bar.

## Lane inputs and checkpoints

| Lane | Inputs | Checkpoints | Success signal |
| ---- | ------ | ----------- | -------------- |
| PR Review | repository + PR number | PR selection, review options, AI review, completion | verdict comment on the PR, no merges |
| Issue Resolution | repository (defaults to the server allowlist) | issue selection, analysis, implementation, completion | analysis approved, fix implemented, Draft PR opened |
| Feature Implementation | repository (defaults to the server allowlist) | feature selection, scope and design, implementation, completion | scope approved, change implemented, Draft PR opened |
| Dependency Update | repository | manifest scan, grouped bumps, validation, merge gate | grouped update PRs staged at the gate |
| Accessibility Audit | repository + target URL | crawl, fix set, re-scan, fix PR | violations resolved, fix PR opened |

## Where the runs land

- **Ticket tab** — the run panel with the per-step surfaces while the ticket
  is open; the terminal steps carry the artefacts (diffs, PR links, audit
  packs).
- **Runs tab** and the **task inbox** — every run, newest first, including
  runs whose ticket is not currently open. Use these to find a run again
  after closing the tab.
- **Debug info** toggle in the run panel shows the raw run JSON when a step
  needs a closer look.

## Resetting and troubleshooting

- Run history is append-only in the console registry; a Jira ticket can be
  re-seeded at any time without touching it.
- Run start fails with 403: the repository is outside
  `GITHUB_REPOSITORY_ALLOWLIST`.
- PR Review refuses to start without a numeric PR number.
- Accessibility Audit cannot reach the target URL: make sure the console is
  actually serving on the URL the ticket names.
