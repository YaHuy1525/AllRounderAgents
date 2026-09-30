#!/usr/bin/env node
/**
 * Harvest TheAgentCompany (CMU benchmark company, MIT licensed) service data
 * into `fixtures/agentcompany/services/` from the prebuilt ghcr images at the
 * same pinned upstream commit as `scripts/import-agentcompany.mjs`.
 *
 * The task bundles imported by that script reference ownCloud documents, a
 * RocketChat workspace and a GitLab instance that only exist inside the
 * published service images. This harvester extracts that state offline, so no
 * services are ever booted and no credentials are needed:
 *
 *   owncloud/files/**            company documents from the ownCloud image
 *   rocketchat/channels.json     35 rooms (15 channels + 20 DMs) with members
 *   rocketchat/users.json        18 accounts (no password hashes)
 *   rocketchat/npc_definition.json  19 Sotopia personas
 *   gitlab/projects.json         the init-script Documentation hub (id 1) plus
 *                                the imported projects in export order
 *   gitlab/issues.json           issues from the baked project exports
 *   gitlab/merge_requests.json   merge requests from the exports
 *   gitlab/wikis.json            company wiki plus per-project wiki bundles
 *   HARVEST.json                 image digests, counts, per-file sha256
 *
 * Extraction strategy per service:
 *   owncloud   docker create + docker cp of /var/www/html/data/theagentcompany
 *   rocketchat docker run mongo:7 + mongorestore of the api-server db.dump,
 *              then a mongosh EJSON export of rooms/users/subscriptions
 *   gitlab     only the `COPY . /assets` image layer (4.18 GB) is downloaded
 *              via a chunked, resumable, sha256-verified fetch from the NJU
 *              mirror, then the project export tarballs inside are unpacked
 *
 * Excluded on purpose: plane backup data (the public image ships 1184-byte
 * placeholder stubs), RocketChat messages (NPC chats are generated live by
 * Sotopia at task time), repository bundles and full git history, issue and
 * merge request notes/events/designs/diff metadata, project uploads, the
 * owncloud.db runtime database, and anything carrying credential material.
 * Issue and merge request descriptions are capped at 800 characters to keep
 * the JSON fixtures a sane size.
 *
 * Usage:
 *   node scripts/harvest-agentcompany-services.mjs                    # all stages
 *   node scripts/harvest-agentcompany-services.mjs --stages owncloud,rocketchat
 *   node scripts/harvest-agentcompany-services.mjs --work tmp/tac-harvest
 *
 * Requires docker, git and network access; re-runs are idempotent and the
 * gitlab layer download resumes from its chunk files.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Readable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import readline from "node:readline";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "fixtures", "agentcompany", "services");
const WORK = argValue("--work") ? path.resolve(ROOT, argValue("--work")) : path.join(ROOT, "tmp", "tac-harvest");

const UPSTREAM = {
  repo: "TheAgentCompany/TheAgentCompany",
  url: "https://github.com/TheAgentCompany/TheAgentCompany",
  commit: "98b68ef82a47690c316f42fddb05baafaab56851",
  committedAt: "2025-11-17T20:31:14Z",
};

const IMAGES = {
  owncloud: {
    ref: "ghcr.io/theagentcompany/servers-owncloud:1.0.0",
    digest: "sha256:326406d88345899db22fc1081aa8fa15415c542a71b80486c0a2cebf59f56f63",
  },
  apiServer: {
    ref: "ghcr.io/theagentcompany/servers-api-server:1.0.0",
    digest: "sha256:fc162044d7062323c1fc5699569b1483e134accdc9c12af6816f991a040c9b5c",
  },
  gitlab: {
    ref: "ghcr.io/theagentcompany/servers-gitlab:1.0.0",
    manifestDigest: "sha256:6c61011c225953f3c081eb44e5ba80068489f31289aeb31ccf621c3df024142e",
  },
};

/** The gitlab build layer that holds /assets/exports/*.tar.gz (COPY . /assets). */
const GITLAB_ASSETS_LAYER = {
  index: 10,
  digest: "sha256:458326969fe44b12ccb8f784d394395cf6daa81fa510b0f2a55b24bc70fa54be",
  bytes: 4377973853,
  mirror: "https://ghcr.nju.edu.cn",
  streams: 12,
};

/** Issue and merge request descriptions are truncated at this length. */
const DESCRIPTION_CAP = 800;

