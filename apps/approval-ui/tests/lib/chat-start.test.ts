import { describe, expect, it } from "vitest";

import {
  addContextChip,
  applyPrefill,
  buildStartInput,
  ensureRunContextChip,
  fieldProvenance,
  missingStartFields,
  parsePrefillReply,
  removeContextChip,
  runContextSuffix,
  shortRunId,
  startDraftCaption,
  startDraftFromRow,
  startProblemLines,
  type ChatStartDraft,
  type ChatStartField,
  type ChatTicketRow,
} from "@/lib/chat-start";
import type { WorkflowDefinition, WorkflowStartField } from "@/lib/workflows";

function field(
  id: string,
  label: string,
  overrides: Partial<WorkflowStartField> = {},
): WorkflowStartField {
  return {
    id,
    label,
    kind: "text",
    required: false,
    example: "",
    help: "",
    values: [],
    ...overrides,
  };
}

function workflow(
  id: string,
  title: string,
  startFields: WorkflowStartField[] = [],
): WorkflowDefinition {
  return {
    id,
    title,
    mastraWorkflow: `${id}Flow`,
    startFields,
    steps: [{ id: "intake", title: "Intake", sideEffecting: false, integrations: [] }],
  };
}

const LEAVE_FIELDS: WorkflowStartField[] = [
  field("employeeId", "Employee id", { required: true, example: "EMP-1042" }),
  field("leaveType", "Leave type", {
    kind: "enum",
    required: true,
    values: ["annual", "sick", "unpaid", "parental"],
  }),
  field("startDate", "First day off", { kind: "date", required: true, example: "2026-11-02" }),
  field("endDate", "Last day off", { kind: "date", required: true, example: "2026-11-06" }),
];

const LEAVE = workflow("leave", "Leave Request", LEAVE_FIELDS);

describe("assistant context chips", () => {
  it("adds chips keyed by uppercase ticket key", () => {
    const chips = addContextChip([], { key: "eng-7", summary: "Refund flow" });
    expect(chips).toEqual([{ key: "ENG-7", summary: "Refund flow" }]);
  });

  it("removes chips by key", () => {
    const chips = addContextChip(
      addContextChip([], { key: "ENG-1", summary: "A" }),
      { key: "ENG-2", summary: "B" },
    );
    expect(removeContextChip(chips, "ENG-1").map((chip) => chip.key)).toEqual(["ENG-2"]);
    expect(removeContextChip(chips, "NOPE-1")).toEqual(chips);
  });

  it("ignores payloads that are not ticket keys", () => {
    expect(addContextChip([], { key: "<script>", summary: "x" })).toEqual([]);
    expect(addContextChip([], { key: "not a key", summary: "x" })).toEqual([]);
  });

  it("deduplicates chips and moves the latest to the front", () => {
    const chips = addContextChip(
      addContextChip([], { key: "ENG-1", summary: "old" }),
      { key: "ENG-1", summary: "new" },
    );
    expect(chips).toEqual([{ key: "ENG-1", summary: "new" }]);
  });
});

