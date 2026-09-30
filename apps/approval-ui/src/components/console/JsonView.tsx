"use client";

import { useState } from "react";

/**
 * Dependency-free collapsible JSON tree used by the debug drawers and as the
 * raw fallback of PayloadView. Values are rendered as inert text with syntax
 * classes only — nothing is ever injected as markup, and copy uses the
 * clipboard API from an event handler, so the component stays SSR-safe.
 */

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function collectContainerPaths(value: unknown, path: string, into: string[]): void {
  if (!isContainer(value)) return;
  into.push(path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectContainerPaths(item, `${path}.${index}`, into));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    collectContainerPaths(item, `${path}.${key}`, into);
  }
}

function primitiveClassOf(value: unknown): string {
  if (value === null) return "json-null";
  if (typeof value === "string") return "json-string";
  if (typeof value === "number") return "json-number";
  if (typeof value === "boolean") return "json-bool";
  return "json-null";
}

function primitiveText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

type JsonNodeProps = {
  name: string | null;
  value: unknown;
  path: string;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
};

function JsonNode({ name, value, path, depth, collapsed, onToggle }: JsonNodeProps) {
  const indent = { paddingLeft: `${depth * 14}px` };
  if (!isContainer(value)) {
    return (
      <div className="json-row" style={indent}>
        {name !== null && <span className="json-key">{`${name}:`}</span>}
        <span className={primitiveClassOf(value)}>{primitiveText(value)}</span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: Array<[string, unknown]> = isArray
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value);
  const open = !collapsed.has(path);

  return (
    <div className="json-branch">
      <button
        type="button"
        className="json-row json-toggle"
        style={indent}
        aria-expanded={open}
        onClick={() => onToggle(path)}
      >
        <span className={`json-caret${open ? " open" : ""}`} aria-hidden="true" />
        {name !== null && <span className="json-key">{`${name}:`}</span>}
        <span className="json-brace">
          {isArray ? `[ ${entries.length} ]` : `{ ${entries.length} }`}
        </span>
      </button>
      {open && (
        <div className="json-children">
          {entries.map(([key, item]) => (
            <JsonNode
              key={key}
              name={isArray ? null : key}
              value={item}
              path={`${path}.${key}`}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function JsonView({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [copied, setCopied] = useState(false);

  function toggle(path: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function collapseAll(): void {
    const paths: string[] = [];
    collectContainerPaths(value, "", paths);
    setCollapsed(new Set(paths));
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access can be denied; the tree stays readable either way.
    }
  }

  return (
    <div className={className === undefined ? "json-view" : `json-view ${className}`}>
      <div className="json-toolbar">
        <button type="button" className="json-tool" onClick={() => setCollapsed(new Set())}>
          Expand
        </button>
        <button type="button" className="json-tool" onClick={collapseAll}>
          Collapse
        </button>
        <button type="button" className="json-tool" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="json-tree">
        <JsonNode name={null} value={value} path="" depth={0} collapsed={collapsed} onToggle={toggle} />
      </div>
    </div>
  );
}
