"use client";

import { useState } from "react";

import { safeBrowseUrl } from "@/lib/board";

import { IconCheck, IconCopy, IconExternalLink } from "./icons";
import { JsonView } from "./JsonView";

/**
 * Humanizes structured payloads for the case/gate views: flat objects become
 * labeled definition rows, dates get local + relative hints, https links stay
 * inert until clicked, status-like values become tone badges, and anything the
 * shapes below cannot express falls back to a JsonView "Raw" tree. Values are
 * rendered as inert text only — no markup is ever injected.
 */

/** Containers render up to this depth; deeper shapes switch to the raw tree. */
const MAX_DEPTH = 2;

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Git SHAs (40), sha256 content hashes (64) and similar digests collapse to a chip. */
const HEX_DIGEST = /^[0-9a-f]{32,}$/i;
/** Long opaque ids (uuid run ids, receipts, paths) that should wrap as mono code. */
const OPAQUE_TOKEN = /^(?=[^0-9]*\d)[A-Za-z0-9][\w.:/-]{23,}$/;

type Tone = "good" | "warn" | "bad" | "info" | "muted";

const STATUS_TONES: Record<string, Tone> = {
  approved: "good",
  ok: "good",
  passed: "good",
  succeeded: "good",
  success: "good",
  completed: "good",
  done: "good",
  merged: "good",
  ready: "good",
  pending: "warn",
  queued: "warn",
  waiting: "warn",
  draft: "warn",
  scheduled: "warn",
  running: "info",
  in_progress: "info",
  awaiting_human: "info",
  open: "info",
  rejected: "bad",
  denied: "bad",
  failed: "bad",
  failure: "bad",
  error: "bad",
  blocked: "bad",
  cancelled: "bad",
  canceled: "bad",
  closed: "muted",
  skipped: "muted",
};

const ACRONYMS: Record<string, string> = { pr: "PR", url: "URL", id: "ID", sha: "SHA", api: "API" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== "object";
}

