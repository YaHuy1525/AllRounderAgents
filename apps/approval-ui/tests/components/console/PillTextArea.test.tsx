import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PillPickerList, PillTextArea } from "@/components/console/PillTextArea";
import type { RunPill, RunPillKind } from "@/lib/pills";

function pill(
  ref: string,
  label: string,
  kind: RunPillKind = "text",
  groupTitle = "Select PR",
  preview = "…",
): RunPill {
  return {
    ref,
    group: ref.split(".")[1] ?? "trigger",
    groupTitle,
    label,
    kind,
    preview,
    stepIndex: groupTitle === "Trigger" ? -1 : 0,
  };
}

const CATALOG: RunPill[] = [
  pill("trigger.repository", "repository", "text", "Trigger", "acme/app"),
  pill("trigger.prNumber", "prNumber", "number", "Trigger", "77"),
  pill("steps.select-pr.summary", "summary", "text", "Select PR", "Looks fine"),
  pill(
    "steps.ai-review.review.citations[0]",
    "review.citations[0]",
    "citation",
    "AI review",
    "kb-benefits @ 12-40",
  ),
];

describe("PillTextArea", () => {
  it("renders a chip per token and keeps the raw text in the textarea", () => {
    const html = renderToString(
      <PillTextArea
        value="PR {{trigger.repository}}#{{trigger.prNumber}}"
        onChange={() => {}}
        pills={CATALOG}
        fieldLabel="Pull request"
      />,
    );
    expect(html).toContain("pill-chips");
    expect(html).toContain("Trigger › repository");
    expect(html).toContain("Trigger › prNumber");
    expect(html).toContain('title="{{trigger.repository}} · acme/app"');
    expect(html).toContain("PR {{trigger.repository}}#{{trigger.prNumber}}");
    expect(html).not.toContain("pill-note");
  });

  it("turns a stale ref red and explains the re-map", () => {
    const html = renderToString(
      <PillTextArea
        value="superseded by {{steps.ghost.value}}"
        onChange={() => {}}
        pills={CATALOG}
      />,
    );
    expect(html).toContain("pill-chip broken");
    expect(html).toContain("Field no longer exists — re-map {{steps.ghost.value}} before proceeding.");
  });

  it("stays neutral about unknown refs while the catalog is not loaded", () => {
    const html = renderToString(
      <PillTextArea value="keeps {{steps.ghost.value}}" onChange={() => {}} />,
    );
    expect(html).toContain("steps.ghost.value");
    expect(html).not.toContain("broken");
    expect(html).not.toContain("pill-note");
  });

  it("leaves the inert field without picker controls when disabled", () => {
    const html = renderToString(
      <PillTextArea
        value="x {{steps.ghost.value}}"
        onChange={() => {}}
        pills={CATALOG}
        disabled
      />,
    );
    expect(html).toContain("pill-chip broken");
    expect(html).not.toContain("pill-insert");
    expect(html).not.toContain("<button");
  });

  it("hints at the @ trigger for an empty field with a catalog", () => {
    const html = renderToString(
      <PillTextArea value="plain text" onChange={() => {}} pills={CATALOG} />,
    );
    expect(html).toContain("Type @ to insert an output from an earlier step.");
    expect(html).toContain("pill-insert");
    expect(html).not.toContain('class="pill-chips"');
  });

  it("forwards the textarea class and id to the control", () => {
    const html = renderToString(
      <PillTextArea
        value=""
        onChange={() => {}}
        id="guidance"
        textareaClassName="md-editor-input"
      />,
    );
    expect(html).toContain('class="pill-textarea md-editor-input"');
    expect(html).toContain('id="guidance"');
  });
});

describe("PillPickerList", () => {
  it("suggests the field-name match first, then the grouped catalog", () => {
    const html = renderToString(
      <PillPickerList pills={CATALOG} fieldLabel="PR number" onPick={() => {}} />,
    );
    expect(html).toContain("Suggested for this field");
    expect(html).toContain('title="trigger.prNumber"');
    expect(html).toContain('title="steps.ai-review.review.citations[0]"');
    expect(html).toContain("citation");
    // The suggested row sits above the grouped remainder.
    expect(html.indexOf("Suggested for this field")).toBeLessThan(html.indexOf(">Select PR<"));
    // A suggested ref is not repeated in its group.
    expect(html.match(/title="trigger\.prNumber"/g)).toHaveLength(1);
  });

  it("falls back to calm copy when there is nothing to offer", () => {
    const html = renderToString(<PillPickerList pills={[]} />);
    expect(html).toContain("No earlier outputs are available for this step yet.");
  });

  it("disables rows without a pick handler", () => {
    const live = renderToString(<PillPickerList pills={CATALOG} onPick={() => {}} />);
    const inert = renderToString(<PillPickerList pills={CATALOG} />);
    expect(live).not.toContain("disabled");
    expect(inert).toContain("disabled");
  });
});
