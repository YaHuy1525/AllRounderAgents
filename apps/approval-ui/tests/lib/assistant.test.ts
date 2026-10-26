import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The module reads its configuration at call time, so each test sets the env it
 * needs and the teardown clears it. Nothing here touches the network: the client
 * is injected, and the token reader is stubbed.
 */
const ENV_KEYS = ["NEXT_PUBLIC_MASTRA_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  vi.unstubAllGlobals();
});

async function withSession(session: unknown) {
  vi.resetModules();
  const { setSessionReaderForTest } = await import("@/lib/assistant");
  setSessionReaderForTest(async () => session);
  return import("@/lib/assistant");
}

describe("assistantResource", () => {
  it("joins the signed tenant claim with the user id", async () => {
    const mod = await withSession({
      user: { id: "user-1", app_metadata: { tenant_id: "omnidewalt" } },
    });
    await expect(mod.assistantResource()).resolves.toBe("omnidewalt:user-1");
  });

  it("is null when the account has no tenant, so the composer can disable", async () => {
    const mod = await withSession({ user: { id: "user-1", app_metadata: {} } });
    await expect(mod.assistantResource()).resolves.toBeNull();
  });

  it("is null with no session at all", async () => {
    const mod = await withSession(null);
    await expect(mod.assistantResource()).resolves.toBeNull();
  });

  it("reads a stalled session from the persisted snapshot", async () => {
    vi.resetModules();
    const storage = new Map<string, string>([
      [
        "allrounder-auth",
        JSON.stringify({
          access_token: "token",
          user: { id: "user-2", email: "a@b.c", app_metadata: { tenant_id: "acme" } },
        }),
      ],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    });
    const { setSessionReaderForTest } = await import("@/lib/assistant");
    // Reader throws to imitate a hung getSession(); the fallback still answers.
    setSessionReaderForTest(async () => {
      throw new Error("stalled");
    });
    const mod = await import("@/lib/assistant");
    await expect(mod.assistantResource()).resolves.toBe("acme:user-2");
  });
});

