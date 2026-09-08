// One-off: list repositories accessible to the GITHUB_TOKEN in .env so the
// GITHUB_REPOSITORY_ALLOWLIST can be filled with real values. Prints only
// repo names — never the token.
import { readFileSync } from "node:fs";

const env = readFileSync(".env", "utf8");
const line = env
  .split(/\r?\n/)
  .find((l) => l.startsWith("GITHUB_TOKEN="));
const token = line?.slice("GITHUB_TOKEN=".length).trim();
if (!token) {
  console.error("GITHUB_TOKEN not set in .env");
  process.exit(1);
}

const response = await fetch(
  "https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member",
  {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  },
);
if (!response.ok) {
  console.error(`GitHub responded ${response.status}`);
  process.exit(1);
}
const repos = await response.json();
for (const repo of repos) {
  const perms = repo.permissions ?? {};
  console.log(
    `${repo.full_name} private=${repo.private} default=${repo.default_branch} push=${perms.push}`,
  );
}
