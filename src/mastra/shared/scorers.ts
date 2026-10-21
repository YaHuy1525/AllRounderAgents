import { createScorer, notScorable } from "@mastra/core/evals";

/**
 * Registered Mastra scorers (instance `scorers` key). These are the auditable
 * Studio-visible twins of gates the lanes already enforce deterministically.
 * Enforcement stays in flow code (`strictRca` in programming/flow.ts, the
 * dispatcher routing table); a scorer never gates a run, it scores what the
 * run produced so the number lands in `mastra_scorers` instead of living as
 * a magic constant only the trace reveals.
 */

/** Concatenate the last assistant message's text parts of an agent-run output. */
function finalAssistantText(output: unknown): string {
  const messages = Array.isArray(output) ? output : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = (messages[index] as { content?: { parts?: unknown } })?.content;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const text = parts
      .filter(
        (part): part is { type: string; text: string } =>
          (part as { type?: string })?.type === "text" &&
          typeof (part as { text?: unknown })?.text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

/** Pull the first JSON object out of a reply (fenced or bare), or `null`. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const CONFIDENCE_FLOOR = 0.8;

/** Validators the actor is allowed to declare (mirrors the actor <output_format>). */
const ALLOWED_PATCH_VALIDATORS = new Set(["json", "yaml", "xml", "basic-syntax"]);

/**
 * True when a "full replacement" content block actually looks like a diff or a
 * truncated placeholder rather than complete file text. Detects unified-diff
 * hunks/headers and a standalone ellipsis line; deliberately does NOT match an
 * inline `...` (a spread or range) so valid code is never flagged.
 */
function looksTruncated(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      return (
        trimmed === "..." ||
        trimmed === "…" ||
        trimmed.startsWith("@@ ") ||
        trimmed.startsWith("+++ ") ||
        trimmed.startsWith("--- ")
      );
    });
}

/**
 * Mirrors the coding lane's `strictRca` policy (programming/flow.ts):
 * evidence must be non-empty, each item needs a path and a plausible line
 * range, and confidence must clear the 0.8 floor. Score 1 = policy-clean,
 * 0.5 = evidence present but confidence below floor, 0 = no usable evidence.
 * Non-JSON outputs (investigator off-contract) score 0 so Studio shows the
 * miss instead of hiding it.
 */
export const rcaEvidenceScorer = createScorer({
  id: "rca-evidence",
  name: "RCA evidence",
  description:
    "Supervised check of the investigator's root-cause contract: non-empty evidence with file paths, line ranges, and confidence at or above 0.8.",
  type: "agent",
})
  .preprocess(({ run }) => parseJsonObject(finalAssistantText(run.output)))
  .generateScore(({ results }) => {
    const rca = results.preprocessStepResult as Record<string, unknown> | null;
    if (rca === null) return 0;
    const evidence = Array.isArray(rca.evidence) ? rca.evidence : [];
    const wellFormed = evidence.every((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return (
        typeof record.path === "string" &&
        record.path !== "" &&
        typeof record.startLine === "number" &&
        typeof record.endLine === "number" &&
        record.endLine >= record.startLine
      );
    });
    if (evidence.length === 0 || !wellFormed) return 0;
    const confidence = typeof rca.confidence === "number" ? rca.confidence : 0;
    return confidence >= CONFIDENCE_FLOOR ? 1 : 0.5;
  })
  .generateReason(({ results, score }) => {
    const rca = results.preprocessStepResult as Record<string, unknown> | null;
    if (rca === null) return "Investigator reply did not contain a JSON RCA object.";
    const evidence = Array.isArray(rca.evidence) ? rca.evidence : [];
    const confidence = typeof rca.confidence === "number" ? rca.confidence : 0;
    if (score === 0) {
      return evidence.length === 0
        ? "No evidence items were reported."
        : "At least one evidence item lacks a path or a valid line range.";
    }
    if (score === 0.5) {
      return `Evidence is well-formed but confidence ${confidence} is below the ${CONFIDENCE_FLOOR} floor.`;
    }
    return `${evidence.length} evidence item(s) with valid paths and line ranges at confidence ${confidence}.`;
  });

/**
 * Golden-ticket routing check for the dispatcher. Ground truth comes from a
 * dataset item's `expected` ({ domain, gate }); live Studio traces carry no
 * ground truth, so the scorer marks itself not-scorable there. Gate mapping:
 * expected `auto` requires `needsHuman` false, any other expected gate
 * (human, escalate, review) requires `needsHuman` true.
 */
