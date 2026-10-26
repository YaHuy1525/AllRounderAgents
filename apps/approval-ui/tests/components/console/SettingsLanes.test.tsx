import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsView } from "@/components/console/SettingsView";
import { emptyPrefs, emptyUiPrefs } from "@/lib/prefs";
import { RUNNABLE_WORKFLOWS } from "@/lib/runs";

/**
 * The settings panel used to carry its own hand-written lane list, so it kept
 * naming Support, Coding and Finance after those lanes stopped being startable.
 * It now reads the launch catalog, and these pins keep the two in step.
 */

function renderPanel(): string {
  return renderToString(
    <SettingsView
      workspace={{ site: "https://example.atlassian.net", projects: ["SCRUM"], boards: [] }}
      prefs={emptyPrefs()}
      uiPrefs={emptyUiPrefs()}
      status=""
      onSave={() => {}}
      onReload={() => {}}
      onProjectChange={() => {}}
      onBoardChange={() => {}}
      onUiChange={() => {}}
    />,
  );
}

describe("settings lane config", () => {
  const html = renderPanel();

  it("renders one card per startable workflow", () => {
    expect(html.match(/class="lane-card"/g) ?? []).toHaveLength(RUNNABLE_WORKFLOWS.length);
  });

  it("names every lane the console can start", () => {
    for (const workflow of RUNNABLE_WORKFLOWS) {
      expect(html).toContain(`<h4>${workflow.label}</h4>`);
    }
  });

  it("drops the lanes this board no longer runs", () => {
    for (const stale of ["Support", "Coding", "Finance", "Vendor Onboarding", "SOC Alert Triage"]) {
      expect(html).not.toContain(`<h4>${stale}</h4>`);
    }
    expect(html).not.toContain("Retrieval, draft, validation");
    expect(html).not.toContain("Reconcile, exceptions");
  });
});
