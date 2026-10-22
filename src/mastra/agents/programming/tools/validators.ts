import type { PatchFile, PatchPlan, ValidationReport, ValidatorResult } from "../contracts.js";
import { ValidationReportSchema, ValidatorResultSchema } from "../contracts.js";

type Validator = (content: string) => string | undefined;

function balanced(content: string, pairs: Readonly<Record<string, string>>): string | undefined {
  const closing = new Set(Object.values(pairs));
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (const character of content) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== undefined) {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (pairs[character] !== undefined) {
      stack.push(pairs[character]);
    } else if (closing.has(character) && stack.pop() !== character) {
      return `Unexpected closing delimiter ${character}`;
    }
  }
  if (quote !== undefined) return "Unclosed string literal";
  if (stack.length > 0) return `Missing closing delimiter ${stack.at(-1) ?? ""}`;
  return undefined;
}

const validators: Record<string, Validator> = {
  json: (content) => {
    try {
      JSON.parse(content);
      return undefined;
    } catch {
      return "Invalid JSON";
    }
  },
  yaml: (content) => {
    if (content.includes("\t")) return "YAML tabs are not allowed";
    const invalid = content
      .split(/\r?\n/)
      .find((line) => line.trim() !== "" && !line.trimStart().startsWith("#")
        && !line.trimStart().startsWith("-") && !line.includes(":"));
    return invalid === undefined ? balanced(content, { "[": "]", "{": "}" }) : "Invalid YAML mapping";
  },
  xml: (content) => {
    const stack: string[] = [];
    const tags = content.match(/<[^>]+>/g);
    if (tags === null) return "XML contains no elements";
    for (const tag of tags) {
      if (/^<\?/.test(tag) || /^<!/.test(tag) || /\/>$/.test(tag)) continue;
      const closing = tag.match(/^<\/([A-Za-z_][\w:.-]*)\s*>$/);
      if (closing !== null) {
        if (stack.pop() !== closing[1]) return "Mismatched XML closing tag";
        continue;
      }
      const opening = tag.match(/^<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?>$/);
      if (opening === null) return "Invalid XML tag";
      stack.push(opening[1] ?? "");
    }
    return stack.length === 0 ? undefined : "Unclosed XML tag";
  },
  "basic-syntax": (content) => balanced(content, { "(": ")", "[": "]", "{": "}" }),
};

/** The patch a per-repo check runs over: its target repository and files. */
export interface RepoCheckContext {
  readonly repository: string;
  readonly files: PatchFile[];
}

/**
 * Optional per-repo real-tooling seam (type-check, lint, test). `affords`
 * is the harnessability gate a repo declares; `run` executes the tooling and
 * returns one result per check/file. Kept behind the seam so repos that lack
 * the tooling cost nothing and the deterministic structure floor still runs.
 */
export interface RepoChecks {
  affords(context: RepoCheckContext): boolean;
  run(context: RepoCheckContext): Promise<ValidatorResult[]>;
}

/** Outcome of a checks pass: whether it ran, its results, or a skip reason. */
export interface CheckOutcome {
  readonly ran: boolean;
  readonly results: ValidatorResult[];
  readonly reason?: string;
}

export class ValidatorRegistry {
  /**
   * The always-on deterministic floor (json/yaml/xml/basic-syntax) plus an
   * optional per-repo checks seam. `checks` runs real tooling (type-check,
   * lint, test) only when the target repo affords it and only pre-Draft-PR
   * (gated by cost), so structure never waits on a slow check and a check
   * that the repo cannot run is skipped with a logged reason.
   */
  constructor(private readonly checks?: RepoChecks) {}

  validate(patch: PatchPlan, attempts = 1): ValidationReport {
    const results = patch.files.flatMap((file) =>
      file.validators.map((name) => {
        const validator = validators[name];
        const error = validator === undefined
          ? `Validator ${name} is not allowlisted`
          : validator(file.content);
        return {
          validator: name,
          path: file.path,
          passed: error === undefined,
          message: error ?? "Passed",
        };
      }),
    );
    return ValidationReportSchema.parse({
      passed: results.every((result) => result.passed),
      attempts,
      results,
    });
  }

  /**
   * Run the optional per-repo checks over the patch. Returns the raw results
   * and whether checks actually ran; a skip carries a reason so the flow can
   * log it and the benchmark can count `checksRun` honestly. Invalid result
   * shapes are rejected through the shared contract.
   */
  async runChecks(
    patch: PatchPlan,
    repository: string,
  ): Promise<CheckOutcome> {
    if (this.checks === undefined) {
      return { ran: false, results: [], reason: "no per-repo checks configured" };
    }
    const context: RepoCheckContext = { repository, files: patch.files };
    if (!this.checks.affords(context)) {
      return { ran: false, results: [], reason: "repository does not afford checks" };
    }
    const results = await this.checks.run(context);
    return {
      ran: true,
      results: results.map((result) => ValidatorResultSchema.parse(result)),
    };
  }
}
