import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { fixtureFile } from "./fixtures.js";

/**
 * Pins the vendored TheAgentCompany service harvest
 * (`fixtures/agentcompany/services`). `scripts/harvest-agentcompany-services.mjs`
 * rebuilds it deterministically from the pinned prebuilt docker images, so
 * these tests fail loudly when the dataset drifts from HARVEST.json or loses
 * its backbone invariants.
 */

const PINNED_COMMIT = "98b68ef82a47690c316f42fddb05baafaab56851";
const servicesDir = fixtureFile("agentcompany/services");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(servicesDir, relativePath), "utf8")) as T;
}

type HarvestManifest = {
  source: {
    repo: string;
    commit: string;
    images: Array<{ ref: string; digest?: string; manifestDigest?: string }>;
  };
  services: {
    owncloud: { files: number; bytes: number };
    rocketchat: { channels: number; directRooms: number; users: number; memberships: number; npcDefinitions: number; messages: number };
    gitlab: { projects: number; issues: number; mergeRequests: number; wikiPages: number };
    plane: { status: string };
  };
  counts: { files: number; bytes: number };
  files: Array<{ path: string; size: number; sha256: string }>;
};

type Channel = { id: string; name: string | null; type: string; members: Array<{ username: string | null }> };
type ChatUser = { username: string | null; status: string | null };
type NpcDefinition = { first_name: string; occupation: string };
type Project = { id: number; slug: string; name: string };
type Issue = {
  project: string;
  iid: number | null;
  title: string | null;
  description: string | null;
  labels: string[];
  author: string | null;
};
type MergeRequest = { project: string; iid: number | null; title: string | null; description: string | null };
type Wiki = { project: string; slug: string | null; content: string | null };

const manifest = readJson<HarvestManifest>("HARVEST.json");

