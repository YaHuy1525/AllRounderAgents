/**
 * Live MCP proof (run manually, never in CI):
 *   node scripts/github-mcp-verify.mjs   (bearer-PAT connectivity check)
 *   $env:E2E_MCP_PR_PROOF="1"; npx vitest run src/mastra/agents/programming/pr-mcp-proof.test.ts
 * Drives the REAL writer through the MCP GitHub backend with a deterministic
 * patch (no LLM) against the allowlisted repo and asserts a Draft PR is
 * opened via the GitHub MCP server. The bearer PAT is read from .env
 * (GITHUB_MCP_TOKEN or GITHUB_TOKEN) and passed to the backend explicitly.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  GitHubRepositoryTools,
  type GitHubPolicy,
} from "./tools/github.js";
import { McpGitHubBackend } from "./tools/mcp.js";
import type { PatchFile } from "./contracts.js";

const ENABLED = process.env.E2E_MCP_PR_PROOF === "1";

function envValue(name: string): string | undefined {
  return readFileSync(new URL("../../../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
}

describe.skipIf(!ENABLED)("github writer mcp e2e proof", () => {
  it(
    "opens a Draft PR through the GitHub MCP backend",
    async () => {
      const token = envValue("GITHUB_MCP_TOKEN") ?? envValue("GITHUB_TOKEN");
      if (!token) throw new Error("GITHUB_MCP_TOKEN/GITHUB_TOKEN missing from .env");

      const policy: GitHubPolicy = {
        repositories: ["YaHuy1525/AllRounderAgents"],
        baseBranch: "main",
        allowPaths: ["contracts/**"],
        denyPaths: [],
        destructivePaths: ["migrations/**", "infra/**"],
        maxFiles: 10,
        maxPatchBytes: 250_000,
        timeoutMs: 15_000,
      };
      const tools = new GitHubRepositoryTools(
        new McpGitHubBackend({ token }),
        policy,
      );
      const { reader, writer } = tools;
      const owner = "YaHuy1525";
      const repo = "AllRounderAgents";
      const path = "contracts/jsonschema/ticket.schema.json";

      const sourceSha = await reader.sourceSha(owner, repo, "main");
      const original = await reader.content(owner, repo, path, sourceSha);
      const schema = JSON.parse(original.content) as {
        properties: Record<string, unknown>;
      };
      if (schema.properties["tenantId"] !== undefined) {
        throw new Error("tenantId already present on remote schema");
      }
      schema.properties["tenantId"] = {
        type: "string",
        minLength: 1,
        title: "Tenantid",
      };
      const content = `${JSON.stringify(schema, null, 2)}\n`;

      const files: PatchFile[] = [{ path, content, validators: ["json"] }];
      const evidence = [
        {
          path,
          startLine: 1,
          endLine: 115,
          excerpt: "Remote ticket schema (deterministic MCP proof)",
        },
      ];
      const branch = "codex/mcp-proof-tenant-schema";

      const manifest = writer.preflight(
        owner,
        repo,
        "main",
        branch,
        sourceSha,
        files,
        evidence,
        [],
      );
      const body = [
        "Deterministic MCP e2e proof for ticket SCRUM-10: adds an optional",
        "tenantId property to contracts/jsonschema/ticket.schema.json through",
        "the GitHub MCP backend (push_files + create_pull_request). No LLM.",
        "",
        `Patch hash: ${manifest.patchHash}`,
      ].join("\n");

      const receipt = await writer.apply(
        manifest,
        files,
        "Enhance ticket JSON schema with optional tenantId (MCP proof)",
        body,
      );
      console.log(`receipt: ${JSON.stringify(receipt, null, 2)}`);
      expect(receipt.draft).toBe(true);
      expect(receipt.number).toBeGreaterThan(0);
      expect(receipt.url).toMatch(/^https:\/\/github\.com\//);
    },
    120_000,
  );
});