export const dispatcherRoutingScorer = createScorer({
  id: "dispatcher-routing",
  name: "Dispatcher routing",
  description:
    "Supervised exact-match of the triage decision against a golden ticket's expected domain and gate.",
  type: "agent",
})
  .preprocess(({ run }) => ({
    decision: parseJsonObject(finalAssistantText(run.output)),
    expected: (run.groundTruth ?? null) as Record<string, unknown> | null,
  }))
  .generateScore(({ results }) => {
    const { decision, expected } = results.preprocessStepResult;
    if (expected === null || expected.domain === undefined) {
      return notScorable("No golden ground truth on this run (live trace).");
    }
    if (decision === null) return 0;
    const domainMatches = decision.domain === expected.domain;
    const needsHuman = decision.needsHuman === true;
    const gateMatches =
      expected.gate === undefined ||
      (expected.gate === "auto" ? !needsHuman : needsHuman);
    return domainMatches && gateMatches ? 1 : 0;
  })
  .generateReason(({ results, score }) => {
    const { decision, expected } = results.preprocessStepResult;
    if (expected === null) return "No ground truth was supplied.";
    if (decision === null) return "Triage reply did not contain a JSON decision object.";
    if (score === 1) {
      return `Routed to ${String(decision.domain)} with the expected human/auto posture.`;
    }
    const domainPart =
      decision.domain === expected.domain
        ? "domain matched"
        : `expected ${String(expected.domain)} but got ${String(decision.domain)}`;
    const gatePart =
      expected.gate === undefined
        ? ""
        : decision.needsHuman === true
          ? ", but escalated to a human"
          : ", but answered without escalation";
    return `Routing miss: ${domainPart}${gatePart}.`;
  });

/**
 * Supervised check that the investigator cited the golden root-cause file.
 * Ground truth is a dataset item's `{ path }`: a non-empty `path` is the file
 * the fix belongs in (a fixable defect), so the reply must name it in
 * `evidence[]` at or above the confidence floor; a null/empty `path` marks an
 * unfixable ticket, so the reply must return empty evidence rather than guess.
 * Live traces carry no golden path, so the scorer marks itself not-scorable.
 */
export const rcaGoldenPathScorer = createScorer({
  id: "rca-golden-path",
  name: "RCA golden path",
  description:
    "Supervised check that the investigator's cited evidence path matches the golden root-cause file (and stays empty for unfixable tickets).",
  type: "agent",
})
  .preprocess(({ run }) => ({
    rca: parseJsonObject(finalAssistantText(run.output)),
    expected: (run.groundTruth ?? null) as Record<string, unknown> | null,
  }))
  .generateScore(({ results }) => {
    const { rca, expected } = results.preprocessStepResult as {
      rca: Record<string, unknown> | null;
      expected: Record<string, unknown> | null;
    };
    if (expected === null || expected.path === undefined) {
      return notScorable("No golden root-cause path on this run (live trace).");
    }
    if (rca === null) return 0;
    const evidence = Array.isArray(rca.evidence) ? rca.evidence : [];
    const expectedPath = expected.path;
    if (typeof expectedPath === "string" && expectedPath !== "") {
      const cited = evidence.some(
        (item) => (item as { path?: unknown })?.path === expectedPath,
      );
      const confidence = typeof rca.confidence === "number" ? rca.confidence : 0;
      return cited && confidence >= CONFIDENCE_FLOOR ? 1 : 0;
    }
    // Unfixable golden ticket: the correct behavior is to report no evidence.
    return evidence.length === 0 ? 1 : 0;
  })
  .generateReason(({ results, score }) => {
    const { rca, expected } = results.preprocessStepResult as {
      rca: Record<string, unknown> | null;
      expected: Record<string, unknown> | null;
    };
    if (expected === null) return "No ground truth was supplied.";
    if (rca === null) return "Investigator reply did not contain a JSON RCA object.";
    const evidence = Array.isArray(rca.evidence) ? rca.evidence : [];
    const expectedPath = expected.path;
    if (typeof expectedPath === "string" && expectedPath !== "") {
      if (score === 1) return `Cited ${expectedPath} at or above the confidence floor.`;
      const cited = evidence.some(
        (item) => (item as { path?: unknown })?.path === expectedPath,
      );
      return cited
        ? `Cited ${expectedPath} but confidence is below the ${CONFIDENCE_FLOOR} floor.`
        : `Did not cite the golden path ${expectedPath}; cited ${JSON.stringify(evidence.map((item) => (item as { path?: unknown })?.path))}.`;
    }
    return score === 1
      ? "Correctly reported no evidence for an unfixable ticket."
      : `Expected empty evidence for an unfixable ticket but got ${evidence.length} item(s).`;
  });

