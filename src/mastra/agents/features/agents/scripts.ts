import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the feature planner. Expected outputs are
 * on-contract (`FeaturePlanOutputSchema`): target-behaviour summary +
 * confidence + the implementation areas the change spans.
 */
export const featurePlannerScenarios: AgentScenario[] = [
  {
    name: "order filters on the search page",
    input: {
      ticket: { key: "FEAT-7", summary: "Add status filters to the orders search page" },
      criteria: [
        "Users can filter orders by status",
        "The selected filter survives a page reload",
      ],
      files: [
        {
          path: "src/orders/SearchPage.tsx",
          content:
            "export function SearchPage() {\n  return <OrderTable />;\n}\n",
        },
        {
          path: "src/orders/useOrders.ts",
          content:
            "export function useOrders() {\n  return useQuery(ordersKey, fetchOrders);\n}\n",
        },
      ],
    },
    expectedOutput: {
      targetSummary:
        "The orders search page gains a status filter whose selection is persisted, and the orders query re-runs against the selected status.",
      confidence: 0.84,
      areas: ["ui", "state-logic", "tests"],
    },
  },
  {
    name: "exportable audit log",
    input: {
      ticket: { key: "FEAT-12", summary: "Expose the audit log as a CSV download" },
      criteria: ["Auditors can download the audit log as CSV"],
      files: [
        {
          path: "src/api/audit.ts",
          content:
            "export async function listAudit() {\n  return db.audit.findMany();\n}\n",
        },
      ],
    },
    expectedOutput: {
      targetSummary:
        "A CSV export endpoint streams the audit log to auditors with the existing row shape.",
      confidence: 0.79,
      areas: ["api-data", "docs-flags"],
    },
  },
];

/**
 * Few-shot scenarios for the feature engineer. Expected outputs are
 * on-contract (`FeatureImplementationOutputSchema`): full replacement
 * contents per file, tagged by area and acceptance criteria, plus the review
 * summary the human checkpoint renders.
 */
export const featureEngineerScenarios: AgentScenario[] = [
  {
    name: "wire the status filter",
    input: {
      ticket: { key: "FEAT-7", summary: "Add status filters to the orders search page" },
      scope: "The orders search page gains a status filter whose selection is persisted.",
      criteria: ["ac-1: Users can filter orders by status"],
      enabledAreas: ["ui", "state-logic", "tests"],
    },
    expectedOutput: {
      summary: "Added the status filter and persisted its selection across reloads.",
      verdict: "ready",
      confidence: 0.82,
      strengths: ["The filter reuses the existing query key so cache invalidation stays correct."],
      risksOpenQuestions: ["The copy for the empty-filter state is a placeholder."],
      crossCuttingNotes: ["The persisted key must be versioned if the filter shape changes."],
      files: [
        {
          path: "src/orders/SearchPage.tsx",
          content:
            "export function SearchPage() {\n  const [status, setStatus] = useOrderFilter();\n  return <OrderTable status={status} onStatusChange={setStatus} />;\n}\n",
          changeDescription: "Render the status filter bound to the persisted hook.",
          criteriaIds: ["ac-1"],
          area: "ui",
        },
        {
          path: "src/orders/useOrderFilter.ts",
          content:
            "export function useOrderFilter() {\n  return useLocalStorage(\"orders.status\", \"all\");\n}\n",
          changeDescription: "Persist the selected filter for reloads.",
          criteriaIds: ["ac-2"],
          area: "state-logic",
        },
      ],
    },
  },
  {
    name: "stream the CSV export",
    input: {
      ticket: { key: "FEAT-12", summary: "Expose the audit log as a CSV download" },
      scope: "A CSV export endpoint streams the audit log to auditors.",
      criteria: ["ac-1: Auditors can download the audit log as CSV"],
      enabledAreas: ["api-data", "docs-flags"],
    },
    expectedOutput: {
      summary: "Added the CSV export endpoint with a streaming row writer.",
      verdict: "ready",
      confidence: 0.88,
      strengths: ["Streams rows so large logs do not buffer in memory."],
      risksOpenQuestions: [],
      crossCuttingNotes: ["The endpoint relies on the existing auditor role check."],
      files: [
        {
          path: "src/api/audit.ts",
          content:
            "export async function exportAudit(res) {\n  res.setHeader(\"content-type\", \"text/csv\");\n  for await (const row of db.audit.stream()) res.write(toCsv(row));\n  res.end();\n}\n",
          changeDescription: "Add the streaming CSV export handler.",
          criteriaIds: ["ac-1"],
          area: "api-data",
        },
      ],
    },
  },
];
