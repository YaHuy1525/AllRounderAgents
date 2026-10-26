import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

import type { CorsOptions, MiddlewareHandler } from "@mastra/core/server";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";

/**
 * Tenant and identity enforcement for the browser-facing console chat.
 *
 * The browser now talks to this host directly instead of through the Python
 * serving plane, so two values the caller controls have to be policed: the
 * tenant the console tools read, and the memory resource that addresses a
 * user's threads. Both are derived here from the verified Supabase access
 * token and never taken from the request.
 *
 * The decisions are a pure function over plain data. The Hono adapter in
 * `chatAuthMiddleware` (Task 3) only converts a `GuardDecision` into a
 * response, which keeps the whole security table testable without a server.
 */

/** Contract names the guard reads, all three supplied by the deployment. */
export const ENV_KEYS = {
  jwks: "SUPABASE_JWKS_URL",
  issuer: "SUPABASE_JWT_ISSUER",
  audience: "SUPABASE_JWT_AUDIENCE",
} as const;

export const DEV_UNAUTHENTICATED_FLAG = "DEV_HOST_UNAUTHENTICATED";

export const STRICT_RESOURCE_MATCH_FLAG = "CHAT_STRICT_RESOURCE_MATCH";

/**
 * The prefixes a browser can reach through the console. Studio, `/health`,
 * the OpenAPI document and the playground routes are not matched, so an
 * operator at the keyboard is never asked for a token. The agent and memory
 * prefixes are the whole data surface, so they are never exempt.
 */
export const PROTECTED_PREFIXES = ["/api/agents/", "/api/memory/"] as const;

/** Body every rejection carries, so a client cannot tell 401 reasons apart. */
export const UNAUTHORIZED_BODY = { error: { message: "invalid or expired token" } } as const;

export type Principal = {
  readonly tenantId: string;
  readonly subject: string;
  readonly roles: readonly string[];
};

export type JwtPayload = JWTPayload & {
  readonly sub?: string;
  readonly app_metadata?: {
    readonly tenant_id?: unknown;
    readonly roles?: unknown;
  };
};

export type GuardInputs = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  /** `memory.resource` from an agent stream/generate body, when present. */
  readonly bodyResource: string | undefined;
  /** `resourceId` from a memory route query string, when present. */
  readonly queryResourceId: string | undefined;
};

export type GuardDecision =
  | { readonly kind: "skip" }
  | { readonly kind: "allow"; readonly principal: Principal; readonly resource: string }
  | { readonly kind: "deny"; readonly status: 401 | 403; readonly reason: string };

export type AuthRuntime = {
  readonly issuer: string;
  readonly audience: string;
  /** Throws on any verification failure; the guard folds every throw into 401. */
  readonly verify: (token: string) => JwtPayload | Promise<JwtPayload>;
  /**
   * Spec §6.1 as written: reject a caller-supplied resource that disagrees
   * with the verified one. Off by default because the reserved-key override in
   * the middleware already makes the client value inert (plan amendment A1);
   * turning it on is a defence-in-depth choice, not a behaviour change.
   */
  readonly strictResourceMatch?: boolean;
};

/** The runtime values plus the dev escape hatch, read once by the middleware. */
export type RuntimeConfig = AuthRuntime & { readonly skipAuth: boolean };

export function extractPrincipal(payload: JwtPayload): Principal | null {
  const subject = typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
  const metadata = payload.app_metadata;
  if (subject === null || metadata === undefined) return null;
  const tenantId =
    typeof metadata.tenant_id === "string" && metadata.tenant_id.trim() !== ""
      ? metadata.tenant_id.trim()
      : null;
  if (tenantId === null) return null;
  // Roles are trusted from app_metadata only. A client-side `roles` claim is
  // unsigned, so it is ignored — mirroring the Python verifier's contract.
  const roles = Array.isArray(metadata.roles)
    ? metadata.roles.filter((role): role is string => typeof role === "string")
    : null;
  if (roles === null) return null;
  return { tenantId, subject, roles };
}

export function expectedResource(principal: Principal): string {
  return `${principal.tenantId}:${principal.subject}`;
}

/**
 * Only the data-bearing methods on the data-bearing prefixes. OPTIONS is
 * excluded because it carries no read, and a preflight that demanded a token
 * would break every browser call before the real request is ever sent.
 */
