import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StartRunCard } from "@/components/console/StartRunCard";
import type { ChatStartDraft, ChatStartField } from "@/lib/chat-start";

function startField(
  id: string,
  label: string,
  overrides: Partial<ChatStartField> = {},
): ChatStartField {
  return {
    id,
    label,
    kind: "text",
    required: false,
    example: "",
    help: "",
    values: [],
    value: "",
    ...overrides,
  };
}

const DRAFT: ChatStartDraft = {
  workflow: "leave",
  workflowLabel: "Leave Request",
  ticketKey: "HR-12",
  title: "Leave Request for HR-12",
  detail: "",
  fields: [
    startField("employeeId", "Employee id", {
      required: true,
      example: "EMP-1042",
      value: "E-1002",
      source: "directory: Priya Raman (E-1002)",
    }),
    startField("leaveType", "Leave type", {
      kind: "enum",
      required: true,
      values: ["annual", "sick"],
      value: "",
    }),
  ],
};

function render(draft: ChatStartDraft = DRAFT): string {
  return renderToString(
    <StartRunCard draft={draft} busy={false} onConfirm={() => {}} onDismiss={() => {}} />,
  );
}

describe("start run card", () => {
  it("renders exactly the fields the catalog published", () => {
    const html = render();
    expect(html).toContain("Leave Request for HR-12");
    expect(html).toContain("Leave Request · HR-12");
    expect(html).toContain("Employee id");
    expect(html).toContain("Leave type");
    expect(html).toContain('<option value="sick">sick</option>');
    expect(html).toContain('id="start-HR-12-employeeId"');
  });

  it("cites the record a prefilled value came from", () => {
    const html = render();
    expect(html).toContain("chat-start-source");
    expect(html).toContain("From directory: Priya Raman (E-1002)");
  });

  it("cites nothing for a value no record proved", () => {
    const html = render({
      ...DRAFT,
      fields: DRAFT.fields.map((field) => ({ ...field, source: undefined })),
    });
    expect(html).not.toContain("chat-start-source");
    expect(html).not.toContain("From directory");
  });

  it("keeps Start off while a required field is empty", () => {
    const html = render();
    expect(html).toContain("Needs: Leave type");
    // Anchored to the hook `evals/qa/cases/console-rail.jsonl` targets, so an
    // extra attribute cannot reorder the class out of the assertion.
    expect(html).toMatch(/data-qa="start-confirm"[^>]*\bdisabled\b/);
  });

  it("enables Start once every required field has a value", () => {
    const html = render({
      ...DRAFT,
      fields: DRAFT.fields.map((field) =>
        field.id === "leaveType" ? { ...field, value: "annual" } : field,
      ),
    });
    expect(html).not.toContain("Needs:");
    expect(html).not.toMatch(/data-qa="start-confirm"[^>]*\bdisabled\b/);
    expect(html).toContain("Start run");
  });
});
