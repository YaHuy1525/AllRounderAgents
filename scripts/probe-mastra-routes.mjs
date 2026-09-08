// One-off probe: list workflow-triggering REST routes registered by the
// deployed Mastra dev server bundle so we know the manual trigger endpoint.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "node_modules/@mastra/deployer/dist";
const patterns = [
  /\/api\/workflows[^"'`\s\\]{0,60}/g,
  /workflows\/:workflowId[^"'`\s\\]{0,60}/g,
  /\/api\/workflows\/:[^"'`\s\\]{0,60}/g,
];

const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".js"));
const found = new Set();
for (const file of files) {
  const text = readFileSync(join(dir, String(file)), "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      found.add(match[0]);
    }
  }
}
console.log([...found].slice(0, 40).join("\n") || "no workflow routes found");
