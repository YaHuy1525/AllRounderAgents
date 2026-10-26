import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Read-only console tools for the chat assistant: what a run still needs,
 * who a person is, and which tickets really exist in the tenant's projects.
 *
 * The start-field contract, the employee directory, and the lane keyword
 * vocabulary all live in the Python serving plane
 * (`WorkflowDefinition.start_fields`, `fixtures/hr_directory.json`,
 * `ticket_search.KEYWORD_LANE_RULES`), so these tools do not re-declare any
 * of them. They call `POST /agent-tools/start-fields`,
 * `POST /agent-tools/employees`, and `POST /agent-tools/tickets` over the
 * same shared service bridge the knowledge routes use. A second declaration
 * in TypeScript would be a second answer to "what does this workflow need"
 * or "which ticket is an HR one", which is exactly the drift the published
 * contracts removed.
 *
 * None of the tools writes. Starting a run stays the console's confirm
 * button, which posts `/runs` with the user's credential: a model-initiated
 * start would be a writer with no receipt and no human behind it.
 *
 * The tenant is never a tool argument. It arrives on the request context that
 * the serving plane sets per turn, so no sentence in a prompt can point the
 * directory, the search, or the board at another tenant.
 */

/** Environment names shared with the knowledge bridge (`/knowledge/search`). */
const BASE_URL_ENV = "KNOWLEDGE_API_URL";
const SERVICE_TOKEN_ENV = "KNOWLEDGE_SERVICE_TOKEN";

/**
 * The request context as this module needs it: a typed getter. Declared
 * structurally so the tools do not depend on an internal import path.
 */
interface ContextReader {
  get(key: string): unknown;
}

export interface ConsoleToolOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** One value the serving plane resolved, plus the record it came from. */
const FIELD_SUGGESTION_SCHEMA = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  source: z.string(),
});

/** A required field the plane could not fill; the user's to type. */
const MISSING_FIELD_SCHEMA = z.object({
  id: z.string(),
  label: z.string(),
});

const RESOLVE_OUTPUT_SCHEMA = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  workflow: z.string().optional(),
  workflowLabel: z.string().optional(),
  fields: z.array(FIELD_SUGGESTION_SCHEMA).optional(),
  missing: z.array(MISSING_FIELD_SCHEMA).optional(),
});

const EMPLOYEE_SCHEMA = z.object({
  employeeId: z.string(),
  fullName: z.string(),
  roleTitle: z.string(),
  department: z.string(),
  managerId: z.string().nullable(),
  status: z.string(),
});

const LOOKUP_OUTPUT_SCHEMA = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  employees: z.array(EMPLOYEE_SCHEMA).optional(),
});

/** One ticket the board search matched, with every lane its text tripped. */
const TICKET_SCHEMA = z.object({
  key: z.string(),
  project: z.string(),
  summary: z.string(),
  issueType: z.string(),
  priority: z.string(),
  status: z.string(),
  assignee: z.string().nullable(),
  labels: z.array(z.string()),
  matchedWorkflows: z.array(z.string()),
});

const TICKETS_OUTPUT_SCHEMA = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  count: z.number().optional(),
  tickets: z.array(TICKET_SCHEMA).optional(),
});

type ToolResult<T> = T & { ok: boolean; error?: string };

/**
 * Build the three tools against one base URL. Exported so tests can drive
 * them with a recorded `fetch` instead of a live API.
 */
