"use client";

import { useId, useState } from "react";

import { Markdown } from "./Markdown";

/**
 * The review lane's per-step surfaces. Every surface renders server content
 * through the shared Markdown renderer — model prose is formatted while raw
 * HTML stays inert text — and knows both the read-only and the inline-edit
 * shape of its step artifact.
 */

export type PullRequestCandidate = {
  number: number;
  title: string;
  repository: string;
  author: string;
  baseBranch: string;
  headSha: string;
  draft: boolean;
};

export type ReviewVerdict = "approve" | "comment" | "request_changes";

export type ReviewComment = { path: string; line: number; body: string };

export type ReviewShape = {
  pullRequest: PullRequestCandidate | null;
  verdict: ReviewVerdict;
  confidence: number | null;
  summary: string;
  strengths: string[];
  improvements: string[];
  comments: ReviewComment[];
  deltaOnly: boolean;
  reviewedSha: string;
};

export type ReviewDraft = {
  verdict: ReviewVerdict;
  summary: string;
  strengthsText: string;
  improvementsText: string;
  comments: ReviewComment[];
};

export type OptionsDraft = { categories: Array<{ id: string; label: string; enabled: boolean }>; guidance: string };

export type PostedComment = { path: string; line: number };

export const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: "Approve",
  comment: "Comment",
  request_changes: "Request changes",
};

const VERDICTS: readonly ReviewVerdict[] = ["approve", "comment", "request_changes"];

export function isVerdict(value: unknown): value is ReviewVerdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function shortSha(sha: string): string {
  return sha.length > 10 ? `${sha.slice(0, 10)}…` : sha;
}

export function parseCandidate(value: unknown): PullRequestCandidate | null {
  const record = asRecord(value);
  if (record === null) return null;
  const number = asNumber(record.number);
  const title = asString(record.title);
  const repository = asString(record.repository);
  if (number === null || title === null || repository === null) return null;
  return {
    number,
    title,
    repository,
    author: asString(record.author) ?? "",
    baseBranch: asString(record.baseBranch) ?? "",
    headSha: asString(record.headSha) ?? "",
    draft: record.draft === true,
  };
}

export function parseCandidates(artifact: Record<string, unknown>): PullRequestCandidate[] {
  const raw = artifact["candidates"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseCandidate(item))
    .filter((item): item is PullRequestCandidate => item !== null);
}

export function parseSelected(artifact: Record<string, unknown>): PullRequestCandidate | null {
  return parseCandidate(artifact["selected"]);
}

export function parseCategories(
  artifact: Record<string, unknown>,
): Array<{ id: string; label: string; enabled: boolean }> {
  const raw = artifact["categories"];
  if (!Array.isArray(raw)) return [];
  const categories: Array<{ id: string; label: string; enabled: boolean }> = [];
  for (const item of raw) {
    const record = asRecord(item);
    const id = record === null ? null : asString(record["id"]);
    const label = record === null ? null : asString(record["label"]);
    if (record === null || id === null || label === null) continue;
    categories.push({ id, label, enabled: record["enabled"] !== false });
  }
  return categories;
}

export function parseGuidance(artifact: Record<string, unknown>): string {
  return asString(artifact["guidance"]) ?? "";
}

export function parseReview(artifact: Record<string, unknown>): ReviewShape | null {
  const verdict = artifact["verdict"];
  const summary = asString(artifact["summary"]);
  if (!isVerdict(verdict) || summary === null) return null;
  const rawComments = artifact["comments"];
  const comments: ReviewComment[] = [];
  if (Array.isArray(rawComments)) {
    for (const item of rawComments) {
      const record = asRecord(item);
      const path = record === null ? null : asString(record["path"]);
      const line = record === null ? null : asNumber(record["line"]);
      const body = record === null ? null : asString(record["body"]);
      if (path === null || line === null || body === null) continue;
      comments.push({ path, line, body });
    }
  }
  return {
    pullRequest: parseCandidate(artifact["pullRequest"]),
    verdict,
    confidence: asNumber(artifact["confidence"]),
    summary,
    strengths: asStringArray(artifact["strengths"]),
    improvements: asStringArray(artifact["improvements"]),
    comments,
    deltaOnly: artifact["deltaOnly"] === true,
    reviewedSha: asString(artifact["reviewedSha"]) ?? "",
  };
}

export type ReceiptView = {
  reviewId: string;
  url: string | null;
  verdict: ReviewVerdict | null;
  reviewedSha: string;
  postedComments: PostedComment[];
};

export function parseReceipt(value: unknown): ReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const reviewId = asString(record["reviewId"]);
  if (reviewId === null) return null;
  const postedComments: PostedComment[] = [];
  const raw = record["postedComments"];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const entry = asRecord(item);
      const path = entry === null ? null : asString(entry["path"]);
      const line = entry === null ? null : asNumber(entry["line"]);
      if (path === null || line === null) continue;
      postedComments.push({ path, line });
    }
  }
  const verdict = record["verdict"];
  return {
    reviewId,
    url: safeHttpsUrl(record["url"]),
    verdict: isVerdict(verdict) ? verdict : null,
    reviewedSha: asString(record["reviewedSha"]) ?? "",
    postedComments,
  };
}

export function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function groupComments(comments: ReviewComment[]): Array<{ path: string; items: ReviewComment[] }> {
  const groups = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const bucket = groups.get(comment.path);
    if (bucket === undefined) groups.set(comment.path, [comment]);
    else bucket.push(comment);
  }
  return [...groups.entries()].map(([path, items]) => ({ path, items }));
}

export function VerdictPill({ verdict }: { verdict: ReviewVerdict }) {
  return <span className={`verdict-pill verdict-${verdict}`}>{VERDICT_LABELS[verdict]}</span>;
}

/** Step 1 — the PR picker with the Change button. */
export function SelectPrSurface({
  artifact,
  editable,
  selectedNumber,
  onSelect,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  selectedNumber: number | null;
  onSelect: (number: number) => void;
}) {
  const groupName = useId();
  const candidates = parseCandidates(artifact);
  const selected = parseSelected(artifact);
  const [pickerOpen, setPickerOpen] = useState(selected === null);
  const active = selectedNumber ?? selected?.number ?? null;
  const open = editable && (pickerOpen || selected === null);

  return (
    <div className="pr-surface">
      {selected === null ? (
        <p className="step-empty">No pull request is selected yet — pick one below.</p>
      ) : (
        <article className="pr-selected">
          <div>
            <p className="pr-title">
              {`#${selected.number} · ${selected.title}`}
              {selected.draft ? <span className="pr-draft">draft</span> : null}
            </p>
            <p className="pr-meta">
              {[selected.repository, selected.author && `by ${selected.author}`, selected.headSha && `head ${shortSha(selected.headSha)}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {editable ? (
            <button type="button" onClick={() => setPickerOpen((value) => !value)}>
              {open ? "Keep" : "Change"}
            </button>
          ) : null}
        </article>
      )}

      {open && (
        <fieldset className="pr-picker">
          <legend>Choose a pull request</legend>
          {candidates.length === 0 ? (
            <p className="step-empty">No open pull requests were returned for this repository.</p>
          ) : (
            candidates.map((candidate) => (
              <label key={candidate.number} className="pr-option">
                <input
                  type="radio"
                  name={groupName}
                  checked={active === candidate.number}
                  onChange={() => onSelect(candidate.number)}
                />
                <span className="pr-option-text">
                  <strong>{`#${candidate.number} · ${candidate.title}`}</strong>
                  <span>{`${candidate.repository} · ${candidate.author || "unknown"} · base ${candidate.baseBranch || "?"}`}</span>
                </span>
              </label>
            ))
          )}
        </fieldset>
      )}
    </div>
  );
}

