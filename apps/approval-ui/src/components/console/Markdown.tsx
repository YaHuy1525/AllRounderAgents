import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders model/board prose as formatted markdown inside the console design.
 * Raw HTML stays inert text — react-markdown never executes it — and only
 * https URLs become anchors, so untrusted server content cannot smuggle
 * markup or active URLs into a summary, review or chat reply.
 */
const ALLOW_HTTPS_ONLY: UrlTransform = (url) => (url.startsWith("https://") ? url : "");

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
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