export function consolePrefillTools(options: ConsoleToolOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (baseUrl === "") {
    throw new Error("consolePrefillTools: baseUrl is required");
  }
  if (options.serviceToken === "") {
    throw new Error("consolePrefillTools: serviceToken is required");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(
    path: string,
    body: Record<string, unknown>,
    abortSignal: AbortSignal | undefined,
  ): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string }> {
    const signals =
      abortSignal === undefined
        ? [AbortSignal.timeout(timeoutMs)]
        : [abortSignal, AbortSignal.timeout(timeoutMs)];
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.serviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      if (!response.ok) {
        return { ok: false, error: `the console API answered HTTP ${response.status}` };
      }
      const payload = (await response.json()) as unknown;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return { ok: false, error: "the console API answered an unreadable body" };
      }
      return { ok: true, payload: payload as Record<string, unknown> };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[mastra] ${path} failed (${reason}); the tool reports the gap.`);
      return { ok: false, error: `the console API could not be reached (${reason})` };
    }
  }

  const resolveStartFields = createTool({
    id: "resolve_start_fields",
    description:
      "Look up what one workflow needs to start, and which of those values the company records already prove (for example an employee id from a full name). "
      + "Call it before drafting a start card, when the user asks what a run needs, or when they name a colleague and a lane. "
      + "It never starts anything: report the filled fields with their source, then tell the user to press the confirm button on the card. "
      + "Values it could not prove come back under `missing` — ask the user for those and never invent them.",
    inputSchema: z.object({
      workflow: z
        .string()
        .min(1)
        .max(40)
        .describe("Workflow id from the console catalog, for example `leave` or `review`."),
      ticketKey: z
        .string()
        .max(40)
        .optional()
        .describe("Jira ticket key when the console has one selected, for example `HR-12`."),
      ticketSummary: z
        .string()
        .max(500)
        .optional()
        .describe("The visible ticket summary, or an empty string."),
      text: z
        .string()
        .max(2_000)
        .optional()
        .describe(
          "The user's own words naming the subject, for example an employee's full name. "
          + "Only a full name resolves an employee id; a first name alone is ambiguous.",
        ),
    }),
    outputSchema: RESOLVE_OUTPUT_SCHEMA,
    execute: async ({ workflow, ticketKey, ticketSummary, text }, context) => {
      const tenantId = readTenant(context.requestContext);
      if (tenantId === undefined) {
        return { ok: false, error: "this turn carries no tenant, so no record can be read" };
      }
      const answer = await post(
        "/agent-tools/start-fields",
        { tenantId, workflow, ticketKey, ticketSummary, text },
        context.abortSignal,
      );
      if (!answer.ok) return { ok: false, error: answer.error };
      return answer.payload as ToolResult<Record<string, unknown>>;
    },
  });

  const lookupEmployee = createTool({
    id: "lookup_employee",
    description:
      "Look up a colleague in the company directory by employee id or by name. "
      + "Use it to answer who someone is, which department they sit in, and who their manager is — "
      + "for example before explaining who must approve a request. "
      + "It returns org facts only: no leave balance, no personal contact details. "
      + "The result does not start or change anything.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(200)
        .describe("An employee id such as `E-1001`, or a full or partial name such as `Jordan Avery`."),
    }),
    outputSchema: LOOKUP_OUTPUT_SCHEMA,
    execute: async ({ query }, context) => {
      const tenantId = readTenant(context.requestContext);
      if (tenantId === undefined) {
        return { ok: false, error: "this turn carries no tenant, so no record can be read" };
      }
      const answer = await post(
        "/agent-tools/employees",
        { tenantId, query },
        context.abortSignal,
      );
      if (!answer.ok) return { ok: false, error: answer.error };
      return answer.payload as ToolResult<Record<string, unknown>>;
    },
  });

  const listTickets = createTool({
    id: "list_tickets",
    description:
      "List the tenant's real Jira tickets that belong to named workflow lanes, read from the board data itself rather than the cards on screen. "
      + "Call it when the user asks which tickets exist or wants to pick one to act on, for example \"list all HR tickets\". "
      + "The HR lanes are leave, onboarding, offboarding, screening, and hr-help; the other keyword-addressable lanes are issues, dependencies, accessibility, security, and vendors. "
      + "Pass the workflow ids (up to 8) and optionally a text needle to narrow by summary; omit both only when the lanes alone answer the question. "
      + "It reads only and never starts anything: give the user the ticket keys it returns and hand the launch to the console's confirm step.",
    inputSchema: z.object({
      workflows: z
        .array(z.string().min(1).max(40))
        .max(8)
        .optional()
        .describe(
          "Workflow lane ids to keep, for example [`leave`, `hr-help`]. Only tickets whose text matches one of these lanes are returned.",
        ),
      text: z
        .string()
        .max(200)
        .optional()
        .describe("Optional case-insensitive needle matched against each ticket summary and labels."),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Row cap for the answer; the default is 30."),
    }),
    outputSchema: TICKETS_OUTPUT_SCHEMA,
    execute: async ({ workflows, text, maxResults }, context) => {
      const tenantId = readTenant(context.requestContext);
      if (tenantId === undefined) {
        return { ok: false, error: "this turn carries no tenant, so no ticket can be read" };
      }
      const lanes = workflows ?? [];
      if (lanes.length === 0 && (text ?? "").trim() === "") {
        return {
          ok: false,
          error: "name the workflow lanes to list, or a text needle to search for",
        };
      }
      const body: Record<string, unknown> = { tenantId, workflows: lanes, text: text ?? "" };
      if (maxResults !== undefined) body.maxResults = maxResults;
      const answer = await post("/agent-tools/tickets", body, context.abortSignal);
      if (!answer.ok) return { ok: false, error: answer.error };
      return answer.payload as ToolResult<Record<string, unknown>>;
    },
  });

  // Keys equal the tool ids, which is how Mastra records them in the tools map.
  return {
    resolve_start_fields: resolveStartFields,
    lookup_employee: lookupEmployee,
    list_tickets: listTickets,
  };
}

/** The tool map type, without naming a Mastra internal. */
type ConsoleTools = ReturnType<typeof consolePrefillTools>;

/**
 * The tools, or `{}` when the console bridge is not configured.
 *
 * Both environment values must be set: a base URL without the token can only
 * answer 401, so attaching the tools would give the model two calls that always
 * fail instead of an honest "I cannot read the records in this build".
 */
export function consoleToolsFromEnv(): ConsoleTools | Record<string, never> {
  const baseUrl = process.env[BASE_URL_ENV]?.trim();
  const serviceToken = process.env[SERVICE_TOKEN_ENV]?.trim();
  const parts = [baseUrl, serviceToken].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  if (parts.length === 2) {
    return consolePrefillTools({
      baseUrl: baseUrl as string,
      serviceToken: serviceToken as string,
    });
  }
  if (parts.length === 1) {
    console.warn(
      `[mastra] ${BASE_URL_ENV} and ${SERVICE_TOKEN_ENV} must both be set;`
        + " the console assistant cannot resolve start fields, look up employees, or list tickets.",
    );
  }
  return {};
}

/** The tenant the serving plane put on this turn, or `undefined`. */
function readTenant(requestContext: ContextReader): string | undefined {
  const value = requestContext.get("tenantId");
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
