// One MCPClient over the hosted GitHub MCP server (Streamable HTTP), built only
// when a token exists so tests never open a socket. `requireToolApproval` gates
// mutating tools, which keeps the deterministic Draft-PR writer the only path
// that opens a pull request, and `allowedHosts` pins outbound contact.

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
