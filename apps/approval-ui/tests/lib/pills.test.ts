import { describe, expect, it } from "vitest";

import {
  brokenPillRefs,
  decisionPillIssues,
  insertPillToken,
  parseRunPills,
  pillBrokenCopy,
  pillChipLabel,
  pillTokens,
  replacePillToken,
  stripPillTrigger,
  suggestPills,
  type RunPill,
  type RunPillKind,
} from "@/lib/pills";

function pill(
  ref: string,
  label: string,
  kind: RunPillKind = "text",
  groupTitle = "Select PR",
): RunPill {
  return { ref, group: ref.split(".")[1] ?? "trigger", groupTitle, label, kind, preview: "…", stepIndex: 0 };
}

const CATALOG: RunPill[] = [
  pill("trigger.repository", "repository", "text", "Trigger"),
  pill("trigger.prNumber", "prNumber", "number", "Trigger"),
  pill("steps.select-pr.prNumber", "prNumber", "number"),
  pill("steps.select-pr.summary", "summary"),
  pill("steps.ai-review.review.citations[0]", "review.citations[0]", "citation", "AI review"),
];

describe("parseRunPills", () => {
  it("parses a well-formed payload", () => {
    const parsed = parseRunPills({
      runId: "run-1",
      workflow: "review",
      currentStepId: "complete",
      pills: [
        {
          ref: "trigger.repository",
          group: "trigger",
          groupTitle: "Trigger",
          label: "repository",
          kind: "text",
          preview: "acme/app",
          stepIndex: -1,
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.runId).toBe("run-1");
    expect(parsed?.currentStepId).toBe("complete");
    expect(parsed?.pills).toHaveLength(1);
    expect(parsed?.pills[0]).toEqual({
      ref: "trigger.repository",
      group: "trigger",
      groupTitle: "Trigger",
      label: "repository",
      kind: "text",
      preview: "acme/app",
      stepIndex: -1,
    });
  });

  it("drops malformed pill rows and defaults unknown kinds to text", () => {
    const parsed = parseRunPills({
      runId: "run-1",
      workflow: "review",
      currentStepId: null,
      pills: [
        { ref: "", group: "trigger", groupTitle: "Trigger", label: "x" },
        { ref: "trigger.a", label: "a" },
        { ref: "trigger.b", group: "trigger", groupTitle: "Trigger", label: "b", kind: "wat" },
      ],
    });
    expect(parsed?.pills).toHaveLength(1);
    expect(parsed?.pills[0]?.ref).toBe("trigger.b");
    expect(parsed?.pills[0]?.kind).toBe("text");
    expect(parsed?.pills[0]?.stepIndex).toBe(-1);
  });

  it("returns null when the payload cannot be trusted", () => {
    expect(parseRunPills(null)).toBeNull();
    expect(parseRunPills("nope")).toBeNull();
    expect(parseRunPills({ runId: "run-1" })).toBeNull();
    expect(parseRunPills({ runId: "run-1", workflow: "review", pills: "x" })).toBeNull();
  });
});

describe("pillTokens", () => {
  it("reads tokens with their spans and ignores single braces", () => {
    const text = "PR {{trigger.repository}}#{{steps.select-pr.prNumber}} {not a token}";
    const tokens = pillTokens(text);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({
      ref: "trigger.repository",
      start: 3,
      end: 3 + "{{trigger.repository}}".length,
    });
    expect(tokens[1]?.ref).toBe("steps.select-pr.prNumber");
    // Index spans let chips map back into the raw text.
    expect(text.slice(tokens[1]!.start, tokens[1]!.end)).toBe("{{steps.select-pr.prNumber}}");
  });

  it("keeps scanning correctly across repeated calls", () => {
    expect(pillTokens("{{a.b}}")).toHaveLength(1);
    expect(pillTokens("{{a.b}} and {{c.d}}")).toHaveLength(2);
  });
});

describe("brokenPillRefs", () => {
  it("flags only refs the catalog no longer offers, deduped in order", () => {
    const text = "{{steps.select-pr.prNumber}} {{steps.ghost.value}} {{steps.ghost.value}}";
    expect(brokenPillRefs(text, CATALOG)).toEqual(["steps.ghost.value"]);
  });

  it("passes clean fields untouched", () => {
    expect(brokenPillRefs("no tokens", CATALOG)).toEqual([]);
    expect(brokenPillRefs("keep {{trigger.repository}}", CATALOG)).toEqual([]);
  });
});

describe("decisionPillIssues", () => {
  it("walks edits and guidance for unknown refs", () => {
    const issues = decisionPillIssues(
      {
        edits: {
          summary: "ok {{trigger.repository}}",
          nested: { list: ["broken {{steps.ghost.value}}"] },
          count: 7,
        },
        guidance: "also {{missing.ref}}",
      },
      CATALOG,
    );
    expect(issues).toEqual(["steps.ghost.value", "missing.ref"]);
  });

  it("returns empty for a clean decision", () => {
    expect(
      decisionPillIssues(
        { edits: { summary: "{{steps.select-pr.summary}}" } },
        CATALOG,
      ),
    ).toEqual([]);
  });
});

describe("insert / strip / replace", () => {
  it("inserts the token at the caret and reports the next caret", () => {
    const result = insertPillToken("hello world", "trigger.repository", 6);
    expect(result.text).toBe("hello {{trigger.repository}}world");
    expect(result.caret).toBe(6 + "{{trigger.repository}}".length);
  });

  it("clamps a wild caret", () => {
    expect(insertPillToken("abc", "a.b", 99).text).toBe("abc{{a.b}}");
    expect(insertPillToken("abc", "a.b", -5).text).toBe("{{a.b}}abc");
  });

  it("drops the @ that opened the picker", () => {
    expect(stripPillTrigger("say @", 4)).toEqual({ text: "say ", caret: 4 });
    // A caret that is not sitting behind an @ keeps the text untouched.
    expect(stripPillTrigger("say ", 4)).toEqual({ text: "say ", caret: 4 });
    expect(stripPillTrigger("hi", 0)).toEqual({ text: "hi", caret: 0 });
  });

  it("replaces a broken chip's span for a re-map", () => {
    const text = "keep {{steps.ghost.value}} here";
    const token = pillTokens(text)[0]!;
    const result = replacePillToken(text, token, "trigger.repository");
    expect(result.text).toBe("keep {{trigger.repository}} here");
    expect(result.caret).toBe(5 + "{{trigger.repository}}".length);
  });
});

describe("suggestPills", () => {
  it("ranks the field-name match first", () => {
    const suggestions = suggestPills("PR number", CATALOG);
    expect(suggestions[0]?.ref).toBe("trigger.prNumber");
    expect(suggestions.some((entry) => entry.ref === "steps.select-pr.prNumber")).toBe(true);
  });

  it("matches through multi-word field labels and casing", () => {
    const suggestions = suggestPills("Analysis summary", [
      pill("steps.analysis.summary", "summary"),
      pill("trigger.repository", "repository", "text", "Trigger"),
    ]);
    expect(suggestions.map((entry) => entry.ref)).toEqual(["steps.analysis.summary"]);
  });

  it("returns nothing for an unlabeled field", () => {
    expect(suggestPills("", CATALOG)).toEqual([]);
    expect(suggestPills("due date", CATALOG)).toEqual([]);
  });
});

describe("copy helpers", () => {
  it("builds the re-map notice with the broken refs", () => {
    expect(pillBrokenCopy(["steps.ghost.value"])).toBe(
      "Field no longer exists — re-map {{steps.ghost.value}} before proceeding.",
    );
    const many = pillBrokenCopy(["a.x", "b.y", "c.z", "d.w", "e.v"]);
    expect(many).toContain("and 2 more");
  });

  it("labels a chip with its group", () => {
    expect(pillChipLabel(CATALOG[3]!)).toBe("Select PR › summary");
  });
});
