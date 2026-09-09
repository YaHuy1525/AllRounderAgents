/**
 * Runtime loader for the MCP TypeScript SDK.
 *
 * The Mastra dev bundler rewrites static imports of third-party packages into
 * specifiers rebuilt with the OS path separator — on Windows the emitted
 * bundle contains `@modelcontextprotocol/sdk\client\index.js`, which Node
 * rejects (`ERR_INVALID_MODULE_SPECIFIER`). Loading the SDK's CJS build
 * through `createRequire` keeps the specifier inside a plain string that the
 * bundler never rewrites, so resolution happens against the real node_modules
 * at runtime no matter where the bundle is executed from. Each value export
 * carries a same-named type export (constructor type) so callers can keep
 * using the SDK names in type positions.
 */
import { createRequire } from "node:module";

type SdkClientModule = typeof import("@modelcontextprotocol/sdk/client/index.js");
type SdkAuthModule = typeof import("@modelcontextprotocol/sdk/client/auth.js");
type SdkStreamableHttpModule = typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const require = createRequire(import.meta.url);
const sdkClient = require("@modelcontextprotocol/sdk/client/index.js") as SdkClientModule;
const sdkAuth = require("@modelcontextprotocol/sdk/client/auth.js") as SdkAuthModule;
const sdkStreamableHttp = require(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
) as SdkStreamableHttpModule;

export const Client = sdkClient.Client;
export type Client = InstanceType<typeof Client>;
export const UnauthorizedError = sdkAuth.UnauthorizedError;
export type UnauthorizedError = InstanceType<typeof UnauthorizedError>;
export const StreamableHTTPClientTransport = sdkStreamableHttp.StreamableHTTPClientTransport;
export type StreamableHTTPClientTransport = InstanceType<typeof StreamableHTTPClientTransport>;
