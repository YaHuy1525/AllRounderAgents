import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve a repo-root fixture (`fixtures/<name>`) by walking up from this
 * module until the fixture is found. This keeps tests working regardless of
 * the process working directory and stays correct in the bundled Mastra dev
 * server, which runs `.mastra/output/index.mjs` from a different directory
 * where a fixed `../../../fixtures` depth overshoots the repo root.
 */
export function fixtureFile(name: string): string {
  const found = findFixture(import.meta.dirname, name);
  return found ?? resolve(import.meta.dirname, "../../../fixtures", name);
}

/** Walk up from `startDir` until `fixtures/<name>` exists; null when missing. */
export function findFixture(startDir: string, name: string): string | null {
  let directory = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(directory, "fixtures", name);
    if (existsSync(candidate)) return candidate;
    directory = resolve(directory, "..");
  }
  return null;
}
