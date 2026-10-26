import { describe, expect, it } from "vitest";

import {
  CONNECTOR_CHANNELS,
  connectedProviders,
  resolveStepProviders,
  type ConnectorStatus,
} from "@/lib/connectors";
import { isIntegrationProvider } from "@/lib/integrations";

function status(provider: string, connected: boolean): ConnectorStatus {
  return {
    provider,
    description: "",
    scope: "reviewed-scope",
    class: "approval",
    connected,
    secretHint: connected ? "\u2026abcd" : "",
    connectedAt: connected ? "2026-10-10T00:00:00+00:00" : null,
  };
}

describe("connector channels", () => {
  it("pins the channel map to the reviewed catalog", () => {
    expect(CONNECTOR_CHANNELS).toEqual({
      github: ["github"],
      jira: ["jira"],
      gmail: ["email"],
      calendar: ["calendar"],
      slack: ["slack"],
    });
  });

  it("uses only ids the integration registry can render", () => {
    for (const [connector, channels] of Object.entries(CONNECTOR_CHANNELS)) {
      expect(isIntegrationProvider(connector)).toBe(true);
      for (const channel of channels) {
        expect(isIntegrationProvider(channel)).toBe(true);
      }
    }
  });
});

describe("connectedProviders", () => {
  it("lists connected providers in catalog order", () => {
    expect(
      connectedProviders([status("github", false), status("jira", true), status("gmail", true)]),
    ).toEqual(["jira", "gmail"]);
    expect(connectedProviders([])).toEqual([]);
  });
});

describe("resolveStepProviders", () => {
  it("keeps declared providers while nothing is connected", () => {
    expect(resolveStepProviders(["email", "github"], [])).toEqual(["email", "github"]);
  });

  it("swaps the generic email glyph for connected gmail", () => {
    // hr-help:send declares `email`; a connected Gmail badges it.
    expect(resolveStepProviders(["email"], ["gmail"])).toEqual(["gmail"]);
    // Unrelated channels on the same step keep their declared ids.
    expect(resolveStepProviders(["email", "kb"], ["gmail"])).toEqual(["gmail", "kb"]);
  });

  it("reverts the overlay the moment the connector disconnects", () => {
    expect(resolveStepProviders(["email"], ["gmail"])).toEqual(["gmail"]);
    expect(resolveStepProviders(["email"], [])).toEqual(["email"]);
  });

  it("keeps declared order and is idempotent for native channels", () => {
    expect(resolveStepProviders(["okta", "email", "aws"], ["gmail"])).toEqual([
      "okta",
      "gmail",
      "aws",
    ]);
    expect(resolveStepProviders(["github"], ["github"])).toEqual(["github"]);
  });

  it("leaves channels no connected connector backs untouched", () => {
    expect(resolveStepProviders(["web"], ["gmail", "calendar"])).toEqual(["web"]);
    expect(resolveStepProviders(["email"], ["calendar"])).toEqual(["email"]);
  });

  it("resolves each declared channel against its own connector", () => {
    expect(resolveStepProviders(["email", "calendar"], ["gmail", "calendar"])).toEqual([
      "gmail",
      "calendar",
    ]);
    expect(resolveStepProviders(["email", "calendar"], ["gmail"])).toEqual([
      "gmail",
      "calendar",
    ]);
  });
});
