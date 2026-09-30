import { describe, expect, it } from "vitest";

import { MemoryDeskAdapter } from "../../desks/memory.js";
import type {
  DeskAdapter,
  DeskAttachment,
  DeskCapabilities,
  DeskComment,
  DeskCommentResult,
  DeskTicketDraft,
  DeskTicketRef,
  DeskTicketState,
} from "../../desks/types.js";
import { MemoryMailSender } from "../../mail/memory.js";
import type { MailSender, OutboundEmail } from "../../mail/types.js";
import { createAllRounderMastra } from "../../mastra.js";
import {
  ApproveArtifactSchema,
  DraftArtifactSchema,
  IntakeArtifactSchema,
  MSP_FLOW_STEPS,
  MspRunStateSchema,
  MspTicketReceiptSchema,
  SendArtifactSchema,
  TicketArtifactSchema,
  type DraftModelOutput,
  type MspPassage,
  type MspRunState,
} from "./contracts.js";
import type { MspDraftContext, MspKnowledge, MspKnowledgeScope, MspModel } from "./flow.js";

const PROCEED_HASH = "0".repeat(64);
const FIXED_NOW = new Date("2026-09-30T09:00:00.000Z");

const EMAIL = {
  messageId: "mail-1",
  from: "sam@acme.com.au",
  fromName: "Sam Turner",
  to: "acme@in.msp.example",
  subject: "VPN outage for three users",
  text: "Hi, the VPN keeps dropping for three of our users since this morning.",
  receivedAt: "2026-09-30T08:55:00.000Z",
} as const;

const PASSAGE: MspPassage = {
  sourceId: "kb/vpn-troubleshooting.md",
  span: "120-360",
  title: "VPN troubleshooting",
  text: "Drops for several users at once usually mean the gateway session limit was reached.",
  score: 0.62,
  stale: false,
};

class FakeModel implements MspModel {
  readonly draftCalls: MspDraftContext[] = [];

  async draft(context: MspDraftContext): Promise<DraftModelOutput> {
    this.draftCalls.push(context);
    const first = context.passages[0]!;
    return {
      body: `Thanks for the report. ${first.text} [${first.sourceId}:${first.span}]\n\nService desk`,
      citations: [{ sourceId: first.sourceId, span: first.span }],
    };
  }
}

/** Cites a source that was never retrieved: the draft must escalate. */
class GhostCitationModel implements MspModel {
  async draft(): Promise<DraftModelOutput> {
    return {
      body: "The fix is documented elsewhere [kb/ghost.md:1-10].",
      citations: [{ sourceId: "kb/ghost.md", span: "1-10" }],
    };
  }
}

/** Comes back too thin to send and without any citation. */
class ThinModel implements MspModel {
  async draft(): Promise<DraftModelOutput> {
    return { body: "Ok.", citations: [] };
  }
}

class FakeKnowledge implements MspKnowledge {
  readonly queries: { scope: MspKnowledgeScope; query: string }[] = [];

  constructor(private readonly passages: readonly MspPassage[]) {}

  async search(scope: MspKnowledgeScope, query: string): Promise<readonly MspPassage[]> {
    this.queries.push({ scope, query });
    return this.passages;
  }
}

/** Counts the side effects so replay tests can prove they never re-execute. */
class CountingDesk implements DeskAdapter {
  creates = 0;
  comments = 0;

  constructor(private readonly inner: DeskAdapter) {}

  get provider(): string {
    return this.inner.provider;
  }

  capabilities(): DeskCapabilities {
    return this.inner.capabilities();
  }

  createTicket(draft: DeskTicketDraft): Promise<DeskTicketRef> {
    this.creates += 1;
    return this.inner.createTicket(draft);
  }

  addComment(ref: DeskTicketRef, comment: DeskComment): Promise<DeskCommentResult> {
    this.comments += 1;
    return this.inner.addComment(ref, comment);
  }

  setStatus(ref: DeskTicketRef, status: string): Promise<DeskTicketRef> {
    return this.inner.setStatus(ref, status);
  }

  attachEvidence(ref: DeskTicketRef, attachment: DeskAttachment): Promise<DeskTicketRef> {
    return this.inner.attachEvidence(ref, attachment);
  }

  readTicket(ref: DeskTicketRef): Promise<DeskTicketState> {
    return this.inner.readTicket(ref);
  }
}

class CountingMailSender implements MailSender {
  sends = 0;
  readonly address: string;

  constructor(private readonly inner: MailSender) {
    this.address = inner.address;
  }

  send(mail: OutboundEmail) {
    this.sends += 1;
    return this.inner.send(mail);
  }
}

