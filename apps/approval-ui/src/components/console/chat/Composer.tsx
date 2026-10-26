"use client";

import { type FormEvent, type KeyboardEvent } from "react";

import { IconSend } from "../icons";

/**
 * Plain textarea. Enter sends, Shift+Enter breaks a line, the stop button aborts.
 * There is deliberately no parser anywhere in this file: message intent is the
 * assistant's decision, which is the entire point of the change.
 */
export function Composer({
  value,
  streaming,
  disabled,
  placeholder,
  onChange,
  onSubmit,
  onStop,
}: {
  value: string;
  streaming: boolean;
  disabled: boolean;
  placeholder: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form id="chat-form" className="assistant-input" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="chat-input">
        Message
      </label>
      <textarea
        id="chat-input"
        placeholder={placeholder}
        rows={4}
        maxLength={2000}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="chat-actions">
        {streaming ? (
          <button id="chat-stop" type="button" onClick={onStop}>
            <span>Stop</span>
          </button>
        ) : null}
        <button id="chat-send" type="submit" disabled={disabled || streaming || value.trim() === ""}>
          {streaming ? <span className="spinner on-solid" aria-hidden="true" /> : <IconSend />}
          <span>Send</span>
        </button>
      </div>
    </form>
  );
}
