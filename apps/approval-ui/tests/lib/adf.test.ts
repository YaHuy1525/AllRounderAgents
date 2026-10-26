import { describe, expect, it } from "vitest";

import { adfToMarkdown } from "@/lib/adf";

/** ADF builder matching the seeder's shape: one paragraph per block. */
function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

describe("adfToMarkdown", () => {
  it("renders seeder paragraphs as markdown blocks", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [paragraph("First block."), paragraph("Second block.")],
    };
    expect(adfToMarkdown(adf)).toBe("First block.\n\nSecond block.");
  });

  it("keeps marks, links, bullets and code blocks", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold " },
            { type: "text", text: "strong", marks: [{ type: "strong" }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "docs",
              marks: [{ type: "link", attrs: { href: "https://example.com/a" } }],
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph("one")] },
            { type: "listItem", content: [paragraph("two")] },
          ],
        },
        { type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: "x = 1" }] },
      ],
    };
    const md = adfToMarkdown(adf);
    expect(md).toContain("**strong**");
    expect(md).toContain("[docs](https://example.com/a)");
    expect(md).toMatch(/[*-]\s+one\n[*-]\s+two/);
    expect(md).toContain("```python\nx = 1\n```");
  });

  it("treats untrusted payloads as no description", () => {
    expect(adfToMarkdown(undefined)).toBe("");
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown({})).toBe("");
    expect(adfToMarkdown("plain string")).toBe("");
    expect(adfToMarkdown([1, 2, 3])).toBe("");
    // Unknown node shapes must degrade to empty text, never throw at render.
    expect(adfToMarkdown({ type: "doc", version: 1, content: [{ type: "mystery" }] })).toBe("");
  });
});
