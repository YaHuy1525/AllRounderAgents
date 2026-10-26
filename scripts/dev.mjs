// Local dev launcher with two named groups, Docker-free by default:
//
//   npm run dev:backend    FastAPI (api) + Mastra agent plane (mastra)
//   npm run dev:frontend   approval UI (next dev)
//   npm run dev            all three in one terminal
//
// Each server runs in reload mode, so a save applies with no Docker rebuild.
// Node built-ins only: no new dependency, so this file never changes
// package-lock.json or the container build inputs.
//
// The API needs a backend for run state: this script probes Redis on the
// REDIS_URL host:port and, when nothing answers, launches the API with
// RUNS_BACKEND=memory so the whole stack runs with no containers at all.
// Start Redis (for example: docker compose up -d redis) before running this
// script to get the shared Redis backend instead.
//
// If a Mastra host for this project already answers on its port (a separate
// `npm run dev:mastra` terminal or the Compose stack), `dev` and `dev:backend`
// reuse it and skip starting a second one. A host that answers but is not this
// project's does not count as reuse; see mastraHostRole below.
//
// The API needs its Python environment. If a local venv exists, this script
// uses its interpreter directly; otherwise it falls back to a `python` already
// on PATH (activate the venv in that case).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";

const onWindows = process.platform === "win32";
const reset = "\x1b[0m";

// Group selection: npm run dev -- backend | frontend (default: everything).
const groupArg = (process.argv[2] ?? "all").toLowerCase();
const validGroups = ["backend", "frontend", "all"];
if (!validGroups.includes(groupArg)) {
  process.stderr.write(`unknown group "${groupArg}" (expected: ${validGroups.join(" | ")})\n`);
  process.exit(1);
}

// Prefer a project-local venv, matching the README setup (python -m venv .venv).
const venvPython = onWindows
  ? join(process.cwd(), ".venv", "Scripts", "python.exe")
  : join(process.cwd(), ".venv", "bin", "python");
const python = existsSync(venvPython) ? venvPython : "python";

// TCP connect probe with a short timeout: answers "is a server listening" on a
// host:port without any protocol traffic, which is enough for the Redis
// backend choice and the already-running-Mastra detection.
function parseRedisTarget(url) {
  const match = /^rediss?:\/\/([^/:]+)(?::(\d+))?/i.exec(url || "");
  if (!match) return { host: "localhost", port: 6379 };
  return { host: match[2], port: Number(match[3] ?? 6379) };
}