export function isProtectedRoute(path: string, method: string): boolean {
  switch (method) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      break;
    default:
      return false;
  }
  return PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export async function guardChatRequest(
  inputs: GuardInputs,
  runtime: AuthRuntime,
  devUnauthenticated = false,
): Promise<GuardDecision> {
  if (devUnauthenticated) return { kind: "skip" };
  if (!isProtectedRoute(inputs.path, inputs.method)) return { kind: "skip" };

  const header = inputs.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    return { kind: "deny", status: 401, reason: "missing bearer token" };
  }
  const token = header.slice("Bearer ".length).trim();
  if (token === "") return { kind: "deny", status: 401, reason: "missing bearer token" };

  let payload: JwtPayload;
  try {
    payload = await runtime.verify(token);
  } catch {
    return { kind: "deny", status: 401, reason: "invalid or expired token" };
  }
  if (payload.iss !== runtime.issuer || payload.aud !== runtime.audience) {
    return { kind: "deny", status: 401, reason: "invalid or expired token" };
  }

  const principal = extractPrincipal(payload);
  if (principal === null) {
    return { kind: "deny", status: 403, reason: "token has no app_metadata.tenant_id" };
  }
  const resource = expectedResource(principal);

  if (runtime.strictResourceMatch === true) {
    const claimed = inputs.bodyResource ?? inputs.queryResourceId;
    if (claimed !== undefined && claimed !== resource) {
      return { kind: "deny", status: 403, reason: "memory resource does not match the token" };
    }
  }
  return { kind: "allow", principal, resource };
}

/** The slice of the framework's RequestContext this adapter writes. */
type ContextWriter = { set: (key: string, value: string) => void };

type Variables = { requestContext: ContextWriter | undefined };

export type GuardDeps = {
  readonly issuer: string;
  readonly audience: string;
  readonly verify: (token: string) => JwtPayload | Promise<JwtPayload>;
  readonly devUnauthenticated: boolean;
  readonly strictResourceMatch?: boolean;
  readonly log?: (message: string, fields: Record<string, string>) => void;
};

/** Rejection bodies never repeat a token-derived detail back to the caller. */
function denialBody(reason: string): { error: { message: string } } {
  return { error: { message: reason } };
}

/**
 * Hono middleware enforcing the console chat contract on the agent and memory
 * routes. Registered through `server.middleware`, so it runs after the
 * framework's context middleware has created the `RequestContext` and before
 * the route handler reads it — that is the object the console tools later read
 * the tenant from, which is why setting it here is enough.
 *
 * It never consumes the request body unless `strictResourceMatch` is on, and
 * then only through `c.req.raw.clone()`, so the handler's own body read is
 * untouched. That is the spec §7.1 implementation risk closed by construction.
 */
export function chatAuthMiddleware(deps: GuardDeps): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;
    if (!isProtectedRoute(path, method)) return next();

    let bodyResource: string | undefined;
    let queryResourceId: string | undefined;
    if (deps.strictResourceMatch === true) {
      queryResourceId = c.req.query("resourceId");
      if (method === "POST" || method === "PUT") {
        const contentType = c.req.header("content-type") ?? "";
        if (contentType.includes("application/json")) {
          try {
            const body = (await c.req.raw.clone().json()) as {
              memory?: { resource?: unknown };
              resourceId?: unknown;
            } | null;
            if (typeof body?.memory?.resource === "string") {
              bodyResource = body.memory.resource;
            }
            if (bodyResource === undefined && typeof body?.resourceId === "string") {
              queryResourceId = body.resourceId;
            }
          } catch {
            // A body the guard cannot read is the handler's problem, not ours.
          }
        }
      }
    }

    const decision = await guardChatRequest(
      {
        method,
        path,
        authorization: c.req.header("authorization"),
        bodyResource,
        queryResourceId,
      },
      {
        issuer: deps.issuer,
        audience: deps.audience,
        verify: deps.verify,
        ...(deps.strictResourceMatch === undefined
          ? {}
          : { strictResourceMatch: deps.strictResourceMatch }),
      },
      deps.devUnauthenticated,
    );

    if (decision.kind === "deny") {
      deps.log?.("chat_auth_denied", { reason: decision.reason, path });
      // The reason is logged, never returned: 401 always says the same thing.
      return decision.status === 401
        ? c.json(denialBody(UNAUTHORIZED_BODY.error.message), 401)
        : c.json(denialBody(decision.reason), 403);
    }
    if (decision.kind === "skip") return next();

    const requestContext = c.get("requestContext");
    if (requestContext === undefined) {
      // Without a context to write into, the tools would fall back to whatever
      // tenant the client supplied. Refuse rather than serve an unscoped read.
      deps.log?.("chat_auth_context_missing", { path });
      return c.json(denialBody(UNAUTHORIZED_BODY.error.message), 401);
    }
    // Unconditional overwrite: the verified claim is the only tenant source, so
    // a body-supplied requestContext.tenantId has no effect (spec §6.1.1).
    requestContext.set("tenantId", decision.principal.tenantId);
    // The framework's getEffectiveResourceId prefers this reserved key over any
    // client-supplied memory.resource, and validateThreadOwnership already 403s
    // a thread whose owner differs. Writing it here is the amendment-A1
    // enforcement: identity is server-derived, thread isolation is framework-
    // enforced, and nothing had to parse the body to get it.
    requestContext.set(MASTRA_RESOURCE_ID_KEY, decision.resource);
    return next();
  };
}

