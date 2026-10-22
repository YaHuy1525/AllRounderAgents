"use client";

import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";

import {
  brokenPillRefs,
  insertPillToken,
  pillBrokenCopy,
  pillChipLabel,
  pillTokens,
  replacePillToken,
  stripPillTrigger,
  suggestPills,
  type PillToken,
  type RunPill,
} from "@/lib/pills";

/**
 * Data pills (N3): a textarea that understands the `{{ref}}` token protocol.
 *
 * Typing `@` opens a picker of earlier outputs; choosing one inserts a token.
 * The chip strip shows what the text references, and any token the catalog no
 * longer offers turns red with a re-map affordance, mirroring the API's own
 * rejection ("Field no longer exists — re-map"). The component never resolves
 * values itself; resolution happens server-side when the decision is recorded.
 */

export type PillTextAreaProps = {
  /** Raw text, `{{ref}}` tokens included. */
  value: string;
  onChange: (value: string) => void;
  /**
   * Picker catalog from `GET /runs/{id}/pills`. `undefined` means the catalog
   * is not loaded yet, so unknown refs render neutral instead of broken.
   */
  pills?: readonly RunPill[];
  /** Visible field label; ranks the Suggested pills for this field. */
  fieldLabel?: string;
  disabled?: boolean;
  maxLength?: number;
  rows?: number;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  /** Extra class for the wrapping element. */
  className?: string;
  /** Extra class for the textarea itself. */
  textareaClassName?: string;
};

export type PillPickerListProps = {
  pills: readonly RunPill[];
  fieldLabel?: string;
  onPick?: (pill: RunPill) => void;
};

function pickerRow(pill: RunPill, onPick?: (pill: RunPill) => void) {
  return (
    <button
      key={pill.ref}
      type="button"
      className="pill-picker-row"
      title={pill.ref}
      disabled={onPick === undefined}
      onClick={() => onPick?.(pill)}
    >
      <span className="pill-picker-label">{pill.label}</span>
      <span className="pill-picker-preview">{pill.preview}</span>
      <span className="pill-picker-kind">{pill.kind}</span>
    </button>
  );
}

/** The grouped picker body, split out so tests can render it standalone. */
export function PillPickerList({ pills, fieldLabel = "", onPick }: PillPickerListProps) {
  const suggestions = suggestPills(fieldLabel, pills);
  const suggested = new Set(suggestions.map((pill) => pill.ref));
  const groups = new Map<string, RunPill[]>();
  for (const pill of pills) {
    if (suggested.has(pill.ref)) continue;
    const bucket = groups.get(pill.groupTitle);
    if (bucket === undefined) groups.set(pill.groupTitle, [pill]);
    else bucket.push(pill);
  }
  if (pills.length === 0) {
    return (
      <p className="pill-picker-empty">No earlier outputs are available for this step yet.</p>
    );
  }
  return (
    <div className="pill-picker-list">
      {suggestions.length > 0 ? (
        <div className="pill-picker-group">
          <div className="pill-picker-group-title">Suggested for this field</div>
          {suggestions.map((pill) => pickerRow(pill, onPick))}
        </div>
      ) : null}
      {[...groups.entries()].map(([title, items]) => (
        <div className="pill-picker-group" key={title}>
          <div className="pill-picker-group-title">{title}</div>
          {items.map((pill) => pickerRow(pill, onPick))}
        </div>
      ))}
    </div>
  );
}