function harness(
  options: {
    desk?: DeskAdapter;
    mail?: MailSender;
    model?: MspModel;
    knowledge?: MspKnowledge;
  } = {},
) {
  const desk = options.desk ?? new MemoryDeskAdapter();
  const mail = options.mail ?? new MemoryMailSender({ now: () => FIXED_NOW });
  const model = options.model ?? new FakeModel();
  const knowledge = options.knowledge ?? new FakeKnowledge([PASSAGE]);
  const mastra = createAllRounderMastra({
    msp: { desk, mail, model, knowledge, now: () => FIXED_NOW },
  });
  const flow = mastra.getWorkflow("mspFlow");
  if (flow === undefined) throw new Error("mspFlow is not registered");
  return { desk, mail, model, knowledge, flow, mastra };
}

type MspFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<MspFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes. Suspend-payload effects are absorbed the
 * way the service merges them, so a re-drive sees every recorded side effect.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = { ...EMAIL };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "MS-7";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): MspRunState {
    return MspRunStateSchema.parse({
      runId: this.runId,
      workflow: "msp",
      ticketKey: this.ticketKey,
      caseId: "case-1",
      attempt: this.attempt,
      input: this.input,
      decisions: this.decisions,
      artifacts: this.artifacts,
      effects: this.effects,
    });
  }

  /** Record a decision the way `RunService.decide()` does, then build resume data. */
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): MspRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return MspRunStateSchema.parse({ ...this.envelope(), decision });
  }
}

interface SuspendView {
  artifact: Record<string, unknown>;
  target?: string;
  effects?: Record<string, Record<string, unknown>>;
}

function suspendView(outcome: unknown, stepId: string): SuspendView {
  const view = outcome as {
    status?: string;
    error?: unknown;
    suspendPayload?: Record<string, SuspendView | undefined>;
  };
  if (view.status !== "suspended") {
    const failure = view.error;
    const detail =
      typeof failure === "object" && failure !== null && "message" in failure
        ? String((failure as { message: unknown }).message)
        : String(view.error ?? view.status);
    throw new Error(`expected suspension at ${stepId}, got ${detail}`);
  }
  const payload = view.suspendPayload?.[stepId];
  if (payload?.artifact === undefined) {
    throw new Error(`no suspend payload for ${stepId}`);
  }
  return payload;
}

/**
 * From the suspension at `startIndex`, store each artifact and proceed until
 * the flow suspends at `stopAt`. Every suspend payload's effects are absorbed
 * into the walk, mirroring the API's merge of `_suspend_effects`.
 */
