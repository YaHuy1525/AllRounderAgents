import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { findFixture, fixtureFile } from "./fixtures.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const expected = resolve(repoRoot, "fixtures", "hr_directory.json");

describe("fixtureFile", () => {
  it("resolves repo fixtures from the source tree", () => {
    expect(fixtureFile("hr_directory.json")).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("finds the repo root when started from the bundled Mastra dev server", () => {
    // The dev server runs `.mastra/output/index.mjs` with its cwd set to a
    // different directory, where a fixed `../../../fixtures` depth overshoots
    // the repo root (it lands next to the repository instead of inside it).
    expect(findFixture(resolve(repoRoot, ".mastra/output"), "hr_directory.json")).toBe(expected);
  });

  it("returns null instead of a wrong path when the fixture is missing", () => {
    expect(findFixture(import.meta.dirname, "missing-fixture-xyz.json")).toBeNull();
  });
});
