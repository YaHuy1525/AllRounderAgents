import type { PatchPlan, ValidationReport } from "../contracts.js";
import { ValidationReportSchema } from "../contracts.js";

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

export class ValidatorRegistry {
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
}
