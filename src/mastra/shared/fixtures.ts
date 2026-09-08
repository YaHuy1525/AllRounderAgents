import { resolve } from "node:path";

/**
 * Resolve a repo-root fixture (`fixtures/<name>`) relative to this file so
 * tests keep working regardless of the process working directory.
 */
export function fixtureFile(name: string): string {
  return resolve(import.meta.dirname, "../../../fixtures", name);
}
