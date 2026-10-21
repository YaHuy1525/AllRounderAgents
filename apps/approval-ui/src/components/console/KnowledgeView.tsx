"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { ApiError } from "@/lib/api";
import {
  KB_UPLOAD_HINT,
  annotatePassage,
  defaultKbDomain,
  emptyKbUploadDraft,
  formatMonthYear,
  kbDomainOptions,
  latestVersionMap,
  listKbDocuments,
  listKbDomains,
  searchKb,
  staleAfterIso,
  suggestUploadMeta,
  uploadKbDocument,
  validateKbUploadDraft,
  type KbDocument,
  type KbDomain,
  type KbPassage,
  type KbPassageNote,
  type KbUploadDraft,
} from "@/lib/kb";
import { ADMIN_HINT } from "@/lib/roles";

import {
  IconAlert,
  IconCheckCircle,
  IconClock,
  IconFileText,
  IconInfo,
  IconPlus,
  IconRefresh,
  IconSearch,
} from "./icons";

const KB_SKELETON_ROWS = 3;

type KbDomainsState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; domains: KbDomain[]; configured: boolean };

type KbCorpusState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; documents: KbDocument[] };

function domainsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sign in with a role that can read knowledge.";
    }
    return `The knowledge partitions could not be loaded (API ${error.status}).`;
  }
  return "The knowledge partitions could not be loaded.";
}

function corpusErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sign in with a role that can read knowledge.";
    }
    return `The corpus listing could not be loaded (API ${error.status}).`;
  }
  return "The corpus listing could not be loaded.";
}

function askErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sign in with a role that can read knowledge.";
    }
    return `The search was rejected (${error.status}).`;
  }
  return "The search could not reach the API.";
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return KB_UPLOAD_HINT;
    if (error.status === 422) {
      return "The API rejected the document — check the field formats.";
    }
    if (error.status === 503) {
      return "Knowledge storage is not configured on this deployment.";
    }
    return `The upload was rejected (${error.status}).`;
  }
  return "The upload could not reach the API.";
}

/** Retrieval scores are rank-fusion values, small by nature. */
function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  return score.toFixed(3);
}

function staleSinceLabel(document: KbDocument): string {
  const month = document.staleAfter === null ? "" : formatMonthYear(document.staleAfter);
  return month === "" ? "stale" : `stale · since ${month}`;
}

/**
 * One `sourceId:span` chip — the reference shape the lanes cite. Version and
 * score ride along; stale, superseded, and missing references render as flags
 * on the same chip so a bad cite is visible at a glance.
 */
export function KbSourceChip({ passage, note }: { passage: KbPassage; note: KbPassageNote }) {
  const invalid = note.missing || note.supersededBy !== null;
  return (
    <span className={`kb-chip${invalid ? " kb-chip-invalid" : ""}`}>
      <IconFileText />
      <span className="kb-chip-source">
        {passage.span === "" ? passage.sourceId : `${passage.sourceId}:${passage.span}`}
      </span>
      {passage.sourceVersion !== "" ? (
        <span className="kb-chip-ver">{passage.sourceVersion}</span>
      ) : null}
      <span className="kb-chip-score num">{formatScore(passage.score)}</span>
      {passage.stale ? (
        <span className="kb-chip-stale">
          <IconClock />
          {note.staleSince === null ? "stale" : `stale · since ${note.staleSince}`}
        </span>
      ) : null}
      {note.supersededBy !== null ? (
        <span className="kb-chip-superseded">{`superseded by ${note.supersededBy}`}</span>
      ) : null}
      {note.missing ? <span className="kb-chip-missing">not in the current corpus</span> : null}
      {note.canonical === false ? (
        <span className="kb-chip-draft">not team-canonical</span>
      ) : null}
    </span>
  );
}