const MONGO_IMAGE = "mongo:7";
const MONGO_EXPORT_SCRIPT = `const rc = db.getSiblingDB("rocketchat");
print("===SECTION messages");
rc.rocketchat_message.find({}, { _id: 1, rid: 1, msg: 1, ts: 1, u: 1 }).sort({ ts: 1 }).forEach((doc) => print(EJSON.stringify(doc)));
print("===SECTION rooms");
rc.rocketchat_room.find({}, { _id: 1, name: 1, t: 1, ts: 1, usersCount: 1, topic: 1, u: 1 }).forEach((doc) => print(EJSON.stringify(doc)));
print("===SECTION users");
rc.users.find({}, { _id: 1, username: 1, name: 1, status: 1, active: 1, roles: 1, emails: 1 }).forEach((doc) => print(EJSON.stringify(doc)));
print("===SECTION subscriptions");
rc.rocketchat_subscription.find({}, { _id: 1, rid: 1, u: 1, roles: 1, ts: 1 }).forEach((doc) => print(EJSON.stringify(doc)));
`;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, { allowFail = false } = {}) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result.status === 0;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 ** 2 });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureImage(image) {
  let repoDigest = capture("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image.ref]);
  if (!repoDigest) {
    console.log(`pulling ${image.ref} ...`);
    run("docker", ["pull", image.ref]);
    repoDigest = capture("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image.ref]);
  }
  if (repoDigest && !repoDigest.endsWith(image.digest)) {
    console.warn(`warning: ${image.ref} digest ${repoDigest} does not match pinned ${image.digest}`);
  }
}

function stageOwncloud() {
  console.log("== owncloud: copying company documents out of the image");
  ensureImage(IMAGES.owncloud);
  const container = "tac-harvest-owncloud";
  run("docker", ["rm", "-f", container], { allowFail: true });
  run("docker", ["create", "--name", container, IMAGES.owncloud.ref]);
  const extracted = path.join(WORK, "owncloud-data");
  if (!existsSync(path.join(extracted, "files"))) {
    run("docker", ["cp", `${container}:/var/www/html/data/theagentcompany`, extracted]);
  }
  run("docker", ["rm", "-f", container], { allowFail: true });

  const target = path.join(FIXTURES, "owncloud", "files");
  mkdirSync(target, { recursive: true });
  for (const folder of ["Documents", "Downloads"]) {
    cpSync(path.join(extracted, "files", folder), path.join(target, folder), { recursive: true });
  }
  console.log(`owncloud: curated files copied into ${path.relative(ROOT, target)}`);
}

async function waitForMongo(container) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ok = capture("docker", ["exec", container, "mongosh", "--quiet", "--eval", "db.runCommand({ ping: 1 }).ok"]);
    if (ok && ok.includes("1")) return;
    await sleep(2000);
  }
  throw new Error("mongo did not become ready");
}

