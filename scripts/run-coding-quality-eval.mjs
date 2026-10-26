// In-process coding-quality eval runner (the native replacement for
// `python scripts/judge-eval.py judge/gate --suite coding-quality`).
//
//   node --experimental-strip-types scripts/run-coding-quality-eval.mjs
//
// It judges PRE-RECORDED candidate snapshots, not live lanes: each committed
// candidate's artifacts are turned into a coding snapshot and scored by the
// native Mastra scorers registered under src/mastra/evals/coding-quality. The
// three deterministic gates always run; the rubric-driven LLM judge set runs only
// when a distinct JUDGE_CHAT_MODEL (and its key) is configured, so the coverage
// gate veto stays provable offline and the judge is never a CI merge gate.
//
// When DATABASE_URL is set it also seeds a `coding-quality` dataset and runs a
// task-target experiment through the same Postgres store id the server uses, so
// the score rows persist and are visible in Studio. That persistence step is
// best-effort: the numeric report is computed from the scorers directly.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";

import {
  buildCodingQualityJudges,
  codingQualityGateScorers,
  codingSnapshot,
  deterministicGateResults,
  loadCodingRubric,
  aggregateSuite,
  compareWithBaseline,
  scoreCase,
} from "../src/mastra/evals/coding-quality/index.ts";

const DATASET_NAME = "coding-quality";

function readJsonl(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

const rubric = loadCodingRubric();
const cases = readJsonl("../evals/judge/cases/coding_quality_cases.jsonl");
const candidates = readJsonl("../evals/judge/candidates/coding-quality.jsonl");
const candidateByCase = new Map(candidates.map((candidate) => [candidate.caseId, candidate]));

// The judge model is opt-in. Without it only the deterministic gates score.
const judgeModel = process.env.JUDGE_CHAT_MODEL;
const judgeEntries = judgeModel === undefined || judgeModel === "" ? [] : buildCodingQualityJudges({ model: judgeModel });
const judgeId = judgeEntries.length > 0 ? `mastra-analyze:${judgeModel}` : null;

const gateScorers = Object.values(codingQualityGateScorers);

/** Score the deterministic gates for one snapshot via the native scorers. */
async function runGates(snapshot, tags) {
  const results = await Promise.all(
    gateScorers.map((scorer) => scorer.run({ output: snapshot, groundTruth: { tags } })),
  );
  // The scorers are binary; fall back to the shared pure function if any declined.
  return deterministicGateResults(snapshot.output).map((gate, index) => {
    const scored = results[index];
    if (scored && typeof scored.score === "number") {
      return { ...gate, passed: scored.score === 1 };
    }
    return gate;
  });
}

/** Run the judge set and collect the normalized value per applicable dimension. */
async function runJudge(snapshot, tags) {
  const judgeScores = {};
  for (const entry of judgeEntries) {
    try {
      const result = await entry.scorer.run({ output: snapshot, groundTruth: { tags } });
      if (result.notScorable || typeof result.score !== "number") continue;
      judgeScores[entry.spec.id] = { normalized: result.score, detail: result.reason ?? "" };
    } catch (error) {
      console.warn(`judge dimension ${entry.spec.id} failed: ${error?.message ?? error}`);
    }
  }
  return judgeScores;
}

const evaluations = [];
for (const testCase of cases) {
  const candidate = candidateByCase.get(testCase.caseId);
  if (candidate === undefined) {
    console.warn(`no recorded candidate for ${testCase.caseId}; skipping`);
    continue;
  }
  const snapshot = codingSnapshot(candidate.artifacts, testCase.input);
  const gateResults = await runGates(snapshot, testCase.tags);
  const judgeScores = await runJudge(snapshot, testCase.tags);
  evaluations.push(
    scoreCase({
      rubric,
      caseId: testCase.caseId,
      tags: testCase.tags,
      gateResults,
      judgeScores,
    }),
  );
}

const report = aggregateSuite({
  rubric,
  judgeId,
  generatedAt: new Date().toISOString(),
  results: evaluations,
});

// Optional: persist the gate scores through a task-target experiment so Studio
// can resolve them. Non-fatal, and skipped entirely without a database.
async function persistExperiment() {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    console.log("DATABASE_URL not set; skipping the Studio dataset/experiment persistence step.");
    return;
  }
  let storeModule;
  try {
    storeModule = await import("@mastra/pg");
  } catch {
    console.warn("@mastra/pg unavailable; skipping persistence.");
    return;
  }
  const { PostgresStoreVNext } = storeModule;
  const ssl =
    new URL(connectionString).hostname === "localhost" ||
    new URL(connectionString).hostname === "127.0.0.1"
      ? false
      : { rejectUnauthorized: false };
  const conn = { connectionString, ssl, max: 2, idleTimeoutMillis: 30_000 };
  const store = new PostgresStoreVNext({ id: "allrounder-orchestrator", ...conn, observability: { ...conn } });
  const mastra = new Mastra({ storage: store, logger: false, scorers: codingQualityGateScorers });

  const existing = (await mastra.datasets.list()).find((dataset) => dataset.name === DATASET_NAME);
  const dataset =
    existing !== undefined
      ? await mastra.datasets.get({ id: existing.id })
      : await mastra.datasets.create({
          name: DATASET_NAME,
          description:
            "Recorded coding-quality candidates judged natively (evals/judge/candidates/coding-quality.jsonl): the deterministic gates enforce coverage/evidence/validation.",
          targetType: "task",
          scorerIds: Object.keys(codingQualityGateScorers),
        });
  if (existing === undefined) {
    await dataset.addItems({
      items: cases.map((testCase) => ({
        externalId: testCase.caseId,
        input: { caseId: testCase.caseId, ...testCase.input },
        groundTruth: { tags: testCase.tags },
      })),
    });
  }

  await dataset.startExperiment({
    targetType: "task",
    task: ({ input }) => {
      const candidate = candidateByCase.get(input.caseId);
      return codingSnapshot(candidate?.artifacts, input);
    },
    scorers: gateScorers,
  });
  console.log(`Persisted a coding-quality task-target experiment on dataset "${dataset.id}".`);
}

