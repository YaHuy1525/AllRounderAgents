/**
 * PII discipline for the HR lanes: artifacts reference people by employee id,
 * and any human-readable label carries redacted initials only. Tests call
 * `assertNoRawPii` with the fixture names so a leak fails loudly instead of
 * shipping in a snapshot.
 */

/** "Jordan Avery" -> "J. A."; single tokens keep their initial. */
export function redactName(fullName: string): string {
  const tokens = fullName
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z]/g, ""))
    .filter((token) => token !== "");
  if (tokens.length === 0) return "—";
  const initials = tokens.map((token) => `${token[0]?.toUpperCase() ?? ""}.`);
  return initials.join(" ").trim();
}

/**
 * Throw when any raw name (4+ characters, case-insensitive) appears anywhere
 * in the serialized value. Short names are skipped so common words never
 * false-positive.
 */
export function assertNoRawPii(value: unknown, rawNames: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const name of rawNames) {
    const trimmed = name.trim();
    if (trimmed.length < 4) continue;
    if (serialized.toLowerCase().includes(trimmed.toLowerCase())) {
      throw new Error(`Raw PII leaked into the artifact: "${trimmed}"`);
    }
  }
}