function portIsReachable(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(750);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

const redisTarget = parseRedisTarget(process.env.REDIS_URL);
const MASTRA_PORT = Number(process.env.MASTRA_PORT ?? 4111);

// An open port is not proof it is our host. Another project's dev server on
// 4111 passed the plain TCP probe below, so this launcher reused an app with no
// console-assistant agent, and the chat failed a long way from the reason. Ask
// the responder who it is, and move to the next free port when it is somebody
// else. A 401 or 403 counts as ours: the agent list is auth-protected.
async function mastraHostRole(port) {
  if (!(await portIsReachable("localhost", port))) return "free";
  try {
    const response = await fetch(`http://localhost:${port}/api/agents`, {
      signal: AbortSignal.timeout(1500),
    });
    if (response.status === 401 || response.status === 403) return "ours";
    return (await response.text()).includes("console-assistant") ? "ours" : "foreign";
  } catch {
    return "foreign";
  }
}

async function firstFreePort(start, span) {
  for (let candidate = start; candidate <= start + span; candidate += 1) {
    if (!(await portIsReachable("localhost", candidate))) return candidate;
  }
  return null;
}

const preferredRole = await mastraHostRole(MASTRA_PORT);
let mastraPort = MASTRA_PORT;
let reuseMastra = preferredRole === "ours";
if (preferredRole === "foreign") {
  const alternate = await firstFreePort(MASTRA_PORT + 1, 20);
  if (alternate !== null) mastraPort = alternate;
}

// Environment for the API child. Two host-development corrections layered on
// top of .env (pydantic-settings lets the process environment win over the
// file, so these two keys intentionally shadow .env unless exported elsewhere):
// 1. .env carries MASTRA_BASE_URL=http://host.docker.internal:4111 for a
//    containerised API. That name does not resolve on the host, so a host-run
//    API reaches the Mastra dev host over loopback instead.
// 2. RUNS_BACKEND: redis keeps the shared multi-process run state; when no
//    Redis server answers, the memory backend runs the whole API in-process
//    with no containers. Terminal runs still archive to Postgres, so run
//    history survives a reload.
const redisReachable = await portIsReachable(redisTarget.host, redisTarget.port);
const mastraOrigin = `http://localhost:${mastraPort}`;
const apiEnv = {
  ...process.env,
  MASTRA_BASE_URL: process.env.MASTRA_BASE_URL ?? mastraOrigin,
  ...(process.env.RUNS_BACKEND
    ? {}
    : { RUNS_BACKEND: redisReachable ? "redis" : "memory" }),
};
// The browser talks to the Mastra host directly, so it has to be told the same
// resolved origin. next.config.ts defaults to 4111, which is wrong whenever
// this launcher had to step off that port.
const uiEnv = {
  ...process.env,
  NEXT_PUBLIC_MASTRA_URL: process.env.NEXT_PUBLIC_MASTRA_URL ?? mastraOrigin,
};

// Each entry: label, group membership, the URL to print, the executable and
// its arguments. `--reload` on uvicorn, `next dev` and `mastra dev` all watch
// their source trees and restart on changes.
const services = [
  {
    name: "api",
    group: "backend",
    color: "\x1b[36m",
    port: 8000,
    command: python,
    env: apiEnv,
    args: [
      "-m",
      "uvicorn",
      "allrounder_api.production:create_production_app",
      "--factory",
      "--app-dir",
      "apps/api/src",
      "--reload",
      "--reload-dir",
      "apps/api/src",
    ],
  },
  {
    name: "mastra",
    group: "backend",
    color: "\x1b[35m",
    port: mastraPort,
    // mastra dev reads PORT (its own default is 4111), so the resolved port
    // travels to the child instead of being a printed suggestion only.
    env: { ...process.env, PORT: String(mastraPort) },
    // npm is a .cmd shim on Windows, which spawn() rejects unless it runs
    // through a shell, so every service is launched with shell: true below.
    command: "npm",
    args: ["run", "dev:mastra"],
    skipIfPortUp: reuseMastra,
  },
  {
    name: "ui",
    group: "frontend",
    color: "\x1b[32m",
    port: 5173,
    env: uiEnv,
    command: "npm",
    args: ["run", "dev", "-w", "@allrounder/approval-ui"],
  },
];

const selected = services.filter(
  (service) => groupArg === "all" || service.group === groupArg,
);

if (preferredRole === "foreign") {
  process.stdout.write(
    `\x1b[33mnote\x1b[0m http://localhost:${MASTRA_PORT} answers, but it is not this project's Mastra host (no console-assistant agent). ` +
      (mastraPort === MASTRA_PORT
        ? "No free port was found nearby, so the host will fail to bind. Stop that server or set MASTRA_PORT.\n"
        : `Binding this project's host to http://localhost:${mastraPort} and pointing the API and UI there.\n`),
  );
}

const children = [];
const started = [];

for (const service of selected) {
  if (service.skipIfPortUp) {
    process.stdout.write(
      `${service.color}skip${reset} ${service.name} (a host already answers on http://localhost:${service.port}, reusing it)\n`,
    );
    continue;
  }
  const child = spawn(service.command, service.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: service.env ?? process.env,
    shell: true,
  });
  children.push(child);
  started.push(service.name);

  child.on("exit", (code) => {
    // If one server dies, bring the siblings down too so a partial stack never lingers.
    for (const sibling of children) {
      if (sibling !== child && sibling.exitCode === null) sibling.kill("SIGINT");
    }
    process.exitCode = code ?? 1;
  });

  child.on("error", (error) => {
    const hint =
      service.name === "api"
        ? "Is the Python environment set up? Create it with `python -m venv .venv`, activate it, then run `python -m pip install -e \".[dev]\"`."
        : "Is Node 22 and the workspace installed? Run `npm install` from the repository root.";
    process.stdout.write(`${service.color}[${service.name}]${reset} failed to start: ${error.message}\n${hint}\n`);
    shutdown();
  });

  process.stdout.write(
    `${service.color}start${reset} ${service.name} (http://localhost:${service.port})\n`,
  );
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill(onWindows ? undefined : "SIGINT");
  }
}

process.stdout.write(
  started.length > 1
    ? `\nCtrl+C stops ${started.join(" + ")}.\n`
    : "\nCtrl+C stops this group. Run the other group separately (npm run dev:backend / npm run dev:frontend).\n",
);
if (selected.some((service) => service.name === "api")) {
  if (apiEnv.RUNS_BACKEND === "memory") {
    process.stdout.write(
      `\x1b[33mnote\x1b[0m Redis not found at ${redisTarget.host}:${redisTarget.port}. ` +
        "API started with RUNS_BACKEND=memory (single-process run state, no Docker needed).\n",
    );
  } else {
    process.stdout.write(
      `\x1b[36mnote\x1b[0m runs backend: ${apiEnv.RUNS_BACKEND ?? "redis"} ` +
        `(Redis reachable at ${redisTarget.host}:${redisTarget.port}).\n`,
    );
  }
}
