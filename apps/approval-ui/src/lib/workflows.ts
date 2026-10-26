import { api } from "./api";

/**
 * Browser-side model for the read-only workflow catalog (`GET /workflows`).
 * The API serves the same definitions the run service snapshots at run start,
 * so the graph, the catalog cards, and the live stepper can never disagree.
 */

export type WorkflowStep = {
  id: string;
  title: string;
  sideEffecting: boolean;
  integrations: string[];
};

/** Input control a start field asks for (mirrors the API's ``StartField.kind``). */
export type WorkflowStartKind = "text" | "date" | "number" | "enum" | "list";

/**
 * One value a workflow needs before its first step can run. Published by
 * `GET /workflows`, so the start card renders exactly the fields the server
 * validates instead of a hand-written form per workflow.
 */
export type WorkflowStartField = {
  id: string;
  label: string;
  kind: WorkflowStartKind;
  required: boolean;
  example: string;
  help: string;
  values: string[];
};

export type WorkflowDefinition = {
  id: string;
  title: string;
  mastraWorkflow: string;
  startFields: WorkflowStartField[];
  steps: WorkflowStep[];
};

const START_FIELD_KINDS: ReadonlySet<string> = new Set([
  "text",
  "date",
  "number",
  "enum",
  "list",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/** Strict step sanitizer: a malformed row invalidates the whole definition.
 *  A missing `integrations` key is tolerated (older payloads); a key of the
 *  wrong type is not. */
function sanitizeStep(value: unknown): WorkflowStep | null {
  const record = asRecord(value);
  if (!record) return null;
  const integrations =
    record.integrations === undefined ? [] : asStringArray(record.integrations);
  if (
    integrations === null ||
    typeof record.id !== "string" ||
    record.id === "" ||
    typeof record.title !== "string" ||
    typeof record.sideEffecting !== "boolean"
  ) {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    sideEffecting: record.sideEffecting,
    integrations,
  };
}

export function sanitizeStartField(value: unknown): WorkflowStartField | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || record.id === "") return null;
  const values = record.values === undefined ? [] : asStringArray(record.values);
  const kind = typeof record.kind === "string" && START_FIELD_KINDS.has(record.kind)
    ? (record.kind as WorkflowStartKind)
    : "text";
  return {
    id: record.id,
    label: typeof record.label === "string" && record.label !== "" ? record.label : record.id,
    kind,
    required: record.required === true,
    example: typeof record.example === "string" ? record.example : "",
    help: typeof record.help === "string" ? record.help : "",
    values: values ?? [],
  };
}

/** Start fields are additive: a malformed row is dropped, an absent key is empty. */
function sanitizeStartFields(value: unknown): WorkflowStartField[] {
  if (!Array.isArray(value)) return [];
  const fields: WorkflowStartField[] = [];
  for (const item of value) {
    const field = sanitizeStartField(item);
    if (field !== null) fields.push(field);
  }
  return fields;
}

export function sanitizeWorkflow(value: unknown): WorkflowDefinition | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    typeof record.id !== "string" ||
    record.id === "" ||
    typeof record.title !== "string" ||
    typeof record.mastraWorkflow !== "string"
  ) {
    return null;
  }
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps: WorkflowStep[] = [];
  for (const item of rawSteps) {
    const step = sanitizeStep(item);
    if (step === null) return null;
    steps.push(step);
  }
  if (steps.length === 0) return null;
  return {
    id: record.id,
    title: record.title,
    mastraWorkflow: record.mastraWorkflow,
    startFields: sanitizeStartFields(record.startFields),
    steps,
  };
}

/** Catalog payload sanitizer: invalid entries are dropped, never thrown. */
export function sanitizeWorkflowCatalog(value: unknown): WorkflowDefinition[] | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.workflows)) return null;
  const workflows: WorkflowDefinition[] = [];
  for (const item of record.workflows) {
    const workflow = sanitizeWorkflow(item);
    if (workflow !== null) workflows.push(workflow);
  }
  return workflows;
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const payload = await api<unknown>("/workflows");
  const workflows = sanitizeWorkflowCatalog(payload);
  if (workflows === null) throw new Error("Unexpected workflow catalog payload");
  return workflows;
}
