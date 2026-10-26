import { describe, expect, it } from "vitest";

import {
  expectedResource,
  extractPrincipal,
  guardChatRequest,
  type AuthRuntime,
  type GuardInputs,
  type JwtPayload,
} from "../../../src/mastra/server/chat-auth.js";

/**
 * The guard is a pure function over plain data, so the whole security truth
 * table is asserted here without a server, a socket, or a real key. The
 * middleware in Task 3 is a thin adapter over these inputs.
 */

const RUNTIME: AuthRuntime = {
  issuer: "https://test.supabase.co/auth/v1",
  audience: "authenticated",
  verify: () => ({}) as JwtPayload,
};

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    method: "POST",
    path: "/api/agents/console-assistant/stream",
    authorization: "Bearer good-token",
    bodyResource: undefined,
    queryResourceId: undefined,
    ...overrides,
  };
}

function claims(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: "user-1",
    iss: "https://test.supabase.co/auth/v1",
    aud: "authenticated",
    app_metadata: { tenant_id: "omnidewalt", roles: ["viewer"] },
    ...overrides,
  };
}

/** Every token this guard accepts verifies to the same claims. */
function runtimeWith(payload: JwtPayload): AuthRuntime {
  return { ...RUNTIME, verify: () => payload };
}

type FakeContext = {
  values: Map<string, unknown>;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
};

function fakeContext(): FakeContext {
  const values = new Map<string, unknown>();
  return {
    values,
    get(key: string) {
      return values.get(key);
    },
    set(key: string, value: unknown) {
      values.set(key, value);
    },
  };
}

describe("console chat guard", () => {
  it("accepts a valid token on a protected path and derives the resource", async () => {
    expect(await guardChatRequest(inputs(), runtimeWith(claims()))).toEqual({
      kind: "allow",
      principal: { tenantId: "omnidewalt", subject: "user-1", roles: ["viewer"] },
      resource: "omnidewalt:user-1",
    });
  });

  it("401s when the header is absent, malformed, or the token does not verify", async () => {
    expect(await guardChatRequest(inputs({ authorization: undefined }), RUNTIME)).toMatchObject(
      { kind: "deny", status: 401, reason: "missing bearer token" },
    );
    expect(await guardChatRequest(inputs({ authorization: "Token abc" }), RUNTIME)).toMatchObject({
      kind: "deny",
      status: 401,
      reason: "missing bearer token",
    });
    expect(await guardChatRequest(inputs({ authorization: "Bearer   " }), RUNTIME)).toMatchObject({
      kind: "deny",
      status: 401,
      reason: "missing bearer token",
    });
    const throwing: AuthRuntime = {
      ...RUNTIME,
      verify: () => {
        throw new Error("JWKSInvalid");
      },
    };
    expect(await guardChatRequest(inputs(), throwing)).toMatchObject({
      kind: "deny",
      status: 401,
      reason: "invalid or expired token",
    });
  });

  it("401s on issuer and audience mismatch", async () => {
    for (const payload of [
      claims({ iss: "https://elsewhere.example/auth/v1" }),
      claims({ aud: "anon" }),
    ]) {
      expect(await guardChatRequest(inputs(), runtimeWith(payload))).toMatchObject({
        kind: "deny",
        status: 401,
        reason: "invalid or expired token",
      });
    }
  });

  it("awaits an asynchronous verifier rather than comparing a promise", async () => {
    // jose's jwtVerify is async. A guard that forgot to await would read `iss`
    // off a promise and deny every request, so the async path is asserted here.
    const asyncRuntime: AuthRuntime = {
      ...RUNTIME,
      verify: async () => claims(),
    };
    expect(await guardChatRequest(inputs(), asyncRuntime)).toMatchObject({ kind: "allow" });
  });

  it("403s when the verified token carries no tenant", async () => {
    expect(
      await guardChatRequest(inputs(), runtimeWith(claims({ app_metadata: { roles: [] } }))),
    ).toMatchObject({
      kind: "deny",
      status: 403,
      reason: "token has no app_metadata.tenant_id",
    });
  });

  it("exempts everything that is not an agent or memory route", async () => {
    for (const path of ["/health", "/api/openapi.json", "/", "/studio/assets.js"]) {
      expect(await guardChatRequest(inputs({ path }), RUNTIME)).toEqual({ kind: "skip" });
    }
  });

  it("exempts every method that cannot read data", async () => {
    expect(await guardChatRequest(inputs({ method: "OPTIONS" }), RUNTIME)).toEqual({
      kind: "skip",
    });
  });

  it("skips the whole check when the dev escape hatch is on", async () => {
    expect(await guardChatRequest(inputs({ authorization: undefined }), RUNTIME, true)).toEqual({
      kind: "skip",
    });
  });

  it("403s a foreign memory resource only in strict mode", async () => {
    const runtime = runtimeWith(claims());
    const strict: AuthRuntime = { ...runtime, strictResourceMatch: true };
    expect(
      await guardChatRequest(inputs({ bodyResource: "other:user-9" }), runtime),
    ).toMatchObject({ kind: "allow" });
    // Foreign resources are refused; the caller's own resource is allowed.
    for (const target of [
      inputs({ bodyResource: "other:user-9" }),
      inputs({ queryResourceId: "other:user-9" }),
    ]) {
      expect(await guardChatRequest(target, strict)).toMatchObject({ kind: "deny", status: 403 });
    }
    expect(await guardChatRequest(inputs({ bodyResource: "omnidewalt:user-1" }), strict))
      .toMatchObject({ kind: "allow" });
  });
});