describe("thread wrappers", () => {
  function fakeClient() {
    const calls: string[] = [];
    const thread = {
      update: async (init: unknown) => {
        calls.push(`update:${JSON.stringify(init)}`);
        return {};
      },
      delete: async () => {
        calls.push("delete");
        return {};
      },
      listMessages: async (init?: unknown) => {
        calls.push(`listMessages:${JSON.stringify(init)}`);
        return {
          messages: [
            { role: "user", content: { format: 2, parts: [{ type: "text", text: "hi" }] } },
            { role: "assistant", content: { format: 2, parts: [{ type: "text", text: "hello" }] } },
          ],
          total: 2,
          hasMore: false,
        };
      },
    };
    return {
      calls,
      thread,
      client: {
        listMemoryThreads: async (init: unknown) => {
          calls.push(`list:${JSON.stringify(init)}`);
          return [{ id: "t-1", title: "First chat", updatedAt: 5 }];
        },
        createMemoryThread: async (init: unknown) => {
          calls.push(`create:${JSON.stringify(init)}`);
          return thread;
        },
        getMemoryThread: ({ threadId }: { threadId: string }) => {
          calls.push(`get:${threadId}`);
          return thread;
        },
      },
    };
  }

  it("scopes every thread call to the agent and the verified resource", async () => {
    const mod = await withSession({
      user: { id: "user-1", app_metadata: { tenant_id: "omnidewalt" } },
    });
    const { client, calls } = fakeClient();
    const threads = await mod.listThreads(client as never);
    expect(threads).toEqual([{ id: "t-1", title: "First chat", updatedAt: 5 }]);
    expect(calls[0]).toContain('"agentId":"console-assistant"');
    expect(calls[0]).toContain('"resourceId":"omnidewalt:user-1"');
  });

  it("degrades to an empty list when the host is unreachable", async () => {
    const mod = await withSession({
      user: { id: "user-1", app_metadata: { tenant_id: "omnidewalt" } },
    });
    const broken = { listMemoryThreads: async () => { throw new Error("down"); } };
    await expect(mod.listThreads(broken as never)).resolves.toEqual([]);
  });

  it("flattens stored message content back to text", async () => {
    const mod = await withSession({
      user: { id: "user-1", app_metadata: { tenant_id: "omnidewalt" } },
    });
    const { client } = fakeClient();
    expect(await mod.loadMessages("t-1", client as never)).toEqual([
      { role: "user", body: "hi" },
      { role: "assistant", body: "hello" },
    ]);
  });

  it("refuses a thread op with no resource rather than sending a doomed request", async () => {
    const mod = await withSession({ user: { id: "user-1", app_metadata: {} } });
    const { client, calls } = fakeClient();
    await expect(mod.listThreads(client as never)).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("threadTitleFor", () => {
  it("uses the first message, truncated at 60 characters", async () => {
    const mod = await withSession({
      user: { id: "u", app_metadata: { tenant_id: "t" } },
    });
    expect(mod.threadTitleFor("  List   all HR tickets  ")).toBe("List all HR tickets");
    expect(mod.threadTitleFor("x".repeat(200))).toHaveLength(60);
    expect(mod.threadTitleFor("")).toBe("New conversation");
  });
});

/**
 * The streaming layer is pure: chunks in, transcript out. Every test below
 * drives the reducer the shell uses, so no behaviour here needs a browser.
 */
async function loadAssistant() {
  vi.resetModules();
  return import("@/lib/assistant");
}

function rowForTest(key: string) {
  return {
    key,
    project: "HR",
    summary: `Ticket ${key}`,
    status: "Open",
    issueType: "Task",
    priority: "High",
    assignee: null,
    labels: [],
    matchedWorkflows: ["hr-leave"],
  };
}

describe("extractTicketRows", () => {
  const row = rowForTest;

  it("reads the enveloped tool-result shape", async () => {
    const mod = await loadAssistant();
    const chunk = {
      type: "tool-result",
      from: "AGENT",
      payload: { toolName: "list_tickets", result: { ok: true, count: 1, tickets: [row("HR-1")] } },
    };
    expect(mod.extractTicketRows(chunk).map((item) => item.key)).toEqual(["HR-1"]);
  });

  it("reads the flat tool-result shape", async () => {
    const mod = await loadAssistant();
    const chunk = {
      payload: { toolName: "list_tickets", result: { tickets: [row("HR-2")] } },
    };
    expect(mod.extractTicketRows(chunk).map((item) => item.key)).toEqual(["HR-2"]);
  });

  it("ignores another tool, a failed result, and a non-result chunk", async () => {
    const mod = await loadAssistant();
    expect(
      mod.extractTicketRows({
        payload: { toolName: "lookup_employee", result: { tickets: [row("X-1")] } },
      }),
    ).toEqual([]);
    expect(
      mod.extractTicketRows({
        payload: { toolName: "list_tickets", result: { ok: false, error: "timeout" } },
      }),
    ).toEqual([]);
    expect(mod.extractTicketRows({ type: "text-delta", payload: { text: "hi" } })).toEqual([]);
    expect(mod.extractTicketRows(null)).toEqual([]);
  });

  it("dedupes by key across calls and caps at ten rows", async () => {
    const mod = await loadAssistant();
    const many = Array.from({ length: 30 }, (_unused, index) => row(`HR-${index}`));
    const chunk = { payload: { toolName: "list_tickets", result: { ok: true, tickets: many } } };
    const first = mod.extractTicketRows(chunk);
    expect(first).toHaveLength(10);
    const repeat = {
      payload: { toolName: "list_tickets", result: { ok: true, tickets: [row("HR-0"), row("HR-99")] } },
    };
    const state = mod.reduceChatState(
      mod.startAssistantTurn(mod.reduceChatState(mod.initialChatState(), chunk)),
      repeat,
    );
    const keys = state.turns.at(-1)?.rows.map((item: { key: string }) => item.key) ?? [];
    expect(keys).toEqual([
      "HR-0",
      "HR-1",
      "HR-2",
      "HR-3",
      "HR-4",
      "HR-5",
      "HR-6",
      "HR-7",
      "HR-8",
      "HR-9",
    ]);
  });

  it("drops a row that cannot be rendered", async () => {
    const mod = await loadAssistant();
    const chunk = {
      payload: {
        toolName: "list_tickets",
        result: { ok: true, tickets: [{ key: "  " }, { summary: "no key" }, row("HR-5")] },
      },
    };
    expect(mod.extractTicketRows(chunk).map((item: { key: string }) => item.key)).toEqual(["HR-5"]);
  });
});

describe("extractExecuteTicket", () => {
  it("reads the single resolved ticket from an execute_ticket result", async () => {
    const mod = await loadAssistant();
    const chunk = {
      type: "tool-result",
      payload: { toolName: "execute_ticket", result: { ok: true, ticket: rowForTest("SCRUM-10") } },
    };
    expect(mod.extractExecuteTicket(chunk)?.key).toBe("SCRUM-10");
  });

  it("yields nothing when the tool failed, matched no ticket, or is another tool", async () => {
    const mod = await loadAssistant();
    expect(
      mod.extractExecuteTicket({
        payload: { toolName: "execute_ticket", result: { ok: false, error: "bad key" } },
      }),
    ).toBeNull();
    expect(
      mod.extractExecuteTicket({
        payload: { toolName: "execute_ticket", result: { ok: true, error: "no ticket SCRUM-99 is on this tenant's board" } },
      }),
    ).toBeNull();
    expect(
      mod.extractExecuteTicket({
        payload: { toolName: "list_tickets", result: { ok: true, ticket: rowForTest("HR-1") } },
      }),
    ).toBeNull();
  });
});

describe("reduceChatState", () => {
  it("appends text deltas onto the open assistant turn", async () => {
    const mod = await loadAssistant();
    let state = mod.startAssistantTurn(mod.initialChatState());
    state = mod.reduceChatState(state, { type: "text-delta", payload: { text: "Leave " } });
    state = mod.reduceChatState(state, { type: "text-delta", payload: { text: "is booked." } });
    expect(state.turns.at(-1)?.body).toBe("Leave is booked.");
    expect(state.streaming).toBe(true);
  });

  it("opens a tool line on tool-call and keeps the prose separate", async () => {
    const mod = await loadAssistant();
    let state = mod.startAssistantTurn(mod.initialChatState());
    state = mod.reduceChatState(state, {
      type: "tool-call",
      payload: { toolName: "list_tickets", args: { workflows: ["hr"] } },
    });
    expect(state.turns.at(-1)?.toolNotes).toEqual(["list_tickets"]);
    expect(state.turns.at(-1)?.body).toBe("");
  });

  it("ignores an empty delta and a chunk with no type", async () => {
    const mod = await loadAssistant();
    const before = mod.startAssistantTurn(mod.initialChatState());
    const after = mod.reduceChatState(
      mod.reduceChatState(before, { type: "text-delta", payload: { text: "" } }),
      { nonsense: true },
    );
    expect(after).toBe(before);
  });

  it("marks an error chunk and closes the turn", async () => {
    const mod = await loadAssistant();
    let state = mod.startAssistantTurn(mod.initialChatState());
    state = mod.reduceChatState(state, { type: "text-delta", payload: { text: "Half an answer." } });
    state = mod.reduceChatState(state, { type: "error", payload: { error: "402 payment required" } });
    expect(state.turns.at(-1)?.error).toBe("402 payment required");
    // The partial prose survives the error rather than vanishing.
    expect(state.turns.at(-1)?.body).toBe("Half an answer.");
    state = mod.endChatTurn(state, "stopped");
    expect(state.streaming).toBe(false);
    expect(state.turns.at(-1)?.stopped).toBe(true);
  });

  it("records rows on the turn that produced them", async () => {
    const mod = await loadAssistant();
    let state = mod.startAssistantTurn(mod.appendUserTurn(mod.initialChatState(), "list HR"));
    state = mod.reduceChatState(state, {
      payload: { toolName: "list_tickets", result: { ok: true, tickets: [rowForTest("HR-7")] } },
    });
    expect(state.turns.map((turn: { role: string }) => turn.role)).toEqual(["user", "assistant"]);
    expect(state.turns[1]?.rows.map((item: { key: string }) => item.key)).toEqual(["HR-7"]);
    expect(state.turns[0]?.rows).toEqual([]);
  });

  it("records the execute ticket on the turn without touching rows", async () => {
    const mod = await loadAssistant();
    let state = mod.startAssistantTurn(mod.appendUserTurn(mod.initialChatState(), "execute SCRUM-10"));
    state = mod.reduceChatState(state, {
      payload: { toolName: "execute_ticket", result: { ok: true, ticket: rowForTest("SCRUM-10") } },
    });
    const assistantTurn = state.turns.at(-1) as { execute: { key: string } | null; rows: unknown[] };
    expect(assistantTurn.execute?.key).toBe("SCRUM-10");
    expect(assistantTurn.rows).toEqual([]);
  });

  it("leaves execute null when the resolve failed, so no button is offered", async () => {
    const mod = await loadAssistant();
    let state = mod.startAssistantTurn(mod.initialChatState());
    state = mod.reduceChatState(state, {
      payload: { toolName: "execute_ticket", result: { ok: false, error: "not a valid key" } },
    });
    expect(state.turns.at(-1)?.execute).toBeNull();
  });
});

describe("sendChat", () => {
  it("never puts a requestContext on the wire", async () => {
    const mod = await loadAssistant();
    const seen: unknown[] = [];
    const fakeClient = {
      getAgent: () => ({
        stream: async (_message: string, init: { requestContext?: unknown }) => {
          seen.push(init);
          return {
            processDataStream: async ({
              onChunk,
            }: {
              onChunk: (chunk: unknown) => Promise<void>;
            }) => {
              await onChunk({ type: "text-delta", payload: { text: "ok" } });
              await onChunk({ type: "finish", payload: {} });
            },
          };
        },
      }),
    };
    let latest = mod.initialChatState();
    await mod.sendChat({
      threadId: "t-1",
      message: "hello",
      resource: "omnidewalt:user-1",
      client: fakeClient as never,
      onState: (state: typeof latest) => {
        latest = state;
      },
    });
    expect(JSON.stringify(seen)).not.toContain("requestContext");
    expect(JSON.stringify(seen)).toContain('"thread":"t-1"');
    expect(JSON.stringify(seen)).toContain('"resource":"omnidewalt:user-1"');
    expect(latest.turns.at(-1)?.body).toBe("ok");
    expect(latest.streaming).toBe(false);
  });

  it("reports a stream failure on the turn instead of throwing away the text", async () => {
    const mod = await loadAssistant();
    const fakeClient = {
      getAgent: () => ({
        stream: async () => {
          throw new Error("host down");
        },
      }),
    };
    let latest = mod.initialChatState();
    await mod.sendChat({
      threadId: "t-1",
      message: "hello",
      resource: "omnidewalt:user-1",
      client: fakeClient as never,
      onState: (state: typeof latest) => {
        latest = state;
      },
    });
    expect(latest.streaming).toBe(false);
    expect(latest.turns.at(-1)?.error).toContain("host down");
  });
});
