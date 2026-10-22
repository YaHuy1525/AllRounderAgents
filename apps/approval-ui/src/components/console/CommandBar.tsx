"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  commandTarget,
  mergeSearchHits,
  searchConsole,
  ticketHits,
  type SearchHit,
  type SearchHitKind,
  type SearchResponse,
} from "@/lib/search";

import {
  IconAlert,
  IconApprovals,
  IconBoard,
  IconClock,
  IconPlay,
  IconSearch,
  IconShield,
} from "./icons";

/**
 * The command bar (upgrade U1): press `/` anywhere and a wide input drops
 * down. Queries resolve through the read-only `GET /search` route plus the
 * board list the console already holds; every result is a deep link that
 * opens a ticket/step or a run. The bar has no execution path — approving,
 * proceeding, and starting always stay in the existing action bars.
 */

/** The pinned vocabulary from the upgrade guide; one click runs the query. */
export const SAVED_QUERIES: readonly string[] = [
  "which tickets wait on me?",
  "what's blocked?",
  "what is overdue?",
];

const DEBOUNCE_MS = 250;

const KIND_LABELS: Record<SearchHitKind, string> = {
  run: "Run",
  approval: "Approval",
  receipt: "Receipt",
  ticket: "Ticket",
};

export type CommandRow =
  | { kind: "suggestion"; key: string; query: string }
  | { kind: "hit"; key: string; hit: SearchHit };

export type CommandStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; response: SearchResponse }
  | { kind: "error" };

function KindIcon({ kind }: { kind: SearchHitKind }) {
  if (kind === "ticket") return <IconBoard />;
  if (kind === "receipt") return <IconShield />;
  if (kind === "approval") return <IconApprovals />;
  return <IconPlay />;
}

/** Row movement shared by the input's arrow keys and mouse hover. */
export function moveCommandCursor(current: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return 0;
  if (current < 0) return direction === 1 ? 0 : length - 1;
  return Math.min(Math.max(current + direction, 0), length - 1);
}

/**
 * Presentational result list — exported so the render-to-string tests can
 * assert the bar only ever renders navigation, never decision controls.
 */
