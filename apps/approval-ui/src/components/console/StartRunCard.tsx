"use client";

import { useEffect, useRef, useState } from "react";

import { fieldProvenance, missingStartFields, type ChatStartDraft } from "@/lib/chat-start";

import { IconPlus } from "./icons";

/**
 * Confirmable start card for the assistant rail. It renders exactly the
 * fields `GET /workflows` publishes for the drafted workflow — the same list
 * `POST /runs` validates — so the rail cannot collect a shape the server does
 * not accept, and nothing starts until the human presses Start.
 *
 * A prefill answer arrives after the card is mounted, so it replaces the
 * draft rather than the component. Values therefore follow the draft only for
 * fields the operator has not touched yet, and a field shows the record it
 * came from only while it still holds the value that record proved.
 */
export function StartRunCard({
  draft,
  busy,
  onConfirm,
  onDismiss,
}: {
  draft: ChatStartDraft;
  busy: boolean;
  onConfirm: (values: Record<string, string>) => void;
  onDismiss: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(draft.fields.map((field) => [field.id, field.value])),
  );
  // Fields the operator edited: a later prefill must never overwrite one.
  const touched = useRef<Set<string>>(new Set());

  useEffect(() => {
    setValues((current) => {
      let changed = false;
      const next = { ...current };
      for (const field of draft.fields) {
        if (touched.current.has(field.id)) continue;
        if ((next[field.id] ?? "") === field.value) continue;
        next[field.id] = field.value;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [draft]);

  const missing = missingStartFields(draft, values);

  return (
    <div className="chat-start" data-qa="start-card">
      <div className="chat-start-head">
        <IconPlus />
        <strong>{draft.title}</strong>
      </div>
      <p className="chat-start-meta">{`${draft.workflowLabel} · ${draft.ticketKey}`}</p>
      <div className="chat-start-fields">
        {draft.fields.map((field) => {
          const id = `start-${draft.ticketKey}-${field.id}`;
          const value = values[field.id] ?? "";
          const update = (next: string): void => {
            touched.current.add(field.id);
            setValues((current) => ({ ...current, [field.id]: next }));
          };
          // Provenance is shown only while the field still holds the proved
          // value: once the operator edits it, the value is theirs.
          const source = fieldProvenance(field, value);
          return (
            <div key={field.id} className="chat-start-field" data-qa={`start-field-${field.id}`}>
              <label htmlFor={id}>
                {field.label}
                {field.required ? <span aria-hidden="true"> *</span> : null}
              </label>
              {field.kind === "enum" ? (
                <select
                  id={id}
                  data-qa={`start-input-${field.id}`}
                  value={value}
                  onChange={(event) => update(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {field.values.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  data-qa={`start-input-${field.id}`}
                  type={
                    field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"
                  }
                  value={value}
                  placeholder={field.example}
                  onChange={(event) => update(event.target.value)}
                />
              )}
              {field.help ? <p className="chat-start-help">{field.help}</p> : null}
              {source !== "" ? <p className="chat-start-source">{`From ${source}`}</p> : null}
            </div>
          );
        })}
      </div>
      {missing.length > 0 ? (
        <p className="chat-start-missing" data-qa="start-missing">{`Needs: ${missing.join(", ")}`}</p>
      ) : null}
      <div className="chat-start-actions">
        <button
          type="button"
          className="chat-task-create"
          data-qa="start-confirm"
          disabled={busy || missing.length > 0}
          onClick={() => onConfirm(values)}
        >
          {busy ? <span className="spinner on-solid" aria-hidden="true" /> : <IconPlus />}
          <span>Start run</span>
        </button>
        <button type="button" data-qa="start-dismiss" disabled={busy} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
