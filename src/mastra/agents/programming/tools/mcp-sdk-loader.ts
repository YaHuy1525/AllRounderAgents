/**
 * Loads the MCP TypeScript SDK through `createRequire` instead of a static import,
 * because the dev bundler rewrites package specifiers with the OS path separator
 * (on Windows `@modelcontextprotocol/sdk\client\index.js` fails with
 * `ERR_INVALID_MODULE_SPECIFIER`). Each value export carries a same-named type.
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
