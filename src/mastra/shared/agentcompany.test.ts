import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { fixtureFile } from "./fixtures.js";

/**
 * Pins the vendored TheAgentCompany import (`fixtures/agentcompany`).
 * `scripts/import-agentcompany.mjs` rebuilds it deterministically from a
 * pinned upstream commit, so these tests fail loudly when the dataset drifts
 * from its manifest or loses backbone invariants.
 */

const PINNED_COMMIT = "98b68ef82a47690c316f42fddb05baafaab56851";
const companyDir = fixtureFile("agentcompany");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(companyDir, relativePath), "utf8")) as T;
}

function readText(relativePath: string): string {
  return readFileSync(resolve(companyDir, relativePath), "utf8");
}

type Manifest = {
  source: { repo: string; commit: string };
  counts: { people: number; staff: number; projects: number; channels: number; tasks: number; files: number };
  files: Array<{ path: string; source: string | null; size: number; sha256: string }>;
};

type PeopleDoc = {
  people: Array<{ id: string; username: string | null; isAiAssistant: boolean; channels: string[] }>;
};

type ProjectsDoc = {
  projects: Array<{ id: string; ownerId: string | null; sourceRepo: string | null }>;
};

type ChannelsDoc = { channels: Array<{ id: string; members: string[] }> };

type Catalog = {
  upstream: { commit: string; taskCount: number };
  byRole: Record<string, number>;
  tasks: Array<{
    id: string;
    role: string;
    request: string | null;
    dataFiles: Array<{ path: string; size: number }>;
    hasData: boolean;
  }>;
};

const manifest = readJson<Manifest>("MANIFEST.json");

describe("agentcompany import", () => {
  it("pins the upstream commit and verifies every manifest hash", () => {
    expect(manifest.source.repo).toBe("TheAgentCompany/TheAgentCompany");
    expect(manifest.source.commit).toBe(PINNED_COMMIT);
    expect(manifest.counts.files).toBe(manifest.files.length);
    for (const file of manifest.files) {
      const actual = createHash("sha256")
        .update(readFileSync(resolve(companyDir, file.path)))
        .digest("hex");
      expect(actual, `hash drift for ${file.path}`).toBe(file.sha256);
    }
  });

  it("keeps the upstream credential map out of the import", () => {
    expect(existsSync(resolve(companyDir, "company/credentials.json"))).toBe(false);
    expect(manifest.files.some((file) => file.path.toLowerCase().includes("credential"))).toBe(false);
    expect(readText("company/people.json").toLowerCase()).not.toContain("password");
  });

  it("resolves the company backbone across people, projects and channels", () => {
    const { people } = readJson<PeopleDoc>("company/people.json");
    const staff = people.filter((person) => !person.isAiAssistant);
    expect(people.length).toBe(manifest.counts.people);
    expect(staff.length).toBe(manifest.counts.staff);
    expect(new Set(people.map((person) => person.id)).size).toBe(people.length);
    for (const person of staff) {
      expect(person.username, `${person.id} username`).toBeTruthy();
      expect(person.channels.length).toBeGreaterThan(0);
    }

    const peopleIds = new Set(people.map((person) => person.id));
    const { projects } = readJson<ProjectsDoc>("company/projects.json");
    expect(projects.length).toBe(manifest.counts.projects);
    for (const project of projects) {
      if (project.ownerId !== null) expect(peopleIds.has(project.ownerId), project.id).toBe(true);
    }
    expect(projects.filter((project) => project.sourceRepo !== null)).toHaveLength(5);

    const { channels } = readJson<ChannelsDoc>("company/channels.json");
    expect(channels.length).toBe(manifest.counts.channels);
    for (const channel of channels) {
      for (const member of channel.members) {
        expect(peopleIds.has(member), `${channel.id}:${member}`).toBe(true);
      }
    }
    expect(channels.find((channel) => channel.id === "general")?.members).toContain("chen-xinyi");
  });

  it("catalogs every task and lands each bundle on disk", () => {
    const catalog = readJson<Catalog>("tasks/catalog.json");
    expect(catalog.upstream.commit).toBe(PINNED_COMMIT);
    expect(catalog.tasks).toHaveLength(manifest.counts.tasks);
    const roleTotal = Object.values(catalog.byRole).reduce((sum, count) => sum + count, 0);
    expect(roleTotal).toBe(catalog.tasks.length);

    for (const task of catalog.tasks) {
      if (task.request) expect(existsSync(resolve(companyDir, task.request)), task.id).toBe(true);
      expect(task.hasData).toBe(task.dataFiles.length > 0);
      for (const file of task.dataFiles) {
        expect(existsSync(resolve(companyDir, file.path)), file.path).toBe(true);
      }
    }
    expect(catalog.tasks.filter((task) => task.hasData).length).toBeGreaterThan(50);
  });

  it("ships the finance and HR evidence files verbatim", () => {
    for (const name of ["budget.xlsx", "actual_spending.xlsx"]) {
      const file = resolve(companyDir, "tasks/finance-budget-variance/files", name);
      expect(existsSync(file), name).toBe(true);
    }
    const attendance = readText("tasks/hr-check-attendance-one-day/files/attendance-2024-03-01.csv");
    expect(attendance).toContain("Clock-in");
    expect(attendance).toContain("Sarah Johnson");
  });
});
