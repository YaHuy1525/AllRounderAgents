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

export type WorkflowDefinition = {
  id: string;
  title: string;
  mastraWorkflow: string;
  steps: WorkflowStep[];
};

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
