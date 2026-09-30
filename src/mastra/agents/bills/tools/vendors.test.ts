import { describe, expect, it } from "vitest";

import { VendorRecordSchema } from "../contracts.js";
import {
  HttpVendorRegistry,
  MemoryVendorRegistry,
  type MemoryVendorEntry,
  type VendorFetch,
} from "./vendors.js";

const BASE_URL = "https://api.example/";
const TOKEN = "knowledge-service-token";

const ENTRY: MemoryVendorEntry = {
  ref: "acme-power",
  name: "Acme Power Pty Ltd",
  accountName: "Acme Power Pty Ltd",
  bsb: "012345",
  accountNumber: "12345678",
  emails: ["billing@acmepower.com.au"],
};

const RECORD = {
  ref: "acme-power",
  name: "Acme Power Pty Ltd",
  accountName: "Acme Power Pty Ltd",
  bsb: "012345",
  accountNumber: "12345678",
};

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: unknown;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Recorded-fixture vendor API: answers the exact response shape the lookup
 * route speaks and records every request, so the wire contract (path, bearer,
 * body) is pinned without a network. Failures script the degradation paths.
 */
class FakeVendorApi {
  readonly requests: RecordedRequest[] = [];
  private scripted: Response | Error | null = null;

  respondWith(response: Response): void {
    this.scripted = response;
  }

  failWith(error: Error): void {
    this.scripted = error;
  }

  readonly fetch: VendorFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    this.requests.push({
      method: init?.method ?? "GET",
      url,
      authorization: headers.get("Authorization") ?? "",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const scripted = this.scripted;
    if (scripted instanceof Error) {
      throw scripted;
    }
    if (scripted === null) {
      throw new Error("FakeVendorApi: no scripted response");
    }
    return scripted;
  };
}

function adapter(api: FakeVendorApi): HttpVendorRegistry {
  return new HttpVendorRegistry({ baseUrl: BASE_URL, serviceToken: TOKEN, fetch: api.fetch });
}

describe("MemoryVendorRegistry", () => {
  it("matches the sender address case-insensitively", async () => {
    const registry = new MemoryVendorRegistry([ENTRY]);

    const found = await registry.lookup({
      tenantId: "tenant-a",
      email: "Billing@AcmePower.com.AU",
    });

    expect(found).toEqual(RECORD);
    // The registry row never leaks its email list past the seam.
    expect(VendorRecordSchema.parse(found)).toEqual(RECORD);
  });

  it("returns null for an unregistered sender", async () => {
    const registry = new MemoryVendorRegistry([ENTRY]);

    const found = await registry.lookup({
      tenantId: "tenant-a",
      email: "accounts@nimbus.test",
    });

    expect(found).toBeNull();
  });
});

describe("HttpVendorRegistry", () => {
  it("forwards the tenant and sender address with the service bearer", async () => {
    const api = new FakeVendorApi();
    api.respondWith(jsonResponse(200, { vendor: RECORD }));

    const found = await adapter(api).lookup({
      tenantId: "tenant-a",
      email: "billing@acmepower.com.au",
    });

    expect(found).toEqual(RECORD);
    expect(api.requests).toEqual([
      {
        method: "POST",
        url: "https://api.example/msp/vendors/lookup",
        authorization: `Bearer ${TOKEN}`,
        body: { tenantId: "tenant-a", email: "billing@acmepower.com.au" },
      },
    ]);
  });

  it("returns null when the registry knows no such sender", async () => {
    const api = new FakeVendorApi();
    api.respondWith(jsonResponse(200, { vendor: null }));

    const found = await adapter(api).lookup({
      tenantId: "tenant-a",
      email: "accounts@nimbus.test",
    });

    expect(found).toBeNull();
  });

  it("skips the call without a tenant and stays unverified", async () => {
    const api = new FakeVendorApi();

    const found = await adapter(api).lookup({
      tenantId: null,
      email: "billing@acmepower.com.au",
    });

    expect(found).toBeNull();
    expect(api.requests).toEqual([]);
  });

  it("degrades to null on transport and HTTP failures", async () => {
    const failures: Array<Response | Error> = [
      jsonResponse(401, { detail: "Invalid credentials" }),
      jsonResponse(500, { detail: "boom" }),
      new Error("socket hang up"),
    ];
    for (const failure of failures) {
      const api = new FakeVendorApi();
      if (failure instanceof Error) {
        api.failWith(failure);
      } else {
        api.respondWith(failure);
      }
      const found = await adapter(api).lookup({
        tenantId: "tenant-a",
        email: "billing@acmepower.com.au",
      });
      expect(found, `failure: ${String(failure)}`).toBeNull();
    }
  });

  it("treats an out-of-contract record as no match at all", async () => {
    const api = new FakeVendorApi();
    api.respondWith(jsonResponse(200, { vendor: { ...RECORD, bsb: 12345 } }));

    const found = await adapter(api).lookup({
      tenantId: "tenant-a",
      email: "billing@acmepower.com.au",
    });

    expect(found).toBeNull();
  });

  it("requires a base URL and a service token", () => {
    expect(() => new HttpVendorRegistry({ baseUrl: "/", serviceToken: TOKEN })).toThrow(/baseUrl/);
    expect(() => new HttpVendorRegistry({ baseUrl: BASE_URL, serviceToken: "" })).toThrow(
      /serviceToken/,
    );
  });
});
