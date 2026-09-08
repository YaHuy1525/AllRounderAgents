/**
 * Classic Mastra entrypoint for Studio / `mastra dev`.
 * The full agent/workflow implementation lives beside this file in
 * `agents/` (lane folders) and `shared/`; this file only exports the
 * assembled instance built in `instance.ts`.
 */
export { mastra } from "./instance.js";
