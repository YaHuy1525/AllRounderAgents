import { AgentBrowser } from "@mastra/agent-browser";

/**
 * Optional Playwright-backed browser for the coding lane. Returns `undefined`
 * unless `AGENT_BROWSER_ENABLED=true`, so tests and the Docker image need no
 * browser binaries. When enabled, the host or container must already have
 * Chromium installed.
 */

let cached: AgentBrowser | undefined;
let initialized = false;

/** True when the operator opted the coding lane into the browser tools. */
export function browserEnabled(): boolean {
  return process.env.AGENT_BROWSER_ENABLED === "true";
}

/**
 * The shared headless browser for coding agents, or `undefined` when the
 * feature is not enabled. Memoized so every enabled agent reuses one provider;
 * the provider keeps per-thread sessions internally.
 */
export function codingBrowser(): AgentBrowser | undefined {
  if (!browserEnabled()) {
    return undefined;
  }
  if (initialized) {
    return cached;
  }
  initialized = true;
  // Headless by default; opt out locally with AGENT_BROWSER_HEADLESS=false to
  // watch the browser drive pages.
  const headless = process.env.AGENT_BROWSER_HEADLESS !== "false";
  cached = new AgentBrowser({ headless });
  console.info(`[mastra] coding browser ON: AgentBrowser headless=${headless}`);
  return cached;
}