describe("principal derivation", () => {
  it("rejects a payload with no subject or a non-array role list", () => {
    // These bypass `claims()` because the payload's `sub` and `app_metadata`
    // are non-optional in `JwtPayload`, and `exactOptionalPropertyTypes`
    // forbids passing `undefined` through the helper's `Partial<>` overrides.
    const noSubject: JwtPayload = {
      iss: "https://test.supabase.co/auth/v1",
      aud: "authenticated",
      app_metadata: { tenant_id: "t", roles: ["viewer"] },
    };
    expect(extractPrincipal(noSubject)).toBeNull();
    expect(extractPrincipal(claims({ app_metadata: { tenant_id: "t", roles: "admin" } }))).toBeNull();
    const noMeta: JwtPayload = {
      sub: "user-1",
      iss: "https://test.supabase.co/auth/v1",
      aud: "authenticated",
    };
    expect(extractPrincipal(noMeta)).toBeNull();
  });

  it("trusts app_metadata roles only, never the client-side claim", () => {
    const principal = extractPrincipal({
      ...claims(),
      role: ["admin"],
      app_metadata: { tenant_id: "t", roles: ["viewer"] },
    });
    expect(principal?.roles).toEqual(["viewer"]);
  });

  it("builds the resource as tenant:subject", () => {
    expect(expectedResource({ tenantId: "omnidewalt", subject: "user-1", roles: [] })).toBe(
      "omnidewalt:user-1",
    );
  });
});