async function runForward(
  run: WorkflowRunHandle,
  walk: Walk,
  startIndex: number,
  currentPayload: SuspendView,
  stopAt: (typeof MSP_FLOW_STEPS)[number],
): Promise<SuspendView> {
  let payload = currentPayload;
  for (let index = startIndex; index < MSP_FLOW_STEPS.length; index += 1) {
    const stepId = MSP_FLOW_STEPS[index]!;
    walk.artifacts[stepId] = payload.artifact;
    if (payload.effects !== undefined) walk.effects = { ...walk.effects, ...payload.effects };
    if (stepId === stopAt) return payload;
    const outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
    payload = suspendView(outcome, MSP_FLOW_STEPS[index + 1]!);
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

interface WalkOptions {
  desk?: DeskAdapter;
  mail?: MailSender;
  model?: MspModel;
  knowledge?: MspKnowledge;
  walk?: Walk;
}

/** Drive the flow from the start until it suspends at `stopAt`. */
async function walkWith(
  options: WalkOptions,
  stopAt: (typeof MSP_FLOW_STEPS)[number],
) {
  const h = harness(options);
  const walk = options.walk ?? new Walk();
  const run = await h.flow.createRun();
  const first = suspendView(await run.start({ inputData: walk.envelope() }), MSP_FLOW_STEPS[0]);
  const payload = await runForward(run, walk, 0, first, stopAt);
  return { ...h, walk, run, payload };
}

function requireArtifact(walk: Walk, stepId: string): Record<string, unknown> {
  const artifact = walk.artifacts[stepId];
  if (artifact === undefined) throw new Error(`${stepId} artifact missing from the walk`);
  return artifact;
}

interface CompletionResult {
  status?: string;
  error?: unknown;
  result?: {
    receipt?: Record<string, unknown>;
    effects?: Record<string, Record<string, unknown>>;
  };
}

/** Resume the send checkpoint and absorb the completed run's effects. */
async function finish(run: WorkflowRunHandle, walk: Walk): Promise<CompletionResult> {
  const done = (await run.resume({
    resumeData: walk.resume(MSP_FLOW_STEPS[4], "proceed", { actionHash: PROCEED_HASH }),
  })) as CompletionResult;
  const effects = done.result?.effects;
  if (effects !== undefined) walk.effects = { ...walk.effects, ...effects };
  return done;
}

/** Extract the failure message from a step failure the way the API would see it. */
async function failureMessage(outcomePromise: Promise<unknown>): Promise<string> {
  try {
    const outcome = (await outcomePromise) as { status?: string; error?: unknown };
    if (outcome.status === "failed") {
      const failure = outcome.error as { message?: unknown };
      return typeof failure?.message === "string" ? failure.message : String(outcome.error);
    }
    return `status ${outcome.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Mastra mspFlow", () => {
  it("registers named msp steps in order", () => {
    const { flow, mastra } = harness();
    expect(flow.id).toBe("mspFlow");
    expect(Object.keys(flow.steps)).toEqual([...MSP_FLOW_STEPS]);
    expect(mastra.getAgent("mspDrafter").id).toBe("msp-drafter");
  });

  it("suspends at intake with the client ref derived from the ingest address", async () => {
    const { flow } = harness();
    const walk = new Walk();
    const run = await flow.createRun();
    const payload = suspendView(await run.start({ inputData: walk.envelope() }), "intake");
    const artifact = IntakeArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("msp:MS-7");
    expect(payload.effects).toEqual({});
    expect(artifact.caseId).toBe("case-1");
    expect(artifact.ticketKey).toBe("MS-7");
    expect(artifact.messageId).toBe("mail-1");
    expect(artifact.from).toBe("sam@acme.com.au");
    expect(artifact.fromName).toBe("Sam Turner");
    expect(artifact.clientRef).toBe("acme");
    expect(artifact.receivedAt).toBe("2026-09-30T08:55:00.000Z");
    expect(artifact.summary).toBe("Inbound client email from sam@acme.com.au for client acme.");
  });

  it("scopes the knowledge lookup to the tenant and client", async () => {
    const scoped = new FakeKnowledge([PASSAGE]);
    const walk = new Walk({
      input: { ...EMAIL, clientRef: "northside", tenantId: "tenant-a" },
    });
    await walkWith({ knowledge: scoped, walk }, "draft");

    expect(scoped.queries).toHaveLength(1);
    expect(scoped.queries[0]?.scope).toEqual({ tenantId: "tenant-a", clientRef: "northside" });
    expect(scoped.queries[0]?.query).toContain("VPN outage for three users");

    const derived = new FakeKnowledge([PASSAGE]);
    await walkWith({ knowledge: derived }, "draft");

    expect(derived.queries[0]?.scope).toEqual({ tenantId: null, clientRef: "acme" });
  });

  it("creates the desk ticket once and carries its effect in the draft suspension", async () => {
    const desk = new CountingDesk(new MemoryDeskAdapter());
    const { walk, payload } = await walkWith({ desk }, "draft");
    const draft = DraftArtifactSchema.parse(payload.artifact);
    const ticket = TicketArtifactSchema.parse(requireArtifact(walk, "ticket"));

    expect(ticket.provider).toBe("memory");
    expect(ticket.title).toBe("[acme] VPN outage for three users");
    expect(ticket.labels).toEqual(["email-intake", "acme"]);
    expect(ticket.correlationId).toBe("msp:case-1:MS-7");
    expect(ticket.existing).toBeNull();
    expect(ticket.summary).toBe("Creates the memory ticket for case case-1.");

    expect(desk.creates).toBe(1);
    const receipt = MspTicketReceiptSchema.parse(walk.effects["ticket"]?.receipt);
    expect(receipt.deskRef.key).toBe("MSP-1");
    expect(receipt.provider).toBe("memory");
    expect(receipt.createdAt).toBe(FIXED_NOW.toISOString());
    // The draft suspension carries the ticket effect, so a re-drive learns
    // about the created ticket before the run reaches its send step.
    expect(payload.effects?.["ticket"]?.receipt).toEqual(receipt);

    expect(draft.subject).toBe("Re: VPN outage for three users");
    expect(draft.escalated).toBe(false);
    expect(draft.escalations).toEqual([]);
    expect(draft.passageCount).toBe(1);
    expect(draft.staleCount).toBe(0);
    expect(draft.body).toContain("[kb/vpn-troubleshooting.md:120-360]");
    expect(draft.citations).toEqual([{ sourceId: "kb/vpn-troubleshooting.md", span: "120-360" }]);
    expect(draft.summary).toBe("Drafted a cited reply with 1 citation(s) from 1 passage(s).");
  });

  it("suspends at approve with the service-desk checkpoint", async () => {
    const { payload } = await walkWith({}, "approve");
    const artifact = ApproveArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("msp:MS-7");
    expect(artifact.approverRole).toBe("service-desk-tech");
    expect(artifact.approverLabel).toBe("Service desk tech on duty");
    expect(artifact.slaHours).toBe(4);
    expect(artifact.state).toBe("pending");
    expect(artifact.requestedAt).toBe(FIXED_NOW.toISOString());
    expect(artifact.decidedAt).toBeNull();
    expect(artifact.summary).toBe(
      "Service desk tech on duty approval requested for the client reply to acme.",
    );
  });

  it("suspends at send with the reply plan and completes with the receipt", async () => {
    const innerMail = new MemoryMailSender({ now: () => FIXED_NOW });
    const mail = new CountingMailSender(innerMail);
    const desk = new CountingDesk(new MemoryDeskAdapter());
    const { run, walk, payload } = await walkWith({ desk, mail }, "send");
    const send = SendArtifactSchema.parse(payload.artifact);

    expect(payload.target).toBe("msp:MS-7");
    expect(send.to).toBe("sam@acme.com.au");
    expect(send.subject).toBe("Re: VPN outage for three users");
    expect(send.from).toBe("service-desk@msp.local");
    expect(send.deskKey).toBe("MSP-1");
    expect(send.idempotencyKey).toBe("msp-send:case-1:MS-7");
    expect(send.summary).toBe(
      "Sends the approved reply to sam@acme.com.au; idempotent by case and ticket.",
    );

    walk.artifacts["send"] = payload.artifact;
    const done = await finish(run, walk);
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toMatchObject({
      caseId: "case-1",
      ticketKey: "MS-7",
      clientRef: "acme",
      deskKey: "MSP-1",
      to: "sam@acme.com.au",
      subject: "Re: VPN outage for three users",
      mailCreated: true,
      commentPosted: true,
      commentId: "c-1",
      escalations: [],
      completedAt: FIXED_NOW.toISOString(),
    });
    expect(done.result?.receipt?.mailMessageId).toMatch(/^<.+@memory\.local>$/);
    expect(done.result?.effects?.send?.receipt).toEqual(done.result?.receipt);
    expect(mail.sends).toBe(1);
    expect(desk.comments).toBe(1);

    const sent = innerMail.outbox[0]!;
    expect(sent.inReplyTo).toBe("mail-1");
    expect(sent.subject).toBe("Re: VPN outage for three users");
    expect(sent.body).toContain("Thanks for the report.");
    expect(sent.body).toContain("[kb/vpn-troubleshooting.md:120-360]");
  });

  it("does not re-execute a send whose effect is already recorded", async () => {
    const innerMail = new MemoryMailSender({ now: () => FIXED_NOW });
    const mail = new CountingMailSender(innerMail);
    const desk = new CountingDesk(new MemoryDeskAdapter());
    const { run, walk, payload } = await walkWith({ desk, mail }, "send");
    walk.artifacts["send"] = payload.artifact;

    const seeded = {
      caseId: "case-1",
      ticketKey: "MS-7",
      clientRef: "acme",
      deskKey: "MSP-1",
      to: "sam@acme.com.au",
      subject: "Re: VPN outage for three users",
      mailArtifact: "memory:msp-send:case-1:MS-7",
      mailMessageId: "<seed@memory.local>",
      mailCreated: true,
      commentId: "c-1",
      commentPosted: true,
      escalations: [],
      completedAt: FIXED_NOW.toISOString(),
    };
    walk.effects["send"] = { actionHash: PROCEED_HASH, receipt: seeded };

    const done = await finish(run, walk);
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toEqual(seeded);
    expect(mail.sends).toBe(0);
    expect(desk.comments).toBe(0);
    expect(innerMail.outbox).toHaveLength(0);
  });

  it("replays a back to the ticket step without creating a second ticket", async () => {
    const desk = new CountingDesk(new MemoryDeskAdapter());
    const { flow, walk } = await walkWith({ desk }, "draft");
    const ticketEffect = walk.effects["ticket"]!;
    expect(desk.creates).toBe(1);

    // The human sends the run back to the ticket step: decisions from ticket
    // on are dropped, recorded effects stay (the run service's back semantics).
    delete walk.decisions["ticket"];
    delete walk.artifacts["ticket"];

    // The re-drive keeps the intake decision, so the fresh run suspends at the
    // ticket step again with the recorded ticket already visible in the plan.
    const run2 = await flow.createRun();
    const ticket2 = suspendView(await run2.start({ inputData: walk.envelope() }), "ticket");
    const plan = TicketArtifactSchema.parse(ticket2.artifact);
    expect(plan.existing?.key).toBe("MSP-1");
    expect(plan.summary).toBe("Ticket MSP-1 already exists for case case-1; the create replays.");
    expect(ticket2.effects?.["ticket"]).toEqual(ticketEffect);

    const draft2 = suspendView(
      await run2.resume({
        resumeData: walk.resume("ticket", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "draft",
    );
    expect(desk.creates).toBe(1);
    expect(walk.effects["ticket"]).toEqual(ticketEffect);
    expect(DraftArtifactSchema.parse(draft2.artifact).caseId).toBe("case-1");
  });

  it("escalates an empty retrieval and refuses to send the unedited draft", async () => {
    const mail = new CountingMailSender(new MemoryMailSender({ now: () => FIXED_NOW }));
    const { run, walk } = await walkWith({ mail, knowledge: new FakeKnowledge([]) }, "send");
    const draft = DraftArtifactSchema.parse(requireArtifact(walk, "draft"));

    expect(draft.escalated).toBe(true);
    expect(draft.escalations).toEqual(["empty_retrieval"]);
    expect(draft.body).toBe("");
    expect(draft.passageCount).toBe(0);
    expect(draft.summary).toBe(
      "Reply draft escalated (empty_retrieval); a human edit is needed before it can be sent.",
    );

    walk.artifacts["send"] = requireArtifact(walk, "send");
    const blocked = await run.resume({
      resumeData: walk.resume("send", "proceed", { actionHash: PROCEED_HASH }),
    });
    expect(await failureMessage(Promise.resolve(blocked))).toContain(
      "edit the draft before sending",
    );
    expect(mail.sends).toBe(0);
  });

  it("lets a human edit carry an escalated draft through the send", async () => {
    const innerMail = new MemoryMailSender({ now: () => FIXED_NOW });
    const mail = new CountingMailSender(innerMail);
    const { run, walk } = await walkWith(
      { mail, knowledge: new FakeKnowledge([]) },
      "draft",
    );
    const editedBody =
      "Thanks for the note. We checked the line from our side and reset the session limit.\n\nService desk";

    const resumed = suspendView(
      await run.resume({
        resumeData: walk.resume("draft", "edit", {
          edits: { body: editedBody },
          actionHash: PROCEED_HASH,
        }),
      }),
      "approve",
    );
    expect(ApproveArtifactSchema.parse(resumed.artifact).state).toBe("pending");
    const approvePayload = await runForward(run, walk, 3, resumed, "send");
    walk.artifacts["send"] = approvePayload.artifact;

    const done = await finish(run, walk);
    expect(done.status).toBe("success");
    expect(done.result?.receipt).toMatchObject({
      mailCreated: true,
      commentPosted: true,
      escalations: ["empty_retrieval"],
    });
    expect(mail.sends).toBe(1);
    expect(innerMail.outbox[0]?.body).toBe(editedBody);

    const approve = ApproveArtifactSchema.parse(requireArtifact(walk, "approve"));
    expect(approve.summary).toBe(
      "Service desk tech on duty approval requested for the client reply · 1 escalation(s) need a decision.",
    );
  });

  it("escalates a citation that was not retrieved", async () => {
    const { walk } = await walkWith({ model: new GhostCitationModel() }, "draft");
    const draft = DraftArtifactSchema.parse(requireArtifact(walk, "draft"));

    expect(draft.escalated).toBe(true);
    expect(draft.escalations).toEqual(["unsupported_claim"]);
    expect(draft.body).toContain("[kb/ghost.md:1-10]");
    expect(draft.summary).toBe(
      "Reply draft escalated (unsupported_claim); a human edit is needed before it can be sent.",
    );
  });

  it("escalates stale evidence without drafting from it", async () => {
    const model = new FakeModel();
    const { walk } = await walkWith(
      { model, knowledge: new FakeKnowledge([{ ...PASSAGE, stale: true }]) },
      "draft",
    );
    const draft = DraftArtifactSchema.parse(requireArtifact(walk, "draft"));

    expect(draft.escalations).toEqual(["stale_evidence"]);
    expect(draft.staleCount).toBe(1);
    expect(draft.body).toBe("");
    expect(model.draftCalls).toHaveLength(0);
  });

  it("escalates a draft that comes back too thin to send", async () => {
    const { walk } = await walkWith({ model: new ThinModel() }, "draft");
    const draft = DraftArtifactSchema.parse(requireArtifact(walk, "draft"));

    expect(draft.escalations).toEqual(["empty_draft", "unsupported_claim"]);
    expect(draft.body).toBe("Ok.");
  });
});