describe("agentcompany service harvest", () => {
  it("pins the service images and verifies every manifest hash", () => {
    expect(manifest.source.repo).toBe("TheAgentCompany/TheAgentCompany");
    expect(manifest.source.commit).toBe(PINNED_COMMIT);
    expect(manifest.source.images.map((image) => image.ref).join(" ")).toContain("servers-owncloud:1.0.0");
    expect(manifest.source.images.map((image) => image.ref).join(" ")).toContain("servers-api-server:1.0.0");
    expect(manifest.source.images.map((image) => image.ref).join(" ")).toContain("servers-gitlab:1.0.0");
    for (const image of manifest.source.images) {
      expect(image.digest ?? image.manifestDigest, image.ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    expect(manifest.counts.files).toBe(manifest.files.length);
    expect(manifest.files.reduce((sum, file) => sum + file.size, 0)).toBe(manifest.counts.bytes);
    for (const file of manifest.files) {
      const absolute = resolve(servicesDir, file.path);
      expect(existsSync(absolute), file.path).toBe(true);
      const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      expect(actual, `hash drift for ${file.path}`).toBe(file.sha256);
    }
  }, 30000);

  it("keeps credential material and runtime state out of the harvest", () => {
    for (const file of manifest.files) {
      expect(file.path).not.toMatch(/db\.dump|owncloud\.db|credential/i);
    }
    expect(readFileSync(resolve(servicesDir, "rocketchat/users.json"), "utf8").toLowerCase()).not.toContain("password");
    expect(manifest.services.plane.status).toBe("unavailable");
    expect(manifest.services.rocketchat.messages).toBe(0);
  });

  it("resolves the rocketchat workspace across rooms, users and personas", () => {
    const channels = readJson<Channel[]>("rocketchat/channels.json");
    const users = readJson<ChatUser[]>("rocketchat/users.json");
    const definitions = readJson<NpcDefinition[]>("rocketchat/npc_definition.json");

    const named = channels.filter((channel) => channel.type === "channel" && channel.name !== null);
    const direct = channels.filter((channel) => channel.type === "direct");
    expect(named).toHaveLength(manifest.services.rocketchat.channels);
    expect(direct).toHaveLength(manifest.services.rocketchat.directRooms);
    expect(users).toHaveLength(manifest.services.rocketchat.users);
    expect(definitions).toHaveLength(manifest.services.rocketchat.npcDefinitions);

    const usernames = new Set(users.map((user) => user.username));
    let memberships = 0;
    const dangling = new Set<string>();
    for (const channel of channels) {
      memberships += channel.members.length;
      for (const member of channel.members) {
        if (member.username === null || !usernames.has(member.username)) dangling.add(member.username ?? "null");
      }
    }
    expect(memberships).toBe(manifest.services.rocketchat.memberships);
    // The upstream dump itself keeps 35 subscriptions for two accounts that no
    // longer exist in its users collection, so they are pinned instead of dropped.
    expect([...dangling].sort()).toEqual(["jobbench", "yufan"]);

    const channelNames = named.map((channel) => channel.name);
    expect(channelNames).toContain("help-desk");
    expect(channelNames).toContain("kudos");
    const general = named.find((channel) => channel.name === "general");
    expect(general?.members.map((member) => member.username)).toContain("chen_xinyi");
  });

  it("links gitlab issues, merge requests and wikis to exported projects", () => {
    const projects = readJson<Project[]>("gitlab/projects.json");
    const issues = readJson<Issue[]>("gitlab/issues.json");
    const mergeRequests = readJson<MergeRequest[]>("gitlab/merge_requests.json");
    const wikis = readJson<Wiki[]>("gitlab/wikis.json");

    expect(projects).toHaveLength(manifest.services.gitlab.projects);
    expect(issues).toHaveLength(manifest.services.gitlab.issues);
    expect(mergeRequests).toHaveLength(manifest.services.gitlab.mergeRequests);
    expect(wikis).toHaveLength(manifest.services.gitlab.wikiPages);
    expect(projects.length).toBeGreaterThan(2);
    expect(projects[0]).toMatchObject({ id: 1, slug: "doc", name: "Documentation" });

    const slugs = new Set(projects.map((project) => project.slug));
    expect(new Set(projects.map((project) => project.id)).size).toBe(projects.length);

    // Aggregated on purpose: the fixture carries ~67k records, so per-record
    // expectations would dwarf the rest of the suite.
    const badIssues = issues.filter(
      (issue) =>
        !slugs.has(issue.project) ||
        !(issue.iid !== null && issue.iid > 0) ||
        !issue.title ||
        !Array.isArray(issue.labels) ||
        (issue.description !== null && issue.description.length > 800),
    );
    expect(badIssues.length, JSON.stringify(badIssues[0] ?? null)).toBe(0);
    const badMergeRequests = mergeRequests.filter(
      (mergeRequest) =>
        !slugs.has(mergeRequest.project) ||
        !(mergeRequest.iid !== null && mergeRequest.iid > 0) ||
        !mergeRequest.title ||
        (mergeRequest.description !== null && mergeRequest.description.length > 800),
    );
    expect(badMergeRequests.length, JSON.stringify(badMergeRequests[0] ?? null)).toBe(0);

    const home = wikis.find((wiki) => wiki.project === "doc" && wiki.slug === "home");
    expect(home?.content).toContain("The Agent Company");
    for (const project of ["janusgraph", "node-red", "streamlit"]) {
      expect(wikis.some((wiki) => wiki.project === project), project).toBe(true);
    }
  });

  it("ships the owncloud company documents that task bundles reference", () => {
    expect(
      existsSync(
        resolve(servicesDir, "owncloud/files/Documents/Financials/Annual Reports/2022-alphabet-annual-report.pdf"),
      ),
    ).toBe(true);
    expect(existsSync(resolve(servicesDir, "owncloud/files/Documents/Human Resources Team/resumes"))).toBe(true);
    expect(existsSync(resolve(servicesDir, "owncloud/files/Downloads/api-server_tagline.txt"))).toBe(true);
    expect(manifest.services.owncloud.files).toBeGreaterThan(600);
    for (const file of manifest.files.filter((entry) => entry.path.startsWith("owncloud/"))) {
      expect(file.path).not.toMatch(/files_versions|files_trashbin|thumbnails|\/cache\/|Photos|Templates/);
    }
  });
});
