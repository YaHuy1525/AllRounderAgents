import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QA_DEFAULT_MAX_STEP_MS,
  QA_TARGET_ACTIONS,
  isLoopbackUrl,
  remoteTargetsAllowed,
  resolveQaTarget,
} from "../../../../src/mastra/agents/qa/contracts.js";

/**
 * The target registry is the lane's blast-radius limit. These tests pin the two
 * refusals that keep it honest — an unknown key, and a URL that is not
 * localhost — because both are the kind of mistake an environment variable
 * makes silently and a prompt can never catch.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("qa target registry", () => {
  it("resolves the local console with its session, refuses and timeout", () => {
    const target = resolveQaTarget("local-console");
    expect(target).toEqual({
      key: "local-console",
      label: "Approval console (local)",
      baseUrl: "http://localhost:3000",
      apiBase: "http://localhost:8000",
      storageState: ".qa/auth/local-console.json",
      allowedActions: [...QA_TARGET_ACTIONS],
      denyActions: ["approve-run-receipt", "post-jira", "delete"],
      maxStepMs: QA_DEFAULT_MAX_STEP_MS,
    });
    expect(target.maxStepMs).toBe(30_000);
  });

  it("refuses an unknown key by name, listing what it does know", () => {
    expect(() => resolveQaTarget("prod")).toThrow('Unknown QA target "prod"');
    expect(() => resolveQaTarget("prod")).toThrow("known targets: local-console");
  });

  it("treats only loopback http(s) URLs as local", () => {
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isLoopbackUrl("https://localhost")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3000")).toBe(true);
    expect(isLoopbackUrl("https://console.example.com")).toBe(false);
    // A look-alike host is not loopback: the guard reads the parsed hostname,
    // so a prefix or suffix cannot smuggle a remote target in.
    expect(isLoopbackUrl("http://localhost.example.com")).toBe(false);
    expect(isLoopbackUrl("http://notlocalhost:3000")).toBe(false);
    // A driver URL is not a console.
    expect(isLoopbackUrl("file://localhost/etc/passwd")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  it("keeps remote targets off unless the operator opts in", () => {
    expect(remoteTargetsAllowed()).toBe(false);
    vi.stubEnv("QA_ALLOW_REMOTE_TARGET", "true");
    expect(remoteTargetsAllowed()).toBe(true);
    vi.stubEnv("QA_ALLOW_REMOTE_TARGET", "1");
    expect(remoteTargetsAllowed()).toBe(false);
  });
});
