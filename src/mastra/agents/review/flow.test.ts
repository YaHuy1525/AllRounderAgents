import { describe, expect, it } from "vitest";

import { createAllRounderMastra } from "../../mastra.js";
import {
  REVIEW_CATEGORIES,
  REVIEW_FLOW_STEPS,
  ReviewModelOutputSchema,
  ReviewRunStateSchema,
  type PullRequestCandidate,
  type ReviewFlowStepId,
  type ReviewModelOutput,
  type ReviewRunState,
} from "./contracts.js";
import { type ReviewModel } from "./flow.js";
import { reviewReviewerScenarios } from "./agents/index.js";
import type {
  PostReviewRequest,
  PostedReview,
  ReviewFile,
  ReviewReader,
  ReviewWriter,
} from "./tools/github-review.js";

const HEAD_SHA = "a".repeat(40);
const PREVIOUS_SHA = "b".repeat(40);
const PROCEED_HASH = "0".repeat(64);

const PR: PullRequestCandidate = {
  number: 7,
  title: "Harden refund endpoint",
  repository: "acme/app",
  author: "dev",
  baseBranch: "main",
  headSha: HEAD_SHA,
  draft: false,
};

const REVIEW_FILE: ReviewFile = {
  path: "src/api/refunds.ts",
  status: "modified",
  additions: 4,
  deletions: 1,
  patch: "@@ -10,3 +10,4 @@\n+  await authorize(request);\n   await payments.refund(order.id);",
};

function reviewOutput(overrides: Partial<ReviewModelOutput> = {}): ReviewModelOutput {
  return {
    verdict: "request_changes",
    confidence: 0.82,
    summary: "The handler refunds before authorizing the caller.",
    strengths: ["Reuses the payments client."],
    improvements: ["Authorize before touching the payment."],
    comments: [{ path: "src/api/refunds.ts", line: 11, body: "Authorize before refunding." }],
    ...overrides,
  };
}

class FakeReviewReader implements ReviewReader {
  candidates: PullRequestCandidate[] = [PR];
  files: ReviewFile[] = [REVIEW_FILE];
  readonly compareCalls: Array<[string, string, string]> = [];
  readonly pullFilesCalls: number[] = [];

  async listCandidates(_repository: string, _limit: number): Promise<PullRequestCandidate[]> {
    return [...this.candidates];
  }

  async pull(_repository: string, _number: number): Promise<PullRequestCandidate> {
    return PR;
  }

  async pullFiles(_repository: string, number: number): Promise<ReviewFile[]> {
    this.pullFilesCalls.push(number);
    return [...this.files];
  }

  async compare(repository: string, base: string, head: string): Promise<ReviewFile[]> {
    this.compareCalls.push([repository, base, head]);
    return [...this.files];
  }
}

class FakeReviewWriter implements ReviewWriter {
  readonly posts: PostReviewRequest[] = [];

  async postReview(request: PostReviewRequest): Promise<PostedReview> {
    this.posts.push(request);
    return {
      reviewId: `review-${this.posts.length}`,
      url: `https://github.com/acme/app/pull/7#pullrequestreview-${this.posts.length}`,
    };
  }
}

/** Candidates scoped to the requested repository, so parallel runs stay distinguishable. */
class RepoScopedReader extends FakeReviewReader {
  override async listCandidates(repository: string): Promise<PullRequestCandidate[]> {
    return [{ ...PR, repository }];
  }

  override async pull(repository: string): Promise<PullRequestCandidate> {
    return { ...PR, repository };
  }
}

function harness(
  options: { reader?: FakeReviewReader; writer?: FakeReviewWriter; model?: ReviewModel } = {},
) {
  const reader = options.reader ?? new FakeReviewReader();
  const writer = options.writer ?? new FakeReviewWriter();
  const mastra = createAllRounderMastra({
    review: {
      github: { reader, writer },
      model: options.model ?? { review: async () => reviewOutput() },
      candidateLimit: 10,
    },
  });
  const flow = mastra.getWorkflow("reviewFlow");
  if (flow === undefined) throw new Error("reviewFlow is not registered");
  return { reader, writer, flow, mastra };
}

type ReviewFlowHandle = ReturnType<typeof harness>["flow"];
type WorkflowRunHandle = Awaited<ReturnType<ReviewFlowHandle["createRun"]>>;

/**
 * Minimal stand-in for the API run service: owns the authoritative
 * decision/artifact/effect maps and builds the exact envelopes the service
 * sends on start and resume passes.
 */
