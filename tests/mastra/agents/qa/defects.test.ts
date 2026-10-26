import { afterEach, describe, expect, it, vi } from "vitest";

import { type QaCaseResult, type QaDefect } from "../../../../src/mastra/agents/qa/contracts.js";
import {
  createQaDefectFiler,
  qaDefectFilerFromEnv,
  unconfiguredQaDefectFiler,
  type QaFileBrief,
} from "../../../../src/mastra/agents/qa/defects.js";

/**
 * Filing is a governed write, so its failure mode matters more than its happy
 * path: a missing bridge, a 401 or an unreadable body must all come back as a
 * receipt the run can show, never as a thrown step that hides the findings.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function recordingFetch(reply: { status?: number; body?: unknown } = {}): {
  impl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: { body?: unknown }) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const status = reply.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => reply.body ?? {},
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function defect(caseId = "QA-OPS-001"): QaDefect {
  return {
    caseId,
    title: `[QA] ${caseId}: the queue lists pending requests`,
    body: `Case ${caseId} failed.`,
    severity: "high",
    evidenceRefs: [`qa:run-qa-1:${caseId}:observed`],
    correlationId: `OPS-123:${caseId}`,
  };
}

function caseResult(caseId: string, status: QaCaseResult["status"]): QaCaseResult {
  return {
    caseId,
    status,
    observed: `${caseId} reported ${status}`,
    evidence: { console: [], network: [], transcript: [] },
    durationMs: 5,
  };
}

function brief(overrides: Record<string, unknown> = {}): QaFileBrief {
  return {
    runId: "run-qa-1",
    storyKey: "OPS-123",
    targetKey: "local-console",
    caseSetHash: "a".repeat(64),
    defects: [defect()],
    results: [caseResult("QA-OPS-001", "failed"), caseResult("QA-OPS-002", "passed")],
    ...overrides,
  } as QaFileBrief;
}

describe("qa defect filing", () => {
  it("reports an unconfigured bridge on every finding instead of filing nothing silently", async () => {
    const filer = unconfiguredQaDefectFiler("bridge_unconfigured:KNOWLEDGE_API_URL");
    expect(await filer.file(brief())).toEqual([
      {
        caseId: "QA-OPS-001",
        correlationId: "OPS-123:QA-OPS-001",
        action: "failed",
        ticketKey: "",
        status: "bridge_unconfigured:KNOWLEDGE_API_URL",
      },
    ]);
  });

  it("falls back to the unconfigured filer when the environment names no bridge", async () => {
    vi.stubEnv("KNOWLEDGE_API_URL", "");
    vi.stubEnv("KNOWLEDGE_SERVICE_TOKEN", "");
    const receipts = await qaDefectFilerFromEnv().file(brief());
    expect(receipts[0]?.action).toBe("failed");
    expect(receipts[0]?.status).toBe("bridge_unconfigured:KNOWLEDGE_API_URL");
  });

  it("posts one governed write per finding, then one per passing case", async () => {
    const { impl, calls } = recordingFetch({
      body: { action: "created", ticketKey: "OPS-77", status: "open" },
    });
    const filer = createQaDefectFiler({
      baseUrl: "http://localhost:8000/",
      serviceToken: "service-token",
      fetch: impl,
    });

    const receipts = await filer.file(brief());
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8000/agent-tools/qa/file-defect",
      "http://localhost:8000/agent-tools/qa/file-defect",
    ]);
    expect(calls[0]?.body).toMatchObject({
      storyKey: "OPS-123",
      caseId: "QA-OPS-001",
      targetKey: "local-console",
      runId: "run-qa-1",
      status: "failed",
      severity: "high",
      correlationId: "OPS-123:QA-OPS-001",
    });
    // The route owns the ledger; TS only says what it saw this run.
    expect(calls[1]?.body).toMatchObject({
      caseId: "QA-OPS-002",
      status: "passed",
      correlationId: "OPS-123:QA-OPS-002",
    });
    expect(String(calls[1]?.body.title)).toContain("now passes");
    expect(receipts).toEqual([
      { caseId: "QA-OPS-001", correlationId: "OPS-123:QA-OPS-001", action: "created", ticketKey: "OPS-77", status: "open" },
      { caseId: "QA-OPS-002", correlationId: "OPS-123:QA-OPS-002", action: "created", ticketKey: "OPS-77", status: "open" },
    ]);
  });

  it("accepts the route's skipped answer for a case with no defect", async () => {
    const { impl } = recordingFetch({ body: { action: "skipped", ticketKey: "", status: "no_defect" } });
    const filer = createQaDefectFiler({
      baseUrl: "http://localhost:8000",
      serviceToken: "service-token",
      fetch: impl,
    });
    const [receipt] = await filer.file(brief({ defects: [] }));
    expect(receipt).toMatchObject({ action: "skipped", ticketKey: "", status: "no_defect" });
  });

  it("turns a refused write into a failed receipt, not a thrown run", async () => {
    const { impl } = recordingFetch({ status: 401, body: { detail: "unauthorised" } });
    const filer = createQaDefectFiler({
      baseUrl: "http://localhost:8000",
      serviceToken: "service-token",
      fetch: impl,
    });
    const receipts = await filer.file(brief({ results: [] }));
    expect(receipts).toEqual([
      {
        caseId: "QA-OPS-001",
        correlationId: "OPS-123:QA-OPS-001",
        action: "failed",
        ticketKey: "",
        status: "http_401",
      },
    ]);
  });

  it("reports an unreadable or invalid answer as a failed receipt", async () => {
    const unreadable = recordingFetch({ body: [] });
    const invalid = recordingFetch({ body: { action: "exploded", ticketKey: "OPS-1", status: "x" } });
    const options = { baseUrl: "http://localhost:8000", serviceToken: "t" };

    const first = await createQaDefectFiler({ ...options, fetch: unreadable.impl }).file(
      brief({ results: [] }),
    );
    expect(first[0]?.status).toBe("unreadable_body");

    const second = await createQaDefectFiler({ ...options, fetch: invalid.impl }).file(
      brief({ results: [] }),
    );
    expect(second[0]?.status).toBe("invalid_receipt");
  });

  it("refuses to construct without a bridge and a token", () => {
    expect(() => createQaDefectFiler({ baseUrl: "", serviceToken: "t" })).toThrow(
      "createQaDefectFiler: baseUrl is required",
    );
    expect(() => createQaDefectFiler({ baseUrl: "http://localhost:8000", serviceToken: "" })).toThrow(
      "createQaDefectFiler: serviceToken is required",
    );
  });
});