describe("run:step context", () => {
  it("suffixes chips with the short run id and current step", () => {
    expect(runContextSuffix({ runId: "3f8a2c1d-0000", currentStepId: "verify" })).toBe(
      "run 3f8a2c1d at verify",
    );
    expect(runContextSuffix({ runId: "3f8a2c1d-0000", currentStepId: null })).toBe("run 3f8a2c1d");
  });

  it("shortens a run id to eight characters", () => {
    expect(shortRunId("3f8a2c1d-0000")).toBe("3f8a2c1d");
  });

  it("adds the selected ticket chip with its run context", () => {
    const chips = ensureRunContextChip([], {
      key: "eng-1",
      summary: "Build board",
      run: { runId: "3f8a2c1d-0000", currentStepId: "verify" },
    });
    expect(chips).toEqual([
      { key: "ENG-1", summary: "Build board · run 3f8a2c1d at verify" },
    ]);
  });

  it("enriches an existing chip in place and stays idempotent", () => {
    const start = [
      { key: "ENG-1", summary: "Build board" },
      { key: "ENG-2", summary: "Other" },
    ];
    const once = ensureRunContextChip(start, {
      key: "ENG-1",
      summary: "Build board",
      run: { runId: "3f8a2c1d-0000", currentStepId: null },
    });
    expect(once.map((chip) => chip.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(once[0]?.summary).toBe("Build board · run 3f8a2c1d");
    expect(once[1]).toBe(start[1]);
    const twice = ensureRunContextChip(once, {
      key: "ENG-1",
      summary: "Build board",
      run: { runId: "3f8a2c1d-0000", currentStepId: null },
    });
    expect(twice).toBe(once);
  });

  it("ignores null runs and invalid keys", () => {
    const chips = [{ key: "ENG-1", summary: "Build board" }];
    expect(
      ensureRunContextChip(chips, { key: "ENG-1", summary: "Build board", run: null }),
    ).toBe(chips);
    expect(
      ensureRunContextChip(chips, {
        key: "bad key",
        summary: "x",
        run: { runId: "r", currentStepId: null },
      }),
    ).toBe(chips);
  });
});

describe("start card contract", () => {
  const draft: ChatStartDraft = {
    workflow: "leave",
    workflowLabel: "Leave Request",
    ticketKey: "HR-12",
    title: "Leave Request for HR-12",
    detail: "",
    fields: LEAVE_FIELDS.map((item) => ({ ...item, value: "" })),
  };

  it("names every required field still empty", () => {
    expect(missingStartFields(draft, {})).toEqual([
      "Employee id",
      "Leave type",
      "First day off",
      "Last day off",
    ]);
    expect(missingStartFields(draft, { employeeId: "EMP-1", leaveType: "annual" })).toEqual([
      "First day off",
      "Last day off",
    ]);
  });

  it("coerces numbers and lists, canonicalizes enums, drops blanks", () => {
    const numberDraft: ChatStartDraft = {
      ...draft,
      fields: [
        field("repository", "Repository"),
        field("prNumber", "Pull request number", { kind: "number" }),
        field("leaveType", "Leave type", {
          kind: "enum",
          values: ["annual", "sick"],
        }),
        field("acceptanceCriteria", "Acceptance criteria", { kind: "list" }),
      ].map((item) => ({ ...item, value: "" })),
    };
    expect(
      buildStartInput(numberDraft, {
        repository: "acme/app",
        prNumber: "7",
        leaveType: "ANNUAL",
        acceptanceCriteria: "one, two ,, three",
      }),
    ).toEqual({
      repository: "acme/app",
      prNumber: 7,
      leaveType: "annual",
      acceptanceCriteria: ["one", "two", "three"],
    });
    expect(buildStartInput(numberDraft, { prNumber: "" })).toEqual({});
  });
});

describe("422 field problems", () => {
  it("reads the runs route refusal body", () => {
    expect(
      startProblemLines({
        detail: {
          message: "employeeId: Employee id is required.",
          workflow: "leave",
          fields: [
            { field: "employeeId", problem: "Employee id is required." },
            { field: "startDate", problem: "First day off is required." },
          ],
        },
      }),
    ).toEqual(["employeeId: Employee id is required.", "startDate: First day off is required."]);
  });

  it("ignores bodies that carry no field list", () => {
    expect(startProblemLines(undefined)).toEqual([]);
    expect(startProblemLines({ detail: "Not found" })).toEqual([]);
  });
});

describe("record prefill", () => {
  const draft: ChatStartDraft = {
    workflow: "leave",
    workflowLabel: "Leave Request",
    ticketKey: "HR-12",
    title: "Leave Request for HR-12",
    detail: "",
    fields: [
      { ...field("employeeId", "Employee id", { required: true }), value: "" },
      {
        ...field("leaveType", "Leave type", {
          kind: "enum",
          required: true,
          values: ["annual", "sick"],
        }),
        value: "sick",
      },
      { ...field("startDate", "First day off", { kind: "date", required: true }), value: "" },
    ],
  };
  const directory = {
    id: "employeeId",
    label: "Employee id",
    value: "E-1002",
    source: "directory: Priya Raman (E-1002)",
  };

  it("fills a blank field and keeps the record it came from", () => {
    const merged = applyPrefill(draft, [
      directory,
      { id: "startDate", label: "First day off", value: "2026-11-02", source: "request sheet" },
    ]);
    expect(merged.fields.map((item) => [item.id, item.value, item.source])).toEqual([
      ["employeeId", "E-1002", "directory: Priya Raman (E-1002)"],
      ["leaveType", "sick", undefined],
      ["startDate", "2026-11-02", "request sheet"],
    ]);
    // The draft the transcript already rendered is never mutated.
    expect(draft.fields[0]?.value).toBe("");
  });

  it("never replaces a value the message already carried", () => {
    const typed: ChatStartDraft = {
      ...draft,
      fields: draft.fields.map((item) =>
        item.id === "employeeId" ? { ...item, value: "E-9999" } : item,
      ),
    };
    expect(applyPrefill(typed, [directory])).toBe(typed);
  });

  it("drops an id the catalog does not publish", () => {
    const merged = applyPrefill(draft, [
      { id: "salary", label: "Salary", value: "999999", source: "directory" },
    ]);
    expect(merged).toBe(draft);
    expect(merged.fields.some((item) => item.id === "salary")).toBe(false);
  });

  it("leaves the provenance empty when the answer states none", () => {
    const merged = applyPrefill(draft, [{ ...directory, source: "" }]);
    expect(merged.fields[0]?.value).toBe("E-1002");
    expect(merged.fields[0]?.source).toBeUndefined();
  });

  it("cites the record only while the field still holds the proved value", () => {
    const suggested: ChatStartField = {
      ...field("employeeId", "Employee id"),
      value: "E-1002",
      source: "directory: Priya Raman (E-1002)",
    };
    expect(fieldProvenance(suggested, "E-1002")).toBe("directory: Priya Raman (E-1002)");
    expect(fieldProvenance(suggested, "E-9999")).toBe("");
    expect(fieldProvenance({ ...suggested, source: undefined }, "E-1002")).toBe("");
  });

  it("reads the prefill answer and keeps its field rows", () => {
    expect(
      parsePrefillReply({
        workflow: "leave",
        fields: [directory],
        missing: [{ id: "startDate", label: "First day off" }],
      }),
    ).toEqual({ workflow: "leave", fields: [directory], missing: ["First day off"] });
  });

  it("refuses a body that is not a prefill answer", () => {
    expect(parsePrefillReply(null)).toBeNull();
    expect(parsePrefillReply("nope")).toBeNull();
    expect(parsePrefillReply({ fields: [] })).toBeNull();
    expect(parsePrefillReply({ workflow: "", fields: [] })).toBeNull();
    expect(parsePrefillReply({ workflow: "leave" })).toBeNull();
  });

  it("skips a row without an id or a value", () => {
    const parsed = parsePrefillReply({
      workflow: "leave",
      fields: [
        { id: "", value: "E-1", source: "directory" },
        { id: "employeeId", value: "", source: "directory" },
        { id: "leaveType", value: 7, source: "directory" },
        { id: "startDate", value: "2026-11-02" },
      ],
      missing: [null, { id: "endDate" }, "not a row"],
    });
    expect(parsed?.fields).toEqual([
      { id: "startDate", label: "startDate", value: "2026-11-02", source: "" },
    ]);
    expect(parsed?.missing).toEqual(["endDate"]);
  });
});

describe("start draft from a listed row", () => {
  const listed: ChatTicketRow = {
    key: "HR-12",
    project: "HR",
    summary: "Annual leave in December",
    status: "Open",
    issueType: "Task",
    priority: "High",
    assignee: null,
    labels: [],
    matchedWorkflows: ["leave"],
  };

  it("blanks every field so nothing is asserted about the message", () => {
    const draft = startDraftFromRow(listed, LEAVE);
    expect(draft.workflow).toBe("leave");
    expect(draft.workflowLabel).toBe("Leave Request");
    expect(draft.ticketKey).toBe("HR-12");
    expect(draft.detail).toBe("Annual leave in December");
    expect(draft.fields.map((item) => [item.id, item.value, item.source])).toEqual([
      ["employeeId", "", undefined],
      ["leaveType", "", undefined],
      ["startDate", "", undefined],
      ["endDate", "", undefined],
    ]);
  });

  it("names the required gap in the caption and never claims a start", () => {
    const caption = startDraftCaption(startDraftFromRow(listed, LEAVE));
    expect(caption).toContain("Employee id");
    expect(caption).toContain("until you confirm");
    expect(caption).not.toContain("started");
  });

  it("says a card with no required gaps is ready, still without a start", () => {
    const bare = workflow("dependencies", "Dependency Update");
    const caption = startDraftCaption(startDraftFromRow(listed, bare));
    expect(caption).toContain("is ready");
    expect(caption).toContain("Confirming starts the run");
  });
});
