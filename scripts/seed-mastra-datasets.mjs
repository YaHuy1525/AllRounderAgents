// Seed the Mastra datasets Studio reads, from the repo's golden fixtures.
//
//   node --env-file=.env scripts/seed-mastra-datasets.mjs
//
// Builds a minimal Mastra directly on the SAME Postgres store id the server
// uses, so dataset rows written here are the rows Studio and the running
// server read. No agent registry is needed for seeding: items are plain
// input/groundTruth pairs. Experiments are then run natively against the
// live server (Studio Datasets -> Run Experiment, dataset.startExperiment in
// code, or scripts/run-coding-eval.mjs over the HTTP API).
//
// Two families are seeded, each idempotent (an existing dataset with the name
// is left untouched):
//   * golden-tickets   -> dispatcher triage (workflow/agent target dispatcherTriage,
//                         scorer dispatcherRouting), from evals/golden_tickets.jsonl.
//   * coding-<lane>    -> one dataset per coding agent (investigator/actor/
//                         validator), each bound to its registered agent target
//                         and the scorers that grade it, from
//                         evals/golden_coding.jsonl.
// Suspend-gated lanes keep the Python judge-eval.py produce +
// submitExperimentResult ingest boundary.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Mastra } from "@mastra/core/mastra";
import { PostgresStoreVNext } from "@mastra/pg";

const GOLDEN_TICKETS_DATASET = "golden-tickets";

// Each coding dataset is bound to the registered agent it measures and the
// registered scorers that grade it, so Studio's "Run Experiment" is
// pre-populated and score rows resolve by id (registration is what persists
// them). `targetId` must match an id in `allRounderAgents()`.
const CODING_TARGETS = {
  investigator: {
    dataset: "coding-investigator",
    targetId: "programming-investigator",
    scorerIds: ["rcaEvidence", "rcaGoldenPath"],
    description:
      "Golden root-cause tickets for the coding investigator (evals/golden_coding.jsonl): a prompt plus the expected evidence path/fixability graded by rcaEvidence + rcaGoldenPath.",
  },
  actor: {
    dataset: "coding-actor",
    targetId: "programming-actor",
    scorerIds: ["patchContract"],
    description:
      "Golden patch tasks for the coding actor (evals/golden_coding.jsonl): an RCA plus the file the surgical patch must be confined to, graded by patchContract.",
  },
  validator: {
    dataset: "coding-validator",
    targetId: "programming-validator",
    scorerIds: ["criticAgreement"],
    description:
      "Golden spec-critic cases for the coding validator (evals/golden_coding.jsonl): acceptance criteria + a patch plus the expected pass/block verdict, graded by criticAgreement.",
  },
};

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  console.error("DATABASE_URL is not set. Run with --env-file=.env (or export DATABASE_URL).");
  process.exit(1);
}

// Same TLS policy as src/mastra/mastra.ts postgresSsl(): localhost stays
// plaintext, managed hosts get TLS without CA pinning, MASTRA_PG_SSL wins.
function postgresSsl(url) {
  const override = process.env.MASTRA_PG_SSL;
  if (override === "true") return { rejectUnauthorized: false };
  if (override === "false") return false;
  const host = new URL(url).hostname;
  if (host === "localhost" || host === "127.0.0.1") return false;
  return { rejectUnauthorized: false };
}

function readJsonl(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

const ssl = postgresSsl(connectionString);
const conn = { connectionString, ssl, max: 2, idleTimeoutMillis: 30_000 };
const store = new PostgresStoreVNext({
  id: "allrounder-orchestrator", // must match the server's store id
  ...conn,
  observability: { ...conn },
});
const mastra = new Mastra({ storage: store, logger: false });

/** Create `name` (bound to target/scorers) if absent and add `items`; else skip. */
async function ensureDataset({ name, description, targetType, targetIds, scorerIds, items }) {
  const existing = (await mastra.datasets.list()).find((dataset) => dataset.name === name);
  if (existing !== undefined) {
    console.log(`Dataset "${name}" already exists (id ${existing.id}). Leaving it untouched.`);
    return;
  }
  const dataset = await mastra.datasets.create({
    name,
    description,
    ...(targetType === undefined ? {} : { targetType }),
    ...(targetIds === undefined ? {} : { targetIds }),
    ...(scorerIds === undefined ? {} : { scorerIds }),
  });
  await dataset.addItems({ items });
  console.log(`Seeded dataset "${name}" (id ${dataset.id}) with ${items.length} item(s).`);
}

// 1. Dispatcher golden tickets: the case id travels inside groundTruth so
//    experiment rows stay traceable back to the JSONL line.
const ticketCases = readJsonl("../evals/golden_tickets.jsonl");
await ensureDataset({
  name: GOLDEN_TICKETS_DATASET,
  description:
    "Golden triage tickets (evals/golden_tickets.jsonl): Jira-webhook payloads with expected domain/gate ground truth for the dispatcher routing scorer.",
  items: ticketCases.map((testCase) => ({
    externalId: testCase.id,
    input: testCase.payload,
    groundTruth: { ...testCase.expected, caseId: testCase.id },
  })),
});

// 2. Coding-lane golden sets, grouped by agent target.
const codingCases = readJsonl("../evals/golden_coding.jsonl");
const byTarget = /** @type {Record<string, typeof codingCases>} */ ({});
for (const testCase of codingCases) {
  (byTarget[testCase.target] ??= []).push(testCase);
}
for (const [target, config] of Object.entries(CODING_TARGETS)) {
  const cases = byTarget[target] ?? [];
  if (cases.length === 0) {
    console.log(`No coding cases for target "${target}"; skipping "${config.dataset}".`);
    continue;
  }
  await ensureDataset({
    name: config.dataset,
    description: config.description,
    targetType: "agent",
    targetIds: [config.targetId],
    scorerIds: config.scorerIds,
    items: cases.map((testCase) => ({
      externalId: testCase.id,
      input: testCase.input,
      groundTruth: testCase.groundTruth,
    })),
  });
}

console.log(
  "Next: in Studio open Datasets -> a coding-* set -> Run Experiment (target and scorers are pre-bound), or run scripts/run-coding-eval.mjs against the live server.",
);
process.exit(0);
