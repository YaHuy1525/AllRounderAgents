#!/usr/bin/env node
/**
 * Import TheAgentCompany (CMU benchmark company, MIT licensed) into
 * `fixtures/agentcompany/` at a pinned upstream commit.
 *
 * Upstream ships a simulated software company: 17 staff personas, 13 product
 * projects and 175 task bundles whose folders carry the real spreadsheets,
 * CSVs and text files used by the originals. This importer vendors those
 * artifacts so the lanes can simulate against real-shaped data with no docker
 * and no network at test time:
 *
 *   company/people.json          18 personas (17 staff + 1 assistant)
 *   company/projects.json        project catalog parsed from the wiki home
 *   company/channels.json        chat channels expanded from persona notes
 *   company/wiki-home.md         the upstream wiki page, verbatim
 *   tasks/<id>/task.md           each task instruction, verbatim
 *   tasks/<id>/files/**          the task's data files, verbatim
 *   tasks/catalog.json           role, lane, dependencies, vendored files
 *   MANIFEST.json                upstream commit, per-file sha256, skips
 *   LICENSE-theagentcompany.txt  upstream MIT license, verbatim
 *
 * Blob downloads are content addressed under
 * `node_modules/.cache/agentcompany/<commit>/` and verified against the git
 * blob sha1, so re-runs are deterministic and `--from-cache` rebuilds
 * offline. Harness code (Dockerfile, Makefile, evaluator.py, checkpoints),
 * model artifacts (*.pt) and credentials are intentionally not imported, and
 * data files above the size cap land in MANIFEST.json as skipped.
 *
 * Usage:
 *   node scripts/import-agentcompany.mjs                # cache first
 *   node scripts/import-agentcompany.mjs --from-cache   # offline, fail on miss
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const UPSTREAM = {
  repo: "TheAgentCompany/TheAgentCompany",
  url: "https://github.com/TheAgentCompany/TheAgentCompany",
  commit: "98b68ef82a47690c316f42fddb05baafaab56851",
  committedAt: "2025-11-17T20:31:14Z",
};

const FROM_CACHE = process.argv.includes("--from-cache");
const OUT_DIR = resolve(process.cwd(), "fixtures", "agentcompany");
const CACHE_DIR = resolve(process.cwd(), "node_modules", ".cache", "agentcompany", UPSTREAM.commit);
const BLOB_DIR = resolve(CACHE_DIR, "blobs");

/** Data file types vendored per task. Everything else is harness or code. */
const DATA_EXTENSIONS = new Set([
  "csv", "tsv", "xlsx", "xls", "txt", "json", "sql", "parquet",
  "pdf", "docx", "pptx", "png", "jpg", "jpeg", "gif",
]);
const SIZE_CAP = 1024 * 1024; // 1 MiB per file
const CONCURRENCY = 8;

/** GitHub sources behind the imported GitLab mirrors (servers/gitlab). */
const SOURCE_REPOS = {
  "opensearch": "opensearch-project/OpenSearch",
  "llama.cpp": "ggerganov/llama.cpp",
  "colly": "gocolly/colly",
  "node-red": "node-red/node-red",
  "risingwave": "risingwavelabs/risingwave",
};

const LANE_BY_ROLE = {
  finance: "finance", hr: "hr", sde: "dev", pm: "dev", qa: "dev",
  ds: "data", ml: "data", research: "research", admin: "admin",
  bm: "marketing", example: "reference",
};

/* ------------------------------------------------------------ helpers */

function fail(message) {
  throw new Error(`import-agentcompany: ${message}`);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** git blob id = sha1("blob <len>\0" + content); lets us verify downloads. */
function gitBlobSha(buffer) {
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fetchWithRetry(url, headers) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((wake) => setTimeout(wake, 400 * attempt));
    }
  }
  fail(`download ${url} failed: ${lastError}`);
}

async function mapPool(items, worker) {
  const queue = [...items];
  let firstError = null;
  const runner = async () => {
    while (queue.length > 0 && !firstError) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (error) {
        firstError = firstError ?? error;
      }
    }
  };
  const size = Math.max(1, Math.min(CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: size }, runner));
  if (firstError) throw firstError;
}

/* ------------------------------------------------------------ download */

/** Whole-repo tree at the pinned commit, cached so rebuilds skip the API. */
async function loadTree() {
  const cachePath = resolve(CACHE_DIR, "tree.json");
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8"));
  if (FROM_CACHE) fail(`tree cache missing at ${cachePath}`);
  const url = `https://api.github.com/repos/${UPSTREAM.repo}/git/trees/${UPSTREAM.commit}?recursive=1`;
  const payload = JSON.parse(
    (await fetchWithRetry(url, {
      Accept: "application/vnd.github+json",
      "User-Agent": "allrounder-agent-agentcompany-import",
    })).toString("utf8"),
  );
  check(!payload.truncated, "upstream tree is truncated; import needs the full tree");
  const cached = { truncated: payload.truncated, tree: payload.tree };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, jsonText(cached));
  return cached;
}

