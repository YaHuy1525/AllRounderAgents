import { describe, expect, it } from "vitest";

import {
  INTEGRATION_PROVIDERS,
  integrationAccent,
  integrationLabel,
  integrationProvider,
  isIntegrationProvider,
  workflowIntegrations,
  workflowProviderIndex,
} from "./integrations.js";

// Pinned to the backend seed vocabulary (runs.definitions + test_workflows.py
// PROVIDER_VOCAB): adding a provider must be a deliberate two-sided edit.
const PROVIDER_VOCAB = [
  "github",
  "jira",
  "slack",
  "okta",
  "workday",
  "aws",
  "zendesk",
  "email",
  "web",
  "kb",
  "erp",
  "banking",
  "payroll",
  "xero",
];

describe("integration registry", () => {
  it("pins the provider vocabulary to the backend seeds", () => {
    expect(INTEGRATION_PROVIDERS.map((provider) => provider.id)).toEqual(PROVIDER_VOCAB);
  });

  it("gives every provider a distinct label and an accent color", () => {
    const labels = new Set(INTEGRATION_PROVIDERS.map((provider) => provider.label));
    expect(labels.size).toBe(INTEGRATION_PROVIDERS.length);
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(provider.label.length).toBeGreaterThan(1);
      expect(provider.accent.startsWith("#")).toBe(true);
      expect(integrationProvider(provider.id)).toEqual(provider);
      expect(isIntegrationProvider(provider.id)).toBe(true);
    }
  });

  it("falls back gracefully for providers the registry does not know", () => {
    expect(integrationLabel("newcrm")).toBe("newcrm");
    expect(integrationAccent("newcrm")).toBe("var(--muted)");
    expect(integrationProvider("newcrm")).toBeNull();
    expect(isIntegrationProvider("newcrm")).toBe(false);
  });

  it("collects unique providers across steps in first-seen order", () => {
    expect(
      workflowIntegrations([
        { integrations: ["okta", "github"] },
        { integrations: ["github", "aws"] },
        { integrations: [] },
      ]),
    ).toEqual(["okta", "github", "aws"]);
    expect(workflowIntegrations([])).toEqual([]);
  });

  it("indexes provider ids per workflow id", () => {
    const index = workflowProviderIndex([
      { id: "review", steps: [{ integrations: ["github", "github"] }] },
      { id: "leave", steps: [{ integrations: ["workday"] }] },
      { id: "hr-help", steps: [{ integrations: [] }] },
    ]);
    expect(index.get("review")).toEqual(["github"]);
    expect(index.get("leave")).toEqual(["workday"]);
    expect(index.get("hr-help")).toEqual([]);
    expect(index.get("missing")).toBeUndefined();
    expect(workflowProviderIndex([]).size).toBe(0);
  });
});
