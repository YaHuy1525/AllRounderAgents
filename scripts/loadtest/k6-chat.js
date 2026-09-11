// k6 load test for the chat surface (/chat and /chat/stream).
//
// Usage (repo root, API running):
//   k6 run -e AUTH_TOKEN="$TOKEN" scripts/loadtest/k6-chat.js
//
// Env knobs:
//   BASE_URL   target origin            (default http://localhost:8000)
//   AUTH_TOKEN Supabase access token    (required; bearer JWT)
//   VUS        virtual users            (default 5)
//   DURATION   test duration            (default 30s)
//   FLOW       chat | stream | mixed    (default chat; mixed streams every 3rd iteration)
//   PACE_MS    pause between iterations (default 0)
//
// HTTP 429 rate-limit responses are expected and validated (Retry-After header)
// instead of counted as failures, so http_req_failed only tracks real errors.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:8000").replace(/\/$/, "");
const TOKEN = __ENV.AUTH_TOKEN;
const FLOW = (__ENV.FLOW || "chat").toLowerCase();
const PACE_MS = Number(__ENV.PACE_MS || 0);

if (!TOKEN) {
  throw new Error("AUTH_TOKEN is required: k6 run -e AUTH_TOKEN=<supabase access token> ...");
}
if (!["chat", "stream", "mixed"].includes(FLOW)) {
  throw new Error(`FLOW must be chat|stream|mixed, got: ${FLOW}`);
}

const rateLimited = new Counter("rate_limited_total");
const chatSource = new Counter("chat_source_total");

const thresholds = {
  http_req_failed: ["rate<0.05"],
  checks: ["rate>0.99"],
};
if (FLOW !== "stream") {
  thresholds["http_req_duration{kind:chat}"] = ["p(95)<2000"];
}
if (FLOW !== "chat") {
  thresholds["http_req_duration{kind:stream}"] = ["p(95)<8000"];
}

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || "30s",
  thresholds,
};

const TICKETS = [
  {
    key: "ENG-201",
    summary: "API returns 500 stack trace",
    status: "To Do",
    issueType: "Bug",
    priority: "High",
    assignee: null,
    labels: ["backend"],
  },
  {
    key: "FIN-201",
    summary: "Reconcile month-end ledger",
    status: "In Progress",
    issueType: "Task",
    priority: "Highest",
    assignee: "finance-bot",
    labels: ["reconciliation"],
  },
  {
    key: "SUP-401",
    summary: "Customer cannot log in",
    status: "Open",
    issueType: "Service Request",
    priority: "High",
    assignee: null,
    labels: ["customer"],
  },
];

const MESSAGES = [
  "What is blocking ENG-201?",
  "Summarize the month-end reconciliation status.",
  "Which tickets need human review right now?",
  "Draft a reply to the customer about their login issue.",
  "How many tickets are open per lane?",
  "What is the highest priority ticket on the board?",
];

function chatPayload() {
  return JSON.stringify({
    message: MESSAGES[__ITER % MESSAGES.length],
    selectedKey: TICKETS[__ITER % TICKETS.length].key,
    tickets: TICKETS,
  });
}

function requestParams(kind, accept, timeout) {
  return {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: accept,
    },
    tags: { kind },
    timeout: timeout || "10s",
    responseCallback: http.expectedStatuses(200, 429),
  };
}

function noteRateLimit(response) {
  rateLimited.add(1);
  const retryAfter = response.headers["Retry-After"] || response.headers["retry-after"] || "";
  check(response, {
    "429 carries Retry-After seconds": () => /^\d+$/.test(String(retryAfter).trim()),
  });
}

function chatRequest() {
  const response = http.post(
    `${BASE_URL}/chat`,
    chatPayload(),
    requestParams("chat", "application/json"),
  );
  if (response.status === 429) {
    noteRateLimit(response);
    return;
  }
  let body = null;
  try {
    body = response.json();
  } catch (error) {
    body = null;
  }
  check(response, {
    "chat status is 200": (r) => r.status === 200,
    "chat reply is non-empty": () => Boolean(body && body.reply),
    "chat source is known": () => Boolean(body && ["model", "local"].includes(body.source)),
  });
  if (body && body.source) {
    chatSource.add(1, { source: body.source });
  }
}

function streamRequest() {
  const response = http.post(
    `${BASE_URL}/chat/stream`,
    chatPayload(),
    requestParams("stream", "text/event-stream", "30s"),
  );
  if (response.status === 429) {
    noteRateLimit(response);
    return;
  }
  check(response, {
    "stream status is 200": (r) => r.status === 200,
    "stream ends with done event": (r) =>
      typeof r.body === "string" && r.body.includes('"done": true'),
    "stream disables proxy buffering": (r) =>
      r.headers["X-Accel-Buffering"] === "no" || r.headers["x-accel-buffering"] === "no",
  });
}

export default function () {
  if (FLOW === "stream" || (FLOW === "mixed" && __ITER % 3 === 2)) {
    streamRequest();
  } else {
    chatRequest();
  }
  if (PACE_MS > 0) {
    sleep(PACE_MS / 1000);
  }
}
