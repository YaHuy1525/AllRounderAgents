import { afterEach, describe, expect, it } from "vitest";

import { browserEnabled, codingBrowser } from "../browser.js";

/**
 * The browser must stay opt-in so the default test and Docker run never depend on
 * the Playwright binaries. These assertions cover the gate only; they never
 * enable the flag around codingBrowser(), so no browser object is constructed.
 */

const original = process.env.AGENT_BROWSER_ENABLED;

afterEach(() => {
  if (original === undefined) {
    delete process.env.AGENT_BROWSER_ENABLED;
  } else {
    process.env.AGENT_BROWSER_ENABLED = original;
  }
});

describe("coding browser gate", () => {
  it("is off and yields no browser when the flag is unset", () => {
    delete process.env.AGENT_BROWSER_ENABLED;
    expect(browserEnabled()).toBe(false);
    expect(codingBrowser()).toBeUndefined();
  });

  it("treats any value other than true as disabled", () => {
    for (const value of ["", "1", "TRUE", "yes"]) {
      process.env.AGENT_BROWSER_ENABLED = value;
      expect(browserEnabled()).toBe(false);
    }
  });

  it("reports enabled only for the exact true string", () => {
    process.env.AGENT_BROWSER_ENABLED = "true";
    expect(browserEnabled()).toBe(true);
  });
});
