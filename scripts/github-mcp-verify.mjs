#!/usr/bin/env node
/**
 * Connectivity + tool-surface check for the GitHub MCP backend.
 *
 * Connects to the hosted GitHub MCP server (GITHUB_MCP_URL, default
 * https://api.githubcopilot.com/mcp/) with the bearer PAT from GITHUB_MCP_TOKEN
 * (falling back to GITHUB_TOKEN, then .env), lists the exposed tools and
 * asserts the five tools the coding agent requires are present.
 *
 * The hosted server does not support OAuth dynamic client registration, so
 * this bearer-PAT header is the documented auth mode for non-first-party
 * hosts (see github/github-mcp-server remote-server docs).
 *
 * Usage: node scripts/github-mcp-verify.mjs
 */
import { readFileSync } from "node:fs";

const SERVER_URL = process.env.GITHUB_MCP_URL || "https://api.githubcopilot.com/mcp/";
const REQUIRED = [
  "get_commit",
  "get_file_contents",
  "push_files",
  "create_pull_request",
  "list_pull_requests",
];

function envOrDotEnv(name) {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  try {
    return readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim();
  } catch {
    return undefined;
  }
}

async function post(headers, body) {
  const res = await fetch(SERVER_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await res.text();
  let payload = raw;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const events = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    payload = events[events.length - 1] ?? "";
  }
  return { res, payload };
}

const token = envOrDotEnv("GITHUB_MCP_TOKEN") ?? envOrDotEnv("GITHUB_TOKEN");
if (!token) {
  console.error(
    "github-mcp-verify: no token found. Set GITHUB_MCP_TOKEN (or GITHUB_TOKEN) to a",
    "classic repo-scope PAT or a fine-grained token with Contents and Pull",
    "requests read/write.",
  );
  process.exitCode = 1;
} else {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  const { res, payload } = await post(headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "github-mcp-verify", version: "0.1.0" },
    },
  });
  if (!res.ok) {
    console.error(`github-mcp-verify: server responded ${res.status}: ${payload.slice(0, 300)}`);
    process.exitCode = 1;
  } else {
    const sessionId = res.headers.get("mcp-session-id");
    const listHeaders = sessionId ? { ...headers, "mcp-session-id": sessionId } : headers;
    const list = await post(listHeaders, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const result = JSON.parse(list.payload).result ?? {};
    const tools = (result.tools ?? []).map((tool) => tool.name);
    const missing = REQUIRED.filter((name) => !tools.includes(name));
    console.log(`Connected to ${SERVER_URL} (${tools.length} tools exposed).`);
    if (missing.length > 0) {
      console.error(`Missing required tools: ${missing.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("All required coding-agent tools are available.");
    }
    if (sessionId) {
      await fetch(SERVER_URL, {
        method: "DELETE",
        headers: listHeaders,
      }).catch(() => {});
    }
  }
}