/** Step 2 — category cards, Select All/Clear, custom guidance. */
export function ReviewOptionsSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: OptionsDraft | null;
  onChange: (draft: OptionsDraft) => void;
}) {
  const guidanceId = useId();
  const baseline: OptionsDraft = {
    categories: parseCategories(artifact),
    guidance: parseGuidance(artifact),
  };
  const value = draft ?? baseline;

  function toggle(id: string, enabled: boolean): void {
    onChange({
      categories: value.categories.map((category) =>
        category.id === id ? { ...category, enabled } : category,
      ),
      guidance: value.guidance,
    });
  }

  function setEnabled(enabled: boolean): void {
    onChange({
      categories: value.categories.map((category) => ({ ...category, enabled })),
      guidance: value.guidance,
    });
  }

  const enabledCount = value.categories.filter((category) => category.enabled).length;

  return (
    <div className="options-surface">
      <div className="options-toolbar">
        <p className="step-summary">{`${enabledCount} of ${value.categories.length} categories enabled`}</p>
        {editable && (
          <div className="options-bulk">
            <button type="button" onClick={() => setEnabled(true)}>
              Select All
            </button>
            <button type="button" onClick={() => setEnabled(false)}>
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="category-grid">
        {value.categories.map((category) => (
          <label key={category.id} className={`category-card${category.enabled ? " enabled" : ""}`}>
            <input
              type="checkbox"
              checked={category.enabled}
              disabled={!editable}
              onChange={(event) => toggle(category.id, event.target.checked)}
            />
            <span>{category.label}</span>
          </label>
        ))}
      </div>

      <label className="guidance-field" htmlFor={guidanceId}>
        <span>Custom guidance</span>
        <textarea
          id={guidanceId}
          rows={3}
          maxLength={4000}
          placeholder="Anything the reviewer should focus on (optional)"
          value={value.guidance}
          disabled={!editable}
          onChange={(event) => onChange({ categories: value.categories, guidance: event.target.value })}
        />
      </label>
    </div>
  );
}

/** The AI review body — shared by the ai-review and complete steps. */
export function AiReviewSurface({
  artifact,
  editing,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editing: boolean;
  draft: ReviewDraft | null;
  onChange: (draft: ReviewDraft) => void;
}) {
  const summaryId = useId();
  const strengthsId = useId();
  const improvementsId = useId();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const parsed = parseReview(artifact);

  if (parsed === null) {
    return <p className="step-empty">The review content is not available yet.</p>;
  }
  const groups = groupComments(parsed.comments);

  if (editing) {
    const value = draft ?? {
      verdict: parsed.verdict,
      summary: parsed.summary,
      strengthsText: parsed.strengths.join("\n"),
      improvementsText: parsed.improvements.join("\n"),
      comments: parsed.comments.map((comment) => ({ ...comment })),
    };
    return (
      <div className="review-editor">
        <label className="field-row">
          <span>Verdict</span>
          <select
            value={value.verdict}
            onChange={(event) => {
              if (isVerdict(event.target.value)) onChange({ ...value, verdict: event.target.value });
            }}
          >
            {VERDICTS.map((verdict) => (
              <option key={verdict} value={verdict}>
                {VERDICT_LABELS[verdict]}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row" htmlFor={summaryId}>
          <span>Summary</span>
          <textarea
            id={summaryId}
            rows={3}
            value={value.summary}
            onChange={(event) => onChange({ ...value, summary: event.target.value })}
          />
        </label>
        <label className="field-row" htmlFor={strengthsId}>
          <span>{`Strengths (one per line)`}</span>
          <textarea
            id={strengthsId}
            rows={3}
            value={value.strengthsText}
            onChange={(event) => onChange({ ...value, strengthsText: event.target.value })}
          />
        </label>
        <label className="field-row" htmlFor={improvementsId}>
          <span>{`Suggested improvements (one per line)`}</span>
          <textarea
            id={improvementsId}
            rows={3}
            value={value.improvementsText}
            onChange={(event) => onChange({ ...value, improvementsText: event.target.value })}
          />
        </label>
        <div className="review-comments editor">
          <h4>{`Inline comments (${value.comments.length})`}</h4>
          {value.comments.map((comment, index) => (
            <label key={`${comment.path}:${comment.line}:${index}`} className="comment-card">
              <span className="comment-location">{`${comment.path}:${comment.line}`}</span>
              <textarea
                rows={2}
                value={comment.body}
                onChange={(event) => {
                  const comments = value.comments.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, body: event.target.value } : item,
                  );
                  onChange({ ...value, comments });
                }}
              />
            </label>
          ))}
          {value.comments.length === 0 ? (
            <p className="step-empty">No inline comments — the summary carries the review.</p>
          ) : null}
        </div>
      </div>
    );
  }

  const anyCollapsed = groups.some((group) => collapsed[group.path] === true);

  return (
    <div className="review-read">
      <div className="verdict-row">
        <VerdictPill verdict={parsed.verdict} />
        {parsed.confidence !== null ? (
          <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
        ) : null}
        {parsed.deltaOnly ? <span className="delta-badge">new pushes only</span> : null}
      </div>
      <Markdown text={parsed.summary} className="review-summary" />

      {parsed.strengths.length > 0 && (
        <div className="review-block">
          <h4>Strengths</h4>
          <ul>
            {parsed.strengths.map((item, index) => (
              <li key={`strength-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {parsed.improvements.length > 0 && (
        <div className="review-block">
          <h4>Suggested improvements</h4>
          <ul>
            {parsed.improvements.map((item, index) => (
              <li key={`improvement-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="review-comments">
        <div className="review-comments-head">
          <h4>{`Inline comments (${parsed.comments.length})`}</h4>
          {groups.length > 1 && (
            <div className="comment-bulk">
              <button
                type="button"
                onClick={() =>
                  setCollapsed(Object.fromEntries(groups.map((group) => [group.path, false])))
                }
              >
                Expand All
              </button>
              <button
                type="button"
                onClick={() =>
                  setCollapsed(Object.fromEntries(groups.map((group) => [group.path, true])))
                }
              >
                Collapse All
              </button>
            </div>
          )}
        </div>
        {groups.length === 0 ? (
          <p className="step-empty">No inline comments — the summary carries the review.</p>
        ) : (
          groups.map((group) => {
            const isOpen = collapsed[group.path] !== true;
            return (
              <section key={group.path} className="comment-group">
                <button
                  type="button"
                  className="comment-file"
                  aria-expanded={isOpen}
                  onClick={() =>
                    setCollapsed((previous) => ({
                      ...previous,
                      [group.path]: !isOpen,
                    }))
                  }
                >
                  <strong>{group.path}</strong>
                  <span>{`${group.items.length} comment${group.items.length === 1 ? "" : "s"}`}</span>
                </button>
                {isOpen &&
                  group.items.map((comment, index) => (
                    <article key={`${comment.line}-${index}`} className="comment-card">
                      <span className="comment-location">{`line ${comment.line}`}</span>
                      <Markdown text={comment.body} />
                    </article>
                  ))}
              </section>
            );
          })
        )}
      </div>
      {anyCollapsed ? (
        <p className="step-summary">Some file groups are collapsed — Expand All to see every comment.</p>
      ) : null}
    </div>
  );
}

/** Step 4 — the posted-review receipt and the follow-up state. */
export function CompleteSurface({
  artifact,
  receipt,
  followUp,
}: {
  artifact: Record<string, unknown> | null;
  receipt: ReceiptView | null;
  followUp?: { onStart: () => void; busy: boolean } | undefined;
}) {
  const review = artifact === null ? null : parseReview(artifact);
  const deltaOnlyOnNewPush =
    asRecord(artifact?.["followUp"])?.["deltaOnlyOnNewPush"] === true;
  // The receipt link is server content too: re-validate it here so the
  // component stays safe even when a caller hands in an unparsed receipt.
  const receiptUrl = receipt === null ? null : safeHttpsUrl(receipt.url);

  return (
    <div className="complete-surface">
      {receipt !== null ? (
        <article className="receipt-card">
          <div className="receipt-head">
            {receipt.verdict !== null ? <VerdictPill verdict={receipt.verdict} /> : null}
            <strong>{`Review #${receipt.reviewId}`}</strong>
          </div>
          {receiptUrl !== null ? (
            <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
              View the posted review
            </a>
          ) : (
            <p className="step-empty">The review was posted; the link is unavailable.</p>
          )}
          {receipt.reviewedSha !== "" ? (
            <p className="step-summary">{`Reviewed commit ${shortSha(receipt.reviewedSha)}`}</p>
          ) : null}
          <div className="receipt-comments">
            <p className="step-summary">
              {`${receipt.postedComments.length} inline comment${receipt.postedComments.length === 1 ? "" : "s"} posted`}
            </p>
            {receipt.postedComments.length > 0 && (
              <ul>
                {receipt.postedComments.map((comment, index) => (
                  <li key={`${comment.path}:${comment.line}:${index}`}>{`${comment.path}:${comment.line}`}</li>
                ))}
              </ul>
            )}
          </div>
        </article>
      ) : (
        <article className="receipt-card pending">
          <strong>The review is ready to post</strong>
          <p className="step-summary">
            Proceeding posts the verdict, summary, and inline comments to the pull request.
          </p>
          {review !== null && (
            <p className="step-summary">
              {`${VERDICT_LABELS[review.verdict]} · ${review.comments.length} inline comment${
                review.comments.length === 1 ? "" : "s"
              }`}
            </p>
          )}
        </article>
      )}

      <p className="follow-up-note">
        {deltaOnlyOnNewPush || receipt !== null
          ? "A follow-up review re-examines deltas only: new pushes are reviewed against the last reviewed commit."
          : "Follow-up reviews re-examine deltas only on new pushes."}
      </p>

      {receipt !== null && followUp !== undefined && (
        <button type="button" className="follow-up-button" disabled={followUp.busy} onClick={followUp.onStart}>
          Start follow-up review (deltas only)
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Issue Resolution lane (`issuesFlow`): selection -> analysis ->
 * implementation -> complete. Every parser tolerates partial artifacts and
 * every renderer keeps server content as text nodes only.
 * ---------------------------------------------------------------------- */

export type IssueTicket = { key: string; summary: string; status: string };

export type IssueAdvanced = {
  includeRegressionTest: boolean;
  maxChangedFiles: number;
  guidance: string;
};

export type IssueSelectionShape = {
  ticket: IssueTicket;
  candidates: IssueTicket[];
  repositories: string[];
  branches: string[];
  repository: string;
  baseBranch: string;
  advanced: IssueAdvanced;
};

export type IssueSelectionDraft = {
  ticket: IssueTicket;
  repository: string;
  baseBranch: string;
  advanced: IssueAdvanced;
};

export type IssueAffectedFileView = {
  path: string;
  startLine: number;
  endLine: number;
  changeDescription: string;
  validators: string[];
};

export type IssueSimilarUpdate = { reference: string; note: string };

export type IssueRegressionPlan = { path: string; description: string };

export type IssueAnalysisShape = {
  summary: string;
  confidence: number | null;
  similarUpdates: IssueSimilarUpdate[];
  affectedFiles: IssueAffectedFileView[];
  regressionTest: IssueRegressionPlan | null;
};

export type IssueAnalysisDraft = {
  summary: string;
  affectedFiles: IssueAffectedFileView[];
};

export type IssuePatchFileView = {
  path: string;
  status: "added" | "modified";
  additions: number;
  deletions: number;
  diff: string;
  content: string;
  validators: string[];
};

export type IssueRegressionPatchView = {
  path: string;
  content: string;
  additions: number;
  deletions: number;
  diff: string;
};

export type IssueValidationResultView = {
  validator: string;
  path: string;
  passed: boolean;
  message: string;
};

export type IssueValidationView = {
  passed: boolean;
  attempts: number;
  results: IssueValidationResultView[];
};

export type IssueImplementationShape = {
  summary: string;
  files: IssuePatchFileView[];
  regressionTest: IssueRegressionPatchView | null;
  validation: IssueValidationView | null;
  repair: { attempted: boolean; applied: boolean } | null;
};

export type IssueImplementationDraft = {
  summary: string;
  /** Edited file contents keyed by path; untouched files stay as recorded. */
  files: Record<string, string>;
  regressionTest: string | null;
};

export type IssueCompletionShape = {
  branch: string;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  regressionTestPath: string | null;
  ticketTransition: { ticketKey: string; targetStatus: string } | null;
  validation: IssueValidationView | null;
};

export type IssueReceiptView = {
  url: string | null;
  number: number | null;
  draft: boolean;
  branch: string;
  ticketTransition: { ticketKey: string; targetStatus: string } | null;
  validation: IssueValidationView | null;
  regressionTestPath: string | null;
  caseId: string;
};

/** Validator names the issues lane understands (mirrors the Mastra contract). */
export const ISSUE_VALIDATORS: readonly string[] = ["basic-syntax", "json", "yaml", "xml"];

/** Deterministic fix branch preview; mirrors the flow's `branchFor`. */
export function issueFixBranch(ticketKey: string): string {
  const slug = ticketKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `fix/${slug === "" ? "ticket" : slug}`;
}

export function parseIssueTicket(value: unknown): IssueTicket | null {
  const record = asRecord(value);
  if (record === null) return null;
  const key = asString(record["key"]);
  const summary = asString(record["summary"]);
  if (key === null || summary === null) return null;
  return { key, summary, status: asString(record["status"]) ?? "" };
}

export function parseIssueSelection(artifact: Record<string, unknown>): IssueSelectionShape | null {
  const ticket = parseIssueTicket(artifact["ticket"]);
  if (ticket === null) return null;
  const candidates: IssueTicket[] = [];
  const rawCandidates = artifact["candidates"];
  if (Array.isArray(rawCandidates)) {
    for (const item of rawCandidates) {
      const parsed = parseIssueTicket(item);
      if (parsed !== null) candidates.push(parsed);
    }
  }
  const advanced = asRecord(artifact["advanced"]);
  const maxChangedFilesRaw = advanced === null ? null : asNumber(advanced["maxChangedFiles"]);
  return {
    ticket,
    candidates,
    repositories: asStringArray(artifact["repositories"]),
    branches: asStringArray(artifact["branches"]),
    repository: asString(artifact["repository"]) ?? "",
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    advanced: {
      includeRegressionTest: advanced === null || advanced["includeRegressionTest"] !== false,
      maxChangedFiles:
        maxChangedFilesRaw === null ? 10 : Math.min(25, Math.max(1, Math.round(maxChangedFilesRaw))),
      guidance: advanced === null ? "" : asString(advanced["guidance"]) ?? "",
    },
  };
}

export function parseIssueAffectedFiles(value: unknown): IssueAffectedFileView[] {
  if (!Array.isArray(value)) return [];
  const files: IssueAffectedFileView[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const path = record === null ? null : asString(record["path"]);
    const startLine = record === null ? null : asNumber(record["startLine"]);
    const endLine = record === null ? null : asNumber(record["endLine"]);
    if (record === null || path === null || startLine === null || endLine === null) continue;
    files.push({
      path,
      startLine,
      endLine,
      changeDescription: asString(record["changeDescription"]) ?? "",
      validators: asStringArray(record["validators"]),
    });
  }
  return files;
}

export function parseIssueAnalysis(artifact: Record<string, unknown>): IssueAnalysisShape | null {
  const summary = asString(artifact["summary"]);
  if (summary === null) return null;
  const similarUpdates: IssueSimilarUpdate[] = [];
  const rawSimilar = artifact["similarUpdates"];
  if (Array.isArray(rawSimilar)) {
    for (const item of rawSimilar) {
      const record = asRecord(item);
      const reference = record === null ? null : asString(record["reference"]);
      const note = record === null ? null : asString(record["note"]);
      if (reference === null || note === null) continue;
      similarUpdates.push({ reference, note });
    }
  }
  const regression = asRecord(artifact["regressionTest"]);
  const regressionPath = regression === null ? null : asString(regression["path"]);
  const regressionDescription = regression === null ? null : asString(regression["description"]);
  return {
    summary,
    confidence: asNumber(artifact["confidence"]),
    similarUpdates,
    affectedFiles: parseIssueAffectedFiles(artifact["affectedFiles"]),
    regressionTest:
      regressionPath !== null && regressionDescription !== null
        ? { path: regressionPath, description: regressionDescription }
        : null,
  };
}

export function parseIssueValidation(value: unknown): IssueValidationView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const results: IssueValidationResultView[] = [];
  const raw = record["results"];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const entry = asRecord(item);
      const validator = entry === null ? null : asString(entry["validator"]);
      const path = entry === null ? null : asString(entry["path"]);
      if (entry === null || validator === null || path === null) continue;
      results.push({
        validator,
        path,
        passed: entry["passed"] === true,
        message: asString(entry["message"]) ?? "",
      });
    }
  }
  return {
    passed: record["passed"] === true,
    attempts: asNumber(record["attempts"]) ?? 0,
    results,
  };
}

export function parseIssueImplementation(
  artifact: Record<string, unknown>,
): IssueImplementationShape | null {
  const summary = asString(artifact["summary"]);
  if (summary === null) return null;
  const files: IssuePatchFileView[] = [];
  const rawFiles = artifact["files"];
  if (Array.isArray(rawFiles)) {
    for (const item of rawFiles) {
      const record = asRecord(item);
      const path = record === null ? null : asString(record["path"]);
      const status = record === null ? null : asString(record["status"]);
      if (record === null || path === null || (status !== "added" && status !== "modified")) continue;
      files.push({
        path,
        status,
        additions: asNumber(record["additions"]) ?? 0,
        deletions: asNumber(record["deletions"]) ?? 0,
        diff: asString(record["diff"]) ?? "",
        content: asString(record["content"]) ?? "",
        validators: asStringArray(record["validators"]),
      });
    }
  }
  const regression = asRecord(artifact["regressionTest"]);
  const regressionPatch: IssueRegressionPatchView | null =
    regression === null || asString(regression["path"]) === null
      ? null
      : {
          path: asString(regression["path"]) ?? "",
          content: asString(regression["content"]) ?? "",
          additions: asNumber(regression["additions"]) ?? 0,
          deletions: asNumber(regression["deletions"]) ?? 0,
          diff: asString(regression["diff"]) ?? "",
        };
  const repair = asRecord(artifact["repair"]);
  return {
    summary,
    files,
    regressionTest: regressionPatch,
    validation: parseIssueValidation(artifact["validation"]),
    repair:
      repair === null
        ? null
        : { attempted: repair["attempted"] === true, applied: repair["applied"] === true },
  };
}

export function parseIssueCompletion(artifact: Record<string, unknown>): IssueCompletionShape | null {
  const branch = asString(artifact["branch"]);
  if (branch === null) return null;
  const files: IssueCompletionShape["files"] = [];
  const rawFiles = artifact["files"];
  if (Array.isArray(rawFiles)) {
    for (const item of rawFiles) {
      const record = asRecord(item);
      const path = record === null ? null : asString(record["path"]);
      if (record === null || path === null) continue;
      files.push({
        path,
        status: asString(record["status"]) ?? "",
        additions: asNumber(record["additions"]) ?? 0,
        deletions: asNumber(record["deletions"]) ?? 0,
      });
    }
  }
  const transition = asRecord(artifact["ticketTransition"]);
  const ticketKey = transition === null ? null : asString(transition["ticketKey"]);
  const targetStatus = transition === null ? null : asString(transition["targetStatus"]);
  return {
    branch,
    files,
    regressionTestPath: asString(artifact["regressionTestPath"]),
    ticketTransition:
      ticketKey !== null && targetStatus !== null ? { ticketKey, targetStatus } : null,
    validation: parseIssueValidation(artifact["validation"]),
  };
}

export function parseIssueReceipt(value: unknown): IssueReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const pr = asRecord(record["pr"]);
  const branch = asString(record["branch"]);
  if (pr === null || branch === null) return null;
  const transition = asRecord(record["ticketTransition"]);
  const ticketKey = transition === null ? null : asString(transition["ticketKey"]);
  const targetStatus = transition === null ? null : asString(transition["targetStatus"]);
  const validation = asRecord(record["validation"]);
  return {
    url: safeHttpsUrl(pr["url"]),
    number: asNumber(pr["number"]),
    draft: pr["draft"] === true,
    branch,
    ticketTransition:
      ticketKey !== null && targetStatus !== null ? { ticketKey, targetStatus } : null,
    validation:
      validation === null
        ? null
        : {
            passed: validation["passed"] === true,
            attempts: asNumber(validation["attempts"]) ?? 0,
            results: [],
          },
    regressionTestPath: asString(record["regressionTestPath"]),
    caseId: asString(record["caseId"]) ?? "",
  };
}

/** The validators verdict list — shared by the implementation and receipt views. */
export function IssueValidationReport({ validation }: { validation: IssueValidationView | null }) {
  if (validation === null) return null;
  return (
    <div className={`validation-report${validation.passed ? " passed" : " failed"}`}>
      <p className="validation-head">
        {`Validators ${validation.passed ? "passed" : "failed"} · ${validation.attempts} attempt${
          validation.attempts === 1 ? "" : "s"
        }`}
      </p>
      {validation.results.length > 0 && (
        <ul className="validation-results">
          {validation.results.map((result, index) => (
            <li
              key={`${result.path}:${result.validator}:${index}`}
              className={result.passed ? "passed" : "failed"}
            >
              {`${result.passed ? "✓" : "✗"} ${result.validator} · ${result.path}${
                result.message !== "" ? ` — ${result.message}` : ""
              }`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-context";
}

/** One collapsible line diff; rendered as text spans only. */
export function IssueDiffBlock({ diff }: { diff: string }) {
  const [open, setOpen] = useState(true);
  const lines = diff === "" ? [] : diff.split("\n");
  return (
    <div className="diff-block">
      <button
        type="button"
        className="diff-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide diff" : `Show diff (${lines.length} lines)`}
      </button>
      {open && (
        <pre className="diff-body">
          {lines.length === 0 ? (
            <span className="diff-line diff-context">{`(no diff recorded)`}</span>
          ) : (
            lines.map((line, index) => (
              <span key={index} className={`diff-line ${diffLineClass(line)}`}>
                {`${line}\n`}
              </span>
            ))
          )}
        </pre>
      )}
    </div>
  );
}

/** Step 1 — bug-ticket chips, repo/branch pickers, Advanced Settings, Start fixing. */
export function IssueSelectionSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: IssueSelectionDraft | null;
  onChange: (draft: IssueSelectionDraft) => void;
}) {
  const groupName = useId();
  const guidanceId = useId();
  const maxFilesId = useId();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const parsed = parseIssueSelection(artifact);

  if (parsed === null) {
    return <p className="step-empty">The issue selection is not available yet.</p>;
  }
  const value: IssueSelectionDraft = draft ?? {
    ticket: parsed.ticket,
    repository: parsed.repository,
    baseBranch: parsed.baseBranch,
    advanced: parsed.advanced,
  };
  const fixBranch = issueFixBranch(value.ticket.key);

  function update(patch: Partial<IssueSelectionDraft>): void {
    onChange({ ...value, ...patch });
  }

  const advancedDirty =
    value.advanced.includeRegressionTest !== parsed.advanced.includeRegressionTest ||
    value.advanced.maxChangedFiles !== parsed.advanced.maxChangedFiles ||
    value.advanced.guidance !== parsed.advanced.guidance;

  return (
    <div className="issue-selection-surface">
      <fieldset className="ticket-chips">
        <legend>Bug ticket</legend>
        {parsed.candidates.length === 0 ? (
          <p className="step-empty">No candidate tickets were provided for this run.</p>
        ) : (
          <div className="ticket-chip-row">
            {parsed.candidates.map((candidate) => (
              <label
                key={candidate.key}
                className={`ticket-chip${candidate.key === value.ticket.key ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name={groupName}
                  checked={candidate.key === value.ticket.key}
                  disabled={!editable}
                  onChange={() => update({ ticket: candidate })}
                />
                <span className="ticket-chip-text">
                  <strong>{candidate.key}</strong>
                  <span>{candidate.summary}</span>
                  {candidate.status !== "" ? (
                    <span className="ticket-chip-status">{candidate.status}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="issue-pickers">
        <label className="field-row">
          <span>Repository</span>
          <select
            value={value.repository}
            disabled={!editable}
            onChange={(event) => update({ repository: event.target.value })}
          >
            {parsed.repositories.length === 0 ? (
              <option value={value.repository}>{value.repository}</option>
            ) : (
              parsed.repositories.map((repository) => (
                <option key={repository} value={repository}>
                  {repository}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="field-row">
          <span>Branch</span>
          <select
            value={value.baseBranch}
            disabled={!editable}
            onChange={(event) => update({ baseBranch: event.target.value })}
          >
            {parsed.branches.length === 0 ? (
              <option value={value.baseBranch}>{value.baseBranch}</option>
            ) : (
              parsed.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      <p className="fix-branch-preview">
        {`The fix lands on ${value.repository || "the repository"}@${fixBranch}, branched from ${
          value.baseBranch || "the base branch"
        }.`}
      </p>

      <div className="advanced-settings">
        <button
          type="button"
          className="advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {`Advanced Settings${advancedDirty ? " · edited" : ""}`}
        </button>
        {advancedOpen && (
          <div className="advanced-body">
            <label className="advanced-check">
              <input
                type="checkbox"
                checked={value.advanced.includeRegressionTest}
                disabled={!editable}
                onChange={(event) =>
                  update({
                    advanced: { ...value.advanced, includeRegressionTest: event.target.checked },
                  })
                }
              />
              <span>Produce a regression test together with the fix</span>
            </label>
            <label className="field-row" htmlFor={maxFilesId}>
              <span>Max changed files</span>
              <input
                id={maxFilesId}
                type="number"
                min={1}
                max={25}
                value={value.advanced.maxChangedFiles}
                disabled={!editable}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next >= 1 && next <= 25) {
                    update({ advanced: { ...value.advanced, maxChangedFiles: next } });
                  }
                }}
              />
            </label>
            <label className="field-row" htmlFor={guidanceId}>
              <span>Guidance</span>
              <textarea
                id={guidanceId}
                rows={3}
                maxLength={4000}
                value={value.advanced.guidance}
                disabled={!editable}
                placeholder="Anything the fix should account for (optional)"
                onChange={(event) =>
                  update({ advanced: { ...value.advanced, guidance: event.target.value } })
                }
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

/** Step 2 — similar-updates callout, affected files, regression cross-link. */
export function IssueAnalysisSurface({
  artifact,
  editing,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editing: boolean;
  draft: IssueAnalysisDraft | null;
  onChange: (draft: IssueAnalysisDraft) => void;
}) {
  const summaryId = useId();
  const [detailsOpen, setDetailsOpen] = useState<Record<string, boolean>>({});
  const parsed = parseIssueAnalysis(artifact);

  if (parsed === null) {
    return <p className="step-empty">The analysis is not available yet.</p>;
  }

  if (editing) {
    const value: IssueAnalysisDraft = draft ?? {
      summary: parsed.summary,
      affectedFiles: parsed.affectedFiles.map((file) => ({ ...file })),
    };
    function updateFile(index: number, patch: Partial<IssueAffectedFileView>): void {
      onChange({
        summary: value.summary,
        affectedFiles: value.affectedFiles.map((file, itemIndex) =>
          itemIndex === index ? { ...file, ...patch } : file,
        ),
      });
    }
    return (
      <div className="analysis-editor">
        <label className="field-row" htmlFor={summaryId}>
          <span>Analysis summary</span>
          <textarea
            id={summaryId}
            rows={3}
            value={value.summary}
            onChange={(event) => onChange({ summary: event.target.value, affectedFiles: value.affectedFiles })}
          />
        </label>
        <div className="affected-files">
          <h4>{`Affected files (${value.affectedFiles.length})`}</h4>
          {value.affectedFiles.map((file, index) => (
            <article key={`${file.path}:${index}`} className="file-card editing">
              <header className="file-card-head">
                <strong className="file-path">{file.path}</strong>
                <span className="line-pill">{`L${file.startLine}–L${file.endLine}`}</span>
              </header>
              <div className="file-edit-grid">
                <label>
                  <span>Start line</span>
                  <input
                    type="number"
                    min={1}
                    value={file.startLine}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isInteger(next) && next >= 1) updateFile(index, { startLine: next });
                    }}
                  />
                </label>
                <label>
                  <span>End line</span>
                  <input
                    type="number"
                    min={1}
                    value={file.endLine}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isInteger(next) && next >= 1) updateFile(index, { endLine: next });
                    }}
                  />
                </label>
                <label>
                  <span>Validator</span>
                  <select
                    value={file.validators[0] ?? "basic-syntax"}
                    onChange={(event) => updateFile(index, { validators: [event.target.value] })}
                  >
                    {ISSUE_VALIDATORS.map((validator) => (
                      <option key={validator} value={validator}>
                        {validator}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field-row">
                <span>Change description</span>
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={file.changeDescription}
                  onChange={(event) => updateFile(index, { changeDescription: event.target.value })}
                />
              </label>
            </article>
          ))}
        </div>
      </div>
    );
  }

  const fileCount = parsed.affectedFiles.length;

  return (
    <div className="analysis-surface">
      <div className="analysis-head">
        <Markdown text={parsed.summary} className="analysis-summary" />
        <div className="analysis-meta">
          {parsed.confidence !== null ? (
            <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
          ) : null}
          <span className="file-count-badge">{`${fileCount} file${fileCount === 1 ? "" : "s"}`}</span>
        </div>
      </div>

      {parsed.similarUpdates.length > 0 && (
        <aside className="similar-callout">
          <h4>Similar updates</h4>
          <ul>
            {parsed.similarUpdates.map((update, index) => (
              <li key={`${update.reference}:${index}`}>
                <strong>{update.reference}</strong>
                <span>{` — ${update.note}`}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}

      <div className="affected-files">
        <div className="affected-files-head">
          <h4>Affected files</h4>
          <span className="file-count-badge">{`${fileCount} file${fileCount === 1 ? "" : "s"}`}</span>
        </div>
        {fileCount === 0 ? (
          <p className="step-empty">No files are cited yet — regenerate the analysis or go back.</p>
        ) : (
          parsed.affectedFiles.map((file) => {
            const open = detailsOpen[file.path] === true;
            return (
              <article key={file.path} className="file-card">
                <header className="file-card-head">
                  <strong className="file-path">{file.path}</strong>
                  <span className="line-pill">{`L${file.startLine}–L${file.endLine}`}</span>
                  <button
                    type="button"
                    className="file-modify"
                    aria-expanded={open}
                    onClick={() =>
                      setDetailsOpen((previous) => ({ ...previous, [file.path]: !open }))
                    }
                  >
                    {open ? "Hide change" : "Modify"}
                  </button>
                </header>
                {open && <Markdown text={file.changeDescription} className="change-description" />}
                <p className="file-validators">{`Validators: ${file.validators.join(", ") || "none"}`}</p>
              </article>
            );
          })
        )}
      </div>

      <aside className="regression-link">
        <h4>Regression test — produced with the fix</h4>
        {parsed.regressionTest === null ? (
          <p className="step-summary">
            No regression test will be produced for this ticket (turned off in Advanced Settings).
          </p>
        ) : (
          <>
            <p className="step-summary">{`${parsed.regressionTest.path} — ${parsed.regressionTest.description}`}</p>
            <p className="step-summary">
              The implementation step generates this regression test together with the patch.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}

/** Step 3 — per-file patch diffs, validators verdicts, the repair trail. */
export function IssueImplementationSurface({
  artifact,
  editing,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editing: boolean;
  draft: IssueImplementationDraft | null;
  onChange: (draft: IssueImplementationDraft) => void;
}) {
  const summaryId = useId();
  const [modifyOpen, setModifyOpen] = useState<Record<string, boolean>>({});
  const parsed = parseIssueImplementation(artifact);

  if (parsed === null) {
    return <p className="step-empty">The implementation is not available yet.</p>;
  }

  if (editing) {
    const value: IssueImplementationDraft = draft ?? {
      summary: parsed.summary,
      files: Object.fromEntries(parsed.files.map((file) => [file.path, file.content])),
      regressionTest: parsed.regressionTest?.content ?? null,
    };
    function updateFile(path: string, content: string): void {
      onChange({ ...value, files: { ...value.files, [path]: content } });
    }
    return (
      <div className="implementation-editor">
        <label className="field-row" htmlFor={summaryId}>
          <span>Implementation summary</span>
          <textarea
            id={summaryId}
            rows={2}
            value={value.summary}
            onChange={(event) => onChange({ ...value, summary: event.target.value })}
          />
        </label>
        {parsed.files.map((file) => (
          <article key={file.path} className="file-card editing">
            <header className="file-card-head">
              <strong className="file-path">{file.path}</strong>
              <span className={`file-status status-${file.status}`}>{file.status}</span>
            </header>
            <textarea
              rows={8}
              className="content-editor"
              value={value.files[file.path] ?? file.content}
              onChange={(event) => updateFile(file.path, event.target.value)}
            />
          </article>
        ))}
        {parsed.regressionTest !== null && (
          <article className="file-card editing">
            <header className="file-card-head">
              <strong className="file-path">{parsed.regressionTest.path}</strong>
              <span className="file-status status-added">regression test</span>
            </header>
            <textarea
              rows={8}
              className="content-editor"
              value={value.regressionTest ?? parsed.regressionTest.content}
              onChange={(event) => onChange({ ...value, regressionTest: event.target.value })}
            />
          </article>
        )}
      </div>
    );
  }

  const totalAdditions = parsed.files.reduce((total, file) => total + file.additions, 0);
  const totalDeletions = parsed.files.reduce((total, file) => total + file.deletions, 0);

  return (
    <div className="implementation-surface">
      <div className="impl-head">
        <Markdown text={parsed.summary} className="analysis-summary" />
        <span className="file-count-badge">{`${parsed.files.length} file${parsed.files.length === 1 ? "" : "s"}`}</span>
      </div>
      <p className="diff-totals">{`+${totalAdditions} / −${totalDeletions} across the patch`}</p>

      {parsed.repair !== null && parsed.repair.attempted && (
        <p className={`repair-note${parsed.repair.applied ? " applied" : " failed"}`}>
          {parsed.repair.applied
            ? "Validators failed once; the fix was repaired automatically and re-validated."
            : "Validators failed and the single repair attempt did not pass — review carefully before proceeding."}
        </p>
      )}

      <IssueValidationReport validation={parsed.validation} />

      {parsed.files.map((file) => {
        const open = modifyOpen[file.path] === true;
        return (
          <article key={file.path} className="patch-card">
            <header className="file-card-head">
              <strong className="file-path">{file.path}</strong>
              <span className={`file-status status-${file.status}`}>{file.status}</span>
              <span className="diff-stat">{`+${file.additions} −${file.deletions}`}</span>
              <button
                type="button"
                className="file-modify"
                aria-expanded={open}
                onClick={() => setModifyOpen((previous) => ({ ...previous, [file.path]: !open }))}
              >
                {open ? "Hide diff" : "Modify"}
              </button>
            </header>
            <p className="file-validators">{`Validators: ${file.validators.join(", ") || "none"}`}</p>
            {open && <IssueDiffBlock diff={file.diff} />}
          </article>
        );
      })}

      {parsed.regressionTest !== null && (
        <article className="patch-card regression">
          <header className="file-card-head">
            <strong className="file-path">{parsed.regressionTest.path}</strong>
            <span className="file-status status-added">regression test</span>
            <span className="diff-stat">{`+${parsed.regressionTest.additions} −${parsed.regressionTest.deletions}`}</span>
          </header>
          <IssueDiffBlock diff={parsed.regressionTest.diff} />
        </article>
      )}
    </div>
  );
}

/** Step 4 — the Draft PR, the validation report and the ticket transition. */
export function IssueCompleteSurface({
  artifact,
  receipt,
}: {
  artifact: Record<string, unknown> | null;
  receipt: IssueReceiptView | null;
}) {
  const completion = artifact === null ? null : parseIssueCompletion(artifact);
  const receivedValidation = receipt === null ? null : receipt.validation;
  const pendingValidation = completion === null ? null : completion.validation;

  return (
    <div className="complete-surface issue-complete">
      {receipt !== null ? (
        <article className="receipt-card">
          <div className="receipt-head">
            <strong>{receipt.number === null ? "Draft PR" : `Draft PR #${receipt.number}`}</strong>
            {receipt.draft ? <span className="pr-draft">draft</span> : null}
          </div>
          {receipt.url !== null ? (
            <a href={receipt.url} target="_blank" rel="noopener noreferrer">
              View the Draft PR
            </a>
          ) : (
            <p className="step-empty">The Draft PR was opened; the link is unavailable.</p>
          )}
          <p className="step-summary">{`Branch ${receipt.branch}`}</p>
          {receipt.ticketTransition !== null && (
            <p className="step-summary">
              {`Ticket ${receipt.ticketTransition.ticketKey} → ${receipt.ticketTransition.targetStatus}`}
            </p>
          )}
          {receipt.regressionTestPath !== null && (
            <p className="step-summary">{`Regression test ${receipt.regressionTestPath}`}</p>
          )}
          <IssueValidationReport validation={receivedValidation} />
          {receipt.caseId !== "" && (
            <p className="step-summary">{`Recorded on case ${receipt.caseId}`}</p>
          )}
        </article>
      ) : (
        <article className="receipt-card pending">
          <strong>The fix is validated — opening the Draft PR completes the run</strong>
          {completion === null ? (
            <p className="step-summary">The completion preview is not available yet.</p>
          ) : (
            <>
              <p className="step-summary">
                {`${completion.files.length} file${completion.files.length === 1 ? "" : "s"} on ${completion.branch}${
                  completion.regressionTestPath !== null
                    ? ` · regression test ${completion.regressionTestPath}`
                    : " · no regression test"
                }`}
              </p>
              {completion.ticketTransition !== null && (
                <p className="step-summary">
                  {`Ticket ${completion.ticketTransition.ticketKey} → ${completion.ticketTransition.targetStatus}`}
                </p>
              )}
              <IssueValidationReport validation={pendingValidation} />
              <ul className="completion-files">
                {completion.files.map((file) => (
                  <li key={file.path}>
                    {`${file.path} · ${file.status} · +${file.additions} −${file.deletions}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Feature Implementation lane (`featuresFlow`): feature-selection ->
 * scope-design -> implementation -> complete. Artifacts mirror the Mastra
 * `features` contracts; every renderer keeps server content as text nodes.
 * ---------------------------------------------------------------------- */

export type FeatureTicket = IssueTicket;

export type FeatureAdvanced = { maxChangedFiles: number; guidance: string };

export type FeatureCriterion = { id: string; text: string; included: boolean };

export type FeatureSelectionShape = {
  ticket: FeatureTicket;
  candidates: FeatureTicket[];
  repositories: string[];
  branches: string[];
  repository: string;
  baseBranch: string;
  acceptanceCriteria: FeatureCriterion[];
  advanced: FeatureAdvanced;
};

export type FeatureSelectionDraft = {
  ticket: FeatureTicket;
  repository: string;
  baseBranch: string;
  acceptanceCriteria: FeatureCriterion[];
  advanced: FeatureAdvanced;
};

export type FeatureArea = { id: string; label: string; enabled: boolean };

export type ScopeDesignShape = {
  ticketKey: string;
  repository: string;
  baseBranch: string;
  sourceSha: string;
  targetSummary: string;
  confidence: number | null;
  areas: FeatureArea[];
  guidance: string;
};

export type ScopeDesignDraft = {
  targetSummary: string;
  areas: FeatureArea[];
  guidance: string;
};

export type FeaturePatchFileView = {
  path: string;
  status: "added" | "modified";
  area: string;
  changeDescription: string;
  criteriaIds: string[];
  additions: number;
  deletions: number;
  diff: string;
  content: string;
  validators: string[];
};

export type FeatureCriterionCoverageView = {
  id: string;
  text: string;
  covered: boolean;
  evidence: string | null;
};

export type FeatureImplementationShape = {
  summary: string;
  verdict: "ready" | "needs_attention";
  confidence: number | null;
  strengths: string[];
  risksOpenQuestions: string[];
  crossCuttingNotes: string[];
  files: FeaturePatchFileView[];
  criteriaCoverage: FeatureCriterionCoverageView[];
  validation: IssueValidationView | null;
  repair: { attempted: boolean; applied: boolean } | null;
};

export type FeatureImplementationDraft = {
  summary: string;
  /** Edited file contents keyed by path; untouched files stay as recorded. */
  files: Record<string, string>;
};

export type FeatureCompletionShape = {
  repository: string;
  branch: string;
  files: Array<{ path: string; status: string; area: string; additions: number; deletions: number }>;
  criteriaCoverage: FeatureCriterionCoverageView[];
  criteriaTotal: number;
  criteriaCovered: number;
  validation: IssueValidationView | null;
  ticketTransition: { ticketKey: string; targetStatus: string } | null;
};

export type FeatureReceiptView = {
  url: string | null;
  number: number | null;
  draft: boolean;
  branch: string;
  ticketTransition: { ticketKey: string; targetStatus: string } | null;
  validation: { passed: boolean; attempts: number } | null;
  criteriaTotal: number;
  criteriaCovered: number;
  caseId: string;
};

/** Deterministic feature branch preview; mirrors the flow's `branchFor`. */
export function featureBranch(ticketKey: string): string {
  const slug = ticketKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `feat/${slug === "" ? "ticket" : slug}`;
}

export function parseFeatureCriterion(value: unknown): FeatureCriterion | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asString(record["id"]);
  const text = asString(record["text"]);
  if (id === null || text === null) return null;
  return { id, text, included: record["included"] !== false };
}

export function parseFeatureSelection(
  artifact: Record<string, unknown>,
): FeatureSelectionShape | null {
  const ticket = parseIssueTicket(artifact["ticket"]);
  if (ticket === null) return null;
  const candidates: FeatureTicket[] = [];
  const rawCandidates = artifact["candidates"];
  if (Array.isArray(rawCandidates)) {
    for (const item of rawCandidates) {
      const parsed = parseIssueTicket(item);
      if (parsed !== null) candidates.push(parsed);
    }
  }
  const acceptanceCriteria: FeatureCriterion[] = [];
  const rawCriteria = artifact["acceptanceCriteria"];
  if (Array.isArray(rawCriteria)) {
    for (const item of rawCriteria) {
      const parsed = parseFeatureCriterion(item);
      if (parsed !== null) acceptanceCriteria.push(parsed);
    }
  }
  const advanced = asRecord(artifact["advanced"]);
  const maxChangedFilesRaw = advanced === null ? null : asNumber(advanced["maxChangedFiles"]);
  return {
    ticket,
    candidates,
    repositories: asStringArray(artifact["repositories"]),
    branches: asStringArray(artifact["branches"]),
    repository: asString(artifact["repository"]) ?? "",
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    acceptanceCriteria,
    advanced: {
      maxChangedFiles:
        maxChangedFilesRaw === null ? 10 : Math.min(25, Math.max(1, Math.round(maxChangedFilesRaw))),
      guidance: advanced === null ? "" : asString(advanced["guidance"]) ?? "",
    },
  };
}

export function parseFeatureAreas(value: unknown): FeatureArea[] {
  if (!Array.isArray(value)) return [];
  const areas: FeatureArea[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const id = record === null ? null : asString(record["id"]);
    const label = record === null ? null : asString(record["label"]);
    if (record === null || id === null || label === null) continue;
    areas.push({ id, label, enabled: record["enabled"] !== false });
  }
  return areas;
}

export function parseScopeDesign(artifact: Record<string, unknown>): ScopeDesignShape | null {
  const ticket = parseIssueTicket(artifact["ticket"]);
  const targetSummary = asString(artifact["targetSummary"]);
  if (ticket === null || targetSummary === null) return null;
  return {
    ticketKey: ticket.key,
    repository: asString(artifact["repository"]) ?? "",
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    sourceSha: asString(artifact["sourceSha"]) ?? "",
    targetSummary,
    confidence: asNumber(artifact["confidence"]),
    areas: parseFeatureAreas(artifact["areas"]),
    guidance: asString(artifact["guidance"]) ?? "",
  };
}

export function parseFeaturePatchFiles(value: unknown): FeaturePatchFileView[] {
  if (!Array.isArray(value)) return [];
  const files: FeaturePatchFileView[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const path = record === null ? null : asString(record["path"]);
    const status = record === null ? null : asString(record["status"]);
    if (record === null || path === null || (status !== "added" && status !== "modified")) continue;
    files.push({
      path,
      status,
      area: asString(record["area"]) ?? "",
      changeDescription: asString(record["changeDescription"]) ?? "",
      criteriaIds: asStringArray(record["criteriaIds"]),
      additions: asNumber(record["additions"]) ?? 0,
      deletions: asNumber(record["deletions"]) ?? 0,
      diff: asString(record["diff"]) ?? "",
      content: asString(record["content"]) ?? "",
      validators: asStringArray(record["validators"]),
    });
  }
  return files;
}

export function parseCriterionCoverage(value: unknown): FeatureCriterionCoverageView[] {
  if (!Array.isArray(value)) return [];
  const coverage: FeatureCriterionCoverageView[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const id = record === null ? null : asString(record["id"]);
    const text = record === null ? null : asString(record["text"]);
    if (record === null || id === null || text === null) continue;
    coverage.push({
      id,
      text,
      covered: record["covered"] === true,
      evidence: asString(record["evidence"]),
    });
  }
  return coverage;
}

export function parseFeatureImplementation(
  artifact: Record<string, unknown>,
): FeatureImplementationShape | null {
  const summary = asString(artifact["summary"]);
  const verdict = artifact["verdict"];
  if (summary === null || (verdict !== "ready" && verdict !== "needs_attention")) return null;
  const repair = asRecord(artifact["repair"]);
  return {
    summary,
    verdict,
    confidence: asNumber(artifact["confidence"]),
    strengths: asStringArray(artifact["strengths"]),
    risksOpenQuestions: asStringArray(artifact["risksOpenQuestions"]),
    crossCuttingNotes: asStringArray(artifact["crossCuttingNotes"]),
    files: parseFeaturePatchFiles(artifact["files"]),
    criteriaCoverage: parseCriterionCoverage(artifact["criteriaCoverage"]),
    validation: parseIssueValidation(artifact["validation"]),
    repair:
      repair === null
        ? null
        : { attempted: repair["attempted"] === true, applied: repair["applied"] === true },
  };
}

export function parseFeatureCompletion(
  artifact: Record<string, unknown>,
): FeatureCompletionShape | null {
  const branch = asString(artifact["branch"]);
  if (branch === null) return null;
  const files: FeatureCompletionShape["files"] = [];
  const rawFiles = artifact["files"];
  if (Array.isArray(rawFiles)) {
    for (const item of rawFiles) {
      const record = asRecord(item);
      const path = record === null ? null : asString(record["path"]);
      if (record === null || path === null) continue;
      files.push({
        path,
        status: asString(record["status"]) ?? "",
        area: asString(record["area"]) ?? "",
        additions: asNumber(record["additions"]) ?? 0,
        deletions: asNumber(record["deletions"]) ?? 0,
      });
    }
  }
  const transition = asRecord(artifact["ticketTransition"]);
  const ticketKey = transition === null ? null : asString(transition["ticketKey"]);
  const targetStatus = transition === null ? null : asString(transition["targetStatus"]);
  return {
    repository: asString(artifact["repository"]) ?? "",
    branch,
    files,
    criteriaCoverage: parseCriterionCoverage(artifact["criteriaCoverage"]),
    criteriaTotal: asNumber(artifact["criteriaTotal"]) ?? 0,
    criteriaCovered: asNumber(artifact["criteriaCovered"]) ?? 0,
    validation: parseIssueValidation(artifact["validation"]),
    ticketTransition:
      ticketKey !== null && targetStatus !== null ? { ticketKey, targetStatus } : null,
  };
}

export function parseFeatureReceipt(value: unknown): FeatureReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const pr = asRecord(record["pr"]);
  const branch = asString(record["branch"]);
  if (pr === null || branch === null) return null;
  const transition = asRecord(record["ticketTransition"]);
  const ticketKey = transition === null ? null : asString(transition["ticketKey"]);
  const targetStatus = transition === null ? null : asString(transition["targetStatus"]);
  const validation = asRecord(record["validation"]);
  return {
    url: safeHttpsUrl(pr["url"]),
    number: asNumber(pr["number"]),
    draft: pr["draft"] === true,
    branch,
    ticketTransition:
      ticketKey !== null && targetStatus !== null ? { ticketKey, targetStatus } : null,
    validation:
      validation === null
        ? null
        : {
            passed: validation["passed"] === true,
            attempts: asNumber(validation["attempts"]) ?? 0,
          },
    criteriaTotal: asNumber(record["criteriaTotal"]) ?? 0,
    criteriaCovered: asNumber(record["criteriaCovered"]) ?? 0,
    caseId: asString(record["caseId"]) ?? "",
  };
}

/** Step 1 — feature-ticket chips, repo/branch pickers, criteria checklist, Start Planning. */
export function FeatureSelectionSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: FeatureSelectionDraft | null;
  onChange: (draft: FeatureSelectionDraft) => void;
}) {
  const groupName = useId();
  const guidanceId = useId();
  const maxFilesId = useId();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const parsed = parseFeatureSelection(artifact);

  if (parsed === null) {
    return <p className="step-empty">The feature selection is not available yet.</p>;
  }
  const value: FeatureSelectionDraft = draft ?? {
    ticket: parsed.ticket,
    repository: parsed.repository,
    baseBranch: parsed.baseBranch,
    acceptanceCriteria: parsed.acceptanceCriteria,
    advanced: parsed.advanced,
  };

  function update(patch: Partial<FeatureSelectionDraft>): void {
    onChange({ ...value, ...patch });
  }

  function toggleCriterion(id: string, included: boolean): void {
    update({
      acceptanceCriteria: value.acceptanceCriteria.map((criterion) =>
        criterion.id === id ? { ...criterion, included } : criterion,
      ),
    });
  }

  const includedCount = value.acceptanceCriteria.filter((criterion) => criterion.included).length;
  const advancedDirty =
    value.advanced.maxChangedFiles !== parsed.advanced.maxChangedFiles ||
    value.advanced.guidance !== parsed.advanced.guidance;

  return (
    <div className="feature-selection-surface">
      <fieldset className="ticket-chips">
        <legend>Feature ticket</legend>
        {parsed.candidates.length === 0 ? (
          <p className="step-empty">No candidate tickets were provided for this run.</p>
        ) : (
          <div className="ticket-chip-row">
            {parsed.candidates.map((candidate) => (
              <label
                key={candidate.key}
                className={`ticket-chip${candidate.key === value.ticket.key ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name={groupName}
                  checked={candidate.key === value.ticket.key}
                  disabled={!editable}
                  onChange={() => update({ ticket: candidate })}
                />
                <span className="ticket-chip-text">
                  <strong>{candidate.key}</strong>
                  <span>{candidate.summary}</span>
                  {candidate.status !== "" ? (
                    <span className="ticket-chip-status">{candidate.status}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="issue-pickers">
        <label className="field-row">
          <span>Repository</span>
          <select
            value={value.repository}
            disabled={!editable}
            onChange={(event) => update({ repository: event.target.value })}
          >
            {parsed.repositories.length === 0 ? (
              <option value={value.repository}>{value.repository}</option>
            ) : (
              parsed.repositories.map((repository) => (
                <option key={repository} value={repository}>
                  {repository}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="field-row">
          <span>Branch</span>
          <select
            value={value.baseBranch}
            disabled={!editable}
            onChange={(event) => update({ baseBranch: event.target.value })}
          >
            {parsed.branches.length === 0 ? (
              <option value={value.baseBranch}>{value.baseBranch}</option>
            ) : (
              parsed.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      <p className="fix-branch-preview">
        {`The feature lands on ${value.repository || "the repository"}@${featureBranch(
          value.ticket.key,
        )}, branched from ${value.baseBranch || "the base branch"}.`}
      </p>

      <fieldset className="criteria-checklist">
        <legend>{`Acceptance criteria (${includedCount} of ${value.acceptanceCriteria.length} included)`}</legend>
        {value.acceptanceCriteria.length === 0 ? (
          <p className="step-empty">This ticket carries no acceptance criteria yet.</p>
        ) : (
          <ul>
            {value.acceptanceCriteria.map((criterion) => (
              <li key={criterion.id} className={criterion.included ? "included" : "excluded"}>
                <label>
                  <input
                    type="checkbox"
                    checked={criterion.included}
                    disabled={!editable}
                    onChange={(event) => toggleCriterion(criterion.id, event.target.checked)}
                  />
                  <strong>{criterion.id}</strong>
                  <span>{criterion.text}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="advanced-settings">
        <button
          type="button"
          className="advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {`Advanced Settings${advancedDirty ? " · edited" : ""}`}
        </button>
        {advancedOpen && (
          <div className="advanced-body">
            <label className="field-row" htmlFor={maxFilesId}>
              <span>Max changed files</span>
              <input
                id={maxFilesId}
                type="number"
                min={1}
                max={25}
                value={value.advanced.maxChangedFiles}
                disabled={!editable}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next >= 1 && next <= 25) {
                    update({ advanced: { ...value.advanced, maxChangedFiles: next } });
                  }
                }}
              />
            </label>
            <label className="field-row" htmlFor={guidanceId}>
              <span>Guidance</span>
              <textarea
                id={guidanceId}
                rows={3}
                maxLength={4000}
                value={value.advanced.guidance}
                disabled={!editable}
                placeholder="Anything the implementation should account for (optional)"
                onChange={(event) =>
                  update({ advanced: { ...value.advanced, guidance: event.target.value } })
                }
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

/** Step 2 — target summary bar with Change, area cards with Select All/Clear, guidance. */
export function ScopeDesignSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: ScopeDesignDraft | null;
  onChange: (draft: ScopeDesignDraft) => void;
}) {
  const summaryId = useId();
  const guidanceId = useId();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const parsed = parseScopeDesign(artifact);

  if (parsed === null) {
    return <p className="step-empty">The scope and design are not available yet.</p>;
  }
  const value: ScopeDesignDraft = draft ?? {
    targetSummary: parsed.targetSummary,
    areas: parsed.areas,
    guidance: parsed.guidance,
  };

  function setArea(id: string, enabled: boolean): void {
    onChange({
      ...value,
      areas: value.areas.map((area) => (area.id === id ? { ...area, enabled } : area)),
    });
  }

  function setAll(enabled: boolean): void {
    onChange({ ...value, areas: value.areas.map((area) => ({ ...area, enabled })) });
  }

  const enabledCount = value.areas.filter((area) => area.enabled).length;

  return (
    <div className="scope-surface">
      <div className="target-summary-bar">
        {summaryOpen && editable ? (
          <label className="field-row" htmlFor={summaryId}>
            <span>Target summary</span>
            <textarea
              id={summaryId}
              rows={2}
              value={value.targetSummary}
              onChange={(event) => onChange({ ...value, targetSummary: event.target.value })}
            />
          </label>
        ) : (
          <Markdown text={value.targetSummary} className="analysis-summary" />
        )}
        <div className="target-summary-meta">
          {parsed.confidence !== null ? (
            <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
          ) : null}
          {editable ? (
            <button type="button" onClick={() => setSummaryOpen((open) => !open)}>
              {summaryOpen ? "Keep" : "Change"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="options-toolbar">
        <p className="step-summary">{`${enabledCount} of ${value.areas.length} areas enabled`}</p>
        {editable && (
          <div className="options-bulk">
            <button type="button" onClick={() => setAll(true)}>
              Select All
            </button>
            <button type="button" onClick={() => setAll(false)}>
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="category-grid">
        {value.areas.map((area) => (
          <label key={area.id} className={`category-card${area.enabled ? " enabled" : ""}`}>
            <input
              type="checkbox"
              checked={area.enabled}
              disabled={!editable}
              onChange={(event) => setArea(area.id, event.target.checked)}
            />
            <span>{area.label}</span>
          </label>
        ))}
      </div>

      <label className="guidance-field" htmlFor={guidanceId}>
        <span>Custom guidance</span>
        <textarea
          id={guidanceId}
          rows={3}
          maxLength={4000}
          placeholder="Anything the implementation should account for (optional)"
          value={value.guidance}
          disabled={!editable}
          onChange={(event) => onChange({ ...value, guidance: event.target.value })}
        />
      </label>
    </div>
  );
}

/** Step 3 — planned changes with new-file badges, the review summary, Edit Plan. */
export function FeatureImplementationSurface({
  artifact,
  editing,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editing: boolean;
  draft: FeatureImplementationDraft | null;
  onChange: (draft: FeatureImplementationDraft) => void;
}) {
  const summaryId = useId();
  const [modifyOpen, setModifyOpen] = useState<Record<string, boolean>>({});
  const parsed = parseFeatureImplementation(artifact);

  if (parsed === null) {
    return <p className="step-empty">The implementation is not available yet.</p>;
  }

  if (editing) {
    const value: FeatureImplementationDraft = draft ?? {
      summary: parsed.summary,
      files: Object.fromEntries(parsed.files.map((file) => [file.path, file.content])),
    };
    return (
      <div className="implementation-editor">
        <label className="field-row" htmlFor={summaryId}>
          <span>Implementation summary</span>
          <textarea
            id={summaryId}
            rows={2}
            value={value.summary}
            onChange={(event) => onChange({ ...value, summary: event.target.value })}
          />
        </label>
        {parsed.files.map((file) => (
          <article key={file.path} className="file-card editing">
            <header className="file-card-head">
              <strong className="file-path">{file.path}</strong>
              <span className={`file-status status-${file.status}`}>
                {file.status === "added" ? "new file" : file.status}
              </span>
            </header>
            <textarea
              rows={8}
              className="content-editor"
              value={value.files[file.path] ?? file.content}
              onChange={(event) =>
                onChange({ ...value, files: { ...value.files, [file.path]: event.target.value } })
              }
            />
          </article>
        ))}
      </div>
    );
  }

  const totalAdditions = parsed.files.reduce((total, file) => total + file.additions, 0);
  const totalDeletions = parsed.files.reduce((total, file) => total + file.deletions, 0);

  return (
    <div className="implementation-surface">
      <div className="impl-head">
        <Markdown text={parsed.summary} className="analysis-summary" />
        <div className="analysis-meta">
          <span className={`verdict-pill verdict-${parsed.verdict}`}>
            {parsed.verdict === "ready" ? "Ready" : "Needs attention"}
          </span>
          {parsed.confidence !== null ? (
            <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
          ) : null}
          <span className="file-count-badge">{`${parsed.files.length} file${parsed.files.length === 1 ? "" : "s"}`}</span>
        </div>
      </div>
      <p className="diff-totals">{`+${totalAdditions} / −${totalDeletions} across the plan`}</p>

      {parsed.strengths.length > 0 && (
        <div className="review-block">
          <h4>Strengths</h4>
          <ul>
            {parsed.strengths.map((item, index) => (
              <li key={`strength-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {parsed.risksOpenQuestions.length > 0 && (
        <div className="review-block">
          <h4>Risks & open questions</h4>
          <ul>
            {parsed.risksOpenQuestions.map((item, index) => (
              <li key={`risk-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {parsed.crossCuttingNotes.length > 0 && (
        <aside className="similar-callout cross-cutting-callout">
          <h4>Cross-cutting notes</h4>
          <ul>
            {parsed.crossCuttingNotes.map((note, index) => (
              <li key={`cross-cutting-${index}`}>{note}</li>
            ))}
          </ul>
        </aside>
      )}

      {parsed.repair !== null && parsed.repair.attempted && (
        <p className={`repair-note${parsed.repair.applied ? " applied" : " failed"}`}>
          {parsed.repair.applied
            ? "Validators failed once; the patch was repaired automatically and re-validated."
            : "Validators failed and the single repair attempt did not pass — review carefully before proceeding."}
        </p>
      )}

      <IssueValidationReport validation={parsed.validation} />

      <div className="planned-changes">
        <div className="affected-files-head">
          <h4>Planned changes</h4>
          <span className="file-count-badge">{`${parsed.files.length} file${parsed.files.length === 1 ? "" : "s"}`}</span>
        </div>
        {parsed.files.map((file) => {
          const open = modifyOpen[file.path] === true;
          return (
            <article key={file.path} className="patch-card">
              <header className="file-card-head">
                <strong className="file-path">{file.path}</strong>
                <span className={`file-status status-${file.status}`}>
                  {file.status === "added" ? "new file" : file.status}
                </span>
                {file.area !== "" ? <span className="line-pill">{file.area}</span> : null}
                <span className="diff-stat">{`+${file.additions} −${file.deletions}`}</span>
                <button
                  type="button"
                  className="file-modify"
                  aria-expanded={open}
                  onClick={() => setModifyOpen((previous) => ({ ...previous, [file.path]: !open }))}
                >
                  {open ? "Hide diff" : "Modify"}
                </button>
              </header>
              <Markdown text={file.changeDescription} className="change-description" />
              {file.criteriaIds.length > 0 ? (
                <p className="file-validators">{`Criteria: ${file.criteriaIds.join(", ")}`}</p>
              ) : null}
              <p className="file-validators">{`Validators: ${file.validators.join(", ") || "none"}`}</p>
              {open && <IssueDiffBlock diff={file.diff} />}
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** The per-criterion coverage checklist — shared by the complete and receipt views. */
export function FeatureCoverageChecklist({
  coverage,
}: {
  coverage: FeatureCriterionCoverageView[];
}) {
  if (coverage.length === 0) return null;
  const covered = coverage.filter((criterion) => criterion.covered).length;
  return (
    <div className="criteria-coverage">
      <p className="step-summary">{`Acceptance criteria: ${covered} of ${coverage.length} covered`}</p>
      <ul className="criteria-coverage-list">
        {coverage.map((criterion) => (
          <li key={criterion.id} className={criterion.covered ? "covered" : "uncovered"}>
            <span className="criterion-mark" aria-hidden="true">
              {criterion.covered ? "✓" : "○"}
            </span>
            {` ${criterion.id}: ${criterion.text}`}
            {criterion.evidence !== null && criterion.evidence !== "" ? (
              <span className="criterion-evidence">{` — ${criterion.evidence}`}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Step 4 — the Draft PR, the coverage checklist, the validation status and the review cross-link. */
export function FeatureCompleteSurface({
  artifact,
  receipt,
  reviewLink,
}: {
  artifact: Record<string, unknown> | null;
  receipt: FeatureReceiptView | null;
  reviewLink?: { onStart: () => void; busy: boolean } | undefined;
}) {
  const completion = artifact === null ? null : parseFeatureCompletion(artifact);

  return (
    <div className="complete-surface feature-complete">
      {receipt !== null ? (
        <article className="receipt-card">
          <div className="receipt-head">
            <strong>{receipt.number === null ? "Draft PR" : `Draft PR #${receipt.number}`}</strong>
            {receipt.draft ? <span className="pr-draft">draft</span> : null}
          </div>
          {receipt.url !== null ? (
            <a href={receipt.url} target="_blank" rel="noopener noreferrer">
              View the Draft PR
            </a>
          ) : (
            <p className="step-empty">The Draft PR was opened; the link is unavailable.</p>
          )}
          <p className="step-summary">{`Branch ${receipt.branch}`}</p>
          {receipt.ticketTransition !== null && (
            <p className="step-summary">
              {`Ticket ${receipt.ticketTransition.ticketKey} → ${receipt.ticketTransition.targetStatus}`}
            </p>
          )}
          {completion !== null && completion.criteriaCoverage.length > 0 ? (
            <FeatureCoverageChecklist coverage={completion.criteriaCoverage} />
          ) : (
            <p className="step-summary">
              {`Acceptance criteria: ${receipt.criteriaCovered} of ${receipt.criteriaTotal} covered`}
            </p>
          )}
          {receipt.validation !== null && (
            <p className="step-summary">
              {`Validators ${receipt.validation.passed ? "passed" : "failed"} · ${receipt.validation.attempts} attempt${
                receipt.validation.attempts === 1 ? "" : "s"
              }`}
            </p>
          )}
          {receipt.caseId !== "" && (
            <p className="step-summary">{`Recorded on case ${receipt.caseId}`}</p>
          )}
        </article>
      ) : (
        <article className="receipt-card pending">
          <strong>The feature is validated — opening the Draft PR completes the run</strong>
          {completion === null ? (
            <p className="step-summary">The completion preview is not available yet.</p>
          ) : (
            <>
              <p className="step-summary">
                {`${completion.files.length} file${completion.files.length === 1 ? "" : "s"} on ${completion.branch}`}
              </p>
              {completion.ticketTransition !== null && (
                <p className="step-summary">
                  {`Ticket ${completion.ticketTransition.ticketKey} → ${completion.ticketTransition.targetStatus}`}
                </p>
              )}
              <FeatureCoverageChecklist coverage={completion.criteriaCoverage} />
              <IssueValidationReport validation={completion.validation} />
              <ul className="completion-files">
                {completion.files.map((file) => (
                  <li key={file.path}>
                    {`${file.path} · ${file.status} · +${file.additions} −${file.deletions}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      )}

      <p className="follow-up-note">
        A human merges the Draft PR. The PR Review workflow reviews the pull request; a follow-up run
        examines deltas only.
      </p>

      {receipt !== null && reviewLink !== undefined && receipt.number !== null && (
        <button
          type="button"
          className="follow-up-button"
          disabled={reviewLink.busy}
          onClick={reviewLink.onStart}
        >
          Start PR Review for this PR
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Dependency Update lane (`dependenciesFlow`): scan -> group -> apply ->
 * validate -> merge. Artifacts mirror the Mastra `dependencies` contracts;
 * every renderer keeps server content as text nodes.
 * ---------------------------------------------------------------------- */

export type DependencyJump = "patch" | "minor" | "major";

export type DependencyVulnerabilityView = {
  cve: string;
  cvss: number | null;
  severity: "low" | "moderate" | "high" | "critical";
  summary: string;
};

const CVE_PATTERN = /^CVE-[0-9]{4}-[0-9]+$/;

const DEPENDENCY_SEVERITIES: readonly DependencyVulnerabilityView["severity"][] = [
  "low",
  "moderate",
  "high",
  "critical",
];

function isDependencySeverity(value: unknown): value is DependencyVulnerabilityView["severity"] {
  return typeof value === "string" && (DEPENDENCY_SEVERITIES as readonly string[]).includes(value);
}

/** CVE detail link, only ever built from an id that passed the CVE pattern. */
export function cveUrl(cve: string): string | null {
  return CVE_PATTERN.test(cve) ? `https://nvd.nist.gov/vuln/detail/${cve}` : null;
}

export function parseDependencyVulnerabilities(value: unknown): DependencyVulnerabilityView[] {
  if (!Array.isArray(value)) return [];
  const vulnerabilities: DependencyVulnerabilityView[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const cve = record === null ? null : asString(record["cve"]);
    const summary = record === null ? null : asString(record["summary"]);
    if (
      record === null ||
      cve === null ||
      summary === null ||
      !CVE_PATTERN.test(cve) ||
      !isDependencySeverity(record["severity"])
    ) {
      continue;
    }
    vulnerabilities.push({
      cve,
      cvss: asNumber(record["cvss"]),
      severity: record["severity"],
      summary,
    });
  }
  return vulnerabilities;
}

function dependencyKind(value: unknown): "dependency" | "devDependency" {
  return value === "devDependency" ? "devDependency" : "dependency";
}

function dependencyJump(value: unknown): DependencyJump | null {
  return value === "major" || value === "minor" || value === "patch" ? value : null;
}

/* --- Scan --- */

export type ScanJumpView = DependencyJump | "up_to_date";

export type ScanPackageView = {
  name: string;
  kind: "dependency" | "devDependency";
  current: string;
  latest: string;
  jump: ScanJumpView;
  daysOutdated: number;
  changelogExcerpt: string;
  vulnerabilities: DependencyVulnerabilityView[];
};

export type DependencyScanShape = {
  repository: string;
  baseBranch: string;
  sourceSha: string;
  manifestPath: string;
  packages: ScanPackageView[];
  totals: { packages: number; outdated: number; vulnerable: number; major: number };
};

export function parseDependencyScan(
  artifact: Record<string, unknown>,
): DependencyScanShape | null {
  const repository = asString(artifact["repository"]);
  const manifestPath = asString(artifact["manifestPath"]);
  if (repository === null || manifestPath === null) return null;
  const packages: ScanPackageView[] = [];
  const rawPackages = artifact["packages"];
  if (Array.isArray(rawPackages)) {
    for (const item of rawPackages) {
      const record = asRecord(item);
      const name = record === null ? null : asString(record["name"]);
      const current = record === null ? null : asString(record["current"]);
      const latest = record === null ? null : asString(record["latest"]);
      if (record === null || name === null || current === null || latest === null) continue;
      const jump = record["jump"];
      packages.push({
        name,
        kind: dependencyKind(record["kind"]),
        current,
        latest,
        jump: jump === "major" || jump === "minor" || jump === "patch" ? jump : "up_to_date",
        daysOutdated: asNumber(record["daysOutdated"]) ?? 0,
        changelogExcerpt: asString(record["changelogExcerpt"]) ?? "",
        vulnerabilities: parseDependencyVulnerabilities(record["vulnerabilities"]),
      });
    }
  }
  const totals = asRecord(artifact["totals"]);
  return {
    repository,
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    sourceSha: asString(artifact["sourceSha"]) ?? "",
    manifestPath,
    packages,
    totals: {
      packages: asNumber(totals?.["packages"]) ?? packages.length,
      outdated:
        asNumber(totals?.["outdated"]) ??
        packages.filter((pkg) => pkg.jump !== "up_to_date").length,
      vulnerable:
        asNumber(totals?.["vulnerable"]) ??
        packages.filter((pkg) => pkg.vulnerabilities.length > 0).length,
      major: asNumber(totals?.["major"]) ?? packages.filter((pkg) => pkg.jump === "major").length,
    },
  };
}

const JUMP_LABELS: Record<ScanJumpView, string> = {
  major: "major",
  minor: "minor",
  patch: "patch",
  up_to_date: "up to date",
};

/** Step 1 — the inventory table with jump badges, CVE tags, and filter chips. */
export function DependencyScanSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const [filter, setFilter] = useState<"all" | "security" | "major">("all");
  const parsed = parseDependencyScan(artifact);

  if (parsed === null) {
    return <p className="step-empty">The dependency scan is not available yet.</p>;
  }
  const packages = parsed.packages.filter((pkg) => {
    if (filter === "security") return pkg.vulnerabilities.length > 0;
    if (filter === "major") return pkg.jump === "major";
    return true;
  });

  return (
    <div className="dependency-scan-surface">
      <p className="step-summary">
        {`${parsed.repository}@${parsed.baseBranch} · ${parsed.manifestPath} — ${parsed.totals.packages} packages, ${parsed.totals.outdated} outdated, ${parsed.totals.vulnerable} vulnerable, ${parsed.totals.major} major.`}
      </p>
      <div className="filter-chips" role="group" aria-label="Filter dependencies">
        {(["all", "security", "major"] as const).map((chip) => (
          <button
            key={chip}
            type="button"
            className={`chip${filter === chip ? " active" : ""}`}
            aria-pressed={filter === chip}
            onClick={() => setFilter(chip)}
          >
            {chip === "all" ? "All" : chip === "security" ? "Security" : "Major"}
          </button>
        ))}
      </div>
      {packages.length === 0 ? (
        <p className="step-empty">No packages match this filter.</p>
      ) : (
        <table className="dependency-table">
          <thead>
            <tr>
              <th>Package</th>
              <th>Current → latest</th>
              <th>Jump</th>
              <th>Vulnerabilities</th>
              <th>Days outdated</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((pkg) => (
              <tr key={pkg.name}>
                <td>
                  <strong>{pkg.name}</strong>
                  {pkg.kind === "devDependency" ? <span className="line-pill">dev</span> : null}
                </td>
                <td className="dependency-version-cell">{`${pkg.current} → ${pkg.latest}`}</td>
                <td>
                  <span className={`jump-badge jump-${pkg.jump}`}>{JUMP_LABELS[pkg.jump]}</span>
                </td>
                <td>
                  {pkg.vulnerabilities.length === 0 ? (
                    "—"
                  ) : (
                    <ul className="vulnerability-tags">
                      {pkg.vulnerabilities.map((vulnerability) => {
                        const href = cveUrl(vulnerability.cve);
                        return (
                          <li key={vulnerability.cve}>
                            {href === null ? (
                              vulnerability.cve
                            ) : (
                              <a href={href} target="_blank" rel="noopener noreferrer">
                                {vulnerability.cve}
                              </a>
                            )}
                            {` · ${vulnerability.severity}${
                              vulnerability.cvss === null ? "" : ` · CVSS ${vulnerability.cvss}`
                            }`}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </td>
                <td>{pkg.jump === "up_to_date" ? "—" : `${pkg.daysOutdated} days`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="step-summary">
        Scanning is informational — Abort if this is the wrong repository or manifest.
      </p>
    </div>
  );
}

/* --- Group --- */

export type GroupPackageView = {
  name: string;
  kind: "dependency" | "devDependency";
  from: string;
  to: string;
  jump: DependencyJump;
  daysOutdated: number;
  changelogExcerpt: string;
  vulnerabilities: DependencyVulnerabilityView[];
  excluded: boolean;
  excludeReason: string;
};

export type DependencyGroupView = {
  id: DependencyJump;
  label: string;
  riskNote: string;
  packages: GroupPackageView[];
};

export type DependencyGroupShape = {
  repository: string;
  baseBranch: string;
  sourceSha: string;
  manifestPath: string;
  groups: DependencyGroupView[];
};

export type DependencyGroupDraft = { groups: DependencyGroupView[] };

function parseGroupPackage(value: unknown): GroupPackageView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asString(record["name"]);
  const from = asString(record["from"]);
  const to = asString(record["to"]);
  const jump = dependencyJump(record["jump"]);
  if (name === null || from === null || to === null || jump === null) return null;
  return {
    name,
    kind: dependencyKind(record["kind"]),
    from,
    to,
    jump,
    daysOutdated: asNumber(record["daysOutdated"]) ?? 0,
    changelogExcerpt: asString(record["changelogExcerpt"]) ?? "",
    vulnerabilities: parseDependencyVulnerabilities(record["vulnerabilities"]),
    excluded: record["excluded"] === true,
    excludeReason: asString(record["excludeReason"]) ?? "",
  };
}

export function parseDependencyGroups(
  artifact: Record<string, unknown>,
): DependencyGroupShape | null {
  const repository = asString(artifact["repository"]);
  if (repository === null) return null;
  const groups: DependencyGroupView[] = [];
  const rawGroups = artifact["groups"];
  if (Array.isArray(rawGroups)) {
    for (const item of rawGroups) {
      const record = asRecord(item);
      const id = record === null ? null : dependencyJump(record["id"]);
      const label = record === null ? null : asString(record["label"]);
      if (record === null || id === null || label === null) continue;
      const packages: GroupPackageView[] = [];
      if (Array.isArray(record["packages"])) {
        for (const pkg of record["packages"]) {
          const parsed = parseGroupPackage(pkg);
          if (parsed !== null) packages.push(parsed);
        }
      }
      groups.push({ id, label, riskNote: asString(record["riskNote"]) ?? "", packages });
    }
  }
  return {
    repository,
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    sourceSha: asString(artifact["sourceSha"]) ?? "",
    manifestPath: asString(artifact["manifestPath"]) ?? "",
    groups,
  };
}

/** Step 2 — group cards; move a package between groups or exclude it with a reason. */
export function DependencyGroupSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: DependencyGroupDraft | null;
  onChange: (draft: DependencyGroupDraft) => void;
}) {
  const parsed = parseDependencyGroups(artifact);

  if (parsed === null) {
    return <p className="step-empty">The dependency grouping is not available yet.</p>;
  }
  const value: DependencyGroupDraft = draft ?? { groups: parsed.groups };
  const allPackages = value.groups.flatMap((group) => group.packages);
  const missingReasons = allPackages.filter(
    (pkg) => pkg.excluded && pkg.excludeReason.trim() === "",
  );

  function setPackage(
    groupId: DependencyJump,
    name: string,
    patch: Partial<GroupPackageView>,
  ): void {
    onChange({
      groups: value.groups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              packages: group.packages.map((pkg) =>
                pkg.name === name ? { ...pkg, ...patch } : pkg,
              ),
            }
          : group,
      ),
    });
  }

  function movePackage(fromId: DependencyJump, name: string, toId: DependencyJump): void {
    if (fromId === toId) return;
    const moved = value.groups
      .find((group) => group.id === fromId)
      ?.packages.find((pkg) => pkg.name === name);
    if (moved === undefined) return;
    onChange({
      groups: value.groups.map((group) => {
        if (group.id === fromId) {
          return { ...group, packages: group.packages.filter((pkg) => pkg.name !== name) };
        }
        if (group.id === toId) return { ...group, packages: [...group.packages, moved] };
        return group;
      }),
    });
  }

  return (
    <div className="dependency-group-surface">
      <div className="options-toolbar">
        <p className="step-summary">
          {`${value.groups.length} groups · ${allPackages.length} packages · ${
            allPackages.filter((pkg) => pkg.excluded).length
          } excluded`}
        </p>
        {editable && (
          <div className="options-bulk">
            <button
              type="button"
              onClick={() =>
                onChange({
                  groups: value.groups.map((group) => ({
                    ...group,
                    packages: group.packages.map((pkg) => ({
                      ...pkg,
                      excluded: false,
                      excludeReason: "",
                    })),
                  })),
                })
              }
            >
              Include All
            </button>
          </div>
        )}
      </div>
      {value.groups.map((group) => (
        <article key={group.id} className={`dependency-group-card group-${group.id}`}>
          <header className="file-card-head">
            <strong>{group.label}</strong>
            <span className="file-count-badge">
              {`${group.packages.length} package${group.packages.length === 1 ? "" : "s"}`}
            </span>
          </header>
          <Markdown text={group.riskNote} className="change-description" />
          {group.packages.length === 0 ? (
            <p className="step-empty">No packages in this group.</p>
          ) : (
            <ul className="dependency-list">
              {group.packages.map((pkg) => (
                <li key={pkg.name} className={pkg.excluded ? "excluded" : ""}>
                  <div className="dependency-row">
                    <strong>{pkg.name}</strong>
                    <span className="dependency-version-cell">{`${pkg.from} → ${pkg.to}`}</span>
                    {pkg.vulnerabilities.length > 0 ? (
                      <span className="jump-badge jump-security">
                        {`${pkg.vulnerabilities.length} CVE`}
                      </span>
                    ) : null}
                    <span className="line-pill">{`${pkg.daysOutdated}d`}</span>
                  </div>
                  {pkg.changelogExcerpt !== "" ? (
                    <Markdown text={pkg.changelogExcerpt} className="change-description" />
                  ) : null}
                  <div className="dependency-controls">
                    <label>
                      <input
                        type="checkbox"
                        checked={pkg.excluded}
                        disabled={!editable}
                        onChange={(event) =>
                          setPackage(group.id, pkg.name, { excluded: event.target.checked })
                        }
                      />
                      <span>Exclude</span>
                    </label>
                    <label>
                      <span>Move to</span>
                      <select
                        value={group.id}
                        disabled={!editable}
                        onChange={(event) =>
                          movePackage(
                            group.id,
                            pkg.name,
                            dependencyJump(event.target.value) ?? group.id,
                          )
                        }
                      >
                        {(["patch", "minor", "major"] as const).map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </label>
                    {pkg.excluded && (
                      <label className="exclude-reason">
                        <span>Reason (required)</span>
                        <input
                          type="text"
                          maxLength={500}
                          value={pkg.excludeReason}
                          disabled={!editable}
                          placeholder="Why is this package excluded?"
                          onChange={(event) =>
                            setPackage(group.id, pkg.name, { excludeReason: event.target.value })
                          }
                        />
                      </label>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      {missingReasons.length > 0 && (
        <p className="run-action-error" role="alert">
          {`An exclude reason is required for ${missingReasons.map((pkg) => pkg.name).join(", ")}.`}
        </p>
      )}
    </div>
  );
}

/* --- Apply --- */

export type DependencyFileChangeView = {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  content: string;
  validators: string[];
};

export type ApplyPackageView = {
  name: string;
  kind: "dependency" | "devDependency";
  from: string;
  to: string;
  jump: DependencyJump;
  vulnerabilities: DependencyVulnerabilityView[];
  included: boolean;
};

export type ApplyGroupView = {
  id: DependencyJump;
  label: string;
  riskNote: string;
  accepted: boolean;
  breakingNotes: string[];
  packages: ApplyPackageView[];
  manifest: DependencyFileChangeView;
  lockfile: DependencyFileChangeView | null;
};

export type DependencyApplyShape = {
  repository: string;
  baseBranch: string;
  sourceSha: string;
  manifestPath: string;
  lockfilePath: string | null;
  summary: string;
  confidence: number | null;
  groups: ApplyGroupView[];
};

export type DependencyApplyDraft = {
  groups: Array<{
    id: DependencyJump;
    accepted: boolean;
    packages: Array<{ name: string; included: boolean }>;
  }>;
};

function parseDependencyFileChange(value: unknown): DependencyFileChangeView | null {
  const record = asRecord(value);
  const path = record === null ? null : asString(record["path"]);
  if (record === null || path === null) return null;
  return {
    path,
    additions: asNumber(record["additions"]) ?? 0,
    deletions: asNumber(record["deletions"]) ?? 0,
    diff: asString(record["diff"]) ?? "",
    content: asString(record["content"]) ?? "",
    validators: asStringArray(record["validators"]),
  };
}

function parseApplyPackage(value: unknown): ApplyPackageView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asString(record["name"]);
  const from = asString(record["from"]);
  const to = asString(record["to"]);
  const jump = dependencyJump(record["jump"]);
  if (name === null || from === null || to === null || jump === null) return null;
  return {
    name,
    kind: dependencyKind(record["kind"]),
    from,
    to,
    jump,
    vulnerabilities: parseDependencyVulnerabilities(record["vulnerabilities"]),
    included: record["included"] !== false,
  };
}

export function parseDependencyApply(
  artifact: Record<string, unknown>,
): DependencyApplyShape | null {
  const repository = asString(artifact["repository"]);
  const summary = asString(artifact["summary"]);
  if (repository === null || summary === null) return null;
  const groups: ApplyGroupView[] = [];
  const rawGroups = artifact["groups"];
  if (Array.isArray(rawGroups)) {
    for (const item of rawGroups) {
      const record = asRecord(item);
      const id = record === null ? null : dependencyJump(record["id"]);
      const label = record === null ? null : asString(record["label"]);
      const manifest = record === null ? null : parseDependencyFileChange(record["manifest"]);
      if (record === null || id === null || label === null || manifest === null) continue;
      const packages: ApplyPackageView[] = [];
      if (Array.isArray(record["packages"])) {
        for (const pkg of record["packages"]) {
          const parsed = parseApplyPackage(pkg);
          if (parsed !== null) packages.push(parsed);
        }
      }
      groups.push({
        id,
        label,
        riskNote: asString(record["riskNote"]) ?? "",
        accepted: record["accepted"] !== false,
        breakingNotes: asStringArray(record["breakingNotes"]),
        packages,
        manifest,
        lockfile: parseDependencyFileChange(record["lockfile"]),
      });
    }
  }
  return {
    repository,
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    sourceSha: asString(artifact["sourceSha"]) ?? "",
    manifestPath: asString(artifact["manifestPath"]) ?? "",
    lockfilePath: asString(artifact["lockfilePath"]),
    summary,
    confidence: asNumber(artifact["confidence"]),
    groups,
  };
}

/** Step 3 — per-group diffs and toggles; majors stay package-by-package. */
export function DependencyApplySurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: DependencyApplyDraft | null;
  onChange: (draft: DependencyApplyDraft) => void;
}) {
  const [diffsOpen, setDiffsOpen] = useState<Record<string, boolean>>({});
  const parsed = parseDependencyApply(artifact);

  if (parsed === null) {
    return <p className="step-empty">The dependency bumps are not available yet.</p>;
  }
  const value: DependencyApplyDraft =
    draft ??
    {
      groups: parsed.groups.map((group) => ({
        id: group.id,
        accepted: group.accepted,
        packages: group.packages.map((pkg) => ({ name: pkg.name, included: pkg.included })),
      })),
    };
  const includedCount = value.groups.reduce(
    (total, group) =>
      total + (group.accepted ? group.packages.filter((pkg) => pkg.included).length : 0),
    0,
  );

  function setGroup(groupId: DependencyJump, accepted: boolean): void {
    onChange({
      groups: value.groups.map((group) => (group.id === groupId ? { ...group, accepted } : group)),
    });
  }

  function setPackage(groupId: DependencyJump, name: string, included: boolean): void {
    onChange({
      groups: value.groups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              packages: group.packages.map((pkg) =>
                pkg.name === name ? { ...pkg, included } : pkg,
              ),
            }
          : group,
      ),
    });
  }

  return (
    <div className="dependency-apply-surface">
      <div className="impl-head">
        <Markdown text={parsed.summary} className="analysis-summary" />
        <div className="analysis-meta">
          {parsed.confidence !== null ? (
            <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
          ) : null}
          <span className="file-count-badge">{`${includedCount} bumps included`}</span>
        </div>
      </div>
      {parsed.groups.map((group) => {
        const draftGroup = value.groups.find((item) => item.id === group.id);
        const accepted = draftGroup?.accepted ?? group.accepted;
        const open = diffsOpen[group.id] === true;
        const major = group.id === "major";
        return (
          <article key={group.id} className={`dependency-group-card group-${group.id}`}>
            <header className="file-card-head">
              <strong>{group.label}</strong>
              <span className="file-count-badge">
                {`${group.packages.length} package${group.packages.length === 1 ? "" : "s"}`}
              </span>
              {major ? (
                <span className="line-pill">package-by-package</span>
              ) : (
                <label className="group-accept">
                  <input
                    type="checkbox"
                    checked={accepted}
                    disabled={!editable}
                    onChange={(event) => setGroup(group.id, event.target.checked)}
                  />
                  <span>Include this group</span>
                </label>
              )}
            </header>
            <Markdown text={group.riskNote} className="change-description" />
            {major && (
              <p className="step-summary">
                Major upgrades are accepted package by package — there is no bulk accept.
              </p>
            )}
            {group.breakingNotes.length > 0 && (
              <aside className="similar-callout breaking-callout">
                <h4>Breaking-change notes</h4>
                <ul>
                  {group.breakingNotes.map((note, index) => (
                    <li key={`breaking-${index}`}>{note}</li>
                  ))}
                </ul>
              </aside>
            )}
            <ul className="dependency-list">
              {group.packages.map((pkg) => {
                const pkgDraft = draftGroup?.packages.find((item) => item.name === pkg.name);
                const included = pkgDraft?.included ?? pkg.included;
                return (
                  <li key={pkg.name} className={included ? "" : "excluded"}>
                    <label className="package-toggle">
                      <input
                        type="checkbox"
                        checked={included}
                        disabled={!editable || !accepted}
                        onChange={(event) => setPackage(group.id, pkg.name, event.target.checked)}
                      />
                      <strong>{pkg.name}</strong>
                      <span className="dependency-version-cell">{`${pkg.from} → ${pkg.to}`}</span>
                      {pkg.vulnerabilities.length > 0 ? (
                        <span className="jump-badge jump-security">
                          {pkg.vulnerabilities.map((vulnerability) => vulnerability.cve).join(", ")}
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="diff-toggles">
              <button
                type="button"
                className="diff-toggle"
                aria-expanded={open}
                onClick={() => setDiffsOpen((previous) => ({ ...previous, [group.id]: !open }))}
              >
                {open ? "Hide diffs" : "Show manifest + lockfile diffs"}
              </button>
            </div>
            {open && (
              <>
                <p className="file-validators">
                  {`${group.manifest.path} · +${group.manifest.additions} −${group.manifest.deletions} · Validators: ${group.manifest.validators.join(", ") || "none"}`}
                </p>
                <IssueDiffBlock diff={group.manifest.diff} />
                {group.lockfile !== null && (
                  <>
                    <p className="file-validators">
                      {`${group.lockfile.path} · +${group.lockfile.additions} −${group.lockfile.deletions} · Validators: ${group.lockfile.validators.join(", ") || "none"}`}
                    </p>
                    <IssueDiffBlock diff={group.lockfile.diff} />
                  </>
                )}
              </>
            )}
          </article>
        );
      })}
      {includedCount === 0 && (
        <p className="run-action-error" role="alert">
          Turn on at least one package before validating the bumps.
        </p>
      )}
    </div>
  );
}

/* --- Validate --- */

export type ValidateFailureView = {
  path: string;
  validator: string;
  message: string;
  isNew: boolean;
};

export type ValidateGroupView = {
  id: DependencyJump;
  label: string;
  skipped: boolean;
  status: "green" | "failed" | "skipped";
  install: { passed: boolean; message: string };
  tests: { passed: number; total: number; failures: ValidateFailureView[] };
  log: string;
  suggestion: string | null;
};

export type DependencyValidateShape = {
  repository: string;
  baseBranch: string;
  sourceSha: string;
  manifestPath: string;
  lockfilePath: string | null;
  groups: ValidateGroupView[];
};

export type DependencyValidateDraft = { skipped: Record<string, boolean> };

function parseValidateFailures(value: unknown): ValidateFailureView[] {
  if (!Array.isArray(value)) return [];
  const failures: ValidateFailureView[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const path = record === null ? null : asString(record["path"]);
    const validator = record === null ? null : asString(record["validator"]);
    const message = record === null ? null : asString(record["message"]);
    if (record === null || path === null || validator === null || message === null) continue;
    failures.push({ path, validator, message, isNew: record["isNew"] === true });
  }
  return failures;
}

export function parseDependencyValidate(
  artifact: Record<string, unknown>,
): DependencyValidateShape | null {
  const repository = asString(artifact["repository"]);
  if (repository === null) return null;
  const groups: ValidateGroupView[] = [];
  const rawGroups = artifact["groups"];
  if (Array.isArray(rawGroups)) {
    for (const item of rawGroups) {
      const record = asRecord(item);
      const id = record === null ? null : dependencyJump(record["id"]);
      const label = record === null ? null : asString(record["label"]);
      const status = record === null ? null : record["status"];
      if (record === null || id === null || label === null) continue;
      if (status !== "green" && status !== "failed" && status !== "skipped") continue;
      const install = asRecord(record["install"]);
      const tests = asRecord(record["tests"]);
      groups.push({
        id,
        label,
        skipped: record["skipped"] === true || status === "skipped",
        status,
        install: {
          passed: install?.["passed"] === true,
          message: asString(install?.["message"]) ?? "",
        },
        tests: {
          passed: asNumber(tests?.["passed"]) ?? 0,
          total: asNumber(tests?.["total"]) ?? 0,
          failures: parseValidateFailures(tests?.["failures"]),
        },
        log: asString(record["log"]) ?? "",
        suggestion: asString(record["suggestion"]),
      });
    }
  }
  return {
    repository,
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    sourceSha: asString(artifact["sourceSha"]) ?? "",
    manifestPath: asString(artifact["manifestPath"]) ?? "",
    lockfilePath: asString(artifact["lockfilePath"]),
    groups,
  };
}

/** Step 4 — install + test results per group, expandable logs, one repair suggestion. */
export function DependencyValidateSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: DependencyValidateDraft | null;
  onChange: (draft: DependencyValidateDraft) => void;
}) {
  const [logsOpen, setLogsOpen] = useState<Record<string, boolean>>({});
  const parsed = parseDependencyValidate(artifact);

  if (parsed === null) {
    return <p className="step-empty">The validation results are not available yet.</p>;
  }
  const groups = parsed.groups;

  function skippedFor(id: DependencyJump, fallback: boolean): boolean {
    return draft?.skipped[id] ?? fallback;
  }

  function setSkipped(id: DependencyJump, skipped: boolean): void {
    onChange({
      skipped: Object.fromEntries(
        groups.map((group) => [
          group.id,
          group.id === id ? skipped : skippedFor(group.id, group.skipped),
        ]),
      ),
    });
  }

  const greenCount = parsed.groups.filter(
    (group) => !skippedFor(group.id, group.skipped) && group.status === "green",
  ).length;
  const skippedCount = parsed.groups.filter((group) => skippedFor(group.id, group.skipped)).length;
  const failingOpen = parsed.groups.filter(
    (group) => !skippedFor(group.id, group.skipped) && group.status === "failed",
  ).length;

  return (
    <div className="dependency-validate-surface">
      <p className="step-summary">
        {`${greenCount} green · ${failingOpen} failing · ${skippedCount} skipped`}
      </p>
      {parsed.groups.map((group) => {
        const skipped = skippedFor(group.id, group.skipped);
        const open = logsOpen[group.id] === true;
        const effective = skipped ? "skipped" : group.status;
        return (
          <article key={group.id} className={`dependency-group-card group-${group.id}`}>
            <header className="file-card-head">
              <strong>{group.label}</strong>
              <span className={`dep-status dep-${effective}`}>
                {effective === "green" ? "Green" : effective === "failed" ? "Failed" : "Skipped"}
              </span>
              {group.status === "failed" && (
                <label className="group-skip">
                  <input
                    type="checkbox"
                    checked={skipped}
                    disabled={!editable}
                    onChange={(event) => setSkipped(group.id, event.target.checked)}
                  />
                  <span>Skip this group</span>
                </label>
              )}
            </header>
            <dl className="validation-row">
              <div>
                <dt>Install</dt>
                <dd>{`${group.install.passed ? "✓" : "✗"} ${group.install.message}`}</dd>
              </div>
              <div>
                <dt>Tests</dt>
                <dd>{`${group.tests.passed}/${group.tests.total} passed`}</dd>
              </div>
            </dl>
            {group.tests.failures.length > 0 && (
              <ul className="validation-failures">
                {group.tests.failures.map((failure, index) => (
                  <li
                    key={`${failure.validator}-${failure.path}-${index}`}
                    className={failure.isNew ? "failure-new" : ""}
                  >
                    {`${failure.isNew ? "new failure · " : ""}${failure.validator} · ${
                      failure.path
                    } — ${failure.message}`}
                  </li>
                ))}
              </ul>
            )}
            {group.suggestion !== null && (
              <aside className="similar-callout repair-callout">
                <h4>Repair suggestion</h4>
                <p>{group.suggestion}</p>
              </aside>
            )}
            <button
              type="button"
              className="diff-toggle"
              aria-expanded={open}
              onClick={() => setLogsOpen((previous) => ({ ...previous, [group.id]: !open }))}
            >
              {open
                ? "Hide log"
                : `Show log (${group.log === "" ? 0 : group.log.split("\n").length} lines)`}
            </button>
            {open && (
              <pre className="validation-log">
                {group.log === "" ? "(no log recorded)" : group.log}
              </pre>
            )}
          </article>
        );
      })}
      {failingOpen > 0 && (
        <p className="run-action-error" role="alert">
          All groups must be green (or explicitly skipped) before the pull requests can be planned.
        </p>
      )}
    </div>
  );
}

/* --- Merge --- */

export type DependencyMergeGroupView = {
  id: DependencyJump;
  label: string;
  branch: string;
  title: string;
  packageCount: number;
  cveFixes: string[];
  packages: Array<{ name: string; from: string; to: string }>;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
};

export type DependencyMergeShape = {
  repository: string;
  baseBranch: string;
  sourceSha: string;
  manifestPath: string;
  groups: DependencyMergeGroupView[];
};

export type DependencyPrView = {
  groupId: string;
  url: string | null;
  number: number | null;
  draft: boolean;
  branch: string;
};

export type DependencyReceiptView = {
  caseId: string;
  repository: string;
  baseBranch: string;
  prs: DependencyPrView[];
  cveFixes: string[];
};

export function parseDependencyMerge(
  artifact: Record<string, unknown>,
): DependencyMergeShape | null {
  const repository = asString(artifact["repository"]);
  if (repository === null) return null;
  const groups: DependencyMergeGroupView[] = [];
  const rawGroups = artifact["groups"];
  if (Array.isArray(rawGroups)) {
    for (const item of rawGroups) {
      const record = asRecord(item);
      const id = record === null ? null : dependencyJump(record["id"]);
      const label = record === null ? null : asString(record["label"]);
      const branch = record === null ? null : asString(record["branch"]);
      if (record === null || id === null || label === null || branch === null) continue;
      const packages: DependencyMergeGroupView["packages"] = [];
      if (Array.isArray(record["packages"])) {
        for (const pkg of record["packages"]) {
          const pkgRecord = asRecord(pkg);
          const name = pkgRecord === null ? null : asString(pkgRecord["name"]);
          const from = pkgRecord === null ? null : asString(pkgRecord["from"]);
          const to = pkgRecord === null ? null : asString(pkgRecord["to"]);
          if (pkgRecord === null || name === null || from === null || to === null) continue;
          packages.push({ name, from, to });
        }
      }
      const files: DependencyMergeGroupView["files"] = [];
      if (Array.isArray(record["files"])) {
        for (const file of record["files"]) {
          const fileRecord = asRecord(file);
          const path = fileRecord === null ? null : asString(fileRecord["path"]);
          if (fileRecord === null || path === null) continue;
          files.push({
            path,
            status: asString(fileRecord["status"]) ?? "",
            additions: asNumber(fileRecord["additions"]) ?? 0,
            deletions: asNumber(fileRecord["deletions"]) ?? 0,
          });
        }
      }
      groups.push({
        id,
        label,
        branch,
        title: asString(record["title"]) ?? "",
        packageCount: asNumber(record["packageCount"]) ?? packages.length,
        cveFixes: asStringArray(record["cveFixes"]).filter((cve) => CVE_PATTERN.test(cve)),
        packages,
        files,
      });
    }
  }
  return {
    repository,
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    sourceSha: asString(artifact["sourceSha"]) ?? "",
    manifestPath: asString(artifact["manifestPath"]) ?? "",
    groups,
  };
}

export function parseDependencyReceipt(value: unknown): DependencyReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const prs: DependencyPrView[] = [];
  const rawPrs = record["prs"];
  if (Array.isArray(rawPrs)) {
    for (const item of rawPrs) {
      const prRecord = asRecord(item);
      const groupId = prRecord === null ? null : asString(prRecord["groupId"]);
      const pull = prRecord === null ? null : asRecord(prRecord["pr"]);
      if (prRecord === null || groupId === null || pull === null) continue;
      prs.push({
        groupId,
        url: safeHttpsUrl(pull["url"]),
        number: asNumber(pull["number"]),
        draft: pull["draft"] === true,
        branch: asString(pull["branch"]) ?? "",
      });
    }
  }
  return {
    caseId: asString(record["caseId"]) ?? "",
    repository: asString(record["repository"]) ?? "",
    baseBranch: asString(record["baseBranch"]) ?? "",
    prs,
    cveFixes: asStringArray(record["cveFixes"]).filter((cve) => CVE_PATTERN.test(cve)),
  };
}

/** Step 5 — PR preview list with CVE callouts; after the writes, the opened PRs. */
export function DependencyMergeSurface({
  artifact,
  receipt,
  reviewLink,
}: {
  artifact: Record<string, unknown> | null;
  receipt: DependencyReceiptView | null;
  reviewLink?: { onStart: (prNumber: number) => void; busy: boolean } | undefined;
}) {
  const parsed = artifact === null ? null : parseDependencyMerge(artifact);

  return (
    <div className="complete-surface dependency-merge">
      {receipt !== null ? (
        <article className="receipt-card">
          <strong>
            {`${receipt.prs.length} bump pull request${
              receipt.prs.length === 1 ? "" : "s"
            } opened`}
          </strong>
          <ul className="completion-files">
            {receipt.prs.map((pr) => (
              <li key={pr.groupId}>
                <strong>{`${pr.groupId}: `}</strong>
                {pr.url === null ? (
                  "PR opened — the link is unavailable."
                ) : (
                  <a href={pr.url} target="_blank" rel="noopener noreferrer">
                    {`Draft PR${pr.number === null ? "" : ` #${pr.number}`}`}
                  </a>
                )}
                {` · branch ${pr.branch}`}
              </li>
            ))}
          </ul>
          {receipt.cveFixes.length > 0 && (
            <p className="step-summary">{`Security fixes: ${receipt.cveFixes.join(", ")}`}</p>
          )}
          {receipt.caseId !== "" && (
            <p className="step-summary">{`Recorded on case ${receipt.caseId}`}</p>
          )}
        </article>
      ) : parsed === null ? (
        <p className="step-empty">The pull request previews are not available yet.</p>
      ) : (
        <>
          <p className="step-summary">
            {`${parsed.repository}@${parsed.baseBranch} · one Draft PR per group`}
          </p>
          {parsed.groups.map((group) => (
            <article key={group.id} className={`dependency-group-card group-${group.id}`}>
              <header className="file-card-head">
                <strong>{group.title}</strong>
                <span className="file-count-badge">
                  {`${group.packageCount} package${group.packageCount === 1 ? "" : "s"}`}
                </span>
              </header>
              <p className="step-summary">{`Branch ${group.branch}`}</p>
              {group.cveFixes.length > 0 && (
                <aside className="similar-callout security-callout">
                  <h4>Security fixes</h4>
                  <ul>
                    {group.cveFixes.map((cve) => {
                      const href = cveUrl(cve);
                      return (
                        <li key={cve}>
                          {href === null ? (
                            cve
                          ) : (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {cve}
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </aside>
              )}
              <ul className="completion-files">
                {group.packages.map((pkg) => (
                  <li key={pkg.name}>{`${pkg.name}: ${pkg.from} → ${pkg.to}`}</li>
                ))}
              </ul>
              <ul className="completion-files">
                {group.files.map((file) => (
                  <li key={file.path}>
                    {`${file.path} · ${file.status} · +${file.additions} −${file.deletions}`}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </>
      )}

      <p className="follow-up-note">
        Opening the bump PRs is the side effect; CI runs on each branch and a human merges them.
      </p>

      {receipt !== null &&
        reviewLink !== undefined &&
        receipt.prs
          .filter((pr) => pr.number !== null)
          .map((pr) => (
            <button
              key={pr.groupId}
              type="button"
              className="follow-up-button"
              disabled={reviewLink.busy}
              onClick={() => reviewLink.onStart(pr.number as number)}
            >
              {`Start PR Review for #${pr.number}`}
            </button>
          ))}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Accessibility Audit lane (`accessibilityFlow`): crawl -> violations ->
 * fix -> re-scan. Artifacts mirror the Mastra `accessibility` contracts;
 * every renderer keeps server content as text nodes.
 * ---------------------------------------------------------------------- */

export type ImpactLevel = "critical" | "serious" | "moderate" | "minor";

export const IMPACT_LEVELS: readonly ImpactLevel[] = ["critical", "serious", "moderate", "minor"];

export const IMPACT_LABELS: Record<ImpactLevel, string> = {
  critical: "Critical",
  serious: "Serious",
  moderate: "Moderate",
  minor: "Minor",
};

function impactLevel(value: unknown): ImpactLevel | null {
  return typeof value === "string" && (IMPACT_LEVELS as readonly string[]).includes(value)
    ? (value as ImpactLevel)
    : null;
}

export type ImpactTotalsView = {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  total: number;
};

function parseImpactTotalsView(value: unknown): ImpactTotalsView {
  const record = asRecord(value);
  return {
    critical: asNumber(record?.["critical"]) ?? 0,
    serious: asNumber(record?.["serious"]) ?? 0,
    moderate: asNumber(record?.["moderate"]) ?? 0,
    minor: asNumber(record?.["minor"]) ?? 0,
    total: asNumber(record?.["total"]) ?? 0,
  };
}

/* --- Crawl --- */

export type AccessibilityRouteView = {
  path: string;
  component: string;
  selected: boolean;
  authenticated: boolean;
  checks: number;
};

export type AccessibilityCrawlShape = {
  repository: string;
  baseBranch: string;
  sourceSha: string;
  targetUrl: string;
  routes: AccessibilityRouteView[];
  totals: { routes: number; selected: number; authenticated: number; checks: number };
};

export type AccessibilityCrawlDraft = { routes: AccessibilityRouteView[] };

function parseAccessibilityRoute(value: unknown): AccessibilityRouteView | null {
  const record = asRecord(value);
  const path = record === null ? null : asString(record["path"]);
  if (record === null || path === null) return null;
  return {
    path,
    component: asString(record["component"]) ?? "",
    selected: record["selected"] !== false,
    authenticated: record["authenticated"] === true,
    checks: asNumber(record["checks"]) ?? 0,
  };
}

export function parseAccessibilityCrawl(
  artifact: Record<string, unknown>,
): AccessibilityCrawlShape | null {
  const repository = asString(artifact["repository"]);
  const targetUrl = asString(artifact["targetUrl"]);
  if (repository === null || targetUrl === null) return null;
  const routes: AccessibilityRouteView[] = [];
  if (Array.isArray(artifact["routes"])) {
    for (const item of artifact["routes"]) {
      const route = parseAccessibilityRoute(item);
      if (route !== null) routes.push(route);
    }
  }
  const totals = asRecord(artifact["totals"]);
  return {
    repository,
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    sourceSha: asString(artifact["sourceSha"]) ?? "",
    targetUrl,
    routes,
    totals: {
      routes: asNumber(totals?.["routes"]) ?? routes.length,
      selected: asNumber(totals?.["selected"]) ?? routes.filter((route) => route.selected).length,
      authenticated:
        asNumber(totals?.["authenticated"]) ??
        routes.filter((route) => route.authenticated).length,
      checks:
        asNumber(totals?.["checks"]) ??
        routes.reduce((total, route) => total + route.checks, 0),
    },
  };
}

/** Live selection totals for the crawl draft (the count estimate). */
export function accessibilityRouteTotals(
  routes: AccessibilityRouteView[],
): AccessibilityCrawlShape["totals"] {
  return {
    routes: routes.length,
    selected: routes.filter((route) => route.selected).length,
    authenticated: routes.filter((route) => route.authenticated).length,
    checks: routes
      .filter((route) => route.selected)
      .reduce((total, route) => total + route.checks, 0),
  };
}

/* --- Violations --- */

export type AccessibilityViolationView = {
  id: string;
  rule: string;
  wcagRef: string;
  impact: ImpactLevel;
  elementPath: string;
  routePath: string;
  occurrences: number;
  description: string;
  screenshotUrl: string | null;
};

function parseAccessibilityViolation(value: unknown): AccessibilityViolationView | null {
  const record = asRecord(value);
  const id = record === null ? null : asString(record["id"]);
  const rule = record === null ? null : asString(record["rule"]);
  const impact = record === null ? null : impactLevel(record["impact"]);
  if (record === null || id === null || rule === null || impact === null) return null;
  return {
    id,
    rule,
    wcagRef: asString(record["wcagRef"]) ?? "",
    impact,
    elementPath: asString(record["elementPath"]) ?? "",
    routePath: asString(record["routePath"]) ?? "",
    occurrences: asNumber(record["occurrences"]) ?? 1,
    description: asString(record["description"]) ?? "",
    screenshotUrl: safeHttpsUrl(record["screenshotUrl"]),
  };
}

export type AccessibilityViolationsShape = {
  repository: string;
  targetUrl: string;
  analyzer: string;
  ruleset: string;
  violations: AccessibilityViolationView[];
  totals: ImpactTotalsView;
  summary: string;
  confidence: number | null;
};

export function parseAccessibilityViolations(
  artifact: Record<string, unknown>,
): AccessibilityViolationsShape | null {
  const repository = asString(artifact["repository"]);
  const targetUrl = asString(artifact["targetUrl"]);
  if (repository === null || targetUrl === null) return null;
  const violations: AccessibilityViolationView[] = [];
  if (Array.isArray(artifact["violations"])) {
    for (const item of artifact["violations"]) {
      const violation = parseAccessibilityViolation(item);
      if (violation !== null) violations.push(violation);
    }
  }
  return {
    repository,
    targetUrl,
    analyzer: asString(artifact["analyzer"]) ?? "",
    ruleset: asString(artifact["ruleset"]) ?? "",
    violations,
    totals: parseImpactTotalsView(artifact["totals"]),
    summary: asString(artifact["summary"]) ?? "",
    confidence: asNumber(artifact["confidence"]),
  };
}

/* --- Fix --- */

export type AccessibilityPatchFileView = { path: string; content: string; validators: string[] };

function parseAccessibilityPatchFile(value: unknown): AccessibilityPatchFileView | null {
  const record = asRecord(value);
  const path = record === null ? null : asString(record["path"]);
  if (record === null || path === null) return null;
  return {
    path,
    content: asString(record["content"]) ?? "",
    validators: asStringArray(record["validators"]),
  };
}

export type AccessibilityFixView = {
  violationId: string;
  rule: string;
  wcagRef: string;
  impact: ImpactLevel;
  elementPath: string;
  routePath: string;
  explanation: string;
  before: string;
  after: string;
  manualRedesign: boolean;
  applied: boolean;
  files: AccessibilityPatchFileView[];
};

export type AccessibilityFixShape = {
  repository: string;
  targetUrl: string;
  summary: string;
  confidence: number | null;
  fixes: AccessibilityFixView[];
  totals: { fixes: number; applied: number; manualRedesign: number; files: number };
};

export type AccessibilityFixDraft = { applied: Record<string, boolean> };

export function parseAccessibilityFix(
  artifact: Record<string, unknown>,
): AccessibilityFixShape | null {
  const repository = asString(artifact["repository"]);
  const targetUrl = asString(artifact["targetUrl"]);
  if (repository === null || targetUrl === null) return null;
  const fixes: AccessibilityFixView[] = [];
  if (Array.isArray(artifact["fixes"])) {
    for (const item of artifact["fixes"]) {
      const record = asRecord(item);
      const violationId = record === null ? null : asString(record["violationId"]);
      const impact = record === null ? null : impactLevel(record["impact"]);
      if (record === null || violationId === null || impact === null) continue;
      const files: AccessibilityPatchFileView[] = [];
      if (Array.isArray(record["files"])) {
        for (const file of record["files"]) {
          const parsed = parseAccessibilityPatchFile(file);
          if (parsed !== null) files.push(parsed);
        }
      }
      fixes.push({
        violationId,
        rule: asString(record["rule"]) ?? "",
        wcagRef: asString(record["wcagRef"]) ?? "",
        impact,
        elementPath: asString(record["elementPath"]) ?? "",
        routePath: asString(record["routePath"]) ?? "",
        explanation: asString(record["explanation"]) ?? "",
        before: asString(record["before"]) ?? "",
        after: asString(record["after"]) ?? "",
        manualRedesign: record["manualRedesign"] === true,
        applied: record["applied"] === true,
        files,
      });
    }
  }
  const totals = asRecord(artifact["totals"]);
  return {
    repository,
    targetUrl,
    summary: asString(artifact["summary"]) ?? "",
    confidence: asNumber(artifact["confidence"]),
    fixes,
    totals: {
      fixes: asNumber(totals?.["fixes"]) ?? fixes.length,
      applied: asNumber(totals?.["applied"]) ?? fixes.filter((fix) => fix.applied).length,
      manualRedesign:
        asNumber(totals?.["manualRedesign"]) ??
        fixes.filter((fix) => fix.manualRedesign).length,
      files: asNumber(totals?.["files"]) ?? fixes.reduce((total, fix) => total + fix.files.length, 0),
    },
  };
}

/* --- Re-scan --- */

export type AccessibilityWaiverView = {
  violationId: string;
  reason: string;
  expiresAt: string;
  approvedBy: string;
};

export type AccessibilityGateView = {
  criticalsOpen: number;
  criticalsWaived: number;
  passing: boolean;
};

function parseAccessibilityGate(value: unknown): AccessibilityGateView | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    criticalsOpen: asNumber(record["criticalsOpen"]) ?? 0,
    criticalsWaived: asNumber(record["criticalsWaived"]) ?? 0,
    passing: record["passing"] === true,
  };
}

export type AccessibilityReScanShape = {
  repository: string;
  baseBranch: string;
  sourceSha: string;
  targetUrl: string;
  branch: string;
  analyzer: string;
  ruleset: string;
  before: ImpactTotalsView;
  after: ImpactTotalsView;
  delta: { critical: number; serious: number; moderate: number; minor: number };
  resolvedIds: string[];
  remaining: AccessibilityViolationView[];
  introduced: AccessibilityViolationView[];
  waivers: AccessibilityWaiverView[];
  gate: AccessibilityGateView | null;
  summary: string;
};

export function parseAccessibilityRescan(
  artifact: Record<string, unknown>,
): AccessibilityReScanShape | null {
  const repository = asString(artifact["repository"]);
  const targetUrl = asString(artifact["targetUrl"]);
  if (repository === null || targetUrl === null) return null;
  const remaining: AccessibilityViolationView[] = [];
  if (Array.isArray(artifact["remaining"])) {
    for (const item of artifact["remaining"]) {
      const violation = parseAccessibilityViolation(item);
      if (violation !== null) remaining.push(violation);
    }
  }
  const introduced: AccessibilityViolationView[] = [];
  if (Array.isArray(artifact["introduced"])) {
    for (const item of artifact["introduced"]) {
      const violation = parseAccessibilityViolation(item);
      if (violation !== null) introduced.push(violation);
    }
  }
  const waivers: AccessibilityWaiverView[] = [];
  if (Array.isArray(artifact["waivers"])) {
    for (const item of artifact["waivers"]) {
      const record = asRecord(item);
      const violationId = record === null ? null : asString(record["violationId"]);
      if (record === null || violationId === null) continue;
      waivers.push({
        violationId,
        reason: asString(record["reason"]) ?? "",
        expiresAt: asString(record["expiresAt"]) ?? "",
        approvedBy: asString(record["approvedBy"]) ?? "",
      });
    }
  }
  const delta = asRecord(artifact["delta"]);
  return {
    repository,
    baseBranch: asString(artifact["baseBranch"]) ?? "",
    sourceSha: asString(artifact["sourceSha"]) ?? "",
    targetUrl,
    branch: asString(artifact["branch"]) ?? "",
    analyzer: asString(artifact["analyzer"]) ?? "",
    ruleset: asString(artifact["ruleset"]) ?? "",
    before: parseImpactTotalsView(artifact["before"]),
    after: parseImpactTotalsView(artifact["after"]),
    delta: {
      critical: asNumber(delta?.["critical"]) ?? 0,
      serious: asNumber(delta?.["serious"]) ?? 0,
      moderate: asNumber(delta?.["moderate"]) ?? 0,
      minor: asNumber(delta?.["minor"]) ?? 0,
    },
    resolvedIds: asStringArray(artifact["resolvedIds"]),
    remaining,
    introduced,
    waivers,
    gate: parseAccessibilityGate(artifact["gate"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type AccessibilityWaiverDraft = {
  entries: Record<string, { reason: string; expiresAt: string }>;
};

export type AccessibilityReceiptView = {
  caseId: string;
  repository: string;
  branch: string;
  resolvedCount: number;
  waivedCount: number;
  remainingCount: number;
  gate: AccessibilityGateView | null;
  prUrl: string | null;
  prNumber: number | null;
  prDraft: boolean;
};

export function parseAccessibilityReceipt(value: unknown): AccessibilityReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const pr = asRecord(record["pr"]);
  return {
    caseId: asString(record["caseId"]) ?? "",
    repository: asString(record["repository"]) ?? "",
    branch: asString(record["branch"]) ?? "",
    resolvedCount: asNumber(record["resolvedCount"]) ?? 0,
    waivedCount: asNumber(record["waivedCount"]) ?? 0,
    remainingCount: asNumber(record["remainingCount"]) ?? 0,
    gate: parseAccessibilityGate(record["gate"]),
    prUrl: pr === null ? null : safeHttpsUrl(pr["url"]),
    prNumber: pr === null ? null : asNumber(pr["number"]),
    prDraft: pr !== null && pr["draft"] === true,
  };
}

/** Step 1 — the route tree with include/auth toggles and the check estimate. */
export function AccessibilityCrawlSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: AccessibilityCrawlDraft | null;
  onChange: (draft: AccessibilityCrawlDraft) => void;
}) {
  const parsed = parseAccessibilityCrawl(artifact);

  if (parsed === null) {
    return <p className="step-empty">The crawl results are not available yet.</p>;
  }
  const value: AccessibilityCrawlDraft = draft ?? {
    routes: parsed.routes.map((route) => ({ ...route })),
  };
  const totals = accessibilityRouteTotals(value.routes);

  function setRoute(path: string, patch: Partial<AccessibilityRouteView>): void {
    onChange({
      routes: value.routes.map((route) => (route.path === path ? { ...route, ...patch } : route)),
    });
  }

  function setAll(selected: boolean): void {
    onChange({ routes: value.routes.map((route) => ({ ...route, selected })) });
  }

  return (
    <div className="a11y-crawl-surface">
      <p className="step-summary">
        {`${parsed.repository}@${parsed.baseBranch} · ${parsed.targetUrl} — ${totals.routes} routes, ${totals.selected} selected, ${totals.authenticated} authenticated · ~${totals.checks} checks`}
      </p>
      {editable && (
        <div className="options-bulk">
          <button type="button" onClick={() => setAll(true)}>
            Select all
          </button>
          <button type="button" onClick={() => setAll(false)}>
            Clear
          </button>
        </div>
      )}
      <table className="dependency-table a11y-route-table">
        <thead>
          <tr>
            <th>Route</th>
            <th>Component</th>
            <th>Include</th>
            <th>Authenticated</th>
            <th>Checks</th>
          </tr>
        </thead>
        <tbody>
          {value.routes.map((route) => (
            <tr key={route.path} className={route.selected ? "" : "excluded"}>
              <td>
                <strong>{route.path}</strong>
              </td>
              <td className="dependency-version-cell">{route.component}</td>
              <td>
                <input
                  type="checkbox"
                  checked={route.selected}
                  disabled={!editable}
                  aria-label={`Include ${route.path}`}
                  onChange={(event) => setRoute(route.path, { selected: event.target.checked })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={route.authenticated}
                  disabled={!editable}
                  aria-label={`Needs authentication for ${route.path}`}
                  onChange={(event) =>
                    setRoute(route.path, { authenticated: event.target.checked })
                  }
                />
              </td>
              <td>{route.checks}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {totals.selected === 0 && (
        <p className="run-action-error" role="alert">
          Select at least one route before running the audit.
        </p>
      )}
    </div>
  );
}

/** Step 2 — findings grouped by impact with filter chips and sort. */
export function AccessibilityViolationsSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const [filter, setFilter] = useState<"all" | ImpactLevel>("all");
  const [sortByOccurrences, setSortByOccurrences] = useState(false);
  const parsed = parseAccessibilityViolations(artifact);

  if (parsed === null) {
    return <p className="step-empty">The accessibility findings are not available yet.</p>;
  }
  const shown =
    filter === "all" ? parsed.violations : parsed.violations.filter((item) => item.impact === filter);
  const groups = IMPACT_LEVELS.map((level) => {
    const items = shown.filter((item) => item.impact === level);
    if (sortByOccurrences) {
      items.sort((left, right) => right.occurrences - left.occurrences);
    }
    return { level, items };
  }).filter((group) => group.items.length > 0);

  return (
    <div className="a11y-violations-surface">
      <p className="step-summary">
        {`${parsed.analyzer} · ${parsed.ruleset} · ${parsed.targetUrl}`}
      </p>
      {parsed.summary !== "" && <Markdown text={parsed.summary} className="analysis-summary" />}
      <div className="options-toolbar">
        <div className="filter-chips" role="group" aria-label="Filter violations">
          <button
            type="button"
            className={`chip${filter === "all" ? " active" : ""}`}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            {`All (${parsed.violations.length})`}
          </button>
          {IMPACT_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`chip${filter === level ? " active" : ""}`}
              aria-pressed={filter === level}
              onClick={() => setFilter(level)}
            >
              {`${IMPACT_LABELS[level]} (${parsed.totals[level]})`}
            </button>
          ))}
        </div>
        <div className="options-bulk">
          <button
            type="button"
            aria-pressed={sortByOccurrences}
            onClick={() => setSortByOccurrences((value) => !value)}
          >
            {sortByOccurrences ? "Sorted by occurrences" : "Sort by occurrences"}
          </button>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="step-empty">No violations match this filter.</p>
      ) : (
        groups.map((group) => (
          <section key={group.level} className={`a11y-impact-group impact-${group.level}`}>
            <h4>{`${IMPACT_LABELS[group.level]} · ${group.items.length}`}</h4>
            <ul className="a11y-violation-list">
              {group.items.map((violation) => (
                <li key={violation.id}>
                  <div className="a11y-violation-row">
                    <span className={`a11y-impact-pill impact-${violation.impact}`}>
                      {IMPACT_LABELS[violation.impact]}
                    </span>
                    <strong className="dependency-version-cell">{violation.rule}</strong>
                    <span className="a11y-wcag">{violation.wcagRef}</span>
                    <span className="line-pill">{`${violation.occurrences}×`}</span>
                  </div>
                  <p className="a11y-location">{`${violation.routePath} · ${violation.elementPath}`}</p>
                  <Markdown text={violation.description} className="change-description" />
                  {violation.screenshotUrl !== null && (
                    <a
                      className="a11y-shot"
                      href={violation.screenshotUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <img
                        src={violation.screenshotUrl}
                        alt={`Highlighted element for rule ${violation.rule}`}
                        loading="lazy"
                      />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <p className="step-summary">
        Review the findings — proceeding plans one fix per violation and flags the manual-redesign
        ones separately.
      </p>
    </div>
  );
}

/** Step 3 — per-violation fix cards: before/after diff, explanation, apply toggle. */
export function AccessibilityFixSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: AccessibilityFixDraft | null;
  onChange: (draft: AccessibilityFixDraft) => void;
}) {
  const parsed = parseAccessibilityFix(artifact);

  if (parsed === null) {
    return <p className="step-empty">The suggested fixes are not available yet.</p>;
  }
  const fixes = parsed.fixes;

  function appliedFor(fix: AccessibilityFixView): boolean {
    return draft?.applied[fix.violationId] ?? fix.applied;
  }

  function setMany(ids: ReadonlySet<string>, applied: boolean): void {
    const next: Record<string, boolean> = {};
    for (const fix of fixes) {
      next[fix.violationId] = ids.has(fix.violationId) ? applied : appliedFor(fix);
    }
    onChange({ applied: next });
  }

  function setApplied(violationId: string, applied: boolean): void {
    setMany(new Set([violationId]), applied);
  }

  const autofixes = fixes.filter((fix) => !fix.manualRedesign);
  const manual = fixes.filter((fix) => fix.manualRedesign);
  const appliedCount = autofixes.filter((fix) => appliedFor(fix)).length;
  const repeatedRules = [...new Set(autofixes.map((fix) => fix.rule))].filter(
    (rule) => autofixes.filter((fix) => fix.rule === rule).length > 1,
  );

  function fixCard(fix: AccessibilityFixView) {
    const applied = appliedFor(fix);
    return (
      <article
        key={fix.violationId}
        className={`dependency-group-card a11y-fix-card${fix.manualRedesign ? " manual" : ""}${
          applied && !fix.manualRedesign ? "" : " skipped"
        }`}
      >
        <header className="file-card-head">
          <span className={`a11y-impact-pill impact-${fix.impact}`}>
            {IMPACT_LABELS[fix.impact]}
          </span>
          <strong className="dependency-version-cell">{fix.rule}</strong>
          <span className="a11y-wcag">{fix.wcagRef}</span>
          {fix.manualRedesign ? (
            <span className="line-pill">manual redesign</span>
          ) : (
            <label className="group-accept">
              <input
                type="checkbox"
                checked={applied}
                disabled={!editable}
                onChange={(event) => setApplied(fix.violationId, event.target.checked)}
              />
              <span>{applied ? "Applied" : "Skipped"}</span>
            </label>
          )}
        </header>
        <p className="a11y-location">{`${fix.routePath} · ${fix.elementPath}`}</p>
        {fix.manualRedesign ? (
          <aside className="similar-callout manual-callout">
            <h4>Needs a manual redesign</h4>
            <Markdown text={fix.explanation} />
          </aside>
        ) : (
          <>
            <Markdown text={fix.explanation} className="change-description" />
            {(fix.before !== "" || fix.after !== "") && (
              <div className="a11y-diff-pair">
                <div>
                  <h4>Before</h4>
                  <pre className="diff-body a11y-before">{fix.before === "" ? "(unchanged)" : fix.before}</pre>
                </div>
                <div>
                  <h4>After</h4>
                  <pre className="diff-body a11y-after">{fix.after === "" ? "(unchanged)" : fix.after}</pre>
                </div>
              </div>
            )}
            {fix.files.length > 0 && (
              <p className="file-validators">
                {`${fix.files.map((file) => file.path).join(", ")} · Validators: ${
                  fix.files.flatMap((file) => file.validators).join(", ") || "none"
                }`}
              </p>
            )}
          </>
        )}
      </article>
    );
  }

  return (
    <div className="a11y-fix-surface">
      <div className="impl-head">
        <Markdown text={parsed.summary} className="analysis-summary" />
        <div className="analysis-meta">
          {parsed.confidence !== null ? (
            <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
          ) : null}
          <span className="file-count-badge">{`${appliedCount} of ${autofixes.length} fixes applied`}</span>
          {manual.length > 0 ? (
            <span className="file-count-badge">{`${manual.length} manual`}</span>
          ) : null}
        </div>
      </div>
      {editable && autofixes.length > 0 && (
        <div className="options-bulk">
          <button
            type="button"
            onClick={() => setMany(new Set(autofixes.map((fix) => fix.violationId)), true)}
          >
            Apply all fixes
          </button>
          <button
            type="button"
            onClick={() => setMany(new Set(autofixes.map((fix) => fix.violationId)), false)}
          >
            Skip all fixes
          </button>
          {repeatedRules.map((rule) => (
            <button
              key={rule}
              type="button"
              onClick={() =>
                setMany(
                  new Set(autofixes.filter((fix) => fix.rule === rule).map((fix) => fix.violationId)),
                  true,
                )
              }
            >
              {`Apply all ${rule} fixes (${autofixes.filter((fix) => fix.rule === rule).length})`}
            </button>
          ))}
        </div>
      )}
      {autofixes.map((fix) => fixCard(fix))}
      {manual.length > 0 && (
        <>
          <h4 className="a11y-section-head">{`Manual redesign · ${manual.length}`}</h4>
          {manual.map((fix) => fixCard(fix))}
        </>
      )}
      {autofixes.length > 0 && appliedCount === 0 && (
        <p className="run-action-error" role="alert">
          Apply at least one fix before the re-scan can open the fix pull request.
        </p>
      )}
    </div>
  );
}

function expiryInFuture(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

/** Step 4 — before/after comparison, remaining list, and the waiver gate. */
export function AccessibilityRescanSurface({
  artifact,
  receipt,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown> | null;
  receipt: AccessibilityReceiptView | null;
  editable: boolean;
  draft: AccessibilityWaiverDraft | null;
  onChange: (draft: AccessibilityWaiverDraft) => void;
}) {
  const parsed = artifact === null ? null : parseAccessibilityRescan(artifact);

  if (parsed === null) {
    if (receipt !== null) {
      return (
        <div className="a11y-rescan-surface">
          <article className="receipt-card">
            <strong>{`Fix pull request opened for ${receipt.repository}`}</strong>
            <ul className="completion-files">
              <li>
                {receipt.prUrl === null ? (
                  "PR opened — the link is unavailable."
                ) : (
                  <a href={receipt.prUrl} target="_blank" rel="noopener noreferrer">
                    {`Draft PR${receipt.prNumber === null ? "" : ` #${receipt.prNumber}`}`}
                  </a>
                )}
                {` · branch ${receipt.branch}`}
              </li>
            </ul>
            <p className="step-summary">
              {`${receipt.resolvedCount} resolved · ${receipt.waivedCount} waived · ${receipt.remainingCount} remaining`}
            </p>
            {receipt.caseId !== "" && (
              <p className="step-summary">{`Recorded on case ${receipt.caseId}`}</p>
            )}
          </article>
        </div>
      );
    }
    return <p className="step-empty">The re-scan comparison is not available yet.</p>;
  }

  function entryFor(id: string): { reason: string; expiresAt: string } | undefined {
    return draft?.entries[id];
  }

  function setEntry(id: string, patch: Partial<{ reason: string; expiresAt: string }>): void {
    const current = entryFor(id) ?? { reason: "", expiresAt: "" };
    onChange({ entries: { ...(draft?.entries ?? {}), [id]: { ...current, ...patch } } });
  }

  const criticals = parsed.remaining.filter((violation) => violation.impact === "critical");
  const waivedInArtifact = (id: string): boolean =>
    parsed.waivers.some(
      (waiver) => waiver.violationId === id && expiryInFuture(waiver.expiresAt),
    );
  const draftCovers = (id: string): boolean => {
    const entry = entryFor(id);
    return entry !== undefined && entry.reason.trim() !== "" && expiryInFuture(entry.expiresAt);
  };
  const criticalsWaived = criticals.filter(
    (violation) => waivedInArtifact(violation.id) || draftCovers(violation.id),
  ).length;
  const criticalsOpen = criticals.length - criticalsWaived;
  const passing = criticalsOpen === 0;

  return (
    <div className="a11y-rescan-surface">
      <p className="step-summary">
        {`${parsed.repository}@${parsed.baseBranch} · branch ${parsed.branch} · ${parsed.analyzer} · ${parsed.ruleset}`}
      </p>
      <Markdown text={parsed.summary} className="analysis-summary" />

      <p className={`run-banner ${passing ? "completed" : "failed"}`} role="status">
        {passing
          ? "Gate passed — no critical violations remain open."
          : `${criticalsOpen} critical violation(s) remain open — fix them, or record an approver waiver with an expiry before opening the fix pull request.`}
        {criticalsWaived > 0 ? ` ${criticalsWaived} waived.` : ""}
      </p>

      <table className="dependency-table a11y-rescan-table">
        <thead>
          <tr>
            <th>Impact</th>
            <th>Before</th>
            <th>After</th>
            <th>Delta</th>
          </tr>
        </thead>
        <tbody>
          {IMPACT_LEVELS.map((level) => {
            const delta = parsed.delta[level];
            return (
              <tr key={level}>
                <td>
                  <span className={`a11y-impact-pill impact-${level}`}>{IMPACT_LABELS[level]}</span>
                </td>
                <td>{parsed.before[level]}</td>
                <td>{parsed.after[level]}</td>
                <td>
                  <span
                    className={`delta-badge ${
                      delta > 0 ? "delta-good" : delta < 0 ? "delta-bad" : "delta-flat"
                    }`}
                  >
                    {delta > 0 ? `+${delta}` : `${delta}`}
                  </span>
                </td>
              </tr>
            );
          })}
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td>{parsed.before.total}</td>
            <td>{parsed.after.total}</td>
            <td>
              <span
                className={`delta-badge ${
                  parsed.before.total - parsed.after.total > 0
                    ? "delta-good"
                    : parsed.before.total - parsed.after.total < 0
                      ? "delta-bad"
                      : "delta-flat"
                }`}
              >
                {parsed.before.total - parsed.after.total > 0
                  ? `+${parsed.before.total - parsed.after.total}`
                  : `${parsed.before.total - parsed.after.total}`}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      {parsed.resolvedIds.length > 0 && (
        <p className="step-summary">{`Resolved: ${parsed.resolvedIds.join(", ")}`}</p>
      )}

      <section className="a11y-remaining">
        <h4 className="a11y-section-head">{`Remaining · ${parsed.remaining.length}`}</h4>
        {parsed.remaining.length === 0 ? (
          <p className="step-empty">Every reported violation was resolved.</p>
        ) : (
          <ul className="a11y-violation-list">
            {parsed.remaining.map((violation) => {
              const waiver = parsed.waivers.find((item) => item.violationId === violation.id);
              return (
                <li key={violation.id}>
                  <div className="a11y-violation-row">
                    <span className={`a11y-impact-pill impact-${violation.impact}`}>
                      {IMPACT_LABELS[violation.impact]}
                    </span>
                    <strong className="dependency-version-cell">{violation.rule}</strong>
                    <span className="a11y-wcag">{violation.wcagRef}</span>
                    <span className="line-pill">{`${violation.occurrences}×`}</span>
                  </div>
                  <p className="a11y-location">{`${violation.routePath} · ${violation.elementPath}`}</p>
                  {waiver !== undefined && (
                    <p className="step-summary">
                      {`Waived by ${waiver.approvedBy} — ${waiver.reason} (expires ${waiver.expiresAt})`}
                    </p>
                  )}
                  {editable && violation.impact === "critical" && waiver === undefined && (
                    <div className="waiver-editor">
                      <label>
                        <span>Waiver reason</span>
                        <input
                          type="text"
                          maxLength={1000}
                          value={entryFor(violation.id)?.reason ?? ""}
                          placeholder="Why can this stay open?"
                          onChange={(event) => setEntry(violation.id, { reason: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>Expires</span>
                        <input
                          type="datetime-local"
                          value={entryFor(violation.id)?.expiresAt ?? ""}
                          onChange={(event) =>
                            setEntry(violation.id, { expiresAt: event.target.value })
                          }
                        />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {parsed.introduced.length > 0 && (
        <aside className="similar-callout new-violations-callout">
          <h4>{`New since the first audit · ${parsed.introduced.length}`}</h4>
          <ul>
            {parsed.introduced.map((violation) => (
              <li key={violation.id}>
                {`${violation.impact} · ${violation.rule} (${violation.wcagRef}) · ${violation.routePath}`}
              </li>
            ))}
          </ul>
        </aside>
      )}

      {editable && (
        <p className="step-summary">
          Fixing more code? Back returns to the Fix step with everything pre-loaded; this re-scan
          re-derives from the new decision.
        </p>
      )}

      {receipt !== null && (
        <article className="receipt-card">
          <strong>{`Fix pull request opened for ${receipt.repository}`}</strong>
          <ul className="completion-files">
            <li>
              {receipt.prUrl === null ? (
                "PR opened — the link is unavailable."
              ) : (
                <a href={receipt.prUrl} target="_blank" rel="noopener noreferrer">
                  {`Draft PR${receipt.prNumber === null ? "" : ` #${receipt.prNumber}`}`}
                </a>
              )}
              {` · branch ${receipt.branch}`}
            </li>
          </ul>
          <p className="step-summary">
            {`${receipt.resolvedCount} resolved · ${receipt.waivedCount} waived · ${receipt.remainingCount} remaining`}
          </p>
          {receipt.caseId !== "" && (
            <p className="step-summary">{`Recorded on case ${receipt.caseId}`}</p>
          )}
        </article>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Vendor Onboarding lane (`vendorsFlow`): collect -> verify -> risk-score ->
 * approve -> create. Artifacts mirror the Mastra `vendors` contracts; every
 * renderer keeps server content as text nodes.
 * ---------------------------------------------------------------------- */

export type VendorDocumentStatus = "missing" | "pending" | "received" | "waived";

export const VENDOR_DOCUMENT_STATUSES: readonly VendorDocumentStatus[] = [
  "missing",
  "pending",
  "received",
  "waived",
];

export const VENDOR_DOCUMENT_STATUS_LABELS: Record<VendorDocumentStatus, string> = {
  missing: "Missing",
  pending: "Pending",
  received: "Received",
  waived: "Waived",
};

function vendorDocumentStatus(value: unknown): VendorDocumentStatus | null {
  return typeof value === "string" && (VENDOR_DOCUMENT_STATUSES as readonly string[]).includes(value)
    ? (value as VendorDocumentStatus)
    : null;
}

export type VendorDocumentView = {
  id: string;
  label: string;
  required: boolean;
  status: VendorDocumentStatus;
  fileName: string | null;
  waivedReason: string | null;
  nudges: number;
  lastNudgedAt: string | null;
};

function parseVendorDocument(value: unknown): VendorDocumentView | null {
  const record = asRecord(value);
  const id = record === null ? null : asString(record["id"]);
  if (record === null || id === null) return null;
  return {
    id,
    label: asString(record["label"]) ?? id,
    required: record["required"] !== false,
    status: vendorDocumentStatus(record["status"]) ?? "missing",
    fileName: asString(record["fileName"]),
    waivedReason: asString(record["waivedReason"]),
    nudges: asNumber(record["nudges"]) ?? 0,
    lastNudgedAt: asString(record["lastNudgedAt"]),
  };
}

export type VendorCollectShape = {
  vendorName: string;
  taxId: string;
  country: string;
  requestor: string;
  documents: VendorDocumentView[];
  totals: { documents: number; required: number; received: number; waived: number; outstanding: number };
  returnedNote: string | null;
  summary: string;
};

export type VendorCollectDraft = {
  documents: VendorDocumentView[];
  returnedNote: string | null;
};

export function parseVendorCollect(
  artifact: Record<string, unknown>,
): VendorCollectShape | null {
  const vendorName = asString(artifact["vendorName"]);
  const taxId = asString(artifact["taxId"]);
  if (vendorName === null || taxId === null) return null;
  const documents: VendorDocumentView[] = [];
  if (Array.isArray(artifact["documents"])) {
    for (const item of artifact["documents"]) {
      const document = parseVendorDocument(item);
      if (document !== null) documents.push(document);
    }
  }
  const totals = asRecord(artifact["totals"]);
  return {
    vendorName,
    taxId,
    country: asString(artifact["country"]) ?? "",
    requestor: asString(artifact["requestor"]) ?? "",
    documents,
    totals: {
      documents: asNumber(totals?.["documents"]) ?? documents.length,
      required: asNumber(totals?.["required"]) ?? documents.filter((item) => item.required).length,
      received:
        asNumber(totals?.["received"]) ??
        documents.filter((item) => item.status === "received").length,
      waived: asNumber(totals?.["waived"]) ?? documents.filter((item) => item.status === "waived").length,
      outstanding:
        asNumber(totals?.["outstanding"]) ??
        documents.filter(
          (item) => item.required && item.status !== "received" && item.status !== "waived",
        ).length,
    },
    returnedNote: asString(artifact["returnedNote"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

/** Live collection totals for the checklist draft. */
export function vendorDocumentTotals(
  documents: VendorDocumentView[],
): VendorCollectShape["totals"] {
  const required = documents.filter((document) => document.required);
  const received = required.filter((document) => document.status === "received").length;
  const waived = required.filter((document) => document.status === "waived").length;
  return {
    documents: documents.length,
    required: required.length,
    received,
    waived,
    outstanding: required.length - received - waived,
  };
}

export type VendorCheckStatus = "pass" | "flag" | "fail";

const VENDOR_CHECK_STATUSES: readonly VendorCheckStatus[] = ["pass", "flag", "fail"];

export const VENDOR_CHECK_STATUS_LABELS: Record<VendorCheckStatus, string> = {
  pass: "Pass",
  flag: "Flag",
  fail: "Fail",
};

function vendorCheckStatus(value: unknown): VendorCheckStatus | null {
  return typeof value === "string" && (VENDOR_CHECK_STATUSES as readonly string[]).includes(value)
    ? (value as VendorCheckStatus)
    : null;
}

export type VendorCheckView = {
  id: string;
  label: string;
  status: VendorCheckStatus;
  source: string;
  checkedAt: string;
  detail: string;
};

function parseVendorCheck(value: unknown): VendorCheckView | null {
  const record = asRecord(value);
  const id = record === null ? null : asString(record["id"]);
  const status = record === null ? null : vendorCheckStatus(record["status"]);
  if (record === null || id === null || status === null) return null;
  return {
    id,
    label: asString(record["label"]) ?? id,
    status,
    source: asString(record["source"]) ?? "",
    checkedAt: asString(record["checkedAt"]) ?? "",
    detail: asString(record["detail"]) ?? "",
  };
}

export type VendorCandidateView = {
  vendorId: string;
  legalName: string;
  taxId: string;
  country: string;
  matchScore: number;
  matchedOn: string[];
};

function parseVendorCandidate(value: unknown): VendorCandidateView | null {
  const record = asRecord(value);
  const vendorId = record === null ? null : asString(record["vendorId"]);
  if (record === null || vendorId === null) return null;
  return {
    vendorId,
    legalName: asString(record["legalName"]) ?? "",
    taxId: asString(record["taxId"]) ?? "",
    country: asString(record["country"]) ?? "",
    matchScore: asNumber(record["matchScore"]) ?? 0,
    matchedOn: asStringArray(record["matchedOn"]),
  };
}

export type VendorResolutionView = { checkId: string; note: string };

export type VendorVerifyShape = {
  vendorName: string;
  taxId: string;
  country: string;
  checks: VendorCheckView[];
  candidates: VendorCandidateView[];
  manualReview: { required: boolean; items: Array<{ checkId: string; reason: string }> };
  resolutions: VendorResolutionView[];
  summary: string;
  confidence: number | null;
};

export type VendorVerifyDraft = { resolutions: Record<string, string> };

export function parseVendorVerify(
  artifact: Record<string, unknown>,
): VendorVerifyShape | null {
  const vendorName = asString(artifact["vendorName"]);
  const taxId = asString(artifact["taxId"]);
  if (vendorName === null || taxId === null) return null;
  const checks: VendorCheckView[] = [];
  if (Array.isArray(artifact["checks"])) {
    for (const item of artifact["checks"]) {
      const check = parseVendorCheck(item);
      if (check !== null) checks.push(check);
    }
  }
  const candidates: VendorCandidateView[] = [];
  if (Array.isArray(artifact["candidates"])) {
    for (const item of artifact["candidates"]) {
      const candidate = parseVendorCandidate(item);
      if (candidate !== null) candidates.push(candidate);
    }
  }
  const manualReviewRecord = asRecord(artifact["manualReview"]);
  const manualReviewItems: Array<{ checkId: string; reason: string }> = [];
  if (Array.isArray(manualReviewRecord?.["items"])) {
    for (const item of manualReviewRecord["items"]) {
      const record = asRecord(item);
      const checkId = record === null ? null : asString(record["checkId"]);
      if (record === null || checkId === null) continue;
      manualReviewItems.push({ checkId, reason: asString(record["reason"]) ?? "" });
    }
  }
  const resolutions: VendorResolutionView[] = [];
  if (Array.isArray(artifact["resolutions"])) {
    for (const item of artifact["resolutions"]) {
      const record = asRecord(item);
      const checkId = record === null ? null : asString(record["checkId"]);
      if (record === null || checkId === null) continue;
      resolutions.push({ checkId, note: asString(record["note"]) ?? "" });
    }
  }
  return {
    vendorName,
    taxId,
    country: asString(artifact["country"]) ?? "",
    checks,
    candidates,
    manualReview: {
      required: manualReviewRecord?.["required"] === true,
      items: manualReviewItems,
    },
    resolutions,
    summary: asString(artifact["summary"]) ?? "",
    confidence: asNumber(artifact["confidence"]),
  };
}

export type VendorRiskTier = "low" | "medium" | "high";

export const VENDOR_RISK_TIERS: readonly VendorRiskTier[] = ["low", "medium", "high"];

function vendorRiskTier(value: unknown): VendorRiskTier | null {
  return typeof value === "string" && (VENDOR_RISK_TIERS as readonly string[]).includes(value)
    ? (value as VendorRiskTier)
    : null;
}

export const VENDOR_ROLE_LABELS: Record<string, string> = {
  "procurement-lead": "Procurement Lead",
  "finance-manager": "Finance Manager",
  cfo: "Chief Financial Officer",
};

export function vendorRoleLabel(role: string): string {
  return VENDOR_ROLE_LABELS[role] ?? role;
}

export type VendorFactorView = { id: string; label: string; points: number; detail: string };

export type VendorMatrixRowView = { tier: VendorRiskTier; requiredSigners: string[] };

export type VendorRiskShape = {
  vendorName: string;
  taxId: string;
  score: number;
  tier: VendorRiskTier;
  factors: VendorFactorView[];
  requiredSigners: string[];
  matrix: VendorMatrixRowView[];
  summary: string;
  confidence: number | null;
};

export function parseVendorRisk(artifact: Record<string, unknown>): VendorRiskShape | null {
  const vendorName = asString(artifact["vendorName"]);
  const tier = vendorRiskTier(artifact["tier"]);
  if (vendorName === null || tier === null) return null;
  const factors: VendorFactorView[] = [];
  if (Array.isArray(artifact["factors"])) {
    for (const item of artifact["factors"]) {
      const record = asRecord(item);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || id === null) continue;
      factors.push({
        id,
        label: asString(record["label"]) ?? id,
        points: asNumber(record["points"]) ?? 0,
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  const matrix: VendorMatrixRowView[] = [];
  if (Array.isArray(artifact["matrix"])) {
    for (const item of artifact["matrix"]) {
      const record = asRecord(item);
      const rowTier = record === null ? null : vendorRiskTier(record["tier"]);
      if (record === null || rowTier === null) continue;
      matrix.push({ tier: rowTier, requiredSigners: asStringArray(record["requiredSigners"]) });
    }
  }
  return {
    vendorName,
    taxId: asString(artifact["taxId"]) ?? "",
    score: asNumber(artifact["score"]) ?? 0,
    tier,
    factors,
    requiredSigners: asStringArray(artifact["requiredSigners"]),
    matrix,
    summary: asString(artifact["summary"]) ?? "",
    confidence: asNumber(artifact["confidence"]),
  };
}

export type VendorSignerState = "pending" | "approved" | "rejected";

const VENDOR_SIGNER_STATES: readonly VendorSignerState[] = ["pending", "approved", "rejected"];

function vendorSignerState(value: unknown): VendorSignerState | null {
  return typeof value === "string" && (VENDOR_SIGNER_STATES as readonly string[]).includes(value)
    ? (value as VendorSignerState)
    : null;
}

export type VendorChainEntryView = {
  role: string;
  name: string;
  state: VendorSignerState;
  requestedAt: string;
  actedAt: string | null;
  note: string | null;
  nudges: number;
  lastNudgedAt: string | null;
};

export type VendorCommentView = { author: string; at: string; body: string };

export type VendorApproveShape = {
  vendorName: string;
  taxId: string;
  tier: VendorRiskTier;
  slaHours: number;
  chain: VendorChainEntryView[];
  comments: VendorCommentView[];
  allApproved: boolean;
  summary: string;
};

export type VendorApproveDraft = {
  chain: VendorChainEntryView[];
  comments: VendorCommentView[];
};

export function parseVendorApprove(
  artifact: Record<string, unknown>,
): VendorApproveShape | null {
  const vendorName = asString(artifact["vendorName"]);
  if (vendorName === null) return null;
  const chain: VendorChainEntryView[] = [];
  if (Array.isArray(artifact["chain"])) {
    for (const item of artifact["chain"]) {
      const record = asRecord(item);
      const role = record === null ? null : asString(record["role"]);
      const state = record === null ? null : vendorSignerState(record["state"]);
      if (record === null || role === null || state === null) continue;
      chain.push({
        role,
        name: asString(record["name"]) ?? vendorRoleLabel(role),
        state,
        requestedAt: asString(record["requestedAt"]) ?? "",
        actedAt: asString(record["actedAt"]),
        note: asString(record["note"]),
        nudges: asNumber(record["nudges"]) ?? 0,
        lastNudgedAt: asString(record["lastNudgedAt"]),
      });
    }
  }
  const comments: VendorCommentView[] = [];
  if (Array.isArray(artifact["comments"])) {
    for (const item of artifact["comments"]) {
      const record = asRecord(item);
      if (record === null) continue;
      comments.push({
        author: asString(record["author"]) ?? "",
        at: asString(record["at"]) ?? "",
        body: asString(record["body"]) ?? "",
      });
    }
  }
  return {
    vendorName,
    taxId: asString(artifact["taxId"]) ?? "",
    tier: vendorRiskTier(artifact["tier"]) ?? "low",
    slaHours: asNumber(artifact["slaHours"]) ?? 48,
    chain,
    comments,
    allApproved: artifact["allApproved"] === true,
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type VendorRecordView = {
  vendorId: string;
  legalName: string;
  taxId: string;
  country: string;
  requestor: string;
  status: string;
  effectiveDate: string;
};

export type VendorCreateShape = {
  record: VendorRecordView;
  idempotencyKey: string;
  welcomePacket: boolean;
  existing: { vendorId: string; legalName: string; createdAt: string } | null;
  summary: string;
};

export type VendorCreateDraft = { welcomePacket: boolean };

export function parseVendorCreate(
  artifact: Record<string, unknown>,
): VendorCreateShape | null {
  const record = asRecord(artifact["record"]);
  const vendorId = record === null ? null : asString(record["vendorId"]);
  if (record === null || vendorId === null) return null;
  const existing = asRecord(artifact["existing"]);
  return {
    record: {
      vendorId,
      legalName: asString(record["legalName"]) ?? "",
      taxId: asString(record["taxId"]) ?? "",
      country: asString(record["country"]) ?? "",
      requestor: asString(record["requestor"]) ?? "",
      status: asString(record["status"]) ?? "",
      effectiveDate: asString(record["effectiveDate"]) ?? "",
    },
    idempotencyKey: asString(artifact["idempotencyKey"]) ?? "",
    welcomePacket: artifact["welcomePacket"] !== false,
    existing:
      existing === null || asString(existing["vendorId"]) === null
        ? null
        : {
            vendorId: asString(existing["vendorId"]) ?? "",
            legalName: asString(existing["legalName"]) ?? "",
            createdAt: asString(existing["createdAt"]) ?? "",
          },
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type VendorReceiptView = {
  vendorId: string;
  legalName: string;
  taxId: string;
  effectiveDate: string;
  welcomePacket: boolean;
  created: boolean;
  registryRef: string;
};

export function parseVendorReceipt(value: unknown): VendorReceiptView | null {
  const record = asRecord(value);
  const vendorId = record === null ? null : asString(record["vendorId"]);
  if (record === null || vendorId === null) return null;
  return {
    vendorId,
    legalName: asString(record["legalName"]) ?? "",
    taxId: asString(record["taxId"]) ?? "",
    effectiveDate: asString(record["effectiveDate"]) ?? "",
    welcomePacket: record["welcomePacket"] === true,
    created: record["created"] === true,
    registryRef: asString(record["registryRef"]) ?? "",
  };
}

/** Step 1 — the document checklist: status pills, uploads, nudges, waivers. */
export function VendorCollectSurface({
  artifact,
  editable,
  draft,
  returnNote,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: VendorCollectDraft | null;
  returnNote: string | null;
  onChange: (draft: VendorCollectDraft) => void;
}) {
  const parsed = parseVendorCollect(artifact);

  if (parsed === null) {
    return <p className="step-empty">The document checklist is not available yet.</p>;
  }
  const note = returnNote ?? parsed.returnedNote;
  const value: VendorCollectDraft = draft ?? {
    documents: parsed.documents.map((document) => ({ ...document })),
    returnedNote: note,
  };
  const totals = vendorDocumentTotals(value.documents);
  const outstandingLabels = value.documents
    .filter((document) => document.required && document.status !== "received" && document.status !== "waived")
    .map((document) => document.label);

  function setDocument(id: string, patch: Partial<VendorDocumentView>): void {
    onChange({
      documents: value.documents.map((document) =>
        document.id === id ? { ...document, ...patch } : document,
      ),
      returnedNote: value.returnedNote,
    });
  }

  function receiveFile(id: string, file: File | null): void {
    if (file === null) return;
    setDocument(id, { status: "received", fileName: file.name.slice(0, 200), waivedReason: null });
  }

  function nudge(id: string): void {
    const document = value.documents.find((item) => item.id === id);
    if (document === undefined) return;
    setDocument(id, { nudges: document.nudges + 1, lastNudgedAt: new Date().toISOString() });
  }

  return (
    <div className="vendors-collect-surface">
      <p className="step-summary">
        {`${parsed.vendorName} · ${parsed.taxId} · ${parsed.country} · requested by ${parsed.requestor}`}
      </p>
      {note !== null && note.trim() !== "" && (
        <aside className="similar-callout vendors-returned-callout">
          <h4>Returned for rework</h4>
          <Markdown text={note} />
        </aside>
      )}
      <div className="analysis-meta">
        <span className="file-count-badge">
          {`${totals.received} of ${totals.required} received`}
        </span>
        {totals.waived > 0 ? (
          <span className="file-count-badge">{`${totals.waived} waived`}</span>
        ) : null}
        <span className="file-count-badge">{`${totals.outstanding} outstanding`}</span>
      </div>
      <Markdown text={parsed.summary} className="step-summary" />
      <ul className="vendors-doc-list">
        {value.documents.map((document) => (
          <li
            key={document.id}
            className={`vendors-doc-row status-${document.status}`}
            onDragOver={(event) => {
              if (editable) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!editable) return;
              event.preventDefault();
              receiveFile(document.id, event.dataTransfer.files?.[0] ?? null);
            }}
          >
            <div className="vendors-doc-head">
              <strong>{document.label}</strong>
              <span className={`vendors-status-pill status-${document.status}`}>
                {VENDOR_DOCUMENT_STATUS_LABELS[document.status]}
              </span>
              {!document.required && <span className="line-pill">optional</span>}
            </div>
            <p className="vendors-doc-meta">
              {document.fileName !== null && document.fileName !== ""
                ? `File: ${document.fileName}`
                : "No file attached"}
              {document.nudges > 0
                ? ` · nudged ${document.nudges}×${
                    document.lastNudgedAt !== null ? ` (${document.lastNudgedAt})` : ""
                  }`
                : ""}
            </p>
            {document.status === "waived" && (
              <label className="vendors-waive-editor">
                <span>Waiver reason</span>
                <input
                  type="text"
                  maxLength={500}
                  value={document.waivedReason ?? ""}
                  readOnly={!editable}
                  placeholder="Why is this document not required?"
                  onChange={(event) => setDocument(document.id, { waivedReason: event.target.value })}
                />
              </label>
            )}
            {editable && (
              <div className="vendors-doc-actions">
                <label className="vendors-upload">
                  <span>{document.status === "received" ? "Replace file" : "Upload"}</span>
                  <input
                    type="file"
                    className="sr-only"
                    aria-label={`Upload ${document.label}`}
                    onChange={(event) => {
                      receiveFile(document.id, event.target.files?.[0] ?? null);
                      event.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setDocument(
                      document.id,
                      document.status === "waived"
                        ? { status: "missing", waivedReason: null }
                        : { status: "waived" },
                    )
                  }
                >
                  {document.status === "waived" ? "Un-waive" : "Waive"}
                </button>
                <button
                  type="button"
                  disabled={document.status === "received" || document.status === "waived"}
                  onClick={() => nudge(document.id)}
                >
                  Nudge requester
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {outstandingLabels.length > 0 && (
        <p className="run-action-error" role="alert">
          {`Collect every required document or waive it with a reason (${outstandingLabels.join(", ")} outstanding).`}
        </p>
      )}
      <p className="step-summary">
        Drop a file on a row (or use Upload) to mark it received; waive with a reason when a document
        does not apply. Nudging the requester records a reminder without contacting anyone.
      </p>
    </div>
  );
}

/** Step 2 — the verification table, duplicate candidates and manual review. */
export function VendorVerifySurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: VendorVerifyDraft | null;
  onChange: (draft: VendorVerifyDraft) => void;
}) {
  const parsed = parseVendorVerify(artifact);

  if (parsed === null) {
    return <p className="step-empty">The verification results are not available yet.</p>;
  }
  const failing = parsed.checks.filter((check) => check.status === "fail");

  const noteFor = (checkId: string): string =>
    draft?.resolutions[checkId] ??
    parsed.resolutions.find((resolution) => resolution.checkId === checkId)?.note ??
    "";

  const setNote = (checkId: string, note: string): void => {
    onChange({ resolutions: { ...(draft?.resolutions ?? {}), [checkId]: note } });
  };

  return (
    <div className="vendors-verify-surface">
      <div className="impl-head">
        <Markdown text={parsed.summary} className="analysis-summary" />
        <div className="analysis-meta">
          {parsed.confidence !== null ? (
            <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
          ) : null}
          <span className="file-count-badge">{`${parsed.checks.length} checks`}</span>
        </div>
      </div>
      <table className="dependency-table vendors-check-table">
        <thead>
          <tr>
            <th>Check</th>
            <th>Result</th>
            <th>Source</th>
            <th>Checked</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {parsed.checks.map((check) => (
            <tr key={check.id} className={`check-${check.status}`}>
              <td>
                <strong>{check.label}</strong>
              </td>
              <td>
                <span className={`vendors-check-pill check-${check.status}`}>
                  {VENDOR_CHECK_STATUS_LABELS[check.status]}
                </span>
              </td>
              <td className="dependency-version-cell">{check.source}</td>
              <td className="dependency-version-cell">{check.checkedAt}</td>
              <td className="change-description">
                <Markdown text={check.detail} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="vendors-candidates">
        <h4 className="a11y-section-head">{`Duplicate candidates · ${parsed.candidates.length}`}</h4>
        {parsed.candidates.length === 0 ? (
          <p className="step-empty">No duplicate candidates were found in the vendor registry.</p>
        ) : (
          <div className="vendors-candidate-grid">
            {parsed.candidates.map((candidate) => (
              <article key={candidate.vendorId} className="dependency-group-card vendors-candidate-card">
                <header className="file-card-head">
                  <strong>{candidate.legalName}</strong>
                  <span className="line-pill">{`match ${Math.round(candidate.matchScore * 100)}%`}</span>
                </header>
                <p className="vendors-doc-meta">
                  {`${candidate.vendorId} · ${candidate.taxId} · ${candidate.country}`}
                </p>
                <p className="file-validators">
                  {`Matched on: ${candidate.matchedOn.join(", ") || "none"}`}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="vendors-manual-review">
        <h4 className="a11y-section-head">{`Manual review · ${failing.length}`}</h4>
        {failing.length === 0 ? (
          <p className="vendors-passed-note" role="status">
            Every check passed — no manual review is required.
          </p>
        ) : (
          <>
            <p className="step-summary">
              Each failing check needs a review note before verification can proceed; the note is the
              evidence recorded with the decision.
            </p>
            <ul className="vendors-review-list">
              {failing.map((check) => (
                <li key={check.id}>
                  <div className="vendors-doc-head">
                    <strong>{check.label}</strong>
                    <span className="vendors-check-pill check-fail">Fail</span>
                  </div>
                  <Markdown text={check.detail} className="change-description" />
                  <label className="vendors-review-note">
                    <span>Manual-review note</span>
                    <textarea
                      rows={2}
                      maxLength={1000}
                      value={noteFor(check.id)}
                      placeholder="Why is this finding acceptable or already handled?"
                      readOnly={!editable}
                      onChange={(event) => setNote(check.id, event.target.value)}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/** Step 3 — the score meter, tier badge, factor breakdown and approver matrix. */
export function VendorRiskSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const parsed = parseVendorRisk(artifact);

  if (parsed === null) {
    return <p className="step-empty">The risk score is not available yet.</p>;
  }
  const scoreWidth = Math.min(100, Math.max(0, parsed.score));

  return (
    <div className="vendors-risk-surface">
      <div className="impl-head">
        <Markdown text={parsed.summary} className="analysis-summary" />
        <div className="analysis-meta">
          {parsed.confidence !== null ? (
            <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
          ) : null}
          <span className={`vendors-tier-badge tier-${parsed.tier}`}>{parsed.tier}</span>
        </div>
      </div>
      <div
        className={`vendors-score-meter tier-${parsed.tier}`}
        role="img"
        aria-label={`Risk score ${parsed.score} of 100`}
      >
        <div className="vendors-score-fill" style={{ width: `${scoreWidth}%` }} />
        <span className="vendors-score-value">{`${parsed.score} / 100`}</span>
      </div>
      <p className="step-summary">
        {`Tier ${parsed.tier} — required signers: ${parsed.requiredSigners
          .map((role) => vendorRoleLabel(role))
          .join(", ")}`}
      </p>

      <h4 className="a11y-section-head">Factor breakdown</h4>
      <ul className="vendors-factor-list">
        {parsed.factors.map((factor) => (
          <li key={factor.id} className="vendors-factor-row">
            <div className="vendors-factor-head">
              <strong>{factor.label}</strong>
              <span className="line-pill">{`+${factor.points}`}</span>
            </div>
            <Markdown text={factor.detail} className="change-description" />
          </li>
        ))}
      </ul>

      <h4 className="a11y-section-head">Approver matrix</h4>
      <table className="dependency-table vendors-matrix-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Required signers</th>
          </tr>
        </thead>
        <tbody>
          {parsed.matrix.map((row) => (
            <tr key={row.tier} className={row.tier === parsed.tier ? "current-tier" : ""}>
              <td>
                <span className={`vendors-tier-badge tier-${row.tier}`}>{row.tier}</span>
              </td>
              <td>{row.requiredSigners.map((role) => vendorRoleLabel(role)).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function vendorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part !== "");
  const first = parts[0]?.charAt(0) ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? "" : "";
  return `${first}${last}`.toUpperCase();
}

function vendorSlaAgeHours(requestedAt: string): number | null {
  const parsed = Date.parse(requestedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 3_600_000));
}

/** Step 4 — the approval chain tracker, comments and the reject-to-collect loop. */
export function VendorApproveSurface({
  artifact,
  editable,
  draft,
  onChange,
  returnFlow,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: VendorApproveDraft | null;
  onChange: (draft: VendorApproveDraft) => void;
  returnFlow?: { onReturn: (reason: string) => void; busy: boolean };
}) {
  const [commentText, setCommentText] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const parsed = parseVendorApprove(artifact);

  if (parsed === null) {
    return <p className="step-empty">The approval chain is not available yet.</p>;
  }
  const chain = draft?.chain ?? parsed.chain;
  const comments = draft?.comments ?? parsed.comments;
  const allApproved = chain.length > 0 && chain.every((entry) => entry.state === "approved");

  function setEntry(role: string, patch: Partial<VendorChainEntryView>): void {
    onChange({
      chain: chain.map((entry) => (entry.role === role ? { ...entry, ...patch } : entry)),
      comments,
    });
  }

  function toggleApproval(entry: VendorChainEntryView): void {
    if (entry.state === "approved") {
      setEntry(entry.role, { state: "pending", actedAt: null, note: null });
      return;
    }
    setEntry(entry.role, {
      state: "approved",
      actedAt: new Date().toISOString(),
      note: entry.note ?? "Approved in review.",
    });
  }

  function nudge(entry: VendorChainEntryView): void {
    setEntry(entry.role, {
      nudges: entry.nudges + 1,
      lastNudgedAt: new Date().toISOString(),
    });
  }

  function addComment(): void {
    const body = commentText.trim();
    if (body === "") return;
    onChange({
      chain,
      comments: [
        ...comments,
        { author: "You", at: new Date().toISOString(), body: body.slice(0, 1000) },
      ],
    });
    setCommentText("");
  }

  return (
    <div className="vendors-approve-surface">
      <Markdown text={parsed.summary} className="step-summary" />
      <div className="analysis-meta">
        <span className={`vendors-tier-badge tier-${parsed.tier}`}>{parsed.tier}</span>
        <span className="file-count-badge">{`SLA ${parsed.slaHours}h`}</span>
        <span className="file-count-badge">{allApproved ? "All approved" : "Awaiting signers"}</span>
      </div>

      <ul className="vendors-chain-list">
        {chain.map((entry) => {
          const age = vendorSlaAgeHours(entry.requestedAt);
          const slaLabel =
            age === null ? `SLA ${parsed.slaHours}h` : `${age}h of ${parsed.slaHours}h SLA`;
          return (
            <li key={entry.role} className={`vendors-chain-row state-${entry.state}`}>
              <span className={`vendors-avatar state-${entry.state}`} aria-hidden="true">
                {vendorInitials(entry.name)}
              </span>
              <div className="vendors-chain-body">
                <div className="vendors-chain-head">
                  <strong>{entry.name}</strong>
                  <span className="vendors-chain-role">{entry.role}</span>
                  <span className={`vendors-chain-state state-${entry.state}`}>{entry.state}</span>
                </div>
                <p className="a11y-location">
                  {`Requested ${entry.requestedAt} · ${slaLabel}`}
                  {entry.actedAt !== null ? ` · acted ${entry.actedAt}` : ""}
                  {entry.nudges > 0 ? ` · nudged ${entry.nudges}×` : ""}
                </p>
                {entry.note !== null && entry.note.trim() !== "" && (
                  <Markdown text={entry.note} className="change-description" />
                )}
                {editable && (
                  <div className="vendors-chain-actions">
                    <button
                      type="button"
                      className={entry.state === "approved" ? "" : "approve"}
                      onClick={() => toggleApproval(entry)}
                    >
                      {entry.state === "approved" ? "Undo approval" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={entry.state !== "pending"}
                      onClick={() => nudge(entry)}
                    >
                      Nudge signer
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <section className="vendors-comments">
        <h4 className="a11y-section-head">{`Comments · ${comments.length}`}</h4>
        {comments.length === 0 ? (
          <p className="step-empty">No comments were recorded on this chain.</p>
        ) : (
          <ul className="vendors-comment-list">
            {comments.map((comment, index) => (
              <li key={`${comment.at}-${index}`}>
                <div className="vendors-comment-head">
                  <strong>{comment.author}</strong>
                  <span className="a11y-location">{comment.at}</span>
                </div>
                <Markdown text={comment.body} className="change-description" />
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <div className="vendors-comment-editor">
            <textarea
              rows={2}
              maxLength={1000}
              value={commentText}
              placeholder="Add a decision comment"
              onChange={(event) => setCommentText(event.target.value)}
            />
            <button type="button" disabled={commentText.trim() === ""} onClick={addComment}>
              Add comment
            </button>
          </div>
        )}
      </section>

      {editable && !allApproved && (
        <p className="step-summary">
          Approve every required signer to create the vendor record, or reject with a reason to return
          this run to Collect.
        </p>
      )}
      {editable && returnFlow !== undefined && (
        <div className="vendors-return-editor">
          <label>
            <span>Reject reason (returns the run to Collect)</span>
            <textarea
              rows={2}
              maxLength={2000}
              value={returnReason}
              placeholder="What must be re-collected before onboarding can continue?"
              onChange={(event) => setReturnReason(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="danger"
            disabled={returnFlow.busy || returnReason.trim() === ""}
            onClick={() => returnFlow.onReturn(returnReason.trim().slice(0, 2000))}
          >
            Reject — return to Collect
          </button>
        </div>
      )}
    </div>
  );
}

/** Step 5 — the master-record preview, welcome toggle and the creation receipt. */
export function VendorCreateSurface({
  artifact,
  receipt,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  receipt: VendorReceiptView | null;
  editable: boolean;
  draft: VendorCreateDraft | null;
  onChange: (draft: VendorCreateDraft) => void;
}) {
  const parsed = parseVendorCreate(artifact);

  if (parsed === null) {
    if (receipt !== null) {
      return (
        <div className="vendors-create-surface">
          <article className="receipt-card">
            <strong>
              {receipt.created
                ? `Vendor ${receipt.vendorId} created`
                : `${receipt.vendorId} already existed — creation replayed idempotently`}
            </strong>
            <ul className="completion-files">
              <li>{`Effective ${receipt.effectiveDate}`}</li>
              <li>{`Welcome packet ${receipt.welcomePacket ? "queued" : "skipped"}`}</li>
              <li>{`Registry: ${receipt.registryRef}`}</li>
            </ul>
          </article>
        </div>
      );
    }
    return <p className="step-empty">The master-record preview is not available yet.</p>;
  }
  const welcomePacket = draft?.welcomePacket ?? parsed.welcomePacket;

  return (
    <div className="vendors-create-surface">
      <Markdown text={parsed.summary} className="analysis-summary" />
      {parsed.existing !== null && (
        <aside className="similar-callout vendors-existing-callout">
          <h4>Existing master record</h4>
          <p>
            {`${parsed.existing.vendorId} · ${parsed.existing.legalName} · created ${parsed.existing.createdAt}. ${
              parsed.existing === null ? "" : "Creating again replays idempotently — no duplicate record."
            }`}
          </p>
        </aside>
      )}
      <dl className="vendors-record-grid">
        <div>
          <dt>Vendor ID</dt>
          <dd>{parsed.record.vendorId}</dd>
        </div>
        <div>
          <dt>Legal name</dt>
          <dd>{parsed.record.legalName}</dd>
        </div>
        <div>
          <dt>Tax ID</dt>
          <dd>{parsed.record.taxId}</dd>
        </div>
        <div>
          <dt>Country</dt>
          <dd>{parsed.record.country}</dd>
        </div>
        <div>
          <dt>Requestor</dt>
          <dd>{parsed.record.requestor}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{parsed.record.status}</dd>
        </div>
        <div>
          <dt>Effective date</dt>
          <dd>{parsed.record.effectiveDate}</dd>
        </div>
        <div>
          <dt>Idempotency key</dt>
          <dd>{parsed.idempotencyKey}</dd>
        </div>
      </dl>
      <label className="group-accept">
        <input
          type="checkbox"
          checked={welcomePacket}
          disabled={!editable}
          onChange={(event) => onChange({ welcomePacket: event.target.checked })}
        />
        <span>{welcomePacket ? "Welcome packet will be sent" : "Welcome packet skipped"}</span>
      </label>
      {receipt !== null && (
        <article className="receipt-card">
          <strong>
            {receipt.created
              ? `Vendor ${receipt.vendorId} created`
              : `${receipt.vendorId} already existed — creation replayed idempotently`}
          </strong>
          <ul className="completion-files">
            <li>{`Effective ${receipt.effectiveDate}`}</li>
            <li>{`Welcome packet ${receipt.welcomePacket ? "queued" : "skipped"}`}</li>
            <li>{`Registry: ${receipt.registryRef}`}</li>
          </ul>
        </article>
      )}
      <p className="step-summary">
        Creating the record is idempotent by tax ID — replaying this decision returns the original
        receipt and never opens a duplicate vendor.
      </p>
    </div>
  );
}

/* ------------------------------------ security lane (SOC alert triage -> containment) */

/** Alert-channel labels for the ingest header. */
export const ALERT_SOURCE_LABELS: Record<string, string> = {
  edr: "EDR",
  siem: "SIEM",
  email: "Email",
  cloud: "Cloud",
};

export function securitySourceLabel(source: string): string {
  return ALERT_SOURCE_LABELS[source] ?? source.toUpperCase();
}

export type SecurityCheckStatus = "pass" | "flag" | "fail";

const SECURITY_CHECK_STATUSES: readonly SecurityCheckStatus[] = ["pass", "flag", "fail"];

function securityCheckStatus(value: unknown): SecurityCheckStatus | null {
  return typeof value === "string" && (SECURITY_CHECK_STATUSES as readonly string[]).includes(value)
    ? (value as SecurityCheckStatus)
    : null;
}

export type SecurityIngestCheckView = {
  id: string;
  label: string;
  status: SecurityCheckStatus;
  detail: string;
};

export type SecurityIngestView = {
  alertId: string;
  alertSource: string;
  title: string;
  host: string | null;
  user: string | null;
  indicators: string[];
  provenance: string;
  checks: SecurityIngestCheckView[];
  seenBefore: boolean;
  priorCaseId: string | null;
  summary: string;
};

export function parseSecurityIngest(artifact: Record<string, unknown>): SecurityIngestView | null {
  const alertId = asString(artifact["alertId"]);
  if (alertId === null) return null;
  const checks: SecurityIngestCheckView[] = [];
  if (Array.isArray(artifact["checks"])) {
    for (const item of artifact["checks"]) {
      const record = asRecord(item);
      const status = record === null ? null : securityCheckStatus(record["status"]);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || status === null || id === null) continue;
      checks.push({
        id,
        label: asString(record["label"]) ?? id,
        status,
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  const dedupe = asRecord(artifact["dedupe"]);
  return {
    alertId,
    alertSource: asString(artifact["alertSource"]) ?? "",
    title: asString(artifact["title"]) ?? "",
    host: asString(artifact["host"]),
    user: asString(artifact["user"]),
    indicators: asStringArray(artifact["indicators"]),
    provenance: asString(artifact["provenance"]) ?? "",
    checks,
    seenBefore: dedupe !== null && dedupe["seenBefore"] === true,
    priorCaseId: dedupe === null ? null : asString(dedupe["priorCaseId"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

/** Step 1 — the normalized alert: dedupe, provenance, indicators, validation checks. */
export function SecurityIngestSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const parsed = parseSecurityIngest(artifact);

  if (parsed === null) {
    return <p className="step-empty">The normalized alert is not available yet.</p>;
  }
  const failed = parsed.checks.filter((check) => check.status === "fail").length;

  return (
    <div className="security-surface">
      <div className="security-head">
        <span className="security-source-pill">{securitySourceLabel(parsed.alertSource)}</span>
        <strong>{parsed.title}</strong>
        <span className="file-count-badge">{parsed.alertId}</span>
      </div>
      <dl className="security-kv">
        <div>
          <dt>Host</dt>
          <dd>{parsed.host ?? "unassigned"}</dd>
        </div>
        <div>
          <dt>User</dt>
          <dd>{parsed.user ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>{parsed.provenance}</dd>
        </div>
        <div>
          <dt>Dedupe</dt>
          <dd>
            {parsed.seenBefore
              ? `Seen before — prior case ${parsed.priorCaseId ?? "unknown"}`
              : "First occurrence"}
          </dd>
        </div>
      </dl>
      {parsed.indicators.length > 0 && (
        <>
          <h4 className="a11y-section-head">{`Indicators · ${parsed.indicators.length}`}</h4>
          <div className="security-chip-row">
            {parsed.indicators.map((indicator) => (
              <span key={indicator} className="security-chip security-mono">
                {indicator}
              </span>
            ))}
          </div>
        </>
      )}
      <h4 className="a11y-section-head">
        {failed > 0
          ? `Validation checks · ${failed} failing`
          : `Validation checks · all ${parsed.checks.length} clear`}
      </h4>
      <ul className="security-check-list">
        {parsed.checks.map((check) => (
          <li key={check.id} className={`security-check-row status-${check.status}`}>
            <div className="security-check-head">
              <span className={`security-status-pill status-${check.status}`}>{check.status}</span>
              <strong>{check.label}</strong>
            </div>
            <Markdown text={check.detail} className="change-description" />
          </li>
        ))}
      </ul>
      <Markdown text={parsed.summary} className="analysis-summary" />
    </div>
  );
}

export const SECURITY_CLASSIFICATION_LABELS: Record<string, string> = {
  tp: "True positive",
  fp: "False positive",
  benign: "Benign",
  unknown: "Unknown",
};

export type SecurityMitreView = { id: string; name: string; tactic: string };

export type SecurityTriageView = {
  classification: string;
  severity: string;
  confidence: number | null;
  mitreTechniques: SecurityMitreView[];
  injectionFlags: string[];
  rationale: string;
  needsInvestigation: boolean;
};

export function parseSecurityTriage(artifact: Record<string, unknown>): SecurityTriageView | null {
  const classification = asString(artifact["classification"]);
  if (classification === null) return null;
  const mitreTechniques: SecurityMitreView[] = [];
  if (Array.isArray(artifact["mitreTechniques"])) {
    for (const item of artifact["mitreTechniques"]) {
      const record = asRecord(item);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || id === null) continue;
      mitreTechniques.push({
        id,
        name: asString(record["name"]) ?? "",
        tactic: asString(record["tactic"]) ?? "",
      });
    }
  }
  return {
    classification,
    severity: asString(artifact["severity"]) ?? "low",
    confidence: asNumber(artifact["confidence"]),
    mitreTechniques,
    injectionFlags: asStringArray(artifact["injectionFlags"]),
    rationale: asString(artifact["rationale"]) ?? "",
    needsInvestigation: artifact["needsInvestigation"] === true,
  };
}

/** Step 2 — the triage verdict: classification pill, severity, ATT&CK chips, injection flags. */
export function SecurityTriageSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const parsed = parseSecurityTriage(artifact);

  if (parsed === null) {
    return <p className="step-empty">The triage verdict is not available yet.</p>;
  }
  const flagged = parsed.injectionFlags.length > 0;

  return (
    <div className="security-surface">
      <div className="security-head">
        <span className={`security-class-pill class-${parsed.classification}`}>
          {SECURITY_CLASSIFICATION_LABELS[parsed.classification] ?? parsed.classification}
        </span>
        <span className={`security-severity-badge severity-${parsed.severity}`}>{parsed.severity}</span>
        {parsed.confidence !== null && (
          <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
        )}
        <span className="file-count-badge">
          {parsed.needsInvestigation ? "Investigation required" : "No investigation needed"}
        </span>
      </div>
      {flagged && (
        <aside className="security-callout callout-danger">
          <h4>Prompt-injection signals detected</h4>
          <p>
            {"The raw alert tried to steer the analyst: "}
            <strong>{parsed.injectionFlags.join(", ")}</strong>
            {". Flagged alerts are never auto-judged — the verdict is pinned and the disposition escalates to a human."}
          </p>
        </aside>
      )}
      {parsed.mitreTechniques.length > 0 && (
        <>
          <h4 className="a11y-section-head">{`ATT&CK map · ${parsed.mitreTechniques.length}`}</h4>
          <ul className="security-mitre-list">
            {parsed.mitreTechniques.map((technique) => (
              <li key={technique.id} className="security-mitre-row">
                <span className="security-mitre-id">{technique.id}</span>
                <div className="security-mitre-body">
                  <strong>{technique.name}</strong>
                  <span className="security-mitre-tactic">{technique.tactic}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 className="a11y-section-head">Analyst rationale</h4>
      <Markdown text={parsed.rationale} className="analysis-summary" />
    </div>
  );
}

export type SecurityCitationView = { sourceId: string; span: string };

function securityCitation(value: unknown): SecurityCitationView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const sourceId = asString(record["sourceId"]);
  const span = asString(record["span"]);
  if (sourceId === null || span === null) return null;
  return { sourceId, span };
}

export function securityCitationLabel(citation: SecurityCitationView): string {
  return `${citation.sourceId}#${citation.span}`;
}

export type SecurityClaimView = {
  claim: string;
  sourceTool: string;
  retrievedAt: string;
  citation: SecurityCitationView;
};

export type SecurityTimelineView = { at: string; event: string; citation: SecurityCitationView };

export type SecurityIndicatorView = {
  indicator: string;
  verdict: string;
  detail: string;
  sourceTool: string;
  retrievedAt: string;
  citation: SecurityCitationView;
};

export type SecurityInvestigateView = {
  claims: SecurityClaimView[];
  timeline: SecurityTimelineView[];
  resolvedIndicators: SecurityIndicatorView[];
  missingEvidence: string[];
  unsourcedCount: number;
  summary: string;
};

export function parseSecurityInvestigate(
  artifact: Record<string, unknown>,
): SecurityInvestigateView | null {
  const claimsRaw = artifact["claims"];
  if (!Array.isArray(claimsRaw) || claimsRaw.length === 0) return null;
  const claims: SecurityClaimView[] = [];
  for (const item of claimsRaw) {
    const record = asRecord(item);
    const citation = record === null ? null : securityCitation(record["snippetRef"]);
    const claim = record === null ? null : asString(record["claim"]);
    if (record === null || citation === null || claim === null) continue;
    claims.push({
      claim,
      sourceTool: asString(record["sourceTool"]) ?? "",
      retrievedAt: asString(record["retrievedAt"]) ?? "",
      citation,
    });
  }
  const timeline: SecurityTimelineView[] = [];
  if (Array.isArray(artifact["timeline"])) {
    for (const item of artifact["timeline"]) {
      const record = asRecord(item);
      const at = record === null ? null : asString(record["at"]);
      const event = record === null ? null : asString(record["event"]);
      const sourceId = record === null ? null : asString(record["sourceId"]);
      const span = record === null ? null : asString(record["span"]);
      if (record === null || at === null || event === null || sourceId === null || span === null) {
        continue;
      }
      timeline.push({ at, event, citation: { sourceId, span } });
    }
  }
  const resolvedIndicators: SecurityIndicatorView[] = [];
  if (Array.isArray(artifact["resolvedIndicators"])) {
    for (const item of artifact["resolvedIndicators"]) {
      const record = asRecord(item);
      const citation = record === null ? null : securityCitation(record["snippetRef"]);
      const indicator = record === null ? null : asString(record["indicator"]);
      if (record === null || citation === null || indicator === null) continue;
      resolvedIndicators.push({
        indicator,
        verdict: asString(record["verdict"]) ?? "unknown",
        detail: asString(record["detail"]) ?? "",
        sourceTool: asString(record["sourceTool"]) ?? "",
        retrievedAt: asString(record["retrievedAt"]) ?? "",
        citation,
      });
    }
  }
  return {
    claims,
    timeline,
    resolvedIndicators,
    missingEvidence: asStringArray(artifact["missingEvidence"]),
    unsourcedCount: asNumber(artifact["unsourcedCount"]) ?? 0,
    summary: asString(artifact["summary"]) ?? "",
  };
}

/** Step 3 — the cited evidence pack: timeline, claims, resolved indicators, evidence gaps. */
export function SecurityInvestigateSurface({
  artifact,
  returnNote,
}: {
  artifact: Record<string, unknown>;
  returnNote?: string | null;
}) {
  const parsed = parseSecurityInvestigate(artifact);

  if (parsed === null) {
    return <p className="step-empty">The evidence pack is not available yet.</p>;
  }
  const note = returnNote ?? "";
  return (
    <div className="security-surface">
      {note.trim() !== "" && (
        <aside className="security-callout callout-warn">
          <h4>Returned from approval</h4>
          <p>{note}</p>
        </aside>
      )}
      <Markdown text={parsed.summary} className="analysis-summary" />
      <div className="analysis-meta">
        <span className="file-count-badge">{`${parsed.claims.length} cited claims`}</span>
        <span className="file-count-badge">
          {parsed.unsourcedCount === 0 ? "0 unsourced" : `${parsed.unsourcedCount} unsourced`}
        </span>
        <span className="file-count-badge">{`${parsed.timeline.length} timeline events`}</span>
      </div>

      {parsed.timeline.length > 0 && (
        <>
          <h4 className="a11y-section-head">Timeline</h4>
          <ol className="security-timeline">
            {parsed.timeline.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="security-timeline-row">
                <span className="security-timeline-at">{entry.at}</span>
                <span className="security-timeline-event">{entry.event}</span>
                <code className="security-citation">{securityCitationLabel(entry.citation)}</code>
              </li>
            ))}
          </ol>
        </>
      )}

      <h4 className="a11y-section-head">{`Evidence claims · ${parsed.claims.length}`}</h4>
      <ul className="security-claim-list">
        {parsed.claims.map((claim, index) => (
          <li key={`claim-${index}`} className="security-claim-row">
            <Markdown text={claim.claim} className="change-description" />
            <p className="security-claim-meta">
              {`${claim.sourceTool === "" ? "tool" : claim.sourceTool} · retrieved ${claim.retrievedAt} · `}
              <code className="security-citation">{securityCitationLabel(claim.citation)}</code>
            </p>
          </li>
        ))}
      </ul>

      {parsed.resolvedIndicators.length > 0 && (
        <>
          <h4 className="a11y-section-head">Resolved indicators</h4>
          <table className="dependency-table security-indicator-table">
            <thead>
              <tr>
                <th>Indicator</th>
                <th>Verdict</th>
                <th>Detail</th>
                <th>Citation</th>
              </tr>
            </thead>
            <tbody>
              {parsed.resolvedIndicators.map((indicator, index) => (
                <tr key={`${indicator.indicator}-${index}`}>
                  <td>
                    <code>{indicator.indicator}</code>
                  </td>
                  <td>
                    <span className={`security-verdict-pill verdict-${indicator.verdict}`}>
                      {indicator.verdict}
                    </span>
                  </td>
                  <td>{indicator.detail}</td>
                  <td>
                    <code className="security-citation">
                      {securityCitationLabel(indicator.citation)}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {parsed.missingEvidence.length > 0 && (
        <aside className="security-callout callout-warn">
          <h4>Missing evidence</h4>
          <ul className="security-missing-list">
            {parsed.missingEvidence.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

export type SecurityRiskFactorView = { id: string; label: string; points: number; detail: string };

export type SecurityRiskView = {
  score: number;
  tier: string;
  factors: SecurityRiskFactorView[];
  blastRadius: string;
  reversibility: string;
  refused: boolean;
};

export type SecurityDecideView = {
  action: string;
  confidence: number | null;
  reasoningClaims: number[];
  risk: SecurityRiskView;
  requiresHuman: boolean;
  detectionProposal: string | null;
  summary: string;
};

export function parseSecurityDecide(artifact: Record<string, unknown>): SecurityDecideView | null {
  const action = asString(artifact["action"]);
  const riskRecord = asRecord(artifact["risk"]);
  if (action === null || riskRecord === null) return null;
  const factors: SecurityRiskFactorView[] = [];
  if (Array.isArray(riskRecord["factors"])) {
    for (const item of riskRecord["factors"]) {
      const record = asRecord(item);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || id === null) continue;
      factors.push({
        id,
        label: asString(record["label"]) ?? id,
        points: asNumber(record["points"]) ?? 0,
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  return {
    action,
    confidence: asNumber(artifact["confidence"]),
    reasoningClaims: Array.isArray(artifact["reasoningClaims"])
      ? artifact["reasoningClaims"].filter((item): item is number => typeof item === "number")
      : [],
    risk: {
      score: asNumber(riskRecord["score"]) ?? 0,
      tier: asString(riskRecord["tier"]) ?? "low",
      factors,
      blastRadius: asString(riskRecord["blastRadius"]) ?? "low",
      reversibility: asString(riskRecord["reversibility"]) ?? "reversible",
      refused: riskRecord["refused"] === true,
    },
    requiresHuman: artifact["requiresHuman"] === true,
    detectionProposal: asString(artifact["detectionProposal"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

/** Step 4 — the disposition proposal: risk meter, factors, cited reasoning, detection advice. */
export function SecurityDecideSurface({
  artifact,
  claims,
}: {
  artifact: Record<string, unknown>;
  claims?: SecurityClaimView[];
}) {
  const parsed = parseSecurityDecide(artifact);

  if (parsed === null) {
    return <p className="step-empty">The disposition proposal is not available yet.</p>;
  }
  const scoreWidth = Math.min(100, Math.max(0, parsed.risk.score));

  return (
    <div className="security-surface">
      <div className="security-head">
        <span className={`security-action-pill action-${parsed.action}`}>{parsed.action}</span>
        <span className={`security-severity-badge severity-${parsed.risk.tier}`}>{`tier ${parsed.risk.tier}`}</span>
        {parsed.confidence !== null && (
          <span className="verdict-confidence">{`confidence ${(parsed.confidence * 100).toFixed(0)}%`}</span>
        )}
        <span className="file-count-badge">
          {parsed.requiresHuman ? "Human decision required" : "Automatic disposition"}
        </span>
      </div>
      <div
        className={`security-score-meter severity-${parsed.risk.tier}`}
        role="img"
        aria-label={`Risk score ${parsed.risk.score} of 100`}
      >
        <div className="security-score-fill" style={{ width: `${scoreWidth}%` }} />
        <span className="security-score-value">{`${parsed.risk.score} / 100`}</span>
      </div>
      <p className="step-summary">
        {`Blast radius ${parsed.risk.blastRadius} · ${parsed.risk.reversibility}${
          parsed.risk.refused ? " · refused by the lane risk policy" : ""
        }`}
      </p>

      {parsed.risk.factors.length > 0 && (
        <>
          <h4 className="a11y-section-head">Risk factors</h4>
          <ul className="security-factor-list">
            {parsed.risk.factors.map((factor) => (
              <li key={factor.id} className="security-factor-row">
                <div className="security-factor-head">
                  <strong>{factor.label}</strong>
                  <span className="line-pill">{`+${factor.points}`}</span>
                </div>
                <Markdown text={factor.detail} className="change-description" />
              </li>
            ))}
          </ul>
        </>
      )}

      {parsed.reasoningClaims.length > 0 && (
        <>
          <h4 className="a11y-section-head">Reasoning · cited claims</h4>
          <ul className="security-claim-list">
            {parsed.reasoningClaims.map((index) => {
              const claim = claims === undefined ? undefined : claims[index];
              return (
                <li key={`reasoning-${index}`} className="security-claim-row">
                  {claim === undefined ? (
                    <p className="a11y-location">{`Claim #${index} — see the investigation pack`}</p>
                  ) : (
                    <>
                      <Markdown text={claim.claim} className="change-description" />
                      <p className="security-claim-meta">
                        {`Claim #${index} · ${claim.sourceTool === "" ? "tool" : claim.sourceTool} · `}
                        <code className="security-citation">{securityCitationLabel(claim.citation)}</code>
                      </p>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {parsed.detectionProposal !== null && parsed.detectionProposal.trim() !== "" && (
        <aside className="security-callout callout-info">
          <h4>Detection-tuning proposal (advisory only — never executed)</h4>
          <Markdown text={parsed.detectionProposal} className="change-description" />
        </aside>
      )}
      <Markdown text={parsed.summary} className="analysis-summary" />
    </div>
  );
}

export type SecuritySignerState = "pending" | "approved" | "rejected";

const SECURITY_SIGNER_STATES: readonly SecuritySignerState[] = ["pending", "approved", "rejected"];

function securitySignerState(value: unknown): SecuritySignerState | null {
  return typeof value === "string" && (SECURITY_SIGNER_STATES as readonly string[]).includes(value)
    ? (value as SecuritySignerState)
    : null;
}

export type SecuritySignerView = {
  role: string;
  name: string;
  state: SecuritySignerState;
  approvedAt: string | null;
  comment: string | null;
};

export type SecurityApproveShape = {
  alertId: string;
  action: string;
  tier: string;
  requiredSigners: string[];
  signers: SecuritySignerView[];
  allApproved: boolean;
  summary: string;
};

export type SecurityApproveDraft = { signers: SecuritySignerView[] };

export function parseSecurityApprove(artifact: Record<string, unknown>): SecurityApproveShape | null {
  const alertId = asString(artifact["alertId"]);
  if (alertId === null) return null;
  const signers: SecuritySignerView[] = [];
  if (Array.isArray(artifact["signers"])) {
    for (const item of artifact["signers"]) {
      const record = asRecord(item);
      const role = record === null ? null : asString(record["role"]);
      const state = record === null ? null : securitySignerState(record["state"]);
      if (record === null || role === null || state === null) continue;
      signers.push({
        role,
        name: asString(record["name"]) ?? role,
        state,
        approvedAt: asString(record["approvedAt"]),
        comment: asString(record["comment"]),
      });
    }
  }
  return {
    alertId,
    action: asString(artifact["action"]) ?? "",
    tier: asString(artifact["tier"]) ?? "low",
    requiredSigners: asStringArray(artifact["requiredSigners"]),
    signers,
    allApproved: artifact["allApproved"] === true,
    summary: asString(artifact["summary"]) ?? "",
  };
}

function securityInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part !== "");
  const first = parts[0]?.charAt(0) ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? "" : "";
  return `${first}${last}`.toUpperCase();
}

/** Step 5 — the signer chain: approve every required role or reject to investigate. */
export function SecurityApproveSurface({
  artifact,
  editable,
  draft,
  onChange,
  returnFlow,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: SecurityApproveDraft | null;
  onChange: (draft: SecurityApproveDraft) => void;
  returnFlow?: { onReturn: (reason: string) => void; busy: boolean };
}) {
  const [returnReason, setReturnReason] = useState("");
  const parsed = parseSecurityApprove(artifact);

  if (parsed === null) {
    return <p className="step-empty">The approval chain is not available yet.</p>;
  }
  const signers = draft?.signers ?? parsed.signers;
  const allApproved =
    signers.length > 0 &&
    signers.every((signer) => signer.state === "approved" && signer.approvedAt !== null);

  function setSigner(role: string, patch: Partial<SecuritySignerView>): void {
    onChange({
      signers: signers.map((signer) => (signer.role === role ? { ...signer, ...patch } : signer)),
    });
  }

  function toggleApproval(signer: SecuritySignerView): void {
    if (signer.state === "approved") {
      setSigner(signer.role, { state: "pending", approvedAt: null, comment: null });
      return;
    }
    setSigner(signer.role, {
      state: "approved",
      approvedAt: new Date().toISOString(),
      comment: signer.comment ?? "Approved in review.",
    });
  }

  return (
    <div className="security-surface">
      <Markdown text={parsed.summary} className="step-summary" />
      <div className="analysis-meta">
        <span className={`security-severity-badge severity-${parsed.tier}`}>{`tier ${parsed.tier}`}</span>
        <span className="file-count-badge">{`action ${parsed.action}`}</span>
        <span className="file-count-badge">{allApproved ? "All approved" : "Awaiting signers"}</span>
      </div>

      <ul className="security-chain-list">
        {signers.map((signer) => (
          <li key={signer.role} className={`security-chain-row state-${signer.state}`}>
            <span className={`security-avatar state-${signer.state}`} aria-hidden="true">
              {securityInitials(signer.name)}
            </span>
            <div className="security-chain-body">
              <div className="security-chain-head">
                <strong>{signer.name}</strong>
                <span className="security-chain-role">{signer.role}</span>
                <span className={`security-chain-state state-${signer.state}`}>{signer.state}</span>
              </div>
              <p className="a11y-location">
                {signer.approvedAt === null ? "No signature recorded yet" : `Signed ${signer.approvedAt}`}
              </p>
              {signer.comment !== null && signer.comment.trim() !== "" && (
                <Markdown text={signer.comment} className="change-description" />
              )}
              {editable && (
                <div className="security-chain-actions">
                  <button
                    type="button"
                    className={signer.state === "approved" ? "" : "approve"}
                    onClick={() => toggleApproval(signer)}
                  >
                    {signer.state === "approved" ? "Undo approval" : "Approve"}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editable && !allApproved && (
        <p className="step-summary">
          Every required signer must approve before containment can be previewed, or reject with a
          reason to return this run to the evidence pack.
        </p>
      )}
      {editable && returnFlow !== undefined && (
        <div className="security-return-editor">
          <label>
            <span>Reject reason (returns the run to Investigate)</span>
            <textarea
              rows={2}
              maxLength={2000}
              value={returnReason}
              placeholder="What must be re-examined before containment can be approved?"
              onChange={(event) => setReturnReason(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="danger"
            disabled={returnFlow.busy || returnReason.trim() === ""}
            onClick={() => returnFlow.onReturn(returnReason.trim().slice(0, 2000))}
          >
            Reject — return to Investigate
          </button>
        </div>
      )}
    </div>
  );
}

export type SecurityPreviewView = {
  alertId: string;
  action: string;
  outcome: string;
  containmentId: string;
  idempotencyKey: string;
  target: string;
  summary: string;
};

export function parseSecurityPreview(artifact: Record<string, unknown>): SecurityPreviewView | null {
  const containmentId = asString(artifact["containmentId"]);
  const alertId = asString(artifact["alertId"]);
  if (containmentId === null || alertId === null) return null;
  return {
    alertId,
    action: asString(artifact["action"]) ?? "",
    outcome: asString(artifact["outcome"]) ?? "",
    containmentId,
    idempotencyKey: asString(artifact["idempotencyKey"]) ?? "",
    target: asString(artifact["target"]) ?? "",
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type SecurityReceiptView = SecurityPreviewView & {
  registryRef: string;
  completedAt: string;
  evidenceRef: string;
};

export function parseSecurityReceipt(value: unknown): SecurityReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const preview = parseSecurityPreview(record);
  if (preview === null) return null;
  return {
    ...preview,
    registryRef: asString(record["registryRef"]) ?? "",
    completedAt: asString(record["completedAt"]) ?? "",
    evidenceRef: asString(record["evidenceRef"]) ?? "",
  };
}

/** Step 6 — the containment preview and its idempotent, replay-safe receipt. */
export function SecurityContainSurface({
  artifact,
  receipt,
  replayed,
}: {
  artifact: Record<string, unknown>;
  receipt: SecurityReceiptView | null;
  replayed: boolean;
}) {
  const preview = parseSecurityPreview(artifact);
  const core = receipt ?? preview;

  if (core === null) {
    return <p className="step-empty">The containment preview is not available yet.</p>;
  }

  return (
    <div className="security-surface">
      <div className="security-head">
        <span className={`security-outcome-pill outcome-${core.outcome}`}>{core.outcome}</span>
        <span className="file-count-badge">{`action ${core.action}`}</span>
        {receipt !== null ? (
          <>
            <span className="file-count-badge">Executed</span>
            {replayed && <span className="security-replay-badge">already replayed</span>}
          </>
        ) : (
          <span className="file-count-badge">Not executed</span>
        )}
      </div>
      <Markdown text={core.summary} className="analysis-summary" />
      <dl className="security-kv">
        <div>
          <dt>Alert</dt>
          <dd>{core.alertId}</dd>
        </div>
        <div>
          <dt>Containment ID</dt>
          <dd>{core.containmentId}</dd>
        </div>
        <div>
          <dt>Idempotency key</dt>
          <dd>{core.idempotencyKey}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{core.target}</dd>
        </div>
        {receipt !== null && (
          <>
            <div>
              <dt>Completed at</dt>
              <dd>{receipt.completedAt}</dd>
            </div>
            <div>
              <dt>Registry reference</dt>
              <dd>{receipt.registryRef}</dd>
            </div>
            <div>
              <dt>Evidence reference</dt>
              <dd>{receipt.evidenceRef}</dd>
            </div>
          </>
        )}
      </dl>
      {receipt === null ? (
        <p className="security-hint">
          Idempotent — replaying this decision returns the original receipt and never re-executes the
          containment.
        </p>
      ) : (
        <article className="receipt-card">
          <strong>{`Containment ${receipt.containmentId} recorded — outcome ${receipt.outcome}`}</strong>
          <ul className="completion-files">
            <li>{`Target ${receipt.target}`}</li>
            <li>{`Completed ${receipt.completedAt}`}</li>
            <li>{`Registry: ${receipt.registryRef}`}</li>
            <li>{`Evidence: ${receipt.evidenceRef}`}</li>
          </ul>
        </article>
      )}
    </div>
  );
}
