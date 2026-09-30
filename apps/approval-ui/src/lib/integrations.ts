/**
 * Display-only integration registry for workflow graphs and platform chips.
 *
 * The provider vocabulary is pinned to the backend seeds
 * (`runs.definitions.StepDefinition.integrations`); the `id` doubles as the
 * glyph key rendered by `ProviderGlyph` (components/console/icons.tsx), so a
 * new provider is a deliberate two-sided edit, never silent drift.
 */

export type IntegrationProvider = {
  id: string;
  label: string;
  /** Chip + satellite accent, readable on the Studio dark surfaces. */
  accent: string;
};

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  { id: "github", label: "GitHub", accent: "#c9d1d9" },
  { id: "jira", label: "Jira", accent: "#579dff" },
  { id: "slack", label: "Slack", accent: "#e0608c" },
  { id: "okta", label: "Okta", accent: "#4fa3e3" },
  { id: "workday", label: "Workday", accent: "#f5a04a" },
  { id: "aws", label: "AWS", accent: "#ff9900" },
  { id: "zendesk", label: "Zendesk", accent: "#6fbf73" },
  { id: "email", label: "Email", accent: "#8ab4f8" },
  { id: "web", label: "Web", accent: "#9aa4b2" },
  { id: "kb", label: "Knowledge base", accent: "#b9a3f0" },
  { id: "erp", label: "ERP", accent: "#5cc8c0" },
  { id: "banking", label: "Banking", accent: "#7fce8f" },
  { id: "payroll", label: "Payroll", accent: "#e2a0e8" },
  { id: "xero", label: "Xero", accent: "#4ec3e0" },
];

const PROVIDER_BY_ID = new Map(INTEGRATION_PROVIDERS.map((item) => [item.id, item]));

export function isIntegrationProvider(id: string): boolean {
  return PROVIDER_BY_ID.has(id);
}

/** Registry entry for a provider id, or null when unknown. */
export function integrationProvider(id: string): IntegrationProvider | null {
  return PROVIDER_BY_ID.get(id) ?? null;
}

/** Human label with a readable fallback for ids the registry does not know yet. */
export function integrationLabel(id: string): string {
  return integrationProvider(id)?.label ?? id;
}

/** Accent color; unknown providers fall back to the theme's neutral muted tone. */
export function integrationAccent(id: string): string {
  return integrationProvider(id)?.accent ?? "var(--muted)";
}

/** Unique providers across a workflow's steps, in first-seen (definition) order. */
export function workflowIntegrations(
  steps: ReadonlyArray<{ integrations: readonly string[] }>,
): string[] {
  const seen: string[] = [];
  for (const step of steps) {
    for (const provider of step.integrations) {
      if (!seen.includes(provider)) seen.push(provider);
    }
  }
  return seen;
}

/**
 * Provider ids per workflow id, resolved once from the catalog. List surfaces
 * (board and approval chips, the runs explorer) share this map instead of
 * fetching per run — the platforms a ticket touched are the union of the
 * platforms its latest run's workflow declares.
 */
export function workflowProviderIndex(
  workflows: ReadonlyArray<{
    id: string;
    steps: ReadonlyArray<{ integrations: readonly string[] }>;
  }>,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const workflow of workflows) {
    index.set(workflow.id, workflowIntegrations(workflow.steps));
  }
  return index;
}
