// One-off e2e: create a Jira enhancement ticket, then start a codingFlow run
// against the allowlisted repo with the ticket as input. Prints the ticket
// key and the run id. Never prints tokens.
import { readFileSync } from "node:fs";

function envValue(name) {
  return readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
}

const JIRA_BASE = envValue("JIRA_BASE_URL");
const JIRA_EMAIL = envValue("JIRA_EMAIL");
const JIRA_TOKEN = envValue("JIRA_API_TOKEN");
const GH_TOKEN = envValue("GITHUB_TOKEN");
const TENANT = "omnidewalt";
const REPO = "YaHuy1525/AllRounderAgents";

const SUMMARY =
  "Enhance ticket JSON schema with optional tenantId for multi-tenant routing";
const PROBLEM = [
  `Project enhancement for repository ${REPO}.`,
  "",
  `File: contracts/jsonschema/ticket.schema.json (JSON Schema draft-07, title \"Ticket\").`,
  "",
  "Context: the backend is multi-tenant - Jira tenants are mapped to project keys in a tenant allowlist (for example omnidewalt maps to SCRUM) - but the ticket schema has no field to carry the tenant identifier, so downstream coding runs cannot bind a ticket to its tenant from the payload alone.",
  "",
  "Requested change (keep it the smallest that satisfies this):",
  "- Add a new optional root property named tenantId of type string with minLength 1 and title \"Tenantid\".",
  "- Place it inside the existing \"properties\" object; do not reorder or alter any other property.",
  "- Do NOT add tenantId to the root \"required\" array and do NOT change \"additionalProperties\": false.",
  "",
  "Do not touch any other file.",
].join("\n");

const ADF_DESCRIPTION = {
  type: "doc",
  version: 1,
  content: PROBLEM.split("\n").map((line) => ({
    type: "paragraph",
    content: [{ type: "text", text: line === "" ? " " : line }],
  })),
};

const basic = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");
const jiraResponse = await fetch(`${JIRA_BASE}/rest/api/3/issue`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${basic}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    fields: {
      project: { key: "SCRUM" },
      summary: SUMMARY,
      issuetype: { name: "Task" },
      labels: ["enhancement", "codingflow-e2e"],
      description: ADF_DESCRIPTION,
    },
  }),
});
const jiraBody = await jiraResponse.json();
if (!jiraResponse.ok) {
  console.error(`Jira create failed ${jiraResponse.status}:`, JSON.stringify(jiraBody));
  process.exit(1);
}
const ticketKey = jiraBody.key;
console.log(`ticket: ${ticketKey} -> ${JIRA_BASE}/browse/${ticketKey}`);

// Fresh sourceSha from the remote default branch.
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GH_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};
const branch = await fetch(`https://api.github.com/repos/${REPO}/branches/main`, {
  headers,
}).then((r) => r.json());
const sourceSha = branch.commit.sha;

const trigger = {
  runId: `run-${ticketKey.toLowerCase()}-001`,
  tenantId: TENANT,
  ticketKey,
  owner: "YaHuy1525",
  repo: "AllRounderAgents",
  baseBranch: "main",
  sourceSha,
  branch: `codex/${ticketKey.toLowerCase()}-tenant-schema`,
  problem: PROBLEM,
  approvedDestructivePaths: [],
};

console.log(`sourceSha: ${sourceSha}`);
const start = await fetch(
  `http://localhost:4111/api/workflows/codingFlow/start-async?runId=${encodeURIComponent(trigger.runId)}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputData: trigger }),
    signal: AbortSignal.timeout(60_000),
  },
);
const startBody = await start.json();
if (!start.ok) {
  console.error(`codingFlow start failed ${start.status}:`, JSON.stringify(startBody));
  process.exit(1);
}
console.log(`run: ${JSON.stringify(startBody)}`);