export type KbAnswerListProps = {
  /** The query that produced `passages`; null before the first ask. */
  asked: string | null;
  /** null while nothing has been asked (or the last ask failed outright). */
  passages: readonly KbPassage[] | null;
  /** The selected domain's corpus listing, for reference annotation. */
  documents: readonly KbDocument[];
  busy: boolean;
  error: string | null;
  degraded: boolean;
};

/**
 * The answer surface: one article per passage, each headed by its source chip.
 * Exported so tests render fixed passages without the fetch layer.
 */
export function KbAnswerList({
  asked,
  passages,
  documents,
  busy,
  error,
  degraded,
}: KbAnswerListProps) {
  const latest = useMemo(() => latestVersionMap(documents), [documents]);

  if (busy) {
    return (
      <p className="kb-status" role="status">
        <IconRefresh className="spin" />
        <span>Searching the corpus…</span>
      </p>
    );
  }

  if (error !== null) {
    return (
      <p className="kb-error" role="alert">
        <IconAlert />
        <span>{error}</span>
      </p>
    );
  }

  if (passages === null) {
    return (
      <p className="kb-hint">
        Ask a question to see the passages a run would ground on, each with its source
        chip.
      </p>
    );
  }

  return (
    <>
      {degraded ? (
        <p className="kb-error kb-degraded" role="alert">
          <IconAlert />
          <span>The retrieval index answered degraded — results may be incomplete.</span>
        </p>
      ) : null}

      {passages.length === 0 ? (
        <p className="kb-hint">
          No passages matched{asked === null ? "" : ` "${asked}"`} — reword it, or flip the
          team-canonical toggle.
        </p>
      ) : (
        <>
          <p className="kb-status">
            <span>{`${passages.length} passage${
              passages.length === 1 ? "" : "s"
            } for "${asked ?? ""}"`}</span>
          </p>
          <div className="kb-answers" aria-label="Cited passages">
            {passages.map((passage, index) => (
              <article
                key={`${passage.sourceId}:${passage.span}:${index}`}
                className="kb-answer anim-fade-up"
                style={{ "--i": index } as CSSProperties}
              >
                <header className="kb-answer-head">
                  <KbSourceChip
                    passage={passage}
                    note={annotatePassage(passage, latest, documents)}
                  />
                </header>
                <p className="kb-answer-text">{passage.text}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export type KbCorpusListProps = {
  domain: string;
  /** null while loading. */
  documents: readonly KbDocument[] | null;
  failed: string | null;
};

/**
 * The corpus listing: every ingested version per source with its chunks and
 * review horizon. Versions behind the latest for their source render as
 * superseded, the same reference check the answer chips apply.
 */
export function KbCorpusList({ domain, documents, failed }: KbCorpusListProps) {
  const latest = useMemo(() => latestVersionMap(documents ?? []), [documents]);
  return (
    <section className="kb-section" aria-label={`Corpus in ${domain}`}>
      <header className="kb-section-head">
        <h3 className="kb-section-title">{`Corpus · ${domain}`}</h3>
        {documents !== null && documents.length > 0 ? (
          <span className="sprint-badge">{`${documents.length} version${
            documents.length === 1 ? "" : "s"
          }`}</span>
        ) : null}
      </header>

      {failed !== null ? (
        <p className="kb-error" role="alert">
          <IconAlert />
          <span>{failed}</span>
        </p>
      ) : documents === null ? (
        <div className="kb-docs" role="status" aria-label="Loading the corpus">
          {Array.from({ length: KB_SKELETON_ROWS }, (_, index) => (
            <div key={index} className="skeleton kb-doc-skeleton" />
          ))}
        </div>
      ) : documents.length === 0 ? (
        <p className="kb-hint">
          {`Nothing is ingested in ${domain} yet — upload a document below to seed it.`}
        </p>
      ) : (
        <div className="kb-docs">
          {documents.map((document, index) => {
            const latestDoc = latest.get(document.sourceId);
            const superseded =
              latestDoc !== undefined && latestDoc.sourceVersion !== document.sourceVersion;
            return (
              <article
                key={`${document.sourceId}@${document.sourceVersion}`}
                className="kb-doc-row anim-fade-up"
                style={{ "--i": index } as CSSProperties}
              >
                <header className="kb-doc-head">
                  <strong className="kb-doc-title">{document.title}</strong>
                  <span className="kb-chip-ver">{document.sourceVersion}</span>
                  {superseded && latestDoc !== undefined ? (
                    <span className="kb-chip-superseded">{`superseded by ${latestDoc.sourceVersion}`}</span>
                  ) : null}
                  {document.canonical ? (
                    <span className="kb-chip-canon">team-canonical</span>
                  ) : (
                    <span className="kb-chip-draft">draft</span>
                  )}
                  {document.stale ? (
                    <span className="kb-chip-stale">
                      <IconClock />
                      {staleSinceLabel(document)}
                    </span>
                  ) : null}
                </header>
                <p className="kb-doc-meta">
                  <span className="kb-doc-source">{document.sourceId}</span>
                  <span className="num">{`${document.chunks} chunk${
                    document.chunks === 1 ? "" : "s"
                  }`}</span>
                  {!document.stale && document.staleAfter !== null ? (
                    <span>{`review by ${formatMonthYear(document.staleAfter)}`}</span>
                  ) : null}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export type KbUploadSectionProps = {
  draft: KbUploadDraft;
  /** Domain options for the picker (existing partitions + suggestions). */
  options: readonly string[];
  canUpload: boolean;
  busy: boolean;
  /** Success note from the last upload. */
  note: string | null;
  /** Validation or API failure for the last submit. */
  error: string | null;
  onField: (patch: Partial<KbUploadDraft>) => void;
  onFile: (file: File) => void;
  onSubmit: () => void;
};

/**
 * Ingest form for the existing store path (versioned rows, re-uploading a
 * version replaces its chunks). Loading a file prefills the draft from its own
 * `# Title` and `Reviewed:` headers; only admins may submit — everyone else
 * sees the hint.
 */
export function KbUploadSection({
  draft,
  options,
  canUpload,
  busy,
  note,
  error,
  onField,
  onFile,
  onSubmit,
}: KbUploadSectionProps) {
  if (!canUpload) {
    return (
      <section className="kb-section" aria-label="Upload a document">
        <header className="kb-section-head">
          <h3 className="kb-section-title">Upload</h3>
        </header>
        <p className="kb-hint" title={ADMIN_HINT}>
          {KB_UPLOAD_HINT}
        </p>
      </section>
    );
  }

  const domainOptions =
    draft.domain === "" || options.includes(draft.domain)
      ? [...options]
      : [draft.domain, ...options];

  return (
    <section className="kb-section" aria-label="Upload a document">
      <header className="kb-section-head">
        <h3 className="kb-section-title">Upload</h3>
        <span className="kb-hint">
          Markdown with a Reviewed: header prefills the review horizon.
        </span>
      </header>

      <form
        className="kb-upload"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="kb-upload-grid">
          <label className="kb-field kb-span-2">
            <span>Document file</span>
            <input
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) onFile(file);
              }}
            />
            {draft.fileName !== "" ? <span className="kb-file-note">{draft.fileName}</span> : null}
          </label>

          <label className="kb-field">
            <span>Domain</span>
            <select
              className="kb-select"
              value={draft.domain}
              disabled={busy}
              onChange={(event) => onField({ domain: event.target.value })}
            >
              {draft.domain === "" ? <option value="">Pick a domain…</option> : null}
              {domainOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="kb-field">
            <span>Source id</span>
            <input
              type="text"
              value={draft.sourceId}
              placeholder="hr_policy/leave-and-time-off.md"
              disabled={busy}
              onChange={(event) => onField({ sourceId: event.target.value })}
            />
          </label>

          <label className="kb-field">
            <span>Title</span>
            <input
              type="text"
              value={draft.title}
              disabled={busy}
              onChange={(event) => onField({ title: event.target.value })}
            />
          </label>

          <label className="kb-field">
            <span>Version</span>
            <input
              type="text"
              value={draft.sourceVersion}
              disabled={busy}
              onChange={(event) => onField({ sourceVersion: event.target.value })}
            />
          </label>

          <label className="kb-field">
            <span>Stale after</span>
            <input
              type="date"
              value={draft.staleAfter}
              disabled={busy}
              onChange={(event) => onField({ staleAfter: event.target.value })}
            />
          </label>

          <label
            className="kb-toggle"
            title="Canonical documents are the ones the team-canonical toggle keeps citing"
          >
            <input
              type="checkbox"
              checked={draft.canonical}
              disabled={busy}
              onChange={(event) => onField({ canonical: event.target.checked })}
            />
            <span>Team-canonical</span>
          </label>
        </div>

        <label className="kb-field">
          <span>Content</span>
          <textarea
            className="kb-content"
            rows={8}
            value={draft.content}
            placeholder={"# Leave and Time Off\n\nReviewed: 2026-07-01"}
            disabled={busy}
            onChange={(event) => onField({ content: event.target.value })}
          />
        </label>

        <div className="kb-upload-actions">
          <button
            type="submit"
            className="kb-submit"
            disabled={busy}
            title={busy ? "An ingest is already in flight…" : undefined}
          >
            {busy ? <IconRefresh className="spin" /> : <IconPlus />}
            <span>{busy ? "Ingesting…" : "Ingest document"}</span>
          </button>
          <span className="kb-hint">
            Re-uploading the same version replaces its chunks; a new version joins
            alongside and both serve until superseded.
          </span>
        </div>

        {note !== null ? (
          <p className="kb-note" role="status">
            <IconCheckCircle />
            <span>{note}</span>
          </p>
        ) : null}

        {error !== null ? (
          <p className="kb-error" role="alert">
            <IconAlert />
            <span>{error}</span>
          </p>
        ) : null}
      </form>
    </section>
  );
}

/**
 * U5 knowledge page — the corpus behind every grounded answer, per domain:
 * ask the same hybrid-retrieval path the command bar uses, read each passage
 * with its `sourceId:span` chip, and flag stale, superseded, or missing
 * references. The only write is the admin-gated upload, which reuses the
 * store's existing ingest; nothing here executes a run.
 */
export function KnowledgeView({ canUpload = false }: { canUpload?: boolean }) {
  const [tick, setTick] = useState(0);
  const [domainsState, setDomainsState] = useState<KbDomainsState>({ phase: "loading" });
  const [domain, setDomain] = useState("");
  const [canonicalOnly, setCanonicalOnly] = useState(false);
  const [corpusState, setCorpusState] = useState<KbCorpusState>({ phase: "loading" });
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answers, setAnswers] = useState<KbPassage[] | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askDegraded, setAskDegraded] = useState(false);
  const [draft, setDraft] = useState<KbUploadDraft>(() => emptyKbUploadDraft());
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Partitions load on mount and refresh; the picker keeps the current choice
  // when it still exists and falls back to the first option otherwise.
  useEffect(() => {
    let cancelled = false;
    setDomainsState({ phase: "loading" });
    void (async () => {
      try {
        const result = await listKbDomains();
        if (cancelled) return;
        setDomainsState({ phase: "ready", domains: result.domains, configured: result.configured });
        setDomain((current) =>
          current !== "" && kbDomainOptions(result.domains).includes(current)
            ? current
            : defaultKbDomain(result.domains),
        );
      } catch (error) {
        if (!cancelled) setDomainsState({ phase: "error", message: domainsErrorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Corpus listing for the selected domain, versions included.
  useEffect(() => {
    if (domain === "") return;
    let cancelled = false;
    setCorpusState({ phase: "loading" });
    void (async () => {
      try {
        const result = await listKbDocuments(domain);
        if (!cancelled) setCorpusState({ phase: "ready", documents: result.documents });
      } catch (error) {
        if (!cancelled) setCorpusState({ phase: "error", message: corpusErrorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, domain]);

  // Citations are domain-scoped: a domain switch clears the standing answer.
  useEffect(() => {
    setAsked(null);
    setAnswers(null);
    setAskError(null);
    setAskDegraded(false);
  }, [domain]);

  // The upload form follows the console domain until the uploader adds content.
  useEffect(() => {
    if (domain === "") return;
    setDraft((current) => (current.content === "" ? { ...current, domain } : current));
  }, [domain]);

  async function askFor(raw: string, canonical: boolean): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === "" || domain === "" || askBusy) return;
    setAsked(trimmed);
    setAskBusy(true);
    setAskError(null);
    setAskDegraded(false);
    setAnswers(null);
    try {
      const result = await searchKb({ query: trimmed, domain, canonical });
      setAnswers(result.passages);
      setAskDegraded(result.degraded);
    } catch (error) {
      setAskError(askErrorMessage(error));
    } finally {
      setAskBusy(false);
    }
  }

  function ask(): void {
    void askFor(query, canonicalOnly);
  }

  /** Flipping the toggle re-asks the standing question under the new filter. */
  function toggleCanonical(next: boolean): void {
    setCanonicalOnly(next);
    if (asked !== null) void askFor(asked, next);
  }

  async function handleFile(file: File): Promise<void> {
    try {
      const content = await file.text();
      const suggested = suggestUploadMeta(content, file.name, draft.domain);
      setDraft((current) => ({
        ...current,
        content,
        fileName: file.name,
        sourceId: current.sourceId === "" ? (suggested.sourceId ?? "") : current.sourceId,
        title: current.title === "" ? (suggested.title ?? "") : current.title,
        staleAfter: current.staleAfter === "" ? suggested.staleAfter : current.staleAfter,
      }));
    } catch {
      setUploadError("The file could not be read.");
    }
  }

  async function submitUpload(): Promise<void> {
    const errors = validateKbUploadDraft(draft);
    if (errors.length > 0) {
      setUploadNote(null);
      setUploadError(errors[0] ?? "The draft is incomplete.");
      return;
    }
    setUploadBusy(true);
    setUploadError(null);
    setUploadNote(null);
    try {
      const result = await uploadKbDocument({
        domain: draft.domain,
        sourceId: draft.sourceId,
        title: draft.title.trim(),
        content: draft.content,
        sourceVersion: draft.sourceVersion,
        staleAfter: staleAfterIso(draft.staleAfter),
        canonical: draft.canonical,
      });
      setUploadNote(
        `Ingested ${result.sourceId} ${result.sourceVersion} — ${result.chunks} chunk${
          result.chunks === 1 ? "" : "s"
        } in ${result.domain}.`,
      );
      setDraft(emptyKbUploadDraft(draft.domain));
      setTick((value) => value + 1);
    } catch (error) {
      setUploadError(uploadErrorMessage(error));
    } finally {
      setUploadBusy(false);
    }
  }

  const loading = domainsState.phase === "loading";
  const domainOptions = domainsState.phase === "ready" ? kbDomainOptions(domainsState.domains) : [];
  const selectedDomain =
    domainsState.phase === "ready"
      ? domainsState.domains.find((item) => item.domain === domain)
      : undefined;
  const pickerOptions =
    domain === "" || domainOptions.includes(domain) ? domainOptions : [domain, ...domainOptions];
  const corpusDocuments = corpusState.phase === "ready" ? corpusState.documents : null;
  const corpusFailed = corpusState.phase === "error" ? corpusState.message : null;

  return (
    <section id="kb-view" className="panel-view" aria-label="Knowledge base">
      <div className="panel-heading">
        <p className="eyebrow">Grounding</p>
        <h2>Knowledge base</h2>
        <p className="panel-note">
          Ask the same hybrid retrieval the command bar uses, read each passage with its
          source:span chip, and spot references that are stale, superseded, or missing.
          Uploads land team-canonical by default.
        </p>
      </div>

      <div className="kb-toolbar">
        <label className="kb-field kb-field-inline">
          <span>Domain</span>
          <select
            className="kb-select"
            value={domain}
            disabled={domainsState.phase !== "ready"}
            onChange={(event) => setDomain(event.target.value)}
          >
            {domain === "" ? <option value="">…</option> : null}
            {pickerOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="kb-toggle" title="Keep only documents flagged team-canonical">
          <input
            type="checkbox"
            checked={canonicalOnly}
            disabled={domainsState.phase !== "ready" || domain === ""}
            onChange={(event) => toggleCanonical(event.target.checked)}
          />
          <span>Team-canonical only</span>
        </label>

        {selectedDomain !== undefined ? (
          <span className="sprint-badge">
            {`${selectedDomain.documents} doc${
              selectedDomain.documents === 1 ? "" : "s"
            } · ${selectedDomain.stale} stale · ${selectedDomain.canonical} canonical`}
          </span>
        ) : null}

        <button
          type="button"
          className="wf-secondary"
          disabled={loading}
          onClick={() => setTick((value) => value + 1)}
        >
          <IconRefresh className={loading ? "spin" : undefined} />
          Refresh
        </button>
      </div>

      {domainsState.phase === "loading" && (
        <div className="kb-docs" role="status" aria-label="Loading the knowledge partitions">
          {Array.from({ length: KB_SKELETON_ROWS }, (_, index) => (
            <div key={index} className="skeleton kb-doc-skeleton" />
          ))}
        </div>
      )}

      {domainsState.phase === "error" && (
        <div className="view-hold" role="alert">
          <IconAlert />
          <strong>Knowledge base unavailable</strong>
          <p>{domainsState.message}</p>
          <button
            type="button"
            className="wf-secondary"
            onClick={() => setTick((value) => value + 1)}
          >
            <IconRefresh />
            Retry
          </button>
        </div>
      )}

      {domainsState.phase === "ready" && !domainsState.configured && (
        <div className="view-hold">
          <IconInfo />
          <strong>Knowledge storage is not configured</strong>
          <p>
            This deployment has no retrieval store wired (KNOWLEDGE_SERVICE_TOKEN and
            embeddings are both required), so domains, corpus, and answers stay empty.
          </p>
        </div>
      )}

      {domainsState.phase === "ready" && domainsState.configured && domain !== "" && (
        <>
          <section className="kb-section" aria-label="Ask the corpus">
            <header className="kb-section-head">
              <h3 className="kb-section-title">Ask the corpus</h3>
              <span className="kb-hint">
                Citations read source:span, the same shape run receipts use.
              </span>
            </header>
            <div className="kb-ask-row">
              <input
                className="kb-ask-input"
                type="text"
                value={query}
                placeholder="How many days of annual leave do we accrue?"
                disabled={askBusy}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") ask();
                }}
              />
              <button
                type="button"
                className="kb-submit"
                disabled={askBusy || query.trim() === ""}
                title={askBusy ? "A search is already in flight…" : undefined}
                onClick={ask}
              >
                <IconSearch />
                <span>Ask</span>
              </button>
            </div>
            <KbAnswerList
              asked={asked}
              passages={answers}
              documents={corpusDocuments ?? []}
              busy={askBusy}
              error={askError}
              degraded={askDegraded}
            />
          </section>

          <KbCorpusList domain={domain} documents={corpusDocuments} failed={corpusFailed} />

          <KbUploadSection
            draft={draft}
            options={domainOptions}
            canUpload={canUpload}
            busy={uploadBusy}
            note={uploadNote}
            error={uploadError}
            onField={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            onFile={(file) => void handleFile(file)}
            onSubmit={() => void submitUpload()}
          />
        </>
      )}
    </section>
  );
}