/**
 * Explicit CORS for a host that is now browser-facing. The framework default is
 * `origin: "*"`, which is not acceptable once tenant data is one fetch away.
 * Origins come from `CHAT_ALLOWED_ORIGINS` as a csv; an unset list yields
 * `undefined` so the framework keeps its default for a purely internal host.
 */
export function chatCorsConfig(
  rawOrigin?: string,
  allowHeaders?: string,
): CorsOptions | undefined {
  const origins = (rawOrigin ?? process.env.CHAT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (origins.length === 0) return undefined;
  // The bearer token is the whole authentication channel, so a preflight that
  // does not allow Authorization would break every console request. Anything in
  // CHAT_ALLOWED_HEADERS is added to that list.
  const extraHeaders = (allowHeaders ?? process.env.CHAT_ALLOWED_HEADERS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return {
    origin: origins,
    allowHeaders: [...new Set(["Content-Type", "Authorization", "Accept", ...extraHeaders])],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length", "X-Requested-With"],
    credentials: false,
  };
}

/**
 * Builds the middleware from deployment configuration, so `mastra.ts` stays
 * declarative. The env is a parameter (defaulting to `process.env`) purely so
 * the production guard rail below is testable without mutating a read-only
 * NODE_ENV. The remote JWKS handle is created once per process; `jose` caches
 * keys and refreshes them by `kid`.
 */
export function consoleChatAuth(
  env: Record<string, string | undefined> = process.env,
): MiddlewareHandler<{ Variables: Variables }> {
  const jwksUrl = env[ENV_KEYS.jwks] ?? "";
  const issuer = env[ENV_KEYS.issuer] ?? "";
  const audience = env[ENV_KEYS.audience] ?? "authenticated";
  const devFlag = (env[DEV_UNAUTHENTICATED_FLAG] ?? "").toLowerCase() === "true";
  const strict = (env[STRICT_RESOURCE_MATCH_FLAG] ?? "").toLowerCase() === "true";
  if (devFlag && env.NODE_ENV === "production") {
    throw new Error(`${DEV_UNAUTHENTICATED_FLAG} is not allowed when NODE_ENV=production`);
  }
  let getKey: JWTVerifyGetKey | undefined;
  if (jwksUrl !== "") getKey = createRemoteJWKSet(new URL(jwksUrl));
  const verify = async (token: string): Promise<JWTPayload> => {
    if (!getKey) throw new Error(`${ENV_KEYS.jwks} is not configured`);
    const result = await jwtVerify(token, getKey, { issuer, audience });
    return result.payload;
  };
  return chatAuthMiddleware({
    issuer,
    audience,
    verify,
    devUnauthenticated: devFlag,
    strictResourceMatch: strict,
    log: (message, fields) => {
      // Never log the token. Reason and path are enough to debug a rejection.
      console.warn(`[chat-auth] ${message}`, fields);
    },
  });
}
