import {
  RepositoryPolicyError,
  type GitHubPolicy,
  type GitHubTransport,
} from "../../programming/tools/github.js";
import {
  PullRequestCandidateSchema,
  type PullRequestCandidate,
  type ReviewComment,
  type ReviewVerdict,
} from "../contracts.js";

/** One changed file in a pull-request or compare payload. */
export interface ReviewFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

/** Read surface the review flow needs (fake-friendly structural interface). */
export interface ReviewReader {
  listCandidates(repository: string, limit: number): Promise<PullRequestCandidate[]>;
  pull(repository: string, number: number): Promise<PullRequestCandidate>;
  pullFiles(repository: string, number: number): Promise<ReviewFile[]>;
  compare(repository: string, base: string, head: string): Promise<ReviewFile[]>;
}

export interface PostReviewRequest {
  readonly repository: string;
  readonly number: number;
  readonly commitSha: string;
  readonly verdict: ReviewVerdict;
  readonly body: string;
  readonly comments: readonly ReviewComment[];
  /** PR author login; the review posts as a comment when it is the token's own user. */
  readonly author?: string;
}

export interface PostedReview {
  readonly reviewId: string;
  readonly url: string;
}

/** Write surface the review flow needs (fake-friendly structural interface). */
export interface ReviewWriter {
  postReview(request: PostReviewRequest): Promise<PostedReview>;
}

const REVIEW_EVENT_BY_VERDICT: Record<ReviewVerdict, string> = {
  approve: "APPROVE",
  comment: "COMMENT",
  request_changes: "REQUEST_CHANGES",
};

function splitRepository(repository: string): { owner: string; repo: string } {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repository);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    throw new Error(`Invalid repository identifier: ${repository}`);
  }
  return { owner, repo };
}

function assertRepository(
  policy: GitHubPolicy,
  repository: string,
): { owner: string; repo: string } {
  const parsed = splitRepository(repository);
  if (!policy.repositories.includes(repository)) {
    throw new RepositoryPolicyError("repository_denied", "Repository not allowed");
  }
  return parsed;
}

/**
 * GitHub error bodies explain the rejection (``message`` plus an ``errors``
 * list, e.g. "Can not approve your own pull request"). Surface that detail —
 * without it a failed run only carries the bare status.
 */
function failureDetail(response: { status: number; body: unknown }): string {
  const item = asRecord(response.body);
  const parts = [asString(item.message)];
  if (Array.isArray(item.errors)) {
    for (const error of item.errors) {
      parts.push(typeof error === "string" ? error : asString(asRecord(error).message));
    }
  }
  const detail = [...new Set(parts.filter((part) => part !== ""))].join("; ");
  return detail === "" ? "" : `: ${detail}`;
}

function bodyObject(response: { status: number; body: unknown }): Record<string, unknown> {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    typeof response.body !== "object" ||
    response.body === null ||
    Array.isArray(response.body)
  ) {
    throw new Error(`GitHub request failed (${response.status})${failureDetail(response)}`);
  }
  return response.body as Record<string, unknown>;
}