async function stageRocketchat() {
  console.log("== rocketchat: restoring the db dump and exporting collections");
  ensureImage(IMAGES.apiServer);
  const apiContainer = "tac-harvest-api";
  run("docker", ["rm", "-f", apiContainer], { allowFail: true });
  run("docker", ["create", "--name", apiContainer, IMAGES.apiServer.ref]);
  const assets = path.join(WORK, "rocketchat-assets");
  mkdirSync(assets, { recursive: true });
  for (const file of ["db.dump", "npc_definition.json"]) {
    run("docker", ["cp", `${apiContainer}:/rocketchat/${file}`, path.join(assets, file)]);
  }
  run("docker", ["rm", "-f", apiContainer], { allowFail: true });

  const mongo = "tac-harvest-mongo";
  run("docker", ["rm", "-f", mongo], { allowFail: true });
  run("docker", ["run", "-d", "--name", mongo, MONGO_IMAGE]);
  try {
    await waitForMongo(mongo);
    run("docker", ["cp", path.join(assets, "db.dump"), `${mongo}:/tmp/db.dump`]);
    run("docker", ["exec", mongo, "mongorestore", "--drop", "--archive=/tmp/db.dump"]);
    const exportScript = path.join(assets, "export.js");
    writeFileSync(exportScript, MONGO_EXPORT_SCRIPT);
    run("docker", ["cp", exportScript, `${mongo}:/tmp/export.js`]);
    run("docker", ["exec", mongo, "sh", "-c", "mongosh --quiet rocketchat --file /tmp/export.js > /tmp/rc-export.txt"]);
    run("docker", ["cp", `${mongo}:/tmp/rc-export.txt`, path.join(assets, "rc-export.txt")]);
  } finally {
    run("docker", ["rm", "-f", mongo], { allowFail: true });
  }

  const sections = parseExport(readFileSync(path.join(assets, "rc-export.txt"), "utf8"));
  const channels = sections.rooms.map((room) => ({
    id: room._id,
    name: room.name ?? null,
    type: room.t === "c" ? "channel" : room.t === "d" ? "direct" : room.t ?? "unknown",
    createdAt: unwrap(room.ts),
    usersCount: unwrap(room.usersCount) ?? null,
    topic: room.topic ?? null,
    createdBy: room.u?.username ?? null,
    members: (sections.subscriptions ?? [])
      .filter((sub) => sub.rid === room._id)
      .map((sub) => ({ username: sub.u?.username ?? null, roles: sub.roles ?? [] }))
      .sort((a, b) => (a.username ?? "").localeCompare(b.username ?? "")),
  }));
  const users = sections.users.map((user) => ({
    id: user._id,
    username: user.username ?? null,
    name: user.name ?? null,
    status: user.status ?? null,
    active: user.active ?? null,
    roles: user.roles ?? [],
    emails: (user.emails ?? []).map((entry) => entry.address),
  }));

  const outDir = path.join(FIXTURES, "rocketchat");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "channels.json"), JSON.stringify(channels, null, 2) + "\n");
  writeFileSync(path.join(outDir, "users.json"), JSON.stringify(users, null, 2) + "\n");
  copyFileSync(path.join(assets, "npc_definition.json"), path.join(outDir, "npc_definition.json"));

  const named = channels.filter((channel) => channel.type === "channel" && channel.name).length;
  const direct = channels.filter((channel) => channel.type === "direct").length;
  console.log(`rocketchat: ${channels.length} rooms (${named} named, ${direct} direct), ${users.length} users, ${(sections.messages ?? []).length} messages`);
}

function parseExport(text) {
  const sections = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^===SECTION (\w+)$/);
    if (marker) {
      current = marker[1];
      sections[current] = [];
      continue;
    }
    if (current && line.trim()) sections[current].push(JSON.parse(line));
  }
  return sections;
}

function unwrap(value) {
  if (value && typeof value === "object") {
    if ("$date" in value) return value.$date;
    if ("$numberInt" in value) return Number(value.$numberInt);
    if ("$oid" in value) return value.$oid;
  }
  return value;
}

async function gitlabToken() {
  try {
    const res = await fetch(`${GITLAB_ASSETS_LAYER.mirror}/token?scope=repository:theagentcompany/servers-gitlab:pull`);
    if (res.ok) return (await res.json()).token ?? null;
  } catch {}
  return null;
}

