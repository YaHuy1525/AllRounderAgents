"use client";

import { useState, type FormEvent } from "react";

import type { AssistantThread } from "@/lib/assistant";

import { IconClose, IconPlus } from "../icons";

/**
 * ChatGPT-style conversation sidebar. Newest first, which the caller's
 * `listThreads()` already guarantees. Rename is inline: clicking the title
 * turns it into the only input on the row, so the affordance needs no icon
 * legend to be discoverable.
 */
export function ThreadList({
  threads,
  selectedId,
  busy,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  threads: AssistantThread[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function submitRename(event: FormEvent<HTMLFormElement>, threadId: string): void {
    event.preventDefault();
    const title = draft.trim();
    setEditing(null);
    if (title !== "") onRename(threadId, title);
  }

  return (
    <nav className="chat-threads" aria-label="Conversations">
      <button type="button" className="chat-thread-new" disabled={busy} onClick={onNew}>
        <IconPlus />
        <span>New chat</span>
      </button>
      {threads.length === 0 ? (
        <p className="chat-thread-empty">No conversations yet.</p>
      ) : (
        <ul>
          {threads.map((thread) => (
            <li key={thread.id} className={thread.id === selectedId ? "chat-thread on" : "chat-thread"}>
              {editing === thread.id ? (
                <form onSubmit={(event) => submitRename(event, thread.id)}>
                  <label className="sr-only" htmlFor={`thread-rename-${thread.id}`}>
                    Conversation title
                  </label>
                  <input
                    id={`thread-rename-${thread.id}`}
                    value={draft}
                    maxLength={60}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => setEditing(null)}
                    autoFocus
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onDoubleClick={() => {
                    setDraft(thread.title);
                    setEditing(thread.id);
                  }}
                  onClick={() => onSelect(thread.id)}
                >
                  <span className="chat-thread-title">{thread.title}</span>
                </button>
              )}
              <button
                type="button"
                className="chat-thread-rename"
                aria-label={`Rename ${thread.title}`}
                disabled={busy || editing !== null}
                onClick={() => {
                  setDraft(thread.title);
                  setEditing(thread.id);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="chat-thread-delete"
                aria-label={`Delete ${thread.title}`}
                disabled={busy || editing !== null}
                onClick={() => onDelete(thread.id)}
              >
                <IconClose />
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