class Walk {
  readonly decisions: Record<string, Record<string, unknown>> = {};
  readonly artifacts: Record<string, Record<string, unknown>> = {};
  readonly effects: Record<string, Record<string, unknown>> = {};
  input: Record<string, unknown> = { repository: "acme/app", prNumber: 7 };
  attempt = 1;
  private readonly runId: string;
  private readonly ticketKey: string;

  constructor(
    identity: { runId?: string; ticketKey?: string; input?: Record<string, unknown> } = {},
  ) {
    this.runId = identity.runId ?? "run-1";
    this.ticketKey = identity.ticketKey ?? "ABC-1";
    if (identity.input !== undefined) this.input = identity.input;
  }

  envelope(): ReviewRunState {
    return ReviewRunStateSchema.parse({
      runId: this.runId,
      workflow: "review",
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
  resume(stepId: string, action: string, extra: Record<string, unknown> = {}): ReviewRunState {
    const decision = { action, ...extra };
    this.decisions[stepId] = decision;
    return ReviewRunStateSchema.parse({ ...this.envelope(), decision });
  }
}

interface SuspendView {
  artifact: Record<string, unknown>;
  target?: string;
}

function suspendView(outcome: unknown, stepId: string): SuspendView {
  const view = outcome as {
    status?: string;
    suspendPayload?: Record<string, SuspendView | undefined>;
  };
  if (view.status !== "suspended") {
    throw new Error(`expected suspension at ${stepId}, got ${String(view.status)}`);
  }
  const payload = view.suspendPayload?.[stepId];
  if (payload?.artifact === undefined) {
    throw new Error(`no suspend payload for ${stepId}`);
  }
  return payload;
}

/** Drive the flow from the start until it suspends at `stopAt`, proceeding every earlier step. */
async function walkTo(
  flow: ReviewFlowHandle,
  walk: Walk,
  stopAt: ReviewFlowStepId,
): Promise<{ run: WorkflowRunHandle; payload: SuspendView; payloads: Record<string, SuspendView> }> {
  const payloads: Record<string, SuspendView> = {};
  const run = await flow.createRun();
  let outcome: unknown = await run.start({ inputData: walk.envelope() });
  for (const stepId of REVIEW_FLOW_STEPS) {
    const payload = suspendView(outcome, stepId);
    payloads[stepId] = payload;
    walk.artifacts[stepId] = payload.artifact;
    if (stepId === stopAt) return { run, payload, payloads };
    outcome = await run.resume({
      resumeData: walk.resume(stepId, "proceed", { actionHash: PROCEED_HASH }),
    });
  }
  throw new Error(`flow never suspended at ${stopAt}`);
}

describe("Mastra reviewFlow", () => {
  it("registers named review steps in order", () => {
    const { flow } = harness();
    expect(flow.id).toBe("reviewFlow");
    expect(Object.keys(flow.steps)).toEqual([...REVIEW_FLOW_STEPS]);
  });

  it("registers the reviewer agent on the AllRounder Mastra instance", () => {
    const { mastra } = harness();
    expect(mastra.getAgent("reviewReviewer").id).toBe("review-reviewer");
  });

  it("keeps the reviewer few-shot scenarios on-contract", () => {
    for (const scenario of reviewReviewerScenarios) {
      expect(ReviewModelOutputSchema.safeParse(scenario.expectedOutput).success).toBe(true);
    }
  });

  it("suspends at every step and posts exactly one review after the complete checkpoint", async () => {
    const { flow, writer, reader } = harness();
    const walk = new Walk();
    const { run, payload: select } = await walkTo(flow, walk, "select-pr");
    expect(select.artifact).toMatchObject({ repository: "acme/app" });
    expect(select.artifact.selected).toMatchObject({ number: 7, headSha: HEAD_SHA });
    expect(select.target).toBe("pr:acme/app#7");

    const options = suspendView(
      await run.resume({ resumeData: walk.resume("select-pr", "proceed", { actionHash: PROCEED_HASH }) }),
      "review-options",
    );
    const categories = options.artifact.categories as Array<{ id: string; enabled: boolean }>;
    expect(categories.map((category) => category.id)).toEqual(
      REVIEW_CATEGORIES.map((category) => category.id),
    );
    expect(categories.every((category) => category.enabled)).toBe(true);
    expect(options.artifact.guidance).toBe("");
    expect(options.target).toBe("pr:acme/app#7");
    walk.artifacts["review-options"] = options.artifact;

    const review = suspendView(
      await run.resume({
        resumeData: walk.resume("review-options", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "ai-review",
    );
    expect(review.artifact).toMatchObject({
      verdict: "request_changes",
      confidence: 0.82,
      deltaOnly: false,
      reviewedSha: HEAD_SHA,
    });
    expect(review.artifact.comments).toHaveLength(1);
    expect(reader.pullFilesCalls).toEqual([7]);
    walk.artifacts["ai-review"] = review.artifact;

    const complete = suspendView(
      await run.resume({
        resumeData: walk.resume("ai-review", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "complete",
    );
    expect(complete.artifact.followUp).toEqual({
      reviewedSha: HEAD_SHA,
      deltaOnlyOnNewPush: true,
    });
    expect(writer.posts).toHaveLength(0); // nothing posted before the checkpoint decision
    walk.artifacts["complete"] = complete.artifact;

    const done = await run.resume({
      resumeData: walk.resume("complete", "proceed", { actionHash: "3".repeat(64) }),
    });
    expect(done.status).toBe("success");
    if (done.status !== "success") throw new Error("expected success");
    expect(done.result.status).toBe("completed");
    expect(done.result.receipt).toMatchObject({
      reviewId: "review-1",
      verdict: "request_changes",
      repository: "acme/app",
      prNumber: 7,
      reviewedSha: HEAD_SHA,
      postedComments: [{ path: "src/api/refunds.ts", line: 11 }],
    });
    expect(done.result.effects["complete"]?.actionHash).toBe("3".repeat(64));
    expect(writer.posts).toHaveLength(1);
    expect(writer.posts[0]).toMatchObject({
      repository: "acme/app",
      number: 7,
      commitSha: HEAD_SHA,
      verdict: "request_changes",
    });
    expect(writer.posts[0]?.body).toContain("Changes requested");
    expect(writer.posts[0]?.body).toContain("Authorize before touching the payment.");
    expect(writer.posts[0]?.comments).toHaveLength(1);
  });

  it("keeps three concurrent review runs on disjoint state", async () => {
    const repos = ["acme/app", "acme/lib", "acme/cli"];
    const reader = new RepoScopedReader();
    const writer = new FakeReviewWriter();
    const model: ReviewModel = {
      review: async (context) =>
        reviewOutput({ summary: `Review for ${context.pullRequest.repository}` }),
    };
    const { flow } = harness({ reader, writer, model });
    const walks = repos.map(
      (repository, index) =>
        new Walk({
          runId: `run-${index + 1}`,
          ticketKey: `ABC-${index + 1}`,
          input: { repository, prNumber: 7 },
        }),
    );

    const starts = await Promise.all(walks.map((walk) => walkTo(flow, walk, "select-pr")));
    starts.forEach((started, index) => {
      expect(started.payload.artifact.repository).toBe(repos[index]);
      expect(started.payload.artifact.selected).toMatchObject({ repository: repos[index] });
      const candidates = started.payload.artifact.candidates as Array<{ repository: string }>;
      expect(candidates.map((candidate) => candidate.repository)).toEqual([repos[index]]);
    });

    async function driveToCompletion(
      run: WorkflowRunHandle,
      walk: Walk,
      current: ReviewFlowStepId,
      actionHash: string,
    ): Promise<Record<string, unknown>> {
      let outcome: unknown = await run.resume({
        resumeData: walk.resume(current, "proceed", { actionHash: PROCEED_HASH }),
      });
      if (current === "select-pr") {
        const options = suspendView(outcome, "review-options");
        walk.artifacts["review-options"] = options.artifact;
        outcome = await run.resume({
          resumeData: walk.resume("review-options", "proceed", { actionHash: PROCEED_HASH }),
        });
      }
      if (current !== "ai-review") {
        const review = suspendView(outcome, "ai-review");
        walk.artifacts["ai-review"] = review.artifact;
        outcome = await run.resume({
          resumeData: walk.resume("ai-review", "proceed", { actionHash: PROCEED_HASH }),
        });
      }
      const complete = suspendView(outcome, "complete");
      walk.artifacts["complete"] = complete.artifact;
      outcome = await run.resume({
        resumeData: walk.resume("complete", "proceed", { actionHash }),
      });
      const done = outcome as {
        status?: string;
        result?: { status?: string; receipt?: Record<string, unknown> };
      };
      if (done.status !== "success" || done.result?.receipt === undefined) {
        throw new Error("run did not complete");
      }
      return done.result.receipt;
    }

    // Run 3 races ahead to the AI review while runs 1 and 2 sit at their own checkpoints.
    const third = starts[2];
    if (third === undefined) throw new Error("missing third start");
    const thirdOptions = suspendView(
      await third.run.resume({
        resumeData: walks[2]!.resume("select-pr", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "review-options",
    );
    expect(thirdOptions.artifact.pullRequest).toMatchObject({ repository: "acme/cli" });
    walks[2]!.artifacts["review-options"] = thirdOptions.artifact;
    const thirdReview = suspendView(
      await third.run.resume({
        resumeData: walks[2]!.resume("review-options", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "ai-review",
    );
    expect(thirdReview.artifact.summary).toBe("Review for acme/cli");
    walks[2]!.artifacts["ai-review"] = thirdReview.artifact;

    const firstReceipt = await driveToCompletion(
      starts[0]!.run,
      walks[0]!,
      "select-pr",
      "1".repeat(64),
    );
    const secondReceipt = await driveToCompletion(
      starts[1]!.run,
      walks[1]!,
      "select-pr",
      "2".repeat(64),
    );
    const thirdReceipt = await driveToCompletion(third.run, walks[2]!, "ai-review", "3".repeat(64));

    // Each run posted exactly its own review; no cross-run state leaked.
    expect(firstReceipt).toMatchObject({ repository: "acme/app", prNumber: 7 });
    expect(secondReceipt).toMatchObject({ repository: "acme/lib" });
    expect(thirdReceipt).toMatchObject({ repository: "acme/cli" });
    expect(writer.posts).toHaveLength(3);
    const posted = writer.posts.map((post) => `${post.repository}#${post.number}`).sort();
    expect(posted).toEqual(["acme/app#7", "acme/cli#7", "acme/lib#7"]);
  });

  it("replays an identical completed action from the recorded effect without posting again", async () => {
    const model: ReviewModel = {
      review: async () => {
        throw new Error("the model must not run on a fully decided replay");
      },
    };
    const { flow, writer } = harness({ model });
    const walk = new Walk();
    const actionHash = "9".repeat(64);
    const completeArtifact = {
      pullRequest: PR,
      verdict: "approve",
      confidence: 0.9,
      summary: "Looks good.",
      strengths: [],
      improvements: [],
      comments: [],
      deltaOnly: false,
      reviewedSha: HEAD_SHA,
      followUp: { reviewedSha: HEAD_SHA, deltaOnlyOnNewPush: true },
    };
    walk.decisions["select-pr"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["review-options"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["ai-review"] = { action: "proceed", actionHash: PROCEED_HASH };
    walk.decisions["complete"] = { action: "proceed", actionHash };
    walk.artifacts["select-pr"] = {
      repository: "acme/app",
      candidates: [PR],
      selected: PR,
    };
    walk.artifacts["review-options"] = {
      pullRequest: PR,
      categories: REVIEW_CATEGORIES.map(({ id, label }) => ({ id, label, enabled: true })),
      guidance: "",
    };
    walk.artifacts["ai-review"] = {
      pullRequest: PR,
      verdict: "approve",
      confidence: 0.9,
      summary: "Looks good.",
      strengths: [],
      improvements: [],
      comments: [],
      categories: ["code-quality"],
      deltaOnly: false,
      reviewedSha: HEAD_SHA,
    };
    walk.artifacts["complete"] = completeArtifact;
    walk.effects["complete"] = {
      actionHash,
      receipt: {
        reviewId: "review-9",
        url: "https://github.com/acme/app/pull/7#pullrequestreview-9",
        verdict: "approve",
        repository: "acme/app",
        prNumber: 7,
        reviewedSha: HEAD_SHA,
        postedComments: [],
      },
    };
    const run = await flow.createRun();
    const started = await run.start({ inputData: walk.envelope() });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("expected success");
    expect(started.result.receipt).toMatchObject({ reviewId: "review-9", verdict: "approve" });
    expect(writer.posts).toHaveLength(0);
  });

  it("merges inline edits over the cached artifact before posting", async () => {
    const { flow, writer } = harness();
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "complete");
    const resumed = await run.resume({
      resumeData: walk.resume("complete", "edit", {
        edits: { summary: "Edited summary from the reviewer." },
        actionHash: "5".repeat(64),
      }),
    });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") throw new Error("expected success");
    expect(writer.posts[0]?.body).toContain("Edited summary from the reviewer.");
    expect(writer.posts[0]?.body).not.toContain("The handler refunds before authorizing");
    expect(resumed.result.effects["complete"]?.actionHash).toBe("5".repeat(64));
  });

  it("recomputes the AI review with custom guidance on regenerate, then advances on proceed", async () => {
    const guidanceCalls: Array<string | undefined> = [];
    const model: ReviewModel = {
      review: async (context) => {
        guidanceCalls.push(context.guidance);
        return reviewOutput();
      },
    };
    const { flow, writer } = harness({ model });
    const walk = new Walk();
    const { run } = await walkTo(flow, walk, "ai-review");
    expect(guidanceCalls).toEqual([undefined]);

    const regenerated = suspendView(
      await run.resume({
        resumeData: walk.resume("ai-review", "regenerate", {
          guidance: "Focus on error handling.",
          regenerations: 1,
        }),
      }),
      "ai-review",
    );
    expect(guidanceCalls).toEqual([undefined, "Focus on error handling."]);
    expect(regenerated.target).toBe("pr:acme/app#7");
    walk.artifacts["ai-review"] = regenerated.artifact;

    const next = suspendView(
      await run.resume({
        resumeData: walk.resume("ai-review", "proceed", { actionHash: PROCEED_HASH }),
      }),
      "complete",
    );
    expect(next.artifact.verdict).toBe("request_changes");
    expect(writer.posts).toHaveLength(0);
  });

  it("re-derives from the re-opened step when a back decision restarts the run", async () => {
    const { flow } = harness();
    const first = new Walk();
    const { payloads } = await walkTo(flow, first, "complete");

    // Back from ai-review invalidates review-options onward: a fresh attempt
    // carries only the earlier decisions/artifacts.
    const second = new Walk();
    second.attempt = 2;
    second.decisions["select-pr"] = { action: "proceed", actionHash: PROCEED_HASH };
    second.artifacts["select-pr"] = payloads["select-pr"]!.artifact;
    const restarted = await flow.createRun();
    const outcome = await restarted.start({ inputData: second.envelope() });
    const payload = suspendView(outcome, "review-options");
    expect(payload.target).toBe("pr:acme/app#7");
  });

  it("fails a proceed when no pull request was selected", async () => {
    const reader = new FakeReviewReader();
    reader.candidates = [];
    const { flow } = harness({ reader });
    const walk = new Walk();
    walk.input = { repository: "acme/app" };
    const run = await flow.createRun();
    const started = await run.start({ inputData: walk.envelope() });
    const payload = suspendView(started, "select-pr");
    expect(payload.artifact.selected).toBeNull();
    expect(payload.target).toBeUndefined();
    walk.artifacts["select-pr"] = payload.artifact;

    let message = "";
    try {
      const outcome = await run.resume({
        resumeData: walk.resume("select-pr", "proceed", { actionHash: PROCEED_HASH }),
      });
      if (outcome.status === "failed") {
        // Mastra serializes step failures as a plain { message, name } record.
        const failure = outcome.error as { message?: unknown };
        message = typeof failure.message === "string" ? failure.message : String(outcome.error);
      } else {
        message = `status ${outcome.status}`;
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Select a pull request");
  });

  it("reviews only new pushes and filters comments to the changed files", async () => {
    const reader = new FakeReviewReader();
    const model: ReviewModel = {
      review: async (context) => {
        expect(context.deltaOnly).toBe(true);
        expect(context.changedFiles).toHaveLength(1);
        return reviewOutput({
          comments: [
            { path: "src/api/refunds.ts", line: 11, body: "On a changed file." },
            { path: "src/legacy/old.ts", line: 3, body: "On an unchanged file." },
          ],
        });
      },
    };
    const { flow } = harness({ reader, model });
    const walk = new Walk();
    walk.input = { repository: "acme/app", prNumber: 7, lastReviewedSha: PREVIOUS_SHA };
    const { payload } = await walkTo(flow, walk, "ai-review");
    expect(reader.compareCalls).toEqual([["acme/app", PREVIOUS_SHA, HEAD_SHA]]);
    expect(reader.pullFilesCalls).toEqual([]);
    expect(payload.artifact.deltaOnly).toBe(true);
    expect(payload.artifact.comments).toHaveLength(1);
    expect(payload.artifact.comments).toMatchObject([{ path: "src/api/refunds.ts" }]);
  });
});
