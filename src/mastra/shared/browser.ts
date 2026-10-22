import { AgentBrowser } from "@mastra/agent-browser";

/**
 * Optional Playwright-backed browser for the coding lane, mirroring the
 * degrade-don't-break posture of {@link webSearchTool}.
 *
 * Mastra attaches a provider's browser tools to an agent through its `browser`
 * config. The browser object itself is cheap to construct; the underlying
 * Chromium only launches on the first tool call, so wiring costs nothing until
 * a run actually drives it. To keep the default test and Docker run free of the
 * Playwright browser binaries, {@link codingBrowser} returns `undefined` unless
 * `AGENT_BROWSER_ENABLED=true`, and the agent only receives the `browser` key
 * when a browser is present.
 *
 * When enabled, the container or host must already have the Playwright browser
 * installed (`npx playwright install chromium` plus OS deps). Screencast is left
 * off, which avoids the `ws` and `@hono/node-ws` peer packages entirely.
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
