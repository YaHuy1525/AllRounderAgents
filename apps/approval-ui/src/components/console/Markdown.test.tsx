import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

const MALICIOUS = '<script>alert("xss")</script> & <img src=x onerror=alert(1)>';

describe("Markdown", () => {
  it("formats headings, lists, emphasis, code and gfm tables", () => {
    const html = renderToString(
      <Markdown
        text={"## Heading\n\n- item **bold**\n- `code`\n\n| a | b |\n| - | - |\n| 1 | 2 |"}
      />,
    );
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
  });

  it("keeps raw html inert, allows https links and drops everything else", () => {
    const html = renderToString(
      <Markdown
        text={`${MALICIOUS}\n\n[ok](https://example.com)\n\n[bad](javascript:alert(1))`}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>bad</span>");
  });

  it("renders nothing for blank text and keeps the caller class", () => {
    expect(renderToString(<Markdown text={"   \n  "} />)).toBe("");
    const html = renderToString(<Markdown text="Summary" className="analysis-summary" />);
    expect(html).toContain("md-body analysis-summary");
  });
});