async function ensureGitlabLayer(layerFile) {
  if (existsSync(layerFile) && `sha256:${await sha256File(layerFile)}` === GITLAB_ASSETS_LAYER.digest) {
    console.log("gitlab: assets layer already downloaded and verified");
    return;
  }
  console.log(`gitlab: fetching the assets layer (${(GITLAB_ASSETS_LAYER.bytes / 1024 ** 2).toFixed(0)} MiB) from ${GITLAB_ASSETS_LAYER.mirror}`);
  const partsDir = path.join(WORK, "gitlab", "parts");
  mkdirSync(partsDir, { recursive: true });
  const token = await gitlabToken();
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const blobUrl = `${GITLAB_ASSETS_LAYER.mirror}/v2/theagentcompany/servers-gitlab/blobs/${GITLAB_ASSETS_LAYER.digest}`;
  const size = GITLAB_ASSETS_LAYER.bytes;
  const per = Math.ceil(size / GITLAB_ASSETS_LAYER.streams);
  const partFile = (index) => path.join(partsDir, `part-${String(index).padStart(2, "0")}.bin`);
  const started = Date.now();

  async function downloadChunk(index) {
    const start = index * per;
    const end = Math.min(start + per, size) - 1;
    const expected = end - start + 1;
    let attempt = 0;
    while (true) {
      const have = existsSync(partFile(index)) ? statSync(partFile(index)).size : 0;
      if (have === expected) return;
      if (have > expected) throw new Error(`chunk ${index} oversized: ${have} > ${expected}`);
      attempt += 1;
      if (attempt > 100) throw new Error(`chunk ${index} exceeded retry limit`);
      const controller = new AbortController();
      let lastData = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastData > 90000) controller.abort();
      }, 15000);
      try {
        const res = await fetch(blobUrl, {
          headers: { ...auth, Range: `bytes=${start + have}-${end}` },
          signal: controller.signal,
        });
        if (res.status !== 206 && res.status !== 200) throw new Error(`status ${res.status}`);
        const meter = new PassThrough();
        meter.on("data", () => {
          lastData = Date.now();
        });
        await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(partFile(index), { flags: "a" }));
      } catch (error) {
        if (attempt % 3 === 1) console.log(`chunk ${index}: retry ${attempt} (${error.message})`);
        await sleep(3000);
      } finally {
        clearInterval(watchdog);
      }
    }
  }

  const progress = setInterval(() => {
    let done = 0;
    for (let index = 0; index < GITLAB_ASSETS_LAYER.streams; index += 1) {
      if (existsSync(partFile(index))) done += statSync(partFile(index)).size;
    }
    console.log(`gitlab: ${(done / 1024 ** 2).toFixed(0)}/${(size / 1024 ** 2).toFixed(0)} MiB at ${(done / 1024 ** 2 / ((Date.now() - started) / 1000)).toFixed(2)} MiB/s`);
  }, 30000);

  await Promise.all(Array.from({ length: GITLAB_ASSETS_LAYER.streams }, (_, index) => downloadChunk(index)));
  clearInterval(progress);

  const out = createWriteStream(layerFile, { flags: "w" });
  for (let index = 0; index < GITLAB_ASSETS_LAYER.streams; index += 1) {
    await pipeline(createReadStream(partFile(index)), out, { end: false });
  }
  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    out.end();
  });

  const digest = `sha256:${await sha256File(layerFile)}`;
  if (digest !== GITLAB_ASSETS_LAYER.digest) {
    throw new Error(`gitlab assets layer digest mismatch: ${digest}`);
  }
  console.log("gitlab: assets layer verified");
}

function exportRoot(dir) {
  const tree = path.join(dir, "tree");
  return existsSync(tree) ? tree : dir;
}

/** Streams relations from `tree/project/*.ndjson` (or plain json) one record at a time. */
async function* streamRecords(root, base) {
  for (const file of [path.join(root, "project", `${base}.ndjson`), path.join(root, `${base}.ndjson`)]) {
    if (!existsSync(file)) continue;
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const text = line.trim();
      if (text) yield JSON.parse(text);
    }
    return;
  }
}