export function CommandResults({
  query,
  status,
  rows,
  cursor,
  onActivate,
  onHover,
}: {
  query: string;
  status: CommandStatus;
  rows: CommandRow[];
  cursor: number;
  onActivate: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const trimmed = query.trim();
  if (trimmed === "") {
    return (
      <div className="command-results" role="listbox" aria-label="Saved and recent queries">
        <p className="command-section-title">Saved</p>
        {SAVED_QUERIES.map((saved, index) => (
          <button
            key={saved}
            type="button"
            role="option"
            aria-selected={cursor === index}
            className={cursor === index ? "command-row command-row-active" : "command-row"}
            onClick={() => onActivate(index)}
            onMouseEnter={() => onHover(index)}
          >
            <span className="command-kind">
              <IconSearch />
            </span>
            <span className="command-hit-main">
              <span className="command-hit-title">{saved}</span>
              <span className="command-hit-sub">Saved query</span>
            </span>
          </button>
        ))}
        <p className="command-section-title">
          <IconClock /> Recent
        </p>
        {rows.length === 0 ? (
          <p className="command-empty">Type a question or a ticket key to search.</p>
        ) : (
          rows.map((row, index) => (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={cursor === SAVED_QUERIES.length + index}
              className={
                cursor === SAVED_QUERIES.length + index
                  ? "command-row command-row-active"
                  : "command-row"
              }
              onClick={() => onActivate(SAVED_QUERIES.length + index)}
              onMouseEnter={() => onHover(SAVED_QUERIES.length + index)}
            >
              <span className="command-kind">
                <IconClock />
              </span>
              <span className="command-hit-main">
                <span className="command-hit-title">
                  {row.kind === "suggestion" ? row.query : row.hit.title}
                </span>
                <span className="command-hit-sub">Recent query</span>
              </span>
            </button>
          ))
        )}
      </div>
    );
  }
  if (status.kind === "loading" || status.kind === "idle") {
    return (
      <div className="command-results">
        <p className="command-empty" role="status">
          <span className="spinner" aria-hidden="true" />
          Searching…
        </p>
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <div className="command-results">
        <p className="command-empty">
          <IconAlert /> Search is unavailable right now. Try again in a moment.
        </p>
      </div>
    );
  }
  const hitRows = rows.filter((row): row is Extract<CommandRow, { kind: "hit" }> =>
    row.kind === "hit",
  );
  return (
    <div className="command-results" role="listbox" aria-label="Search results">
      {hitRows.length === 0 ? (
        <p className="command-empty">{`No matches for “${trimmed}”.`}</p>
      ) : (
        hitRows.map((row, index) => (
          <button
            key={row.key}
            type="button"
            role="option"
            aria-selected={cursor === index}
            className={cursor === index ? "command-row command-row-active" : "command-row"}
            onClick={() => onActivate(index)}
            onMouseEnter={() => onHover(index)}
          >
            <span className="command-kind">
              <KindIcon kind={row.hit.kind} />
            </span>
            <span className="command-hit-main">
              <span className="command-hit-title">
                {row.hit.title}
                <span className="command-hit-badge">{KIND_LABELS[row.hit.kind]}</span>
              </span>
              <span className="command-hit-sub">
                {row.hit.ticketKey !== null ? `${row.hit.ticketKey} · ` : ""}
                {row.hit.stepId !== null ? `step ${row.hit.stepId} · ` : ""}
                {row.hit.subtitle}
              </span>
              {row.hit.reason !== null && <span className="command-hit-reason">{row.hit.reason}</span>}
              {row.hit.logLine !== null && (
                <code className="command-hit-log">{row.hit.logLine}</code>
              )}
              {row.hit.snippet !== "" && (
                <span className="command-hit-snippet">{row.hit.snippet}</span>
              )}
            </span>
          </button>
        ))
      )}
      {status.response.kb.length > 0 && (
        <>
          <p className="command-section-title">Knowledge</p>
          {status.response.kb.map((passage) => (
            <article key={`${passage.sourceId}:${passage.span}`} className="command-kb-card">
              <header>
                <span className="command-kb-source">{passage.title}</span>
                <span className="command-kb-span">
                  {passage.span}
                  {passage.stale ? <span className="command-kb-stale">stale</span> : null}
                </span>
              </header>
              <p>{passage.text}</p>
            </article>
          ))}
        </>
      )}
      {status.response.kbDegraded && (
        <p className="command-empty">
          <IconAlert /> Knowledge search is degraded — showing runs and tickets only.
        </p>
      )}
    </div>
  );
}

/**
 * Shell around the input: overlay, debounce, keyboard cursor, and the
 * activate/remember flow. Mounted once by the Console; `open` toggles it.
 */
export function CommandBar({
  open,
  tickets,
  recent,
  onClose,
  onRemember,
  onNavigate,
}: {
  open: boolean;
  tickets: readonly { key: string; summary: string }[];
  recent: readonly string[];
  onClose: () => void;
  onRemember: (query: string) => void;
  /** Deep-link navigation only; the console owns what "open" means. */
  onNavigate: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<CommandStatus>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setStatus({ kind: "idle" });
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed === "") {
      setStatus({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setStatus({ kind: "loading" });
    const timer = window.setTimeout(() => {
      void searchConsole(trimmed).then(
        (response) => {
          if (!cancelled) setStatus({ kind: "ready", response });
        },
        () => {
          if (!cancelled) setStatus({ kind: "error" });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const mergedHits = useMemo(() => {
    if (status.kind !== "ready") return [];
    return mergeSearchHits(status.response.results, ticketHits(query, tickets));
  }, [query, status, tickets]);

  const rows = useMemo<CommandRow[]>(() => {
    if (query.trim() === "") {
      return recent.map((item) => ({ kind: "suggestion", key: `recent:${item}`, query: item }));
    }
    return mergedHits.map((hit) => ({ kind: "hit", key: `${hit.kind}:${hit.id}`, hit }));
  }, [query, recent, mergedHits]);

  const rowCount =
    query.trim() === "" ? SAVED_QUERIES.length + rows.length : rows.length;

  function activate(index: number): void {
    if (query.trim() === "") {
      if (index < SAVED_QUERIES.length) {
        setQuery(SAVED_QUERIES[index] ?? "");
        setCursor(0);
        return;
      }
      const suggestion = rows[index - SAVED_QUERIES.length];
      if (suggestion !== undefined && suggestion.kind === "suggestion") {
        setQuery(suggestion.query);
        setCursor(0);
      }
      return;
    }
    const row = rows[index];
    if (row === undefined || row.kind !== "hit") return;
    const target = commandTarget(row.hit);
    if (target === null) return;
    onRemember(query.trim());
    onNavigate(row.hit);
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((current) => moveCommandCursor(current, rowCount, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((current) => moveCommandCursor(current, rowCount, -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(cursor);
    }
  }

  if (!open) return null;
  return (
    <div
      className="command-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="command-bar" role="dialog" aria-modal="true" aria-label="Command bar">
        <header className="command-input-row">
          <IconSearch />
          <input
            ref={inputRef}
            className="command-input"
            type="search"
            value={query}
            placeholder="Search tickets, runs, receipts — or ask why something is blocked…"
            aria-label="Search everything"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <kbd className="command-kbd">Esc</kbd>
        </header>
        <CommandResults
          query={query}
          status={status}
          rows={rows}
          cursor={cursor}
          onActivate={activate}
          onHover={setCursor}
        />
        <footer className="command-foot">
          <span>Enter opens the highlighted result</span>
          {status.kind === "ready" && (
            <span className="command-counts">
              {`${status.response.counts.runs} run hits · ${status.response.counts.approvals} approvals`}
            </span>
          )}
          <span className="command-foot-note">Navigation only — decisions stay in the run action bar</span>
        </footer>
      </section>
    </div>
  );
}