try {
  await persistExperiment();
} catch (error) {
  console.warn(`experiment persistence skipped: ${error?.message ?? error}`);
}

const reportDir = new URL("../evals/judge/reports/", import.meta.url);
if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
const reportPath = new URL("coding-quality-native-latest.json", reportDir);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

// Regression gate against a committed baseline, when one exists.
const baselinePath = new URL("../evals/judge/baselines/coding-quality.json", import.meta.url);
let gate = { passed: true, regressions: [] };
if (existsSync(baselinePath)) {
  gate = compareWithBaseline(report, JSON.parse(readFileSync(baselinePath, "utf8")));
} else {
  console.log("No coding-quality baseline committed yet; reporting without regression gate.");
}

const failed = report.cases.filter((testCase) => !testCase.passed);
console.log(`coding-quality suite score ${report.score.toFixed(3)} (threshold ${rubric.threshold})`);
console.log(`pass rate ${(report.pass_rate * 100).toFixed(0)}% across ${report.cases.length} case(s)`);
for (const testCase of report.cases) {
  const gates = testCase.outcomes
    .filter((outcome) => outcome.source === "deterministic")
    .map((outcome) => `${outcome.criterionId}=${outcome.passed ? "ok" : "FAIL"}`)
    .join(" ");
  console.log(`- ${testCase.caseId}: score ${testCase.score.toFixed(3)} passed=${testCase.passed} [${gates}]`);
}

// Exit non-zero only on a regression against the committed baseline; a known
// failing candidate (the partial export) is expected and is not a hard failure.
if (failed.length > 0) {
  console.log(`expected failures recorded: ${failed.map((testCase) => testCase.caseId).join(", ")}`);
}
process.exit(gate.passed ? 0 : 1);