function readProject(root) {
  const file = path.join(root, "project.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function truncateDescription(value) {
  if (typeof value !== "string" || !value) return value ?? null;
  return value.length > DESCRIPTION_CAP ? value.slice(0, DESCRIPTION_CAP) : value;
}

function labelsOf(issue) {
  const linked = issue.label_links?.map((link) => link.label?.title ?? link.label ?? null) ?? null;
  return (linked ?? issue.labels ?? []).filter((label) => typeof label === "string" && label);
}

async function stageGitlab() {
  console.log("== gitlab: unpacking the exported projects");
  const layerFile = path.join(WORK, "gitlab", "layer10-copy-assets.tar");
  await ensureGitlabLayer(layerFile);

  const extracted = path.join(WORK, "gitlab", "extracted");
  const assetsDir = path.join(extracted, "assets");
  if (!existsSync(assetsDir)) {
    mkdirSync(extracted, { recursive: true });
    run("tar", ["-xf", layerFile, "-C", extracted]);
  }

  const exportsDir = path.join(assetsDir, "exports");
  const exportsOut = path.join(WORK, "gitlab", "exports");
  mkdirSync(exportsOut, { recursive: true });
  for (const tarball of readdirSync(exportsDir).filter((name) => name.endsWith(".tar.gz"))) {
    const name = tarball.replace(/\.tar\.gz$/, "");
    const dir = path.join(exportsOut, name);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      run("tar", ["-xzf", path.join(exportsDir, tarball), "-C", dir]);
    }
  }

  const projects = [
    {
      id: 1,
      slug: "doc",
      name: "Documentation",
      description: "Wiki for company-wide doc",
      source: "init-script",
    },
  ];
  const issues = [];
  const mergeRequests = [];
  const wikis = [];
  const names = readdirSync(exportsOut)
    .filter((name) => statSync(path.join(exportsOut, name)).isDirectory())
    .sort();

  for (const [index, name] of names.entries()) {
    const root = exportRoot(path.join(exportsOut, name));
    const project = readProject(root);
    projects.push({
      id: index + 2,
      slug: name,
      name: project.name ?? name,
      description: project.description ?? null,
      visibilityLevel: project.visibility_level ?? null,
      archived: project.archived ?? null,
      source: "export",
    });

    const members = new Map();
    for await (const member of streamRecords(root, "project_members")) {
      if (member.user?.username) members.set(member.user_id, member.user.username);
    }
    for await (const issue of streamRecords(root, "issues")) {
      issues.push({
        project: name,
        iid: issue.iid ?? null,
        title: issue.title ?? null,
        description: truncateDescription(issue.description),
        state: issue.state ?? null,
        labels: labelsOf(issue),
        author: members.get(issue.author_id) ?? null,
        createdAt: issue.created_at ?? null,
        updatedAt: issue.updated_at ?? null,
        closedAt: issue.closed_at ?? null,
      });
    }
    for await (const mergeRequest of streamRecords(root, "merge_requests")) {
      mergeRequests.push({
        project: name,
        iid: mergeRequest.iid ?? null,
        title: mergeRequest.title ?? null,
        description: truncateDescription(mergeRequest.description),
        state: mergeRequest.state ?? null,
        sourceBranch: mergeRequest.source_branch ?? null,
        targetBranch: mergeRequest.target_branch ?? null,
        author: members.get(mergeRequest.author_id) ?? null,
        createdAt: mergeRequest.created_at ?? null,
        mergedAt: mergeRequest.merged_at ?? null,
      });
    }

    const wikiBundle = path.join(exportsOut, name, "project.wiki.bundle");
    if (existsSync(wikiBundle)) {
      // Bare clone plus `git show`: some node-red wiki pages carry colons in
      // their names, which Windows cannot check out as files.
      const wikiDir = path.join(WORK, "gitlab", "wikis", `${name}.git`);
      if (!existsSync(path.join(wikiDir, "HEAD"))) {
        rmSync(wikiDir, { recursive: true, force: true });
        mkdirSync(path.dirname(wikiDir), { recursive: true });
        run("git", ["clone", "--quiet", "--bare", wikiBundle, wikiDir]);
      }
      for (const entry of capture("git", ["-C", wikiDir, "ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0")) {
        if (!entry.endsWith(".md")) continue;
        const slug = path.basename(entry).replace(/\.md$/, "");
        const content = capture("git", ["-C", wikiDir, "show", `HEAD:${entry}`]);
        if (content === null) throw new Error(`git show failed for ${name}/${entry}`);
        wikis.push({ project: name, slug, title: slug, content });
      }
    }
  }

  const wikisAssetDir = path.join(assetsDir, "wikis");
  if (existsSync(wikisAssetDir)) {
    for (const file of readdirSync(wikisAssetDir).filter((name) => name.endsWith(".md"))) {
      const title = file.replace(/\.md$/, "");
      wikis.push({ project: "doc", slug: title.toLowerCase(), title, content: readFileSync(path.join(wikisAssetDir, file), "utf8") });
    }
  }

  const outDir = path.join(FIXTURES, "gitlab");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "projects.json"), `${JSON.stringify(projects, null, 2)}\n`);
  writeFileSync(path.join(outDir, "issues.json"), `${JSON.stringify(issues)}\n`);
  writeFileSync(path.join(outDir, "merge_requests.json"), `${JSON.stringify(mergeRequests)}\n`);
  writeFileSync(path.join(outDir, "wikis.json"), `${JSON.stringify(wikis, null, 2)}\n`);
  console.log(`gitlab: ${projects.length} projects, ${issues.length} issues, ${mergeRequests.length} merge requests, ${wikis.length} wiki pages`);
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, visit);
    else visit(absolute);
  }
}