export function PillTextArea({
  value,
  onChange,
  pills,
  fieldLabel = "",
  disabled = false,
  maxLength,
  rows,
  placeholder,
  id,
  ariaLabel,
  className,
  textareaClassName,
}: PillTextAreaProps) {
  const catalog = pills ?? [];
  const catalogKnown = pills !== undefined;
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [remap, setRemap] = useState<PillToken | null>(null);
  const caretRef = useRef<number | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const tokens = useMemo(() => pillTokens(value), [value]);
  const byRef = useMemo(
    () => new Map(catalog.map((pill) => [pill.ref, pill] as const)),
    [catalog],
  );
  const broken = useMemo(
    () => (catalogKnown ? brokenPillRefs(value, catalog) : []),
    [catalogKnown, value, catalog],
  );
  const pickerOpen = insertAt !== null || remap !== null;

  const closePicker = () => {
    setInsertAt(null);
    setRemap(null);
  };

  const focusWithCaret = (caret: number) => {
    const node = areaRef.current;
    if (node === null) return;
    node.focus();
    // One frame later the controlled value has landed; move the caret too.
    window.requestAnimationFrame(() => {
      try {
        node.setSelectionRange(caret, caret);
      } catch {
        // Detached node (never happens in practice) — the caret stays put.
      }
    });
  };

  const trackCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    caretRef.current = event.currentTarget.selectionStart;
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.currentTarget.value;
    const caret = event.currentTarget.selectionStart ?? next.length;
    caretRef.current = caret;
    onChange(next);
    // Typing `@` opens the picker right behind the caret.
    if (caret > 0 && next.length > value.length && next.charAt(caret - 1) === "@") {
      setRemap(null);
      setInsertAt(caret - 1);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && pickerOpen) closePicker();
  };

  const pick = (pill: RunPill) => {
    if (remap !== null) {
      const next = replacePillToken(value, remap, pill.ref);
      onChange(next.text);
      caretRef.current = next.caret;
      focusWithCaret(next.caret);
    } else if (insertAt !== null) {
      let base = value;
      let at = insertAt;
      const caret = caretRef.current ?? insertAt;
      if (caret > at + 1 && base.charAt(at) === "@") {
        // The user kept typing a query after `@`; consume it with the trigger.
        base = base.slice(0, at) + base.slice(caret);
      } else {
        const stripped = stripPillTrigger(base, at);
        base = stripped.text;
        at = stripped.caret;
      }
      const next = insertPillToken(base, pill.ref, at);
      onChange(next.text);
      caretRef.current = next.caret;
      focusWithCaret(next.caret);
    }
    closePicker();
  };

  const openPickerAtCaret = () => {
    if (insertAt !== null || remap !== null) {
      closePicker();
      return;
    }
    const at = Math.min(Math.max(caretRef.current ?? value.length, 0), value.length);
    setInsertAt(at);
  };

  const openRemap = (token: PillToken) => {
    setInsertAt(null);
    setRemap(token);
  };

  return (
    <div className={className ? `pill-field ${className}` : "pill-field"}>
      {tokens.length > 0 ? (
        <div className="pill-chips" aria-label="Data pills in this field">
          {tokens.map((token) => {
            const pill = byRef.get(token.ref);
            const key = `${token.ref}:${token.start}`;
            if (pill === undefined && catalogKnown) {
              if (disabled) {
                return (
                  <span
                    key={key}
                    className="pill-chip broken"
                    title={`{{${token.ref}}} — no longer exists`}
                  >
                    {token.ref}
                  </span>
                );
              }
              return (
                <button
                  key={key}
                  type="button"
                  className="pill-chip broken"
                  title={`{{${token.ref}}} — field no longer exists, re-map it`}
                  onClick={() => openRemap(token)}
                >
                  {token.ref}
                </button>
              );
            }
            if (pill === undefined) {
              // Catalog not loaded: show the ref, but do not accuse it yet.
              return (
                <span key={key} className="pill-chip kind-text" title={token.ref}>
                  {token.ref}
                </span>
              );
            }
            return (
              <span
                key={key}
                className={`pill-chip kind-${pill.kind}`}
                title={`{{${pill.ref}}} · ${pill.preview}`}
              >
                {pillChipLabel(pill)}
              </span>
            );
          })}
        </div>
      ) : null}
      <textarea
        ref={areaRef}
        id={id}
        className={textareaClassName ? `pill-textarea ${textareaClassName}` : "pill-textarea"}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={trackCaret}
        onClick={trackCaret}
        onSelect={trackCaret}
        disabled={disabled}
        maxLength={maxLength}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      {broken.length > 0 ? <p className="pill-note">{pillBrokenCopy(broken)}</p> : null}
      {disabled ? null : (
        <div className="pill-toolbar">
          <button
            type="button"
            className="pill-insert"
            aria-expanded={insertAt !== null}
            onClick={openPickerAtCaret}
          >
            @ Insert pill
          </button>
          {tokens.length === 0 && catalog.length > 0 ? (
            <span className="pill-hint">Type @ to insert an output from an earlier step.</span>
          ) : null}
        </div>
      )}
      {pickerOpen && !disabled ? (
        <div className="pill-picker" aria-label="Data pill picker">
          <div className="pill-picker-head">
            {remap !== null ? (
              <span>Re-map {`{{${remap.ref}}}`} — field no longer exists</span>
            ) : (
              <span>Insert a data pill</span>
            )}
          </div>
          <PillPickerList pills={catalog} fieldLabel={fieldLabel} onPick={pick} />
        </div>
      ) : null}
    </div>
  );
}
