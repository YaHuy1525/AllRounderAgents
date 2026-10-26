import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConnectorList,
  type ConnectorListProps,
} from "@/components/console/ConnectionsSection";
import type { ConnectorStatus } from "@/lib/connectors";

function makeConnector(overrides: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    provider: "gmail",
    description: "Sends the HR help desk reply behind the hr-help:send receipt.",
    scope: "hr-help:send",
    class: "approval",
    connected: false,
    secretHint: "",
    connectedAt: null,
    ...overrides,
  };
}

const CATALOG = [
  makeConnector({
    provider: "github",
    description: "Repository reads and pull-request actions for the coding lanes.",
    scope: "repo-allowlist",
    class: "read-only",
  }),
  makeConnector({
    connected: true,
    secretHint: "\u2026abcd",
    connectedAt: "2026-10-10T00:00:00+00:00",
  }),
];

function renderList(overrides: Partial<ConnectorListProps> = {}): string {
  const props: ConnectorListProps = {
    connectors: CATALOG,
    loadFailed: false,
    canManage: true,
    formProvider: null,
    secret: "",
    busy: false,
    onSecretChange: () => {},
    onOpenForm: () => {},
    onCloseForm: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    ...overrides,
  };
  return renderToString(<ConnectorList {...props} />);
}

describe("connector list", () => {
  it("renders the catalog with per-tenant status", () => {
    const html = renderList();
    expect(html).toContain("GitHub");
    expect(html).toContain("Gmail");
    expect(html).toContain("Repository reads and pull-request actions");
    expect(html).toContain("repo-allowlist");
    expect(html).toContain("read-only");
    expect(html).toContain("hr-help:send");
    expect(html).toContain("approval");
    expect(html).toContain("Connected");
    expect(html).toContain("\u2026abcd");
    // Disconnected providers offer Connect; connected ones replace/disconnect.
    expect(html).toContain("Connect</button>");
    expect(html).toContain("Replace credential");
    expect(html).toContain("Disconnect");
  });

  it("badges only the connected providers", () => {
    const html = renderList();
    expect((html.match(/>Connected</g) ?? []).length).toBe(1);
  });

  it("disables every control without the agent role and explains why", () => {
    const html = renderList({ canManage: false });
    expect(html).toContain("agent or admin role");
    expect((html.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("opens the credential form for the picked provider only", () => {
    const html = renderList({ formProvider: "gmail" });
    expect(html).toContain("New Gmail credential");
    expect(html).toContain('type="password"');
    expect(html).toContain("Save credential");
    expect(html).toContain("Cancel");
    expect(renderList()).not.toContain('type="password"');
  });

  it("labels a first-connect form with the plain credential title", () => {
    const html = renderList({ formProvider: "github" });
    expect(html).toContain("<span>GitHub credential</span>");
  });

  it("shows the loading placeholder until the catalog resolves", () => {
    const html = renderList({ connectors: null });
    expect(html).toContain("Loading connections");
    expect(html).not.toContain("<ul");
  });

  it("lands on a plain message for a bare or failed catalog", () => {
    expect(renderList({ connectors: [], loadFailed: true })).toContain(
      "Connections are unavailable right now.",
    );
    expect(renderList({ connectors: [] })).toContain("No connectable providers");
  });

  it("locks the open form while a save is in flight", () => {
    const html = renderList({ formProvider: "gmail", secret: "abcdefgh", busy: true });
    expect(html).toContain("Saving");
    expect(html).not.toContain("Save credential");
    expect(html).toContain("disabled");
  });
});