/** Fetch one blob by tree entry, verifying the git blob sha1; cache by sha. */
async function loadBlob(entry) {
  const cachePath = resolve(BLOB_DIR, entry.sha);
  if (existsSync(cachePath)) return readFileSync(cachePath);
  if (FROM_CACHE) fail(`blob cache missing for ${entry.path} (${entry.sha})`);
  const buffer = await fetchWithRetry(
    `https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.commit}/${encodeURI(entry.path)}`,
    { "User-Agent": "allrounder-agent-agentcompany-import" },
  );
  const actual = gitBlobSha(buffer);
  check(actual === entry.sha, `blob sha mismatch for ${entry.path}: ${actual} != ${entry.sha}`);
  mkdirSync(BLOB_DIR, { recursive: true });
  writeFileSync(cachePath, buffer);
  return buffer;
}

/* ------------------------------------------------------------ parsing */

/** Split upstream `public_info` prose into structured persona fields. */
function parsePublicInfo(text) {
  const parsed = { responsibilities: "", project: "", skills: [] };
  if (!text) return parsed;
  for (const segment of text.split("; ")) {
    const pivot = segment.indexOf(": ");
    if (pivot < 0) continue;
    const key = segment.slice(0, pivot).trim();
    const value = segment.slice(pivot + 2).trim();
    if (key === "Responsibilities") parsed.responsibilities = value;
    if (key === "Project") parsed.project = value;
    if (key === "Skills" && value !== "N/A") parsed.skills = value.split(", ");
  }
  return parsed;
}

const ROLE_RULES = [
  [/CTO|chief/i, "executive"],
  [/human resources/i, "people"],
  [/finance/i, "finance"],
  [/sales|marketing/i, "revenue"],
  [/product manager/i, "product"],
  [/ux|designer/i, "design"],
  [/documentation/i, "docs"],
  [/quality assurance|QA\b/i, "quality"],
  [/software|researcher|database|engineer/i, "engineering"],
];

function roleFamily(occupation) {
  for (const [pattern, family] of ROLE_RULES) if (pattern.test(occupation)) return family;
  return "general";
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function channelKind(id) {
  if (id.startsWith("project-")) return "project";
  if (id === "general") return "company";
  if (id === "hr-announcements") return "people";
  if (id === "sales-marketing") return "revenue";
  if (id === "product" || id === "frontend") return id;
  return "engineering";
}

/** Expand persona chat notes ("All project channels", "#x, #y") to ids. */
function expandChannels(note, technicalIds, projectIds) {
  const ids = new Set();
  for (const token of (note ?? "").split(",")) {
    const value = token.trim();
    if (value.startsWith("#")) ids.add(value.slice(1));
    else if (/^all technical channels$/i.test(value)) for (const id of technicalIds) ids.add(id);
    else if (/^all project channels$/i.test(value)) for (const id of projectIds) ids.add(id);
  }
  return [...ids].sort();
}

/* ------------------------------------------------------------ build */

const tree = (await loadTree()).tree.filter((entry) => entry.type === "blob");
const byPath = new Map(tree.map((entry) => [entry.path, entry]));

function blob(path) {
  const entry = byPath.get(path);
  check(entry !== undefined, `expected upstream file ${path}`);
  return entry;
}

/* Company backbone: personas, credentials (usernames only), wiki, license. */

const personas = JSON.parse(
  (await loadBlob(blob("servers/rocketchat/npc/npc_definition.json"))).toString("utf8"),
);
const credentials = JSON.parse(
  (await loadBlob(blob("workspaces/base_image/npc/npc_credential.json"))).toString("utf8"),
);
const wikiHome = (await loadBlob(blob("servers/gitlab/wikis/Home.md"))).toString("utf8");
const licenseText = await loadBlob(blob("LICENSE"));

const rawChannelIds = new Set();
for (const person of personas) {
  for (const token of (person.slack_channels ?? "").split(",")) {
    const value = token.trim();
    if (value.startsWith("#")) rawChannelIds.add(value.slice(1));
  }
}
const projectChannelIds = [...rawChannelIds].filter((id) => id.startsWith("project-")).sort();
const technicalChannelIds = [...projectChannelIds, "engineering", "tech-talk"].sort();

const people = personas.map((person) => {
  const fullName = `${person.first_name} ${person.last_name}`;
  const parsed = parsePublicInfo(person.public_info);
  const isAiAssistant = /AI Assistant/i.test(person.occupation ?? "");
  return {
    id: slugify(fullName),
    username: credentials[fullName]?.username ?? null,
    fullName,
    firstName: person.first_name,
    lastName: person.last_name,
    age: person.age ?? null,
    gender: person.gender ?? null,
    pronouns: person.gender_pronoun ?? null,
    occupation: person.occupation,
    roleFamily: roleFamily(person.occupation ?? ""),
    responsibilities: parsed.responsibilities,
    project: parsed.project,
    skills: parsed.skills,
    channels: expandChannels(person.slack_channels, technicalChannelIds, projectChannelIds),
    isAiAssistant,
    summary: person.public_info ?? null,
  };
});

const peopleIds = new Set(people.map((person) => person.id));
check(peopleIds.size === people.length, "duplicate persona ids");
const staff = people.filter((person) => !person.isAiAssistant);
check(staff.length >= 15, `expected at least 15 staff, got ${staff.length}`);
for (const person of staff) {
  check(person.username !== null, `${person.fullName} has no upstream username`);
  check(person.channels.length > 0, `${person.fullName} has no channels`);
}

const channels = [...rawChannelIds].sort().map((id) => ({
  id,
  name: `#${id}`,
  kind: channelKind(id),
  members: people.filter((person) => person.channels.includes(id)).map((person) => person.id),
}));

const linkPattern = /^\[([^\]]+)\]\(([^)]+)\)\s+is\s+(.+)$/;
const wikiParagraphs = [];
let currentParagraph = "";
for (const line of wikiHome.split(/\r?\n/)) {
  if (line.trim() === "") {
    if (currentParagraph !== "") wikiParagraphs.push(currentParagraph);
    currentParagraph = "";
  } else {
    currentParagraph = currentParagraph === "" ? line.trim() : `${currentParagraph} ${line.trim()}`;
  }
}
if (currentParagraph !== "") wikiParagraphs.push(currentParagraph);

