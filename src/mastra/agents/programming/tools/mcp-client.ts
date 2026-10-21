// Reusable GitHub MCP client (coding-lane MCPClient redesign).
//
// One `MCPClient` speaks the hosted GitHub MCP server over Streamable HTTP,
// exactly as https://mastra.ai/docs/connections/mcp documents it. Its
// discovered tools (`github_<name>`) are wired statically onto the coding
// agents so the model sees the real GitHub tool catalog and decides which to
// call, instead of the retired hand-written backend that hardcoded tool names.
//
// Governance carried by the client config itself (both are the docs' Security
// + Tool-approval options):
//   * `requireToolApproval` gates every mutating tool pre-execution (Option B):
//     the agent can *see* push/PR tools but they suspend for a human rather than
//     auto-execute, so the deterministic Draft-PR writer stays the only path
//     that actually opens a pull request.
//   * `allowedHosts` pins outbound contact to the configured server host.
//
// The client is constructed only when a token exists. With no credentials it is
// `undefined` and discovery resolves an empty map, so tests and the dev
// fallback never open a socket.

import { MCPClient } from "@mastra/mcp";

/** The hosted GitHub MCP server endpoint (Streamable HTTP, bearer PAT). */
export const GITHUB_MCP_DEFAULT_URL = "https://api.githubcopilot.com/mcp/";

// MCP tool names that mutate repository state. A discovered tool whose name
// (after stripping the `github_` server prefix) starts with one of these verbs
// requires human approval before it may execute. Reads (get_*, list_*, search_*)
// never match and run freely.
const WRITE_TOOL_PREFIXES = [
  "create_",
  "update_",
  "delete_",
  "merge_",
  "push_",
  "fork_",
  "add_",
  "close_",
] as const;

function isMutating(toolName: string): boolean {
  const bare = toolName.replace(/^github_/, "");
  return WRITE_TOOL_PREFIXES.some((prefix) => bare.startsWith(prefix));
}

export const githubMcpClient: MCPClient | undefined = (() => {
  const token = process.env.GITHUB_MCP_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (token === undefined || token === "") return undefined;
  const url = new URL(process.env.GITHUB_MCP_URL?.trim() || GITHUB_MCP_DEFAULT_URL);
  return new MCPClient({
    id: "allrounder-github-mcp",
    servers: {
      github: {
        url,
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
        // Option B gate: mutating tools suspend for a human; reads run freely.
        requireToolApproval: ({ toolName }) => isMutating(toolName),
        // Pin outbound contact to the configured server host.
        allowedHosts: [url.host],
      },
    },
  });
})();

/** The tool map `listTools()` resolves to: `github_<name>` keys. */
export type GitHubToolMap = Awaited<ReturnType<MCPClient["listTools"]>>;

// Discovery is memoized in ONE promise so the three coding agents (and the
// deterministic backend) share a single connection. A cold or unreachable
// GitHub MCP degrades to an empty map instead of crashing module load.
let discovered: Promise<GitHubToolMap> | undefined;

export function githubMcpTools(): Promise<GitHubToolMap> {
  if (githubMcpClient === undefined) return Promise.resolve({});
  discovered ??= githubMcpClient.listTools().catch(() => ({}) as GitHubToolMap);
  return discovered;
}