/**
 * Contract check of the actor's patch plan: at least one file, each a relative
 * path with non-empty full-replacement content (no diff/ellipsis) and one or
 * more allowed validators. When the dataset item carries a golden `path`, a
 * plan confined to that file scores 1; a well-formed plan that also touches
 * other files (off-citation) scores 0.5; an unparseable or empty plan scores 0.
 * Not supervised on the golden path, so it also scores live traces.
 */
export const patchContractScorer = createScorer({
  id: "patch-contract",
  name: "Patch contract",
  description:
    "Checks the actor's patch plan is a non-empty set of full-file replacements with valid validators, confined to the cited path.",
  type: "agent",
})
  .preprocess(({ run }) => ({
    patch: parseJsonObject(finalAssistantText(run.output)),
    expected: (run.groundTruth ?? null) as Record<string, unknown> | null,
  }))
  .generateScore(({ results }) => {
    const { patch, expected } = results.preprocessStepResult as {
      patch: Record<string, unknown> | null;
      expected: Record<string, unknown> | null;
    };
    if (patch === null) return 0;
    const files = Array.isArray(patch.files) ? patch.files : [];
    if (files.length === 0) return 0;
    const shapeOk = files.every((file) => {
      const record = (file ?? {}) as Record<string, unknown>;
      const content = typeof record.content === "string" ? record.content : "";
      const validators = Array.isArray(record.validators) ? record.validators : [];
      return (
        typeof record.path === "string" &&
        record.path !== "" &&
        !record.path.startsWith("/") &&
        content.trim() !== "" &&
        !looksTruncated(content) &&
        validators.length > 0 &&
        validators.every(
          (validator) =>
            typeof validator === "string" && ALLOWED_PATCH_VALIDATORS.has(validator),
        )
      );
    });
    if (!shapeOk) return 0;
    const expectedPath = expected?.path;
    if (typeof expectedPath === "string" && expectedPath !== "") {
      const paths = files.map((file) => (file as { path: string }).path);
      return paths.every((path) => path === expectedPath) ? 1 : 0.5;
    }
    return 1;
  })
  .generateReason(({ results, score }) => {
    const { patch, expected } = results.preprocessStepResult as {
      patch: Record<string, unknown> | null;
      expected: Record<string, unknown> | null;
    };
    if (patch === null) return "Actor reply did not contain a JSON patch-plan object.";
    const files = Array.isArray(patch.files) ? patch.files : [];
    if (files.length === 0) return "The patch plan listed no files.";
    if (score === 0) {
      return "A file lacked a relative path, complete content, or a valid validator.";
    }
    if (score === 0.5) {
      return `Patch is well-formed but touches files beyond the cited ${String(expected?.path ?? "path")}.`;
    }
    return `${files.length} file(s) shipped as full replacements with valid validators.`;
  });

/**
 * Supervised agreement between the spec critic's verdict and the golden verdict.
 * Ground truth is a dataset item's `{ passed }`; the critic must agree and name
 * the criteria it judged. Live traces have no golden verdict, so not-scorable.
 */
export const criticAgreementScorer = createScorer({
  id: "critic-agreement",
  name: "Critic agreement",
  description:
    "Supervised check that the spec critic's pass/block verdict matches the golden verdict and names the criteria it judged.",
  type: "agent",
})
  .preprocess(({ run }) => ({
    verdict: parseJsonObject(finalAssistantText(run.output)),
    expected: (run.groundTruth ?? null) as Record<string, unknown> | null,
  }))
  .generateScore(({ results }) => {
    const { verdict, expected } = results.preprocessStepResult as {
      verdict: Record<string, unknown> | null;
      expected: Record<string, unknown> | null;
    };
    if (expected === null || typeof expected.passed !== "boolean") {
      return notScorable("No golden verdict on this run (live trace).");
    }
    if (verdict === null) return 0;
    const checked = Array.isArray(verdict.checkedCriteria) ? verdict.checkedCriteria : [];
    return verdict.passed === expected.passed && checked.length > 0 ? 1 : 0;
  })
  .generateReason(({ results, score }) => {
    const { verdict, expected } = results.preprocessStepResult as {
      verdict: Record<string, unknown> | null;
      expected: Record<string, unknown> | null;
    };
    if (expected === null) return "No ground truth was supplied.";
    if (verdict === null) return "Critic reply did not contain a JSON verdict object.";
    const checked = Array.isArray(verdict.checkedCriteria) ? verdict.checkedCriteria : [];
    if (score === 1) {
      return `Verdict (${String(expected.passed)}) matched the golden gate with ${checked.length} criterion(s) named.`;
    }
    if (checked.length === 0) return "The verdict named no acceptance criteria it judged.";
    return `Verdict ${String(verdict.passed)} disagrees with the golden gate ${String(expected.passed)}.`;
  });