const projects = [];
for (const paragraph of wikiParagraphs) {
  const match = linkPattern.exec(paragraph);
  if (!match) continue;
  const [, name, companyUrl, rawDescription] = match;
  const id = companyUrl.replace(/\/+$/, "").split("/").pop();
  const owner = people.find((person) => person.project.toLowerCase().includes(id.toLowerCase()));
  projects.push({
    id,
    name,
    description: rawDescription.replace(/\.\s*$/, ""),
    companyUrl,
    sourceRepo: SOURCE_REPOS[id] ?? null,
    ownerId: owner?.id ?? null,
  });
}
check(projects.length >= 10, `expected at least 10 wiki projects, got ${projects.length}`);

/* Task bundles: instructions plus data files, per upstream task folder. */

const taskEntries = new Map();
let harnessCount = 0;
let modelArtifactCount = 0;
const oversize = [];
for (const entry of tree) {
  const match = /^workspaces\/tasks\/([^/]+)\/(.+)$/.exec(entry.path);
  if (!match) continue;
  const [, taskId, relative] = match;
  if (/^(Dockerfile|Makefile|evaluator\.py|checkpoints\.md)$/.test(relative)) {
    harnessCount += 1;
    continue;
  }
  if (relative.endsWith(".pt")) {
    modelArtifactCount += 1;
    continue;
  }
  const extension = relative.includes(".") ? relative.split(".").pop().toLowerCase() : "";
  const isRequest = relative === "task.md";
  const isDependencies = relative === "dependencies.yml";
  const isData = DATA_EXTENSIONS.has(extension) && !isRequest;
  if (!isRequest && !isDependencies && !isData) continue;
  if (isData && entry.size > SIZE_CAP) {
    oversize.push({ path: entry.path, size: entry.size, reason: `size ${entry.size} exceeds cap ${SIZE_CAP}` });
    continue;
  }
  const task = taskEntries.get(taskId) ?? { id: taskId, request: null, dependencies: null, data: [] };
  if (isRequest) task.request = entry;
  else if (isDependencies) task.dependencies = entry;
  else task.data.push(entry);
  taskEntries.set(taskId, task);
}

const taskIds = [...taskEntries.keys()].sort();
check(taskIds.length >= 170, `expected at least 170 task folders, got ${taskIds.length}`);
const budgetVariance = taskEntries.get("finance-budget-variance");
check(budgetVariance?.data.length > 0, "finance-budget-variance must carry data files");
const attendance = taskEntries.get("hr-check-attendance-one-day");
check(attendance?.data.some((entry) => entry.path.endsWith("attendance-2024-03-01.csv")), "attendance CSV missing");

const uniqueBlobs = new Map();
for (const task of taskEntries.values()) {
  for (const entry of [task.request, task.dependencies, ...task.data]) {
    if (entry) uniqueBlobs.set(entry.sha, entry);
  }
}
console.log(`fetching ${uniqueBlobs.size} upstream blobs (cache first)...`);
await mapPool([...uniqueBlobs.values()], async (entry) => {
  await loadBlob(entry);
});

