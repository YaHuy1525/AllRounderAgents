/**
 * One-off live proof (run manually, never in CI):
 *   $env:E2E_PR_PROOF="1"; npx vitest run src/mastra/agents/programming/pr-proof.test.ts
 * Drives the REAL GitHub writer with a deterministic patch (no LLM) against the
 * allowlisted repo and asserts a Draft PR is opened. Reads GITHUB_TOKEN from .env.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FetchGitHubTransport,
  GitHubRepositoryTools,
  type GitHubPolicy,
} from "./tools/github.js";
import type { PatchFile } from "./contracts.js";

const ENABLED = process.env.E2E_PR_PROOF === "1";

function envValue(name: string): string | undefined {
  return readFileSync(new URL("../../../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
}

describe.skipIf(!ENABLED)("github writer e2e proof", () => {
  it(
    "opens a Draft PR with a deterministic tenantId schema patch",
    async () => {
      const token = envValue("GITHUB_TOKEN");
      if (!token) throw new Error("GITHUB_TOKEN missing from .env");

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
        new FetchGitHubTransport(token),
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
          excerpt: "Remote ticket schema (deterministic enhancement proof)",
        },
      ];
      const branch = "codex/scr10-proof-tenant-schema";

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
        "Deterministic e2e proof for ticket SCRUM-10: adds an optional tenantId",
        "property to contracts/jsonschema/ticket.schema.json so coding runs can",
        "bind a ticket to its tenant. No LLM involved in producing this patch.",
        "",
        `Patch hash: ${manifest.patchHash}`,
      ].join("\n");

      const receipt = await writer.apply(
        manifest,
        files,
        "Enhance ticket JSON schema with optional tenantId",
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
