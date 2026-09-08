export const AGENT_DOMAINS = [
  "dispatcher",
  "programming",
  "finance",
  "marketing",
  "support",
] as const;

export type AgentDomain = (typeof AGENT_DOMAINS)[number];

export * from "./dispatcher/index.js";
export * from "./programming/index.js";
export * from "./finance/index.js";
export * from "./marketing/index.js";
export * from "./support/index.js";
export * from "./registry.js";
export * from "./script.js";