const written = [];
function emit(relativePath, buffer, source) {
  const target = resolve(OUT_DIR, relativePath);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, buffer);
  written.push({ path: relativePath.replaceAll("\\", "/"), source: source ?? null, size: buffer.length, sha256: sha256(buffer) });
}

const catalogTasks = [];
for (const taskId of taskIds) {
  const task = taskEntries.get(taskId);
  const role = taskId.split("-")[0];
  const dataFiles = [];
  for (const entry of [...task.data].sort((a, b) => a.path.localeCompare(b.path))) {
    const relative = entry.path.split(`workspaces/tasks/${taskId}/`)[1];
    const buffer = await loadBlob(entry);
    emit(`tasks/${taskId}/files/${relative}`, buffer, entry.path);
    dataFiles.push({ path: `tasks/${taskId}/files/${relative}`, size: entry.size });
  }
  let request = null;
  if (task.request) {
    emit(`tasks/${taskId}/task.md`, await loadBlob(task.request), task.request.path);
    request = `tasks/${taskId}/task.md`;
  }
  let dependencies = [];
  if (task.dependencies) {
    const lines = (await loadBlob(task.dependencies)).toString("utf8").split(/\r?\n/);
    dependencies = lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1).trim()).sort();
  }
  catalogTasks.push({
    id: taskId,
    role,
    lane: LANE_BY_ROLE[role] ?? "general",
    dependencies,
    request,
    dataFiles,
    hasData: dataFiles.length > 0,
  });
}

const byRole = {};
for (const task of catalogTasks) byRole[task.role] = (byRole[task.role] ?? 0) + 1;

emit("company/people.json", Buffer.from(jsonText({
  company: "The Agent Company",
  source: { repo: UPSTREAM.repo, commit: UPSTREAM.commit },
  people,
})), null);
emit("company/projects.json", Buffer.from(jsonText({ projects })), null);
emit("company/channels.json", Buffer.from(jsonText({ channels })), null);
emit("company/wiki-home.md", Buffer.from(wikiHome), "servers/gitlab/wikis/Home.md");
emit("tasks/catalog.json", Buffer.from(jsonText({
  upstream: { repo: UPSTREAM.repo, commit: UPSTREAM.commit, taskCount: catalogTasks.length },
  laneByRole: LANE_BY_ROLE,
  byRole,
  tasks: catalogTasks,
})), null);
emit("LICENSE-theagentcompany.txt", licenseText, "LICENSE");

/* ------------------------------------------------------------ manifest */

written.sort((a, b) => a.path.localeCompare(b.path));
const totalBytes = written.reduce((sum, file) => sum + file.size, 0);
const manifest = {
  source: {
    repo: UPSTREAM.repo,
    url: UPSTREAM.url,
    commit: UPSTREAM.commit,
    committedAt: UPSTREAM.committedAt,
  },
  license: "MIT",
  attribution: [
    "Personas, project catalog and task artifacts imported from TheAgentCompany",
    "(Frank F. Xu et al., CMU), MIT licensed, pinned at the commit above.",
    "Paper: https://arxiv.org/abs/2412.14161. License text: LICENSE-theagentcompany.txt.",
  ].join(" "),
  rules: {
    dataExtensions: [...DATA_EXTENSIONS].sort(),
    sizeCapBytes: SIZE_CAP,
    notImported: ["harness code (Dockerfile, Makefile, evaluator.py, checkpoints.md)", "model artifacts (*.pt)", "credentials"],
  },
  counts: {
    people: people.length,
    staff: staff.length,
    projects: projects.length,
    channels: channels.length,
    tasks: catalogTasks.length,
    tasksWithData: catalogTasks.filter((task) => task.hasData).length,
    dataFiles: catalogTasks.reduce((sum, task) => sum + task.dataFiles.length, 0),
    files: written.length,
    bytes: totalBytes,
    harnessFilesSkipped: harnessCount,
    modelArtifactsSkipped: modelArtifactCount,
  },
  skipped: oversize.sort((a, b) => a.path.localeCompare(b.path)),
  files: written,
};
writeFileSync(resolve(OUT_DIR, "MANIFEST.json"), jsonText(manifest));

console.log(`upstream=${UPSTREAM.repo}@${UPSTREAM.commit.slice(0, 8)}`);
console.log(`people=${people.length} staff=${staff.length} projects=${projects.length} channels=${channels.length}`);
console.log(`tasks=${catalogTasks.length} withData=${manifest.counts.tasksWithData} dataFiles=${manifest.counts.dataFiles}`);
console.log(`files=${written.length} bytes=${totalBytes} skippedOversize=${oversize.length}`);
console.log(`out=${OUT_DIR}`);
