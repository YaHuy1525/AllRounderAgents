// Drive the coding-lane LLMOps loop end-to-end against a RUNNING Mastra server.
//
//   node scripts/run-coding-eval.mjs [--base http://localhost:4111] [--out path] [--no-advisor]
//
// For each coding dataset (seeded by scripts/seed-mastra-datasets.mjs) it:
//   1. starts an experiment on the dataset's bound agent target + scorers,
//   2. waits for the run to finish,
//   3. pulls the persisted scores back (they are stored under runId = experimentId),
//   4. aggregates a per-scorer pass-rate + the failing items with their reasons,
//   5. feeds that summary to the read-only `llmops-upgrade-advisor` agent and
//      prints the upgrade recommendations.
//
// This is the scripted twin of Studio's "Run Experiment" button; scores also
// land in Studio Scores regardless. It needs only a reachable server (the
// server, not this script, holds the model + DB credentials).
//
// Exit code is non-zero if any experiment failed to run to completion, so it
// can gate CI. The advisor is advisory only and never changes anything.

const DEFAULT_BASE = process.env.MASTRA_BASE_URL ?? "http://localhost:4111";
const API_PREFIX = process.env.MASTRA_API_PREFIX ?? "/api";

// Mirrors scripts/seed-mastra-datasets.mjs. `targetId` must be a registered
// agent id; `scorerIds` must be registered on the instance (registration is
// what persists their scores).
const CODING_TARGETS = [
  { dataset: "coding-investigator", targetId: "programming-investigator", scorerIds: ["rcaEvidence", "rcaGoldenPath"] },
  { dataset: "coding-actor", targetId: "programming-actor", scorerIds: ["patchContract"] },
  { dataset: "coding-validator", targetId: "programming-validator", scorerIds: ["criticAgreement"] },
];

const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled"]);

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, out: undefined, advisor: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--base") args.base = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--no-advisor") args.advisor = false;
  }
  return args;
}

async function request(base, path, init) {
  const url = `${base.replace(/\/+$/, "")}${API_PREFIX}${path}`;
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return text === "" ? null : JSON.parse(text);
}

const getJson = (base, path) => request(base, path, { method: "GET" });
const postJson = (base, path, body) =>
  request(base, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** First page of datasets, as { name -> id }. */
async function datasetByName(base) {
  const data = await getJson(base, "/datasets?page=0&perPage=200");
  const list = Array.isArray(data?.datasets) ? data.datasets : Array.isArray(data) ? data : [];
  const map = new Map();
  for (const dataset of list) map.set(dataset.name, dataset.id);
  return map;
}

/** Poll the experiment record until it reaches a terminal status or times out. */
async function waitForExperiment(base, datasetId, experimentId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let experiment = null;
  while (Date.now() < deadline) {
    experiment = await getJson(base, `/datasets/${datasetId}/experiments/${experimentId}`);
    if (TERMINAL.has(experiment?.status)) return experiment;
    await sleep(2000);
  }
  return experiment;
}

/** Fetch every score persisted for the experiment run (runId === experimentId). */
async function scoresForRun(base, experimentId) {
  const scores = [];
  let page = 0;
  for (;;) {
    const data = await getJson(base, `/scores/run/${experimentId}?page=${page}&perPage=200`);
    const batch = Array.isArray(data?.scores) ? data.scores : [];
    scores.push(...batch);
    const pagination = data?.pagination;
    if (!pagination?.hasMore) break;
    page += 1;
    if (page > 50) break; // hard stop against a mis-paginating server
  }
  return scores;
}

/** Group flat score rows into per-scorer stats with the failing items. */
function aggregateScores(scores) {
  const byScorer = new Map();
  for (const score of scores) {
    const id = score.scorerId ?? score.scorer?.id ?? "unknown";
    const bucket = byScorer.get(id) ?? { scorer: id, values: [], failures: [] };
    if (typeof score.score === "number") {
      bucket.values.push(score.score);
      if (score.score < 1) {
        bucket.failures.push({ itemId: score.entityId, score: score.score, reason: score.reason ?? "" });
      }
    }
    byScorer.set(id, bucket);
  }
  return [...byScorer.values()].map((bucket) => {
    const count = bucket.values.length;
    const mean = count === 0 ? null : bucket.values.reduce((sum, v) => sum + v, 0) / count;
    const passRate = count === 0 ? null : bucket.values.filter((v) => v === 1).length / count;
    return { scorer: bucket.scorer, samples: count, mean, passRate, failures: bucket.failures };
  });
}

async function runTarget(base, datasetId, config, experimentName, timeoutMs) {
  const created = await postJson(base, `/datasets/${datasetId}/experiments`, {
    name: experimentName,
    targetType: "agent",
    targetId: config.targetId,
    scorerIds: config.scorerIds,
    start: true,
  });
  const experimentId = created?.id ?? created?.experimentId;
  if (typeof experimentId !== "string") {
    throw new Error(`No experiment id in create response for ${config.dataset}: ${JSON.stringify(created).slice(0, 200)}`);
  }
  const experiment = await waitForExperiment(base, datasetId, experimentId, timeoutMs);
  const scores = await scoresForRun(base, experimentId);
  return {
    dataset: config.dataset,
    target: config.targetId,
    experimentId,
    status: experiment?.status ?? "unknown",
    counts: {
      total: experiment?.totalItems ?? null,
      succeeded: experiment?.succeededCount ?? null,
      failed: experiment?.failedCount ?? null,
    },
    scorers: aggregateScores(scores),
  };
}

/** Pull the first JSON object out of an agent reply (fenced or bare). */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function agentReplyText(data) {
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.object === "object" && data.object !== null) return JSON.stringify(data.object);
  const choice = data?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  return JSON.stringify(data ?? {});
}