describe("chat auth middleware", () => {
  /** The Hono context, reduced to the four members the adapter touches. */
  function honoContext(options: {
    context: FakeContext | undefined;
    authorization: string | undefined;
    path?: string;
    method?: string;
  }) {
    const jsonCalls: Array<{ body: unknown; status: number }> = [];
    const c = {
      req: {
        method: options.method ?? "POST",
        path: options.path ?? "/api/agents/console-assistant/stream",
        header: (name: string) =>
          name.toLowerCase() === "authorization" ? options.authorization : undefined,
        query: () => undefined,
        raw: { clone: () => ({ json: async () => ({}) }) },
      },
      get: (name: string) => (name === "requestContext" ? options.context : undefined),
      // Hono accepts the status either positionally or as an init object, so
      // the fake normalises both shapes rather than pinning one calling style.
      json: (body: unknown, init?: number | { status?: number }) => {
        const status = typeof init === "number" ? (init ?? 200) : (init?.status ?? 200);
        jsonCalls.push({ body, status });
        return new Response(JSON.stringify(body), { status });
      },
    };
    return { c: c as never, jsonCalls };
  }

  it("writes tenant and the reserved resource onto the live request context", async () => {
    const { chatAuthMiddleware } = await import("../../../src/mastra/server/chat-auth.js");
    const context = fakeContext();
    const handler = chatAuthMiddleware({
      issuer: "https://test.supabase.co/auth/v1",
      audience: "authenticated",
      verify: () => claims(),
      devUnauthenticated: false,
    });
    const { c } = honoContext({ context, authorization: "Bearer good-token" });
    let called = false;
    const response = await handler(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(response).toBeUndefined();
    expect(context.values.get("tenantId")).toBe("omnidewalt");
    // The reserved key is what makes a client-supplied memory.resource inert.
    expect(context.values.get("mastra__resourceId")).toBe("omnidewalt:user-1");
  });

  it("401s an unauthenticated agent stream before the handler runs", async () => {
    const { chatAuthMiddleware } = await import("../../../src/mastra/server/chat-auth.js");
    const handler = chatAuthMiddleware({
      issuer: "https://test.supabase.co/auth/v1",
      audience: "authenticated",
      verify: () => claims(),
      devUnauthenticated: false,
    });
    const { c, jsonCalls } = honoContext({ context: fakeContext(), authorization: undefined });
    let called = false;
    const response = await handler(c, async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(jsonCalls).toEqual([
      { body: { error: { message: "invalid or expired token" } }, status: 401 },
    ]);
    expect(response).toBeInstanceOf(Response);
  });

  it("leaves an unprotected path alone even with no token", async () => {
    const { chatAuthMiddleware } = await import("../../../src/mastra/server/chat-auth.js");
    const handler = chatAuthMiddleware({
      issuer: "https://test.supabase.co/auth/v1",
      audience: "authenticated",
      verify: () => claims(),
      devUnauthenticated: false,
    });
    const { c, jsonCalls } = honoContext({
      context: undefined,
      authorization: undefined,
      path: "/health",
    });
    let called = false;
    await handler(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(jsonCalls).toEqual([]);
  });

  it("refuses rather than trusting a request with no context to write into", async () => {
    const { chatAuthMiddleware } = await import("../../../src/mastra/server/chat-auth.js");
    const handler = chatAuthMiddleware({
      issuer: "https://test.supabase.co/auth/v1",
      audience: "authenticated",
      verify: () => claims(),
      devUnauthenticated: false,
    });
    const { c, jsonCalls } = honoContext({ context: undefined, authorization: "Bearer good-token" });
    let called = false;
    await handler(c, async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(jsonCalls[0]).toMatchObject({ status: 401 });
  });
});

describe("cors configuration", () => {
  it("returns undefined for an empty list so the framework default survives", async () => {
    const { chatCorsConfig } = await import("../../../src/mastra/server/chat-auth.js");
    const previous = process.env.CHAT_ALLOWED_ORIGINS;
    try {
      delete process.env.CHAT_ALLOWED_ORIGINS;
      expect(chatCorsConfig("")).toBeUndefined();
      expect(chatCorsConfig(undefined)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CHAT_ALLOWED_ORIGINS;
      else process.env.CHAT_ALLOWED_ORIGINS = previous;
    }
  });

  it("turns a csv into an explicit origin allow-list", async () => {
    const { chatCorsConfig } = await import("../../../src/mastra/server/chat-auth.js");
    const config = chatCorsConfig("https://console.example, http://localhost:3000 ,");
    expect(config?.origin).toEqual(["https://console.example", "http://localhost:3000"]);
    // The bearer header has to be allowed or every console request preflights
    // into a rejection.
    expect(config?.allowHeaders).toContain("Authorization");
  });
});

describe("runtime configuration from the environment", () => {
  // The env is a parameter rather than a process.env read inside the function,
  // so the guard rail is testable without mutating a read-only NODE_ENV.
  it("refuses DEV_HOST_UNAUTHENTICATED in production", async () => {
    const { consoleChatAuth } = await import("../../../src/mastra/server/chat-auth.js");
    expect(() =>
      consoleChatAuth({
        DEV_HOST_UNAUTHENTICATED: "true",
        NODE_ENV: "production",
        SUPABASE_JWKS_URL: "https://test.supabase.co/auth/v1/.well-known/jwks.json",
      }),
    ).toThrow(/DEV_HOST_UNAUTHENTICATED/);
  });

  it("builds a handler with the dev flag off and no JWKS url", async () => {
    const { consoleChatAuth } = await import("../../../src/mastra/server/chat-auth.js");
    expect(typeof consoleChatAuth({ NODE_ENV: "test" })).toBe("function");
  });

  it("treats a missing JWKS url as a rejection at request time, not boot time", async () => {
    // A host that boots without SUPABASE_JWKS_URL must not answer a protected
    // route: verify() throws and the guard folds that into 401.
    const { chatAuthMiddleware } = await import("../../../src/mastra/server/chat-auth.js");
    const handler = chatAuthMiddleware({
      issuer: "https://test.supabase.co/auth/v1",
      audience: "authenticated",
      verify: () => {
        throw new Error("SUPABASE_JWKS_URL is not configured");
      },
      devUnauthenticated: false,
    });
    const c = {
      req: {
        method: "POST",
        path: "/api/memory/threads",
        header: () => "Bearer whatever",
        query: () => undefined,
        raw: { clone: () => ({ json: async () => ({}) }) },
      },
      get: () => fakeContext(),
      json: (_body: unknown, init?: number | { status?: number }) =>
        new Response(null, { status: typeof init === "number" ? init : (init?.status ?? 200) }),
    };
    let called = false;
    const response = await handler(c as never, async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect((response as Response).status).toBe(401);
  });
});