async function stageManifest() {
  console.log("== manifest: writing HARVEST.json");
  const files = [];
  const pending = [];
  walk(FIXTURES, (absolute) => {
    const relative = path.relative(FIXTURES, absolute).split(path.sep).join("/");
    if (relative === "HARVEST.json") return;
    pending.push({ relative, absolute });
  });
  for (const { relative, absolute } of pending) {
    files.push({ path: relative, size: statSync(absolute).size, sha256: await sha256File(absolute) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const channels = JSON.parse(readFileSync(path.join(FIXTURES, "rocketchat", "channels.json"), "utf8"));
  const users = JSON.parse(readFileSync(path.join(FIXTURES, "rocketchat", "users.json"), "utf8"));
  const npcDefinitions = JSON.parse(readFileSync(path.join(FIXTURES, "rocketchat", "npc_definition.json"), "utf8"));
  const projects = JSON.parse(readFileSync(path.join(FIXTURES, "gitlab", "projects.json"), "utf8"));
  const issues = JSON.parse(readFileSync(path.join(FIXTURES, "gitlab", "issues.json"), "utf8"));
  const mergeRequests = JSON.parse(readFileSync(path.join(FIXTURES, "gitlab", "merge_requests.json"), "utf8"));
  const wikis = JSON.parse(readFileSync(path.join(FIXTURES, "gitlab", "wikis.json"), "utf8"));
  const owncloudFiles = files.filter((file) => file.path.startsWith("owncloud/"));
  const owncloudBytes = owncloudFiles.reduce((sum, file) => sum + file.size, 0);

  const manifest = {
    source: {
      repo: UPSTREAM.repo,
      url: UPSTREAM.url,
      commit: UPSTREAM.commit,
      committedAt: UPSTREAM.committedAt,
      method: "offline extraction from the prebuilt service images; no services are booted",
      images: [
        { ref: IMAGES.owncloud.ref, digest: IMAGES.owncloud.digest },
        { ref: IMAGES.apiServer.ref, digest: IMAGES.apiServer.digest },
        {
          ref: IMAGES.gitlab.ref,
          manifestDigest: IMAGES.gitlab.manifestDigest,
          assetsLayer: { digest: GITLAB_ASSETS_LAYER.digest, bytes: GITLAB_ASSETS_LAYER.bytes },
        },
      ],
    },
    license: "MIT",
    attribution:
      "Service data extracted from TheAgentCompany prebuilt docker images (Frank F. Xu et al., CMU), MIT licensed, pinned at the commit above. Paper: https://arxiv.org/abs/2412.14161.",
    services: {
      owncloud: {
        root: "/var/www/html/data/theagentcompany (account)",
        files: owncloudFiles.length,
        bytes: owncloudBytes,
        note: "Documents/ and Downloads/ only. Stock demo assets (Photos, Templates, ownCloud Manual.pdf) and runtime dirs (cache, files_versions, files_trashbin, thumbnails) excluded, along with owncloud.db (runtime metadata and credential hashes).",
      },
      rocketchat: {
        channels: channels.filter((channel) => channel.type === "channel").length,
        directRooms: channels.filter((channel) => channel.type === "direct").length,
        users: users.length,
        memberships: channels.reduce((sum, channel) => sum + channel.members.length, 0),
        npcDefinitions: npcDefinitions.length,
        messages: 0,
        note: "NPC conversations are generated live by the benchmark's Sotopia agents at task time, so the dump carries rooms, users and subscriptions only. db.dump itself is excluded (contains password hashes). The dump's users collection lists the 18 personas; subscriptions still referencing the deleted seeding accounts (jobbench, yufan) are kept verbatim.",
      },
      gitlab: {
        projects: projects.length,
        issues: issues.length,
        mergeRequests: mergeRequests.length,
        wikiPages: wikis.length,
        note: "Imported from the project export tarballs baked into the image (project id 1 is the init-script Documentation hub, the rest follow the alphabetical export order). Repository bundles, project uploads and issue/MR notes or diff metadata are not vendored (size); issue and merge request descriptions are capped at 800 characters, and per-project wiki bundles are expanded into markdown pages.",
      },
      plane: {
        status: "unavailable",
        note: "The public api-server image ships 1184-byte placeholder stubs for pgdata.tar.gz, redisdata.tar.gz and uploads.tar.gz; upstream documents the plane backups as a manual step, so no plane data can be harvested from published artifacts.",
      },
    },
    counts: { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) },
    files,
  };
  writeFileSync(path.join(FIXTURES, "HARVEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest: ${files.length} files, ${(manifest.counts.bytes / 1024 ** 2).toFixed(1)} MiB`);
}

const STAGES = {
  owncloud: stageOwncloud,
  rocketchat: stageRocketchat,
  gitlab: stageGitlab,
  manifest: stageManifest,
};

const requested = (argValue("--stages") ?? "all")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const stages = requested.includes("all") ? Object.keys(STAGES) : requested;
for (const name of stages) {
  const stage = STAGES[name];
  if (!stage) throw new Error(`unknown stage: ${name}`);
  await stage();
}
console.log("harvest complete");