function printReport(summary) {
  console.log(`\nCoding LLMOps run @ ${summary.base} (${summary.generatedAt})`);
  for (const target of summary.targets) {
    console.log(`\n  ${target.dataset}  ->  ${target.target}  [${target.status}]`);
    if (target.error) {
      console.log(`    ERROR: ${target.error}`);
      continue;
    }
    for (const scorer of target.scorers) {
      const mean = scorer.mean === null ? "n/a" : scorer.mean.toFixed(2);
      const pass = scorer.passRate === null ? "n/a" : `${Math.round(scorer.passRate * 100)}%`;
      console.log(`    ${scorer.scorer.padEnd(18)} mean=${mean}  pass=${pass}  (${scorer.samples} scored)`);
      for (const failure of scorer.failures.slice(0, 5)) {
        console.log(`      - ${failure.itemId} (score ${failure.score}): ${failure.reason}`);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeoutMs = Number(process.env.EVAL_EXPERIMENT_TIMEOUT_MS ?? 600_000);

  let names;
  try {
    names = await datasetByName(args.base);
  } catch (error) {
    console.error(`Cannot reach the Mastra server at ${args.base}${API_PREFIX}/datasets.`);
    console.error(String(error.message));
    console.error("Start it first (npm run dev:mastra) and seed datasets (npm run eval:seed).");
    process.exit(1);
  }

  const targets = [];
  for (const config of CODING_TARGETS) {
    const datasetId = names.get(config.dataset);
    if (datasetId === undefined) {
      console.warn(`Dataset "${config.dataset}" not found — run npm run eval:seed. Skipping.`);
      continue;
    }
    const experimentName = `coding-eval ${new Date().toISOString()}`;
    try {
      targets.push(await runTarget(args.base, datasetId, config, experimentName, timeoutMs));
    } catch (error) {
      targets.push({ dataset: config.dataset, target: config.targetId, error: String(error.message) });
    }
  }

  const summary = { generatedAt: new Date().toISOString(), base: args.base, targets };
  printReport(summary);

  if (args.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.out, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`\nWrote summary to ${args.out}`);
  }

  if (args.advisor && targets.some((target) => target.scorers)) {
    try {
      const reply = await postJson(args.base, "/agents/llmops-upgrade-advisor/generate", {
        messages: [{ role: "user", content: JSON.stringify(summary) }],
      });
      const advice = extractJson(agentReplyText(reply));
      console.log("\nUpgrade advisor:");
      if (advice?.recommendations?.length) {
        for (const rec of advice.recommendations) {
          console.log(`  [${rec.changeType}] ${rec.target} / ${rec.scorer}: ${rec.proposedChange}`);
          console.log(`      why: ${rec.symptom}`);
        }
      } else {
        console.log(`  ${advice?.summary ?? "No recommendations returned."}`);
      }
    } catch (error) {
      console.error(`\nAdvisor call failed (scores are still saved in Studio): ${String(error.message)}`);
    }
  }

  const failedToRun = targets.some((target) => target.error || (target.status && !TERMINAL.has(target.status)));
  process.exit(failedToRun ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