function bodyArray(response: { status: number; body: unknown }): unknown[] {
  if (response.status < 200 || response.status >= 300 || !Array.isArray(response.body)) {
    throw new Error(`GitHub request failed (${response.status})${failureDetail(response)}`);
  }
  return response.body;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toCandidate(raw: unknown, repository: string): PullRequestCandidate {
  const item = asRecord(raw);
  return PullRequestCandidateSchema.parse({
    number: asNumber(item.number),
    title: asString(item.title, "(untitled)"),
    repository,
    author: asString(asRecord(item.user).login, "unknown"),
    baseBranch: asString(asRecord(item.base).ref, "main"),
    headSha: asString(asRecord(item.head).sha),
    draft: item.draft === true,
  });
}

function toFile(raw: unknown): ReviewFile {
  const item = asRecord(raw);
  return {
    path: asString(item.filename),
    status: asString(item.status, "modified"),
    additions: asNumber(item.additions),
    deletions: asNumber(item.deletions),
    patch: asString(item.patch),
  };
}

/**
 * GitHub REST surface for the review workflow. Reads only pull-request
 * metadata/diffs; the writer posts one review per `complete` step. Every call
 * is scoped by the same repository allowlist the coding lane uses.
 */
export class GitHubReviewReader implements ReviewReader {
  constructor(
    private readonly transport: GitHubTransport,
    private readonly policy: GitHubPolicy,
  ) {}

  async listCandidates(repository: string, limit: number): Promise<PullRequestCandidate[]> {
    const { owner, repo } = assertRepository(this.policy, repository);
    const perPage = Math.max(1, Math.min(50, limit));
    const response = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${perPage}`,
      undefined,
      this.policy.timeoutMs,
    );
    return bodyArray(response)
      .slice(0, limit)
      .map((item) => toCandidate(item, repository));
  }

  async pull(repository: string, number: number): Promise<PullRequestCandidate> {
    const { owner, repo } = assertRepository(this.policy, repository);
    const response = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}`,
      undefined,
      this.policy.timeoutMs,
    );
    return toCandidate(bodyObject(response), repository);
  }

  async pullFiles(repository: string, number: number): Promise<ReviewFile[]> {
    const { owner, repo } = assertRepository(this.policy, repository);
    const response = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
      undefined,
      this.policy.timeoutMs,
    );
    return bodyArray(response).map((item) => toFile(item));
  }

  async compare(repository: string, base: string, head: string): Promise<ReviewFile[]> {
    const { owner, repo } = assertRepository(this.policy, repository);
    const response = await this.transport.request(
      "GET",
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      undefined,
      this.policy.timeoutMs,
    );
    const files = bodyObject(response).files;
    return (Array.isArray(files) ? files : []).map((item) => toFile(item));
  }
}

/**
 * Appended when an approve/request-changes verdict posts as a comment instead:
 * GitHub rejects both from the pull request's own author.
 */
const SELF_REVIEW_NOTE =
  "\n\n---\n_Note: posted as a comment review — GitHub does not allow a pull-request"
  + " author to approve or request changes on their own pull request._";

export class GitHubReviewWriter implements ReviewWriter {
  private loginLookup: Promise<string | undefined> | undefined;

  constructor(
    private readonly transport: GitHubTransport,
    private readonly policy: GitHubPolicy,
  ) {}

  /** The token's login, fetched once; undefined when the lookup fails. */
  private async authenticatedLogin(): Promise<string | undefined> {
    this.loginLookup ??= this.transport
      .request("GET", "/user", undefined, this.policy.timeoutMs)
      .then((response) => {
        if (response.status < 200 || response.status >= 300) return undefined;
        const login = asString(asRecord(response.body).login);
        return login === "" ? undefined : login;
      })
      .catch(() => undefined);
    return this.loginLookup;
  }

  async postReview(request: PostReviewRequest): Promise<PostedReview> {
    const { owner, repo } = assertRepository(this.policy, request.repository);
    const event = REVIEW_EVENT_BY_VERDICT[request.verdict];
    const login =
      event === "COMMENT" || request.author === undefined
        ? undefined
        : await this.authenticatedLogin();
    const selfAuthored =
      login !== undefined && request.author?.toLowerCase() === login.toLowerCase();
    const response = await this.transport.request(
      "POST",
      `/repos/${owner}/${repo}/pulls/${request.number}/reviews`,
      {
        commit_id: request.commitSha,
        event: selfAuthored ? "COMMENT" : event,
        body: selfAuthored ? `${request.body}${SELF_REVIEW_NOTE}` : request.body,
        ...(request.comments.length === 0
          ? {}
          : {
              comments: request.comments.map((comment) => ({
                path: comment.path,
                line: comment.line,
                side: "RIGHT",
                body: comment.body,
              })),
            }),
      },
      this.policy.timeoutMs,
    );
    const body = bodyObject(response);
    return {
      reviewId: String(body.id ?? ""),
      url: asString(body.html_url),
    };
  }
}

/** Bundle injected into the review flow (mirrors `GitHubRepositoryTools`). */
export class GitHubReviewTools {
  readonly reader: GitHubReviewReader;
  readonly writer: GitHubReviewWriter;

  constructor(transport: GitHubTransport, policy: GitHubPolicy) {
    this.reader = new GitHubReviewReader(transport, policy);
    this.writer = new GitHubReviewWriter(transport, policy);
  }
}
