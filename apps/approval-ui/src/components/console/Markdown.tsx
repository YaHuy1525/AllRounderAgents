"use client";

import { useState, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { IconCheck, IconCopy } from "./icons";

/**
 * Renders model/board prose as formatted markdown inside the console design.
 * Raw HTML stays inert text — react-markdown never executes it — and only
 * https URLs become anchors, so untrusted server content cannot smuggle
 * markup or active URLs into a summary, review or chat reply.
 */
const ALLOW_HTTPS_ONLY: UrlTransform = (url) => (url.startsWith("https://") ? url : "");

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access can be denied; the block stays selectable either way.
    }
  }

  return (
    <button
      type="button"
      className="md-code-copy"
      title={copied ? "Copied" : "Copy code"}
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => void copy()}
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Fenced blocks get a language chip + copy affordance; the original
  // <pre><code> content is rendered untouched underneath. Inline code and
  // raw HTML are unaffected.
  pre: ({ children }) => {
    let language: string | null = null;
    if (isValidElement(children)) {
      const className = (children.props as { className?: string }).className ?? "";
      const match = /language-([\w-]+)/.exec(className);
      if (match?.[1] !== undefined) language = match[1];
    }
    const code = textOf(children).replace(/\n$/, "");
    return (
      <div className="md-code">
        <div className="md-code-head">
          <span className="md-code-lang">{language ?? "code"}</span>
          <CodeCopyButton text={code} />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
  // GFM tables scroll horizontally inside their own frame instead of
  // stretching the surrounding prose.
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  if (text.trim() === "") return null;
  return (
    <div className={className === undefined ? "md-body" : `md-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={COMPONENTS}
        urlTransform={ALLOW_HTTPS_ONLY}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
