// One-command local dev for the two services you edit most: the FastAPI
// backend and the approval UI. Both run in reload mode, so a save applies with
// no Docker rebuild. Node built-ins only: no new dependency, so this file never
// changes package-lock.json or the container build inputs.
//
// Run it from the repository root with:  npm run dev
// Redis (and, if you want it, Mastra) stay in Docker:  docker compose up -d redis mastra
//
// The API needs its Python environment. If a local venv exists, this script
// uses its interpreter directly; otherwise it falls back to a `python` already
// on PATH (activate the venv in that case).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const onWindows = process.platform === "win32";
const reset = "\x1b[0m";

// Prefer a project-local venv, matching the README setup (python -m venv .venv).
const venvPython = onWindows
  ? join(process.cwd(), ".venv", "Scripts", "python.exe")
  : join(process.cwd(), ".venv", "bin", "python");
const python = existsSync(venvPython) ? venvPython : "python";

// Each entry: a short label, the executable, and its arguments. `--reload` on
// uvicorn and `next dev` both watch their source trees and restart on changes.
const services = [
  {
    name: "api",
    color: "\x1b[36m",
    command: python,
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
    name: "ui",
    color: "\x1b[32m",
    // npm is a .cmd shim on Windows, which spawn() rejects unless it runs
    // through a shell, so every service is launched with shell: true below.
    command: "npm",
    args: ["run", "dev", "-w", "@allrounder/approval-ui"],
  },
];

const children = [];

for (const service of services) {
  const child = spawn(service.command, service.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
    shell: true,
  });
  children.push(child);

  child.on("exit", (code) => {
    // If one server dies, bring the other down too so a partial stack never lingers.
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
    `${service.color}start${reset} ${service.name} (http://localhost:${service.name === "api" ? "8000" : "5173"})\n`,
  );
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill(onWindows ? undefined : "SIGINT");
  }
}

process.stdout.write("\nCtrl+C stops both. Redis/Mastra containers keep running separately.\n");
