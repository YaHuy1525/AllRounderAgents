import { RequestContext } from "@mastra/core/request-context";
import { noopObserve, type ToolExecuteContext, type ToolExecutionContext } from "@mastra/core/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { consolePrefillTools, consoleToolsFromEnv } from "../../../src/mastra/shared/console-tools.js";

/**
 * The console assistant's four read tools, asserted at the wire.
 *
 * Every case answers from a recorded response, so the contract these tools
 * must keep is pinned without a live API: the served path, the shared bearer,
 * the tenant travelling in the body, and a failure that returns a sentence
 * instead of throwing into the agent's tool loop.
 */

const BASE_URL = "https://api.example/";
const TOKEN = "knowledge-service-token";
const TENANT = "omnidewalt";

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string;
  readonly body: unknown;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class FakeConsoleApi {
  readonly requests: RecordedRequest[] = [];
  private scripted: (() => Response) | null = null;

  constructor(
    private readonly answer: unknown,
    status = 200,
  ) {
    this.scripted = () => jsonResponse(status, answer);
  }

  failWith(error: Error): void {
    this.scripted = () => {
      throw error;
    };
  }

  answerWith(status: number, body: string): void {
    this.scripted = () => new Response(body, { status });
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    this.requests.push({
      url: String(input),
      authorization: headers.get("Authorization") ?? "",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const scripted = this.scripted;
    if (scripted === null) throw new Error("no scripted response");
    return scripted();
  }) as typeof globalThis.fetch;
}

/**
 * The context the framework hands `execute`. `observe` is required by the type
 * even though these tools never read it, so the stub is the framework's own
 * no-op rather than a hand-written double.
 */
function context(tenantId?: string): ToolExecuteContext<ToolExecutionContext> {
  const requestContext = new RequestContext();
  if (tenantId !== undefined) requestContext.set("tenantId", tenantId);
  return { requestContext, observe: noopObserve };
}

function toolsAgainst(api: FakeConsoleApi) {
  return consolePrefillTools({
    baseUrl: BASE_URL,
    serviceToken: TOKEN,
    fetch: api.fetch,
  });
}

const RESOLVED = {
  ok: true,
  workflow: "leave",
  workflowLabel: "Leave request",
  fields: [
    {
      id: "employeeId",
      label: "Employee id",
      value: "E-1001",
      source: "directory: Jordan Avery (E-1001)",
    },
  ],
  missing: [{ id: "startDate", label: "First day of leave" }],
};

const EMPLOYEES = {
  ok: true,
  employees: [
    {
      employeeId: "E-1002",
      fullName: "Priya Raman",
      roleTitle: "Engineering Manager",
      department: "Engineering",
      managerId: "E-1008",
      status: "active",
    },
  ],
};

const TICKETS = {
  ok: true,
  count: 1,
  tickets: [
    {
      key: "HR-1",
      project: "HR",
      summary: "Annual leave request for PTO in December",
      issueType: "Task",
      priority: "Medium",
      status: "To Do",
      assignee: "Jordan Avery",
      labels: [],
      matchedWorkflows: ["leave"],
    },
  ],
};

describe("console tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("attaches four tools whose ids match their map keys", () => {
    const tools = toolsAgainst(new FakeConsoleApi(RESOLVED));
    expect(Object.keys(tools)).toEqual([
      "resolve_start_fields",
      "lookup_employee",
      "list_tickets",
      "execute_ticket",
    ]);
    expect(tools.resolve_start_fields.id).toBe("resolve_start_fields");
    expect(tools.lookup_employee.id).toBe("lookup_employee");
    expect(tools.list_tickets.id).toBe("list_tickets");
    expect(tools.execute_ticket.id).toBe("execute_ticket");
  });

  it("never describes itself as a writer", () => {
    const tools = toolsAgainst(new FakeConsoleApi(RESOLVED));
    expect(tools.resolve_start_fields.description).toContain("never starts anything");
    expect(tools.lookup_employee.description).toContain("does not start or change anything");
    expect(tools.list_tickets.description).toContain("never starts anything");
    expect(tools.execute_ticket.description).toContain("never starts anything");
  });

  it("resolves start fields over the service bridge with the tenant in the body", async () => {
    const api = new FakeConsoleApi(RESOLVED);
    const tools = toolsAgainst(api);

    const output = (await tools.resolve_start_fields.execute?.(
      {
        workflow: "leave",
        ticketKey: "HR-12",
        ticketSummary: "Jordan Avery is out next week",
        text: "Jordan Avery",
      },
      context(TENANT),
    )) as typeof RESOLVED;

    expect(output).toEqual(RESOLVED);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.url).toBe(`${BASE_URL}agent-tools/start-fields`);
    expect(api.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.requests[0]?.body).toEqual({
      tenantId: TENANT,
      workflow: "leave",
      ticketKey: "HR-12",
      ticketSummary: "Jordan Avery is out next week",
      text: "Jordan Avery",
    });
  });

  it("looks an employee up by id or name", async () => {
    const api = new FakeConsoleApi(EMPLOYEES);
    const tools = toolsAgainst(api);

    const output = (await tools.lookup_employee.execute?.(
      { query: "Priya Raman" },
      context(TENANT),
    )) as typeof EMPLOYEES;

    expect(output.employees?.[0]?.fullName).toBe("Priya Raman");
    expect(api.requests[0]?.url).toBe(`${BASE_URL}agent-tools/employees`);
    expect(api.requests[0]?.body).toEqual({ tenantId: TENANT, query: "Priya Raman" });
  });

  it("lists lane-matched tickets over the service bridge", async () => {
    const api = new FakeConsoleApi(TICKETS);
    const tools = toolsAgainst(api);

    const output = (await tools.list_tickets.execute?.(
      { workflows: ["leave", "hr-help"] },
      context(TENANT),
    )) as typeof TICKETS;

    expect(output.tickets?.[0]?.key).toBe("HR-1");
    expect(api.requests[0]?.url).toBe(`${BASE_URL}agent-tools/tickets`);
    expect(api.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.requests[0]?.body).toEqual({
      tenantId: TENANT,
      workflows: ["leave", "hr-help"],
      text: "",
    });
  });

  it("refuses a ticket listing that names neither lanes nor a needle", async () => {
    const api = new FakeConsoleApi(TICKETS);
    const tools = toolsAgainst(api);
    const output = (await tools.list_tickets.execute?.({}, context(TENANT))) as {
      ok: boolean;
      error?: string;
    };

    expect(output.ok).toBe(false);
    expect(output.error).toContain("workflow lanes");
    expect(api.requests).toHaveLength(0);
  });

  it("resolves one named ticket by its exact key for the run tab", async () => {
    const api = new FakeConsoleApi(TICKETS);
    const tools = toolsAgainst(api);

    const output = (await tools.execute_ticket.execute?.(
      { key: " hr-1 " },
      context(TENANT),
    )) as { ok: boolean; ticket?: { key: string; matchedWorkflows: string[] } };

    expect(output.ok).toBe(true);
    expect(output.ticket?.key).toBe("HR-1");
    expect(output.ticket?.matchedWorkflows).toEqual(["leave"]);
    expect(api.requests[0]?.url).toBe(`${BASE_URL}agent-tools/tickets`);
    expect(api.requests[0]?.body).toEqual({ tenantId: TENANT, key: "HR-1" });
  });

  it("refuses a malformed ticket key before touching the API", async () => {
    const api = new FakeConsoleApi(TICKETS);
    const tools = toolsAgainst(api);
    const output = (await tools.execute_ticket.execute?.(
      { key: "not a key" },
      context(TENANT),
    )) as { ok: boolean; error?: string };

    expect(output.ok).toBe(false);
    expect(output.error).toContain("not a valid Jira ticket key");
    expect(api.requests).toHaveLength(0);
  });

  it("reports an honest miss when no ticket carries that key", async () => {
    const api = new FakeConsoleApi({ ok: true, count: 0, tickets: [] });
    const tools = toolsAgainst(api);
    const output = (await tools.execute_ticket.execute?.(
      { key: "SCRUM-99" },
      context(TENANT),
    )) as { ok: boolean; ticket?: unknown; error?: string };

    expect(output.ok).toBe(true);
    expect(output.ticket).toBeUndefined();
    expect(output.error).toContain("no ticket SCRUM-99");
  });

  it("refuses to execute a ticket without a tenant on the request", async () => {
    const api = new FakeConsoleApi(TICKETS);
    const tools = toolsAgainst(api);
    const output = (await tools.execute_ticket.execute?.(
      { key: "HR-1" },
      context(),
    )) as { ok: boolean; error?: string };

    expect(output.ok).toBe(false);
    expect(output.error).toContain("no tenant");
    expect(api.requests).toHaveLength(0);
  });

  it("refuses to read anything without a tenant on the request", async () => {
    const api = new FakeConsoleApi(RESOLVED);
    const tools = toolsAgainst(api);

    const output = (await tools.resolve_start_fields.execute?.(
      { workflow: "leave" },
      context(),
    )) as { ok: boolean; error?: string };

    expect(output.ok).toBe(false);
    expect(output.error).toContain("no tenant");
    // Nothing was asked of the API: the tenant is not something the model supplies.
    expect(api.requests).toHaveLength(0);
  });

  it("treats a blank tenant as missing", async () => {
    const api = new FakeConsoleApi(EMPLOYEES);
    const tools = toolsAgainst(api);
    const output = (await tools.lookup_employee.execute?.(
      { query: "E-1001" },
      context("   "),
    )) as { ok: boolean };

    expect(output.ok).toBe(false);
    expect(api.requests).toHaveLength(0);
  });

  it("reports an HTTP failure instead of throwing", async () => {
    const api = new FakeConsoleApi(RESOLVED, 500);
    const tools = toolsAgainst(api);
    const output = (await tools.lookup_employee.execute?.(
      { query: "E-1001" },
      context(TENANT),
    )) as { ok: boolean; error?: string };

    expect(output.ok).toBe(false);
    expect(output.error).toContain("HTTP 500");
  });

  it("reports an unreachable service instead of throwing", async () => {
    const api = new FakeConsoleApi(RESOLVED);
    api.failWith(new Error("connect ECONNREFUSED"));
    const tools = toolsAgainst(api);
    const output = (await tools.resolve_start_fields.execute?.(
      { workflow: "leave" },
      context(TENANT),
    )) as { ok: boolean; error?: string };

    expect(output.ok).toBe(false);
    expect(output.error).toContain("could not be reached");
  });

  it("reports an unreadable body instead of feeding it to the model", async () => {
    const api = new FakeConsoleApi(RESOLVED);
    api.answerWith(200, "[1,2,3]");
    const tools = toolsAgainst(api);
    const output = (await tools.lookup_employee.execute?.(
      { query: "E-1001" },
      context(TENANT),
    )) as { ok: boolean; error?: string };

    expect(output.ok).toBe(false);
    expect(output.error).toContain("unreadable body");
  });
});

describe("consoleToolsFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("attaches nothing when the console bridge is unconfigured", () => {
    vi.stubEnv("KNOWLEDGE_API_URL", "");
    vi.stubEnv("KNOWLEDGE_SERVICE_TOKEN", "");
    expect(consoleToolsFromEnv()).toEqual({});
  });

  it("attaches nothing when only half the bridge is configured", () => {
    vi.stubEnv("KNOWLEDGE_API_URL", BASE_URL);
    vi.stubEnv("KNOWLEDGE_SERVICE_TOKEN", "");
    expect(consoleToolsFromEnv()).toEqual({});
  });

  it("attaches all four tools when the bridge is configured", () => {
    vi.stubEnv("KNOWLEDGE_API_URL", BASE_URL);
    vi.stubEnv("KNOWLEDGE_SERVICE_TOKEN", TOKEN);
    expect(Object.keys(consoleToolsFromEnv())).toEqual([
      "resolve_start_fields",
      "lookup_employee",
      "list_tickets",
      "execute_ticket",
    ]);
  });
});
