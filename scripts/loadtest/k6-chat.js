// k6 load test for the console assistant on the Mastra host.
//
// Usage (repo root, host running):
//   k6 run -e AUTH_TOKEN="$TOKEN" scripts/loadtest/k6-chat.js
//
// Env knobs:
//   BASE_URL   host origin              (default http://localhost:4111)
//   AUTH_TOKEN Supabase access token    (required; the host derives tenant from it)
//   AGENT_ID   agent id on the host     (default console-assistant)
//   VUS / DURATION / FLOW / PACE_MS as before
//
// The host enforces no rate limit, so 429 handling is gone. A non-200 is a real failure.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:4111").replace(/\/$/, "");
const AGENT_ID = __ENV.AGENT_ID || "console-assistant";
const TOKEN = __ENV.AUTH_TOKEN;
const FLOW = (__ENV.FLOW || "generate").toLowerCase();
const PACE_MS = Number(__ENV.PACE_MS || 0);

if (!TOKEN) {
  throw new Error("AUTH_TOKEN is required: k6 run -e AUTH_TOKEN=<supabase access token> ...");
}
if (!["generate", "stream", "mixed"].includes(FLOW)) {
  throw new Error(`FLOW must be generate|stream|mixed, got: ${FLOW}`);
}

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || "30s",
  thresholds:
    FLOW === "generate"
      ? { http_req_failed: ["rate<0.05"], checks: ["rate>0.99"], "http_req_duration{kind:generate}": ["p(95)<20000"] }
      : FLOW === "stream"
        ? { http_req_failed: ["rate<0.05"], checks: ["rate>0.99"], "http_req_duration{kind:stream}": ["p(95)<60000"] }
        : { http_req_failed: ["rate<0.05"], checks: ["rate>0.99"] },
};

const MESSAGES = [
  "Which tickets look stuck right now?",
  "Summarize what is assigned to me.",
  "What is high priority and still open?",
  "List the tickets mentioning reconciliation.",
];

// The host overwrites the resource from the verified token, so this value is a
// probe of that override: a resource that is not the caller's must not change
// what comes back.
function body() {
  return JSON.stringify({
    messages: [{ role: "user", content: MESSAGES[__ITER % MESSAGES.length] }],
    memory: { thread: `loadtest-${__ITER % 5}`, resource: "loadtest:probe" },
  });
}

function params(kind, accept, timeout) {
  return {
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: accept },
    tags: { kind },
    timeout,
    responseCallback: http.expectedStatuses(200),
  };
}

function generateRequest() {
  const res = http.post(
    `${BASE_URL}/api/agents/${AGENT_ID}/generate`,
    body(),
    params("generate", "application/json", "60s"),
  );
  let text = null;
  try {
    text = res.json().text;
  } catch (error) {
    text = null;
  }
  check(res, {
    "generate status is 200": (r) => r.status === 200,
    "generate returned text": () => typeof text === "string" && text.length > 0,
  });
}

function streamRequest() {
  const res = http.post(
    `${BASE_URL}/api/agents/${AGENT_ID}/stream`,
    body(),
    params("stream", "application/json", "120s"),
  );
  check(res, {
    "stream status is 200": (r) => r.status === 200,
    "stream carried text deltas": (r) => typeof r.body === "string" && r.body.includes("text-delta"),
  });
}

export default function () {
  if (FLOW === "stream" || (FLOW === "mixed" && __ITER % 3 === 2)) {
    streamRequest();
  } else {
    generateRequest();
  }
  if (PACE_MS > 0) sleep(PACE_MS / 1000);
}