function humanizeKey(key: string): string {
  const acronym = ACRONYMS[key.toLowerCase()];
  if (acronym !== undefined) return acronym;
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseIso(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function relativeLabel(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const future = diffMs > 0;
  const seconds = Math.round(Math.abs(diffMs) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return future ? `in ${months}mo` : `${months}mo ago`;
  const years = Math.round(months / 12);
  return future ? `in ${years}y` : `${years}y ago`;
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return String(value);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access can be denied; the value stays selectable either way.
    }
  }

  return (
    <button
      type="button"
      className="payload-copy"
      title={label}
      aria-label={label}
      onClick={() => void copy()}
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

function RawToggle({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="payload-raw">
      <button
        type="button"
        className="payload-raw-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Hide raw" : "Raw"}
      </button>
      {open && <JsonView value={value} />}
    </div>
  );
}

function PayloadString({ value }: { value: string }) {
  const date = parseIso(value);
  if (date !== null) {
    return (
      <span className="payload-date">
        <time dateTime={value}>{date.toLocaleString()}</time>
        <span className="payload-rel">{relativeLabel(date)}</span>
      </span>
    );
  }
  if (value.startsWith("https://")) {
    const href = safeBrowseUrl(value);
    if (href !== "#") {
      return (
        <a className="payload-link" href={href} target="_blank" rel="noopener noreferrer">
          {value}
          <IconExternalLink />
        </a>
      );
    }
  }
  if (HEX_DIGEST.test(value)) {
    return (
      <span className="payload-sha">
        <code title={value}>{value.slice(0, 7)}</code>
        <CopyButton text={value} label="Copy hash" />
      </span>
    );
  }
  const tone = STATUS_TONES[value.toLowerCase()];
  if (tone !== undefined) {
    return <span className={`payload-badge tone-${tone}`}>{value}</span>;
  }
  if (OPAQUE_TOKEN.test(value)) {
    return <code className="payload-code" title={value}>{value}</code>;
  }
  return <span className="payload-text">{value}</span>;
}

function PayloadScalar({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="payload-null">—</span>;
  if (typeof value === "boolean") {
    return (
      <span className={`payload-badge tone-${value ? "good" : "muted"}`}>{String(value)}</span>
    );
  }
  if (typeof value === "number") return <span className="payload-num">{String(value)}</span>;
  if (typeof value === "string") return <PayloadString value={value} />;
  return <span className="payload-null">{String(value)}</span>;
}

function PayloadCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="payload-null">—</span>;
  if (typeof value === "number") return <span className="payload-num">{String(value)}</span>;
  if (typeof value === "boolean") {
    return (
      <span className={`payload-badge tone-${value ? "good" : "muted"}`}>{String(value)}</span>
    );
  }
  const text = String(value);
  const tone = STATUS_TONES[text.toLowerCase()];
  if (tone !== undefined) return <span className={`payload-badge tone-${tone}`}>{text}</span>;
  return <span className="payload-text">{text}</span>;
}

function PayloadChips({ values }: { values: unknown[] }) {
  return (
    <span className="payload-chips">
      {values.map((item, index) => (
        <span key={index} className="payload-chip" title={scalarText(item)}>
          {scalarText(item)}
        </span>
      ))}
    </span>
  );
}

function PayloadTable({
  items,
  columns,
}: {
  items: Array<Record<string, unknown>>;
  columns: string[];
}) {
  return (
    <div className="payload-table-wrap">
      <table className="payload-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{humanizeKey(column)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column}>
                  <PayloadCell value={item[column]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Common keys that stay scalar across every row; null when a table would lie. */
function scalarColumns(items: Array<Record<string, unknown>>): string[] | null {
  if (items.length === 0) return null;
  const keysOf = (item: Record<string, unknown>) => new Set(Object.keys(item));
  let common = keysOf(items[0]!);
  for (const item of items) {
    const keys = keysOf(item);
    common = new Set([...common].filter((key) => keys.has(key)));
  }
  const columns = [...common].filter((key) =>
    items.every((item) => isScalar(item[key])),
  );
  if (columns.length === 0 || columns.length > 6) return null;
  return columns;
}

function PayloadCards({ items, depth }: { items: Array<Record<string, unknown>>; depth: number }) {
  return (
    <div className="payload-cards">
      {items.map((item, index) => (
        <div key={index} className="payload-card">
          <PayloadFields value={item} depth={depth} />
        </div>
      ))}
    </div>
  );
}

function PayloadValue({ value, depth }: { value: unknown; depth: number }) {
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return <RawToggle value={value} />;
    if (value.length === 0) return <span className="payload-null">empty list</span>;
    if (value.every((item) => isScalar(item))) return <PayloadChips values={value} />;
    if (value.every((item) => isPlainObject(item))) {
      const objects = value as Array<Record<string, unknown>>;
      const columns = scalarColumns(objects);
      if (columns !== null) return <PayloadTable items={objects} columns={columns} />;
      return <PayloadCards items={objects} depth={depth + 1} />;
    }
    return <RawToggle value={value} />;
  }
  if (isPlainObject(value)) {
    if (depth >= MAX_DEPTH) return <RawToggle value={value} />;
    if (Object.keys(value).length === 0) return <span className="payload-null">empty object</span>;
    return (
      <div className="payload-nested">
        <PayloadFields value={value} depth={depth + 1} />
      </div>
    );
  }
  return <PayloadScalar value={value} />;
}

function PayloadFields({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  return (
    <dl className="payload-fields">
      {Object.entries(value).map(([key, item]) => {
        const stacked = typeof item === "object" && item !== null;
        return (
          <div key={key} className={stacked ? "payload-row stacked" : "payload-row"}>
            <dt className="payload-label" title={key}>
              {humanizeKey(key)}
            </dt>
            <dd className="payload-value">
              <PayloadValue value={item} depth={depth} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function PayloadView({ value, className }: { value: unknown; className?: string }) {
  if (!isPlainObject(value)) {
    return <JsonView value={value} className={className} />;
  }
  const classes = className === undefined ? "payload-view" : `payload-view ${className}`;
  if (Object.keys(value).length === 0) {
    return (
      <div className={classes}>
        <p className="payload-null">Empty payload</p>
      </div>
    );
  }
  return (
    <div className={classes}>
      <PayloadFields value={value} depth={0} />
    </div>
  );
}
